import { describe, expect, it } from "vitest";
import { cleanStatementTraces, findStatementTraces, preCleanOwnLitter, snapshotQueryIds, targetedReset, type StatementClient } from "./statements-cleanup.ts";

/**
 * The cleanup helper, against a double instead of the store.
 *
 * These are the gates that decide whether a name-scoped cleanup in a shared store is cleanup or somebody else's lost
 * baseline, and every one of them came from a measurement home-ops made on this Postgres: an ungated `like` sweep
 * that would reset 14 rows carrying 395 calls neither repo created, a `LIKE` underscore that quietly widens every
 * probe name, and a reset that reports success while removing nothing.
 */

interface FakeRow {
  queryid: string;
  dbid: string;
  userid: string;
  calls: number;
  query: string;
}

/** A stand-in for `pg_stat_statements` that records the SQL it was asked to run, so the read can be asserted too. */
class FakeStore implements StatementClient {
  resets: Array<string[]> = [];
  sql: string[] = [];
  constructor(private rows: FakeRow[]) {}

  async query(sql: string, values: unknown[] = []) {
    this.sql.push(sql.replace(/\s+/g, " ").trim());
    if (sql.includes("proargnames")) return { rows: [{ proargnames: ["userid", "dbid", "queryid"] }], rowCount: 1 };
    if (sql.includes("pg_stat_statements_reset(")) {
      this.resets.push((values ?? []) as string[]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("from pg_stat_statements")) {
      const marker = values[0] as string | undefined;
      const matched = marker === undefined ? this.rows : this.rows.filter((row) => row.query.includes(marker));
      const left = matched.filter((row) => !this.resets.some((v) => v[2] === row.queryid) && !row.query.includes("from pg_stat_statements"));
      if (sql.includes("count(*)")) return { rows: [{ n: left.length }], rowCount: 1 };
      return { rows: left, rowCount: left.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("a cleanup in a shared store is gated, or it is not a cleanup", () => {
  const mine = { queryid: "9000000000000000001", dbid: "16384", userid: "10", calls: 3, query: "select 1 from probe_run_2026" };
  const theirs = { queryid: "9000000000000000002", dbid: "16384", userid: "10", calls: 400, query: "select 1 from probe_run_2026 -- written last week" };

  it("refuses to clean at all without a before-snapshot", async () => {
    // Not "cleans anyway and warns". The function cannot tell a row the run created from a row the run merged into
    // without the snapshot, and the two have opposite consequences: one is litter, the other is a peer's baseline.
    const store = new FakeStore([mine, theirs]);
    await expect(cleanStatementTraces(store, "probe_run_2026")).rejects.toThrowError(/refusing an ungated cleanup/);
    expect(store.resets, "the refusal must happen before any reset is sent").toEqual([]);
    // And the refusal says what is at stake, in numbers, rather than just failing.
    await expect(cleanStatementTraces(store, "probe_run_2026")).rejects.toThrowError(/matches 2 row\(s\) carrying 403 call/);
  });

  it("removes the row the run created and refuses the row that predates it", async () => {
    const store = new FakeStore([mine, theirs]);
    const before = new Set([theirs.queryid]);
    const swept = await cleanStatementTraces(store, "probe_run_2026", before);
    expect(swept).toEqual({ rows: 1, calls: 3, refused: 1, leftovers: 1 });
    expect(store.resets).toEqual([["10", "16384", mine.queryid]]);
    // The leftover is the refused row, and it is *reported* rather than removed: that count is the honest version of
    // "cleaned up", because a merged row is not the run's to delete.
    expect(swept.leftovers).toBe(1);
  });

  it("reads the marker as a substring, never as a LIKE pattern", async () => {
    // `LIKE` makes `_` a single-character wildcard, and every probe name in this repo is full of underscores, so
    // `%probe_run_2026%` also matches `probeXrunY2026`. The read is `position($1 in query) > 0`, and the pattern
    // reaches the store without wildcards.
    const store = new FakeStore([mine]);
    await findStatementTraces(store, "probe_run_2026");
    const read = store.sql.find((sql) => sql.includes("from pg_stat_statements"));
    expect(read).toContain("position($1 in query) > 0");
    expect(read ?? "").not.toMatch(/query like/);
    expect(store.sql.some((sql) => /query like/i.test(sql)), "no LIKE anywhere in the cleanup path").toBe(false);
  });

  it("does not let the leftover count be made by a query that would match itself", async () => {
    // A check written as `where query like '%probe%'` counts its own row, which is the self-reference home-ops found
    // from the other side: the assertion can never report zero about itself.
    const store = new FakeStore([mine]);
    const swept = await cleanStatementTraces(store, "probe_run_2026", new Set());
    expect(swept.rows).toBe(1);
    const counted = store.sql.filter((sql) => sql.includes("count(*)"));
    expect(counted.length).toBe(1);
    expect(counted[0]).toContain("query not like '%from pg_stat_statements%'");
  });

  it("reports the ids it was given, as text", async () => {
    const store = new FakeStore([mine, theirs]);
    const ids = await snapshotQueryIds(store);
    expect([...ids]).toEqual([mine.queryid, theirs.queryid]);
    // Text, not number: these ids are around 9e18 and past 2^53, so a number is a different identity.
    expect([...ids].every((id) => typeof id === "string")).toBe(true);
  });

  it("collects the litter of a run that never finished, which the gate would refuse forever", async () => {
    // The gate is correct about other people's rows and wrong about mine: a cancelled run leaves its probes in the
    // view, and the next run sees them as predating itself and refuses to remove them. This is the one reset with no
    // before-snapshot, and it is legitimate because the stored text is the *first* statement that saw the shape - a
    // row carrying my marker was made by a submission carrying my marker, or it would carry somebody else's text.
    const store = new FakeStore([mine, theirs]);
    const swept = await preCleanOwnLitter(store, "probe_run_2026");
    expect(swept).toEqual({ rows: 2, calls: 403 });
    expect(store.resets.length).toBe(2);
  });

  it("takes a marker list, so a file's whole namespace is covered by one call", async () => {
    const other = { queryid: "9000000000000000003", dbid: "16384", userid: "10", calls: 1, query: "select 1 from probe_split_1794" };
    const store = new FakeStore([mine, other]);
    const swept = await preCleanOwnLitter(store, "probe_run_2026", ["probe_split"]);
    expect(swept.rows).toBe(2);
    // The read is a parameter, and the marker is a substring: no LIKE, so no underscore wildcard.
    expect(store.sql.some((sql) => /query like/i.test(sql))).toBe(false);
  });
});

describe("the reset arguments are refused before the call, in both directions", () => {
  const order = ["userid", "dbid", "queryid"];
  const good = { userid: "10", dbid: "16384", queryid: "9000000000000000001" };

  it("sends a complete triple in the declared order", async () => {
    const store = new FakeStore([]);
    await targetedReset(store, good, order);
    expect(store.resets).toEqual([["10", "16384", "9000000000000000001"]]);
  });

  it("refuses a zero, because 0 means every row with that id", async () => {
    // Measured: `reset(0, 17680, 0)` took a scratch database from 31 tracked rows to 1 and left `stats_reset`
    // byte-identical. A scoped reset with a zero in it is a mass deletion with no witness.
    for (const bad of [
      { ...good, userid: "0" },
      { ...good, dbid: 0 },
      { ...good, queryid: "0" },
    ]) {
      const store = new FakeStore([]);
      await expect(targetedReset(store, bad, order)).rejects.toThrowError(/0 means every/);
      expect(store.resets).toEqual([]);
    }
  });

  it("refuses a missing id, because a STRICT function turns NULL into a silent success", async () => {
    for (const bad of [undefined, null, ""]) {
      const store = new FakeStore([]);
      await expect(targetedReset(store, { ...good, dbid: bad }, order)).rejects.toThrowError(/missing/);
      expect(store.resets, "the call must not be sent at all").toEqual([]);
    }
  });
});
