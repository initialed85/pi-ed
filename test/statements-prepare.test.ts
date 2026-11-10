import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanStatementTraces, preCleanOwnLitter, snapshotQueryIds } from "./statements-cleanup.ts";

/** The prefix every `prepare` label in this file carries, so cleanup can find what this file named. */
const PREPARE_LABEL = "pi_ed_prepare_probe";

/**
 * Every statement this extension exports has to be something Postgres accepts, and the way to check that without
 * writing rows is `PREPARE`.
 *
 * Why this file exists. In one bulk edit this file's subject introduced
 * `insert into memory.session (id, agent_id), repo, cwd, source, started_at, last_activity_at)` - a single stray
 * parenthesis inside a template literal. Three layers of defence each let it through, and the reasons are worth
 * recording because they are not obvious:
 *
 *   - TypeScript accepted it, because SQL in this codebase is a string and the compiler has no opinion about strings.
 *   - The unit suite accepted it, because the unit assertions compare SQL text to expected SQL text, and an expected
 *     string copied from the same buggy source agrees with the bug instead of catching it.
 *   - The LIVE suite accepted it, which is the uncomfortable one: a failed flush is deliberately caught, spooled to
 *     disk, and reported on the heartbeat, because a memory system must survive the store being unreachable. That is
 *     the right behaviour for the product and makes it a poor test harness - the statement on the main write path of
 *     every session this extension records was failing, and the suite stayed green.
 *
 * `PREPARE` closes that gap without executing anything. It parses the SQL, resolves every table and column name
 * against the real schema in the real database - which is also what makes schema qualification testable rather than
 * a matter of taste - and checks parameter numbers against the actual columns. It writes nothing.
 *
 * A parenthesis-balance check runs in the unit half of this file for the same reason CI has no live store: it is the
 * cheapest thing that would have caught the typo, and it is not a joke - SQL is mostly parentheses, and a statement
 * whose parentheses do not balance is a statement that cannot be right.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "parked", "memory.ts");
const liveDsn = process.env.PI_LIVE_DSN ?? "";

type Statement = { sql: string; values: unknown[] };

/** The argument shapes the exported builders accept, tried in order until one produces a statement. */
const argShapes: unknown[][] = [
  [],
  ["agent-id", "repo"],
  ["agent-id"],
  ["agent-id", 12],
  ["agent-id", "a rolled-back flush", 3],
  // `heartbeatFailureStatement(agentId, repo, error, spoolRows)`. Without a four-argument shape this builder threw
  // on every shape above and left the reachable set silently - which is exactly what the frozen name list in
  // `names exactly the builders...` caught, and exactly what the README's "19 statements" claim had been wrong about.
  ["agent-id", "repo", "could not connect to 10.43.5.96:5432", 7],
  // `eventStatement(sessionId, agentId, rows)` builds its value tuples in a loop, so a rows array is the only way to
  // reach it at all. The SQL is dynamic; the statement is not untestable.
  ["session-1", "agent-id", [
    { sourceEntryId: "entry-1", kind: "user", at: "2026-01-01T00:00:00Z", text: "how do I roll this back", meta: {} },
    { sourceEntryId: "entry-2", kind: "tool_result", at: "2026-01-01T00:00:01Z", toolName: "bash", text: "ok", meta: { exit: 0 } },
  ]],
  [{ sessionId: "s1", agentId: "a", cwd: "/w", repo: "r", firstAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-01T00:00:00Z" }],
  [{ agentLike: "a%" }],
  ["how do I roll this back", "agent-id"],
  ["agent-id", [0.1, 0.2]],
];

async function loadModule(): Promise<Record<string, unknown>> {
  return (await import(source)) as Record<string, unknown>;
}

/**
 * Where this file's sweeps are allowed to write.
 *
 * Set before the source is imported for the first time, because the extension reads `PI_MEMORY_SPOOL` once, at module
 * load. Left unset, the sweep below writes to `~/.pi/agent/memory-spool.jsonl` - the real fallback queue of whoever is
 * running the tests - which is what happened on 2026-11-08: the file ended up with 1,014 lines of one-character JSON
 * strings, none of them a row, in place of whatever backlog had been there.
 */
const scratch = path.join(os.tmpdir(), `pi-ed-statements-prepare-${process.pid}`);
const scratchSpool = path.join(scratch, "spool.jsonl");
process.env.PI_MEMORY_SPOOL = scratchSpool;
process.env.PI_MEMORY_CONFIG = path.join(scratch, "memory.json");

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Not statement builders, and not safe to call with a fixture argument.
 *
 * `writeSpool` and `rewriteSpool` iterate their argument. Handed a string - which is what `argShapes[7]` is - a string
 * iterates one character at a time, and each character is a valid JSON value, so the call succeeds and appends
 * `"a"\n"g"\n"e"\n...` to the spool. Measured on the pre-fix source: `writeSpool("agent-id")` produced 8 junk lines and
 * `readSpool` replayed 0 rows. A sweep over every export wants the SQL factories, not the ones with a file handle.
 */
const NON_SQL_EXPORTS = new Set(["readSpool", "writeSpool", "rewriteSpool"]);

function collect(mod: Record<string, unknown>): Array<{ name: string; spec: Statement }> {
  const out: Array<{ name: string; spec: Statement }> = [];
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    if (NON_SQL_EXPORTS.has(name)) continue;
    if ((value as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") continue;
    for (const args of argShapes) {
      let result: unknown;
      try {
        result = (value as (...a: unknown[]) => unknown)(...args);
      } catch {
        continue;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        break;
      }
      const spec = result as Statement | undefined;
      if (spec && typeof spec.sql === "string" && Array.isArray(spec.values)) {
        out.push({ name, spec });
        break;
      }
    }
  }
  return out;
}

/**
 * Parens outside single-quoted literals. A statement whose parentheses do not balance cannot be executed, and this
 * check needs no database, no network and no permissions, which makes it the only guard in this file that CI runs.
 */
function parenBalance(sql: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inLiteral = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      // '' inside a literal is an escaped quote, not the end of one.
      if (inLiteral && sql[i + 1] === "'") {
        i += 1;
        continue;
      }
      inLiteral = !inLiteral;
      continue;
    }
    if (inLiteral) continue;
    if (ch === "(") open += 1;
    if (ch === ")") close += 1;
  }
  return { open, close };
}

function highestParam(sql: string): number {
  return [...sql.matchAll(/\$(\d+)/g)].reduce((max, m) => Math.max(max, Number(m[1])), 0);
}

describe("every exported statement", () => {
  it("has balanced parentheses and a parameter list that matches its values", async () => {
    const specs = collect(await loadModule());
    // The count is asserted so a builder that stops being callable with these shapes cannot quietly leave the set.
    expect(specs.length).toBeGreaterThanOrEqual(18);
    expect(specs.map((s) => s.name)).toContain("sessionStatement");

    const unbalanced = specs
      .map(({ name, spec }) => ({ name, ...parenBalance(spec.sql) }))
      .filter((row) => row.open !== row.close);
    expect(unbalanced).toEqual([]);

    const mismatched = specs
      .map(({ name, spec }) => ({ name, params: highestParam(spec.sql), values: spec.values.length }))
      .filter((row) => row.params !== row.values);
    expect(mismatched).toEqual([]);
  });

  it("names exactly the builders the fleet sweep validates, so a name leaving the set is a diff and not a gap", async () => {
    // home-ops' runner discovers the builder list from this source rather than trusting a list it maintains, and the
    // reason is worth encoding here as well: the row of counts a validation sweep prints says nothing when a builder
    // stops being reachable, while a diff in the *name list* says it immediately. Frozen here so the list changes in
    // a diff that gets reviewed, not in someone's memory.
    const mod = await loadModule();
    const builders = Object.keys(mod).filter((name) => name.endsWith("Statement")).sort();
    expect(builders).toEqual([
      "agentStatement",
      "dreamCallEdgeStatement",
      "dreamConsiderStatement",
      "dreamCursorStatement",
      "dreamSpanStatement",
      "dreamStatement",
      "dreamWatermarkStatement",
      "eventStatement",
      "heartbeatActivityStatement",
      "heartbeatAdvisoryAlertStatement",
      "heartbeatFailureStatement",
      "heartbeatFlushStatement",
      "heartbeatPageAlertStatement",
      "heartbeatReadStatement",
      "heartbeatSweepStatement",
      "identityPairStatement",
      "memorySpanEdgesStatement",
      "messageEdgesStatement",
      "ownRowCountStatement",
      "sessionStatement",
      "storeReadingSanityStatement",
      "storeShapeCountsStatement",
      "subjectEdgesStatement",
      "subjectsStatement",
      "vectorCoverageStatement",
      "wakeEdgesStatement",
    ]);

    // One builder assembles its value tuples in a loop, so no static extraction can reach its SQL and it is the one
    // name a sweep has to report as information rather than as a validation. Naming it here keeps the exception a
    // reviewed fact instead of a silent hole: a second name appearing in this list means a statement left the
    // reachable set without anyone saying so.
    const text = readFileSync(source, "utf8");
    const dynamic = builders.filter((name) => {
      const after = text.split(`export function ${name}(`)[1] ?? "";
      return /\bfor \(|\.map\(|\.push\(/.test(after.slice(0, after.indexOf("\nexport ")));
    });
    expect(dynamic).toEqual(["eventStatement"]);

    // And every name in the list is actually reachable by the sweep's argument shapes. A builder that started
    // requiring an argument the sweep does not try would be absent from the collected set while still being here.
    const collected = collect(mod).map((s) => s.name);
    expect(builders.filter((name) => !collected.includes(name))).toEqual([]);
  });

  it("leaves the spool it was handed alone", async () => {
    // A sweep that calls every export with fixture arguments is a sweep that can reach a file handle. Run the sweep,
    // then look at the file it would have written to.
    collect(await loadModule());
    // Built eagerly on purpose: the point of the assertion is the content, and "absent" and "empty" are the same claim.
    const written = existsSync(scratchSpool) ? readFileSync(scratchSpool, "utf8") : "";
    expect(written).toBe("");
  });
});

describe.skipIf(!liveDsn)("every exported statement, prepared against the real store", () => {
  let pg: typeof import("pg");
  let Client: new (dsn: string) => import("pg").Client;
  let statsResetAtStart: string;
  // The gate for every cleanup in this file, taken before any of it has run. A row whose id is absent from this set
  // was created by this invocation and is its to remove; a row whose id is in it predates the run, and the run's
  // shape may well have merged into it - which is why the name scope is not enough to decide ownership.
  let idsAtStart: Set<string>;

  beforeAll(async () => {
    pg = await import("pg");
    Client = pg.Client;
    // Recorded before anything this file runs, so the cleanup test can prove it never moved the shared window.
    const seed = new Client(liveDsn);
    await seed.connect();
    // A run that was cancelled mid-file left its prepare labels and its prepare-key relation here, and the gate
    // would refuse to remove them on the next run because they predate it. Collect them first, on the file's own
    // namespace, before the snapshot is taken.
    const litter = await preCleanOwnLitter(seed, PREPARE_LABEL, ["stat_probe_preparekey"]);
    if (litter.rows) console.log(`statements-prepare: collected ${litter.rows} tracked statement(s) carrying ${litter.calls} call(s) from an earlier run`);
    const info = await seed.query(`select stats_reset::text as stats_reset from pg_stat_statements_info`);
    statsResetAtStart = info.rows[0].stats_reset;
    idsAtStart = await snapshotQueryIds(seed);
    await seed.end();
  });
  it("is accepted by Postgres without executing anything", async () => {
    const specs = collect(await loadModule());
    const client = new Client(liveDsn);
    await client.connect();

    const rejected: Array<{ name: string; message: string }> = [];
    let prepared = 0;
    try {
      for (const { name, spec } of specs) {
        const label = `${PREPARE_LABEL}_${prepared}_${name.replace(/[^a-z0-9_]/gi, "")}`;
        try {
          await client.query(`prepare ${label} as ${spec.sql}`);
          await client.query(`deallocate ${label}`);
          prepared += 1;
        } catch (error) {
          rejected.push({ name, message: (error as Error).message.split("\n")[0] ?? String(error) });
          // Leave no half-prepared statement behind if one of them is rejected.
          try {
            await client.query(`deallocate ${label}`);
          } catch {
            // nothing to deallocate
          }
        }
      }
    } finally {
      await client.end();
    }

    // PREPARE resolves names against the real schema, so an unqualified table that happens to be reachable through
    // `search_path` today and a table that is not there at all produce the same class of failure here. Both halves of
    // the store's qualification contract - this extension's own writes and the readers it exports - are covered by the
    // same statement list.
    expect(rejected).toEqual([]);
    expect(prepared).toBeGreaterThanOrEqual(18);
    // The stronger invariant, and the one that would have caught this file's own gap: not "at least 18", but "no
    // exported builder is missing". Two builders were unreachable through the argument shapes above -
    // `heartbeatFailureStatement` needed a fourth argument and `eventStatement` needed a rows array - and a run of 18
    // looked like a pass while the two most write-shaped statements in the extension went unvalidated. A count is
    // evidence about the sweep; a name list is evidence about the store.
    const preparedNames = new Set(specs.map((s) => s.name));
    const unreachable = Object.keys(await loadModule())
      .filter((name) => name.endsWith("Statement") && !preparedNames.has(name));
    expect(unreachable, "every exported builder must be reachable by the sweep's argument shapes").toEqual([]);
  });

  it("keys a prepared statement to its inner statement, and labels it with whatever submitted first", async () => {
    // The mechanism behind every warning in this file, measured here so it stops being folklore.
    //
    // A `prepare X as Q` that is never executed is not tracked at all. Once it is executed, the row is keyed by the
    // hash of *Q* - the inner statement - and the text stored on that row is whatever was submitted first, which is
    // the whole `prepare X as Q` string. So the label is not in the hash, the alias is not in the hash, and the name
    // a name-scoped cleanup can see is only the first thing that ever ran the shape.
    //
    // This is why a shared store cannot be cleaned by name. It is also why home-ops saw a row
    // `prepare pi_ed_prepare_probe_13_vectorCoverageStatement as select count(*)::int ...` accumulating calls while
    // nothing in this suite executes anything: the row was keyed by the inner SELECT, and the label was merely its
    // first-seen text.
    const rel = `stat_probe_preparekey_${Date.now()}`;
    const inner = `select count(*)::int as n from ${rel}`;
    const client = new Client(liveDsn);
    await client.connect();
    // Taken after the connection and before any statement of the test: the gate is the ids that existed when the
    // run started, so a row this run merged into is refused rather than reset.
    const idsBefore = await snapshotQueryIds(client);
    const rows = async () =>
      (
        await client.query(
          `select queryid::text as queryid, calls::int as calls, query from pg_stat_statements where query like $1`,
          [`%${rel}%`],
        )
      ).rows;

    try {
      await client.query(`create temp table ${rel} (n int)`);
      await client.query(`prepare ${rel}_p as ${inner}`);
      await client.query(`execute ${rel}_p`);
      const created = await rows();
      const prepareRow = created.find((row) => row.query.startsWith("prepare "));
      expect(prepareRow).toBeDefined();
      expect(prepareRow!.calls).toBe(1);

      // The same inner statement, submitted directly: it lands on the prepare's row, because the hash is the inner
      // statement's and the row is not the prepare's.
      await client.query(inner);
      const direct = await rows();
      const stillKeyed = direct.find((row) => row.queryid === prepareRow!.queryid)!;
      expect(stillKeyed.calls).toBe(2);
      expect(stillKeyed.query).toBe(prepareRow!.query); // and the text still says `prepare ...`, not what just ran

      // A third submission, with a different alias on the same shape: the alias is outside the hash too.
      await client.query(`select count(*)::int as ${rel}_alias from ${rel}`);
      const aliased = await rows();
      expect(aliased.find((row) => row.queryid === prepareRow!.queryid)!.calls).toBe(3);
      expect(aliased.filter((row) => row.query.includes(`as ${rel}_alias`)).length).toBe(0);
    } finally {
      // The temporary relation dies with the session; the trace of it does not, and this is the case where a name
      // scope genuinely works - the relation is the run's own, and the relation is in the hash.
      const swept = await cleanStatementTraces(client, rel, idsBefore);
      expect(swept.leftovers).toBe(0);
      await client.end();
    }
  });

  it("leaves no statement in the view labelled with its own probe names", async () => {
    // This test runs `prepare` and `deallocate` against a store other agents read, so it owes the view back what it
    // labelled with its own names. The wording is "labelled" because that is the only thing a run can prove:
    //
    //   A prepare that is never executed is not tracked at all, and a prepare that is executed is tracked under the
    //   hash of its INNER statement. So the run's own statements split into two kinds. The ones whose structure was
    //   novel get a row carrying the run's name, and those are the run's to remove. The ones that merged into a
    //   pre-existing row leave no name-scoped trace, and removing the row they landed on would erase another
    //   writer's history with it - in a shared store that is not cleanup, it is somebody else's lost baseline.
    //
    // So this asserts the first kind is gone and says nothing about the second, which is the honest version of
    // "clean up everything you ran". The shared `hack/pg-statement-traces.mjs` tool reports the second kind as a
    // landing delta rather than pretending it is absent.
    const client = new Client(liveDsn);
    await client.connect();
    try {
      const swept = await cleanStatementTraces(client, PREPARE_LABEL, idsAtStart);
      expect(swept.leftovers, "a probe label this file invented must not survive the file that made it").toBe(0);

      // Idempotence: a second sweep finding nothing is what distinguishes cleanup from a lucky count.
      const again = await cleanStatementTraces(client, PREPARE_LABEL, idsAtStart);
      expect(again.rows).toBe(0);
      expect(again.leftovers).toBe(0);

      // And the shared window is untouched by all of it: this suite has no claim on anybody else's bucket.
      const statsReset = await client.query(`select stats_reset::text as stats_reset from pg_stat_statements_info`);
      expect(String(statsReset.rows[0].stats_reset)).toBe(statsResetAtStart);
    } finally {
      await client.end();
    }
  });
});
