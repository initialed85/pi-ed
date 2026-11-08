import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isToolQuery, matchNames, parseArgs, siblings, skeleton } from "../hack/pg-statement-traces.mjs";

/**
 * The shared statement-trace tool, tested where it can be tested without a store: at its gates.
 *
 * The reason this file exists is a measurement two agents made independently on the same Postgres (home-ops
 * `f5a1415`, reproduced here). A `pg_stat_statements` row is a *counter* keyed by the hash of a statement's
 * structure, and its stored text is only the first thing that ran that shape. So a cleanup that matches on the run's
 * name either finds nothing (the run's calls merged into a row that does not carry its name) or finds a row that is
 * not its own (the run's name is on the row because the run was first, and another writer has been counting on it
 * since). Both readings say "leftovers 0" and both are wrong.
 *
 * The response is a contract, not a better regex: `assert` is read-only and shareable across the fleet, `remove` is
 * gated on proof that the row did not exist before this invocation. That proof is the whole value of the tool, so it
 * is asserted here, in the dark, with no database to be polite about.
 */

const tool = fileURLToPath(new URL("../hack/pg-statement-traces.mjs", import.meta.url));

function run(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  // The point of these tests is what the tool refuses to do before it connects, so they must not depend on a store
  // being reachable. An empty DSN is the honest way to ask that question.
  const result = spawnSync(process.execPath, [tool, ...args], {
    encoding: "utf8",
    env: { ...process.env, PI_LIVE_DSN: "", PI_MEMORY_DSN: "", ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the tool's argument contract", () => {
  it("separates the names it cleans by from the statements it grades by", () => {
    const parsed = parseArgs([
      "assert",
      "--before",
      "/tmp/before.json",
      "--name",
      "stat_probe_1",
      "--name",
      "my_temp_relation",
      "--statement",
      "select count(*)::int as stat_probe_1 from memory.memory",
    ]);
    expect(parsed.mode).toBe("assert");
    expect(parsed.names).toEqual(["stat_probe_1", "my_temp_relation"]);
    expect(parsed.statements).toEqual(["select count(*)::int as stat_probe_1 from memory.memory"]);
    expect(parsed.flags.before).toBe("/tmp/before.json");
  });
});

describe("the shape key behind the merge warning", () => {
  it("is the same for two statements that differ only by an alias", () => {
    // Measured on this store: `select count(*)::int as n from memory.memory` and
    // `select count(*)::int as stat_probe_litalias_<ts> from memory.memory` are one row, one counter.
    expect(skeleton("select count(*)::int as n from memory.memory")).toBe(
      skeleton("select count(*)::int as stat_probe_litalias_1794103553786 from memory.memory"),
    );
  });

  it("is the same for a direct statement and a prepare of it", () => {
    // The row for `prepare X as Q` is keyed by Q, so the prepare's text has to grade as the same shape as the
    // statement it wraps. This is the case that made a labelled row appear in the shared view while nothing in the
    // suite that named it executed anything.
    const inner = "select count(*)::int as n from memory.memory where agent_id = $1";
    expect(skeleton(`prepare some_label as ${inner}`)).toBe(skeleton(inner));
  });

  it("is different for a different relation", () => {
    expect(skeleton("select count(*)::int as n from memory.memory")).not.toBe(skeleton("select count(*)::int as n from run_event"));
    expect(skeleton("select count(*)::int as n from memory.memory")).not.toBe(skeleton("select count(*)::int as n from memory.run_event"));
  });

  it("is empty when there is no relation clause to key on", () => {
    // A bare `select $1 as x` has no structure to fence by, which is exactly the shape that merges with everything.
    expect(skeleton("select $1 as readme_demo_alpha")).toBe("");
  });
});

describe("the tool does not count itself as a landing", () => {
  it("recognises every statement it emits about the view", () => {
    for (const text of [
      "select queryid::text as queryid, calls::bigint as calls, query from pg_stat_statements",
      "select stats_reset::text as stats_reset from pg_stat_statements_info",
      "show pg_stat_statements.max",
      "select p.proargnames::text[] as names from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
      "select $1::bigint as userid, $2::bigint as dbid, $3::bigint as queryid",
      "select pg_stat_statements_reset($1, $2, $3)",
    ]) {
      expect(isToolQuery(text), `the tool must exclude its own statement: ${text.slice(0, 40)}`).toBe(true);
    }
    // And it must not swallow a real probe. This is the one a run genuinely wants to see in its delta.
    expect(isToolQuery("select count(*)::int as n from memory.memory")).toBe(false);
  });

  it("matches a name only in the stored text, which is the limit of a name scope", () => {
    expect(matchNames("select count(*)::int as stat_probe_1 from memory.memory", ["stat_probe_1"])).toBe("stat_probe_1");
    // A value carrying the name is normalised to `$1` by the view and is invisible here. Measured, not assumed.
    expect(matchNames("select $1 as n from memory.memory where agent_id = $2", ["stat_probe_1"])).toBeUndefined();
  });

  it("matches a name that is only part of another writer's alias, which is why a name scope is not attribution", () => {
    // Measured on this store: `assert --name pi_ed_` reported a leftover that was not mine at all. The row is
    // home-ops' cleanup verification, and it carries `pi_ed` because that is the name of the database, used as an
    // alias. `remove` refused it because the row predates the run, which is the only thing standing between a
    // marker like this and a reset of someone else's counter.
    const peerRow = "select count(*) filter (where dbid=$1) as probe_rows_after, count(*) filter (where dbid=$2) as pi_ed_rows_after, count(*) as total_after from public.pg_stat_statements";
    expect(matchNames(peerRow, ["pi_ed_"])).toBe("pi_ed_");
    // A marker that cannot be an identifier someone else would choose is the fix, and the run's own probes use it.
    expect(matchNames(peerRow, ["pi_ed_prepare_probe", "stat_probe_"])).toBeUndefined();
  });
});

describe("the sibling report: one statement, several rows", () => {
  // The merge's counterpart, and the one home-ops hit for real. Adding a column to a select list changes the hash,
  // so the statement starts a new row and the old generation keeps its counter. The five rows they read for the
  // heartbeat sweep were caused by pi-ed `79b0202` - a routine column addition in this repo, invisible in the diff
  // of the repo whose baseline broke.
  const rows = {
    "1": { calls: 78, dbid: "16384", userid: "10", query: "select agent_id, repo, last_activity_at from memory.writer_heartbeat where last_flush_at is null" },
    "2": { calls: 7, dbid: "16384", userid: "10", query: "select agent_id, repo, last_activity_at, (flushes = 0) as never_attempted from memory.writer_heartbeat where last_flush_at is null" },
    "3": { calls: 3, dbid: "16384", userid: "10", query: "select agent_id from memory.writer_heartbeat where repo = $1" },
    "4": { calls: 1, dbid: "16384", userid: "10", query: "select agent_id, repo from memory.memory where last_activity_at is null" },
  };

  it("groups the generations of a shape by their relation clause", () => {
    const hits = siblings(rows, "select agent_id, repo from memory.writer_heartbeat where last_flush_at is null");
    expect(hits.map((h) => h.queryid).sort()).toEqual(["1", "2"]);
    // The new generation is found by the clause alone; the extra column is in the target list, which is where the
    // alias-free difference lives.
    expect(hits.find((h) => h.queryid === "2")!.byClause).toBe(true);
  });

  it("reports a nested statement by its leading text, because the clause key cannot fire for one", () => {
    // The heartbeat sweep is `select * from ( ... ) x`, so `skeleton()` takes the whole subquery as the relation
    // clause and every generation of the statement has a different clause. This is what the live report showed:
    // five rows for the sweep, matched by head, zero by clause. The clause key is a flat-statement heuristic and
    // the report says which key fired rather than pretending they are the same signal.
    const generations = {
      a: { calls: 78, dbid: "16384", userid: "10", query: "select * from ( select agent_id, repo, case when (last_flush_at is null) then $1 else $2 end as severity, flushes, failures from memory.writer_heartbeat ) x" },
      b: { calls: 7, dbid: "16384", userid: "10", query: "select * from ( select agent_id, repo, case when (last_flush_at is null) then $1 else $2 end as severity, flushes, failures, (flushes = 0) as never_attempted from memory.writer_heartbeat ) x" },
    };
    const hits = siblings(generations, generations.a.query);
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.byHead)).toBe(true);
    // The statement matches its own clause trivially; the generation it re-baselined does not, and the head key is
    // the only thing that finds it.
    expect(hits.find((hit) => hit.queryid === "a")!.byClause).toBe(true);
    expect(hits.find((hit) => hit.queryid === "b")!.byClause).toBe(false);
  });

  it("does not group a different relation or a different filter", () => {
    const hits = siblings(rows, "select agent_id, repo from memory.writer_heartbeat where last_flush_at is null");
    expect(hits.some((h) => h.queryid === "4")).toBe(false);
    expect(hits.some((h) => h.queryid === "3")).toBe(false);
  });

  it("catches a where-clause change by the leading text, which the clause key cannot", () => {
    // The page condition is the half of this statement that has actually changed twice, and when it does the
    // relation clause no longer matches the old generation. The head key is what keeps the report honest.
    const moved = {
      a: { calls: 5, dbid: "16384", userid: "10", query: "select agent_id from memory.writer_heartbeat where last_flush_at is null and x < 1" },
      b: { calls: 2, dbid: "16384", userid: "10", query: "select agent_id from memory.writer_heartbeat where last_flush_at is null and x < 2" },
    };
    expect(siblings(moved, "select agent_id from memory.writer_heartbeat where last_flush_at is null and x < 1").map((h) => h.queryid).sort())
      .toEqual(["a", "b"]);
  });

  it("reports one row for a shape that has not been re-baselined", () => {
    expect(siblings(rows, "select agent_id from memory.writer_heartbeat where repo = $1").length).toBe(1);
  });
});

describe("the gates that make remove safe to run against a shared store", () => {
  it("refuses a mutating mode with no before-snapshot", () => {
    // Without a snapshot the tool cannot tell a row the run created from a row the run merged into, and resetting the
    // second kind deletes another writer's baseline. So the mode that can delete refuses to guess.
    const result = run(["remove", "--name", "stat_probe_1"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--before");
  });

  it("refuses a nameless sweep in either mode", () => {
    // A nameless `remove` would reset every row the snapshot says is new, which is not scoped to the run at all.
    for (const mode of ["assert", "remove"]) {
      const result = run([mode, "--before", "/tmp/definitely-not-a-snapshot.json"]);
      expect(result.status, `${mode} must not run without a name`).toBe(2);
      expect(result.stderr).toContain("--name");
    }
  });

  it("says nothing was measured when it has no DSN", () => {
    // "Connecting is not measuring." A report of 0 leftovers from a place the tool never reached is worse than no
    // report, and this is the failure mode that a cron job would otherwise swallow.
    const result = run(["snapshot", "--out", "/tmp/should-not-exist.json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("nothing was measured");
  });

  it("rejects an unknown mode instead of defaulting to one", () => {
    const result = run(["clean", "--name", "stat_probe_1"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});
