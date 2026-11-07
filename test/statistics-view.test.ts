import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The rules of the statistics view, measured against the store rather than recited.
 *
 * `pg_stat_statements` is the only window into what this store costs, and three of its properties are easy to get
 * wrong in ways that produce confident, wrong numbers:
 *
 *   1. Constants are normalised away, so statements that differ only in a literal - or only in an alias on a
 *      constant select - are ONE row. home-ops measured nine probes held by one row whose `calls` read 3, then 6,
 *      then 9 (home-ops `12fa5e9`); this file reproduces it here, in the Longhorn-backed store, and finds the same
 *      `queryid` both sides computed for `select $1 as <alias>`.
 *   2. A row's text is whichever variant arrived first, so a printed label is not a record of what the counter
 *      counted. Attribute by `queryid`; text is a hint.
 *   3. `pg_stat_statements_reset` has a three-argument form that is the only surgical way to remove a fabricated
 *      probe's counters, and its first two arguments are (`userid`, `dbid`) in this build. Passing them the other
 *      way round is a **silent no-op**: no error, no moved `stats_reset`, no changed counters - a cleanup that
 *      looks like it ran.
 *
 * Fabricated statements here are named `stat_probe_*` and are removed by the targeted reset in the declared
 * argument order, verified by reading the view afterwards. Run as:
 *
 *   PI_LIVE_DSN="$DSN" npx vitest run test/statistics-view.test.ts
 */

const liveDsn = process.env.PI_LIVE_DSN ?? "";
const PROBE = "stat_probe";
// `_` is a one-character wildcard in LIKE, so every pattern below escapes it. Left unescaped, `stat_probe` matches
// any statement shaped like `statXprobe`, which is a test that passes for the wrong reason.
const like = (fragment: string) => fragment.replace(/_/g, "\\_");

type Client = {
  connect: () => Promise<void>;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};
type ClientOptions = { connectionString: string; application_name?: string };

let client: Client;
let query: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
/** The declared argument order of the targeted reset, read from the server rather than assumed from documentation. */
let resetArgs: string[];
let statsResetAtBefore = "";

const probeRows = async () =>
  query(`select queryid, dbid, userid, calls, total_exec_time, query from pg_stat_statements where query like $1 order by queryid`, [
    like(`select $1 as ${PROBE}%`),
  ]);

/** Removes one tracked statement, in the argument order *this build* declares. */
const targetedReset = async (row: Record<string, unknown>) => {
  const placeholders = resetArgs.map((_, index) => `$${index + 1}`).join(", ");
  const values = resetArgs.map((name) => {
    if (name === "queryid") return String(row.queryid);
    if (name === "dbid") return String(row.dbid);
    if (name === "userid") return String(row.userid);
    throw new Error(`pg_stat_statements_reset has an argument this test does not know: ${name}`);
  });
  await query(`select pg_stat_statements_reset(${placeholders})`, values);
};

describe.skipIf(!liveDsn)("pg_stat_statements contract", () => {
    beforeAll(async () => {
      const pg = (await import("pg")) as unknown as { Client: new (options: ClientOptions) => Client };
      client = new pg.Client({ connectionString: liveDsn, application_name: "pi-ed statistics contract" } as ClientOptions);
      await client.connect();
      query = async (sql, values) => (await client.query(sql, values)).rows;

      const declared = await query(
        `select p.proargnames::text[] as names
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'pg_stat_statements_reset' and array_length(p.proargnames, 1) = 3`,
      );
      if (!declared.length) throw new Error("the three-argument pg_stat_statements_reset is not present in this store");
      resetArgs = declared[0].names as string[];

      statsResetAtBefore = String((await query(`select stats_reset from pg_stat_statements_info`))[0].stats_reset);

      // A previous run's probes, cleared through the only route that exists: the view is not deletable in this
      // version, so the targeted reset is the cleanup - and it doubles as the first measurement below.
      for (const row of await probeRows()) await targetedReset(row);
    });

    afterAll(async () => {
      for (const row of await probeRows()) await targetedReset(row);
      const stamp = String((await query(`select stats_reset from pg_stat_statements_info`))[0].stats_reset);
      // The window a *different* reader is measuring against is shared state. Nothing in this file may move it.
      expect(stamp).toBe(statsResetAtBefore);
      await client.end();
    });

    it("declares the reset argument order in an order that is not the obvious one", async () => {
      // Measured fact, asserted rather than assumed, because a wrong order is a silent no-op rather than an error:
      // this build takes (userid, dbid, queryid), and calling it (dbid, userid, queryid) - the order the manual
      // page suggests - changes nothing at all.
      expect(resetArgs).toEqual(["userid", "dbid", "queryid"]);
    });

    it("holds one counter for three constant selects that only differ in their alias", async () => {
      for (const [literal, alias] of [
        [7001, "alpha"],
        [7002, "beta"],
        [7003, "gamma"],
      ]) {
        await query(`select ${literal} as ${PROBE}_${alias}`);
      }

      const rows = await probeRows();
      const merged = rows.filter((row) => /^select \$1 as stat_probe_/.test(String(row.query)));
      expect(merged, "three structurally identical probes must land on one row - that is the finding").toHaveLength(1);
      expect(Number(merged[0].calls)).toBeGreaterThanOrEqual(3);

      // And the label is a lie by construction: the row names whichever variant created it, so the two aliases that
      // never appear in the view ran just as many times as the one that does.
      const text = String(merged[0].query);
      const named = ["alpha", "beta", "gamma"].filter((alias) => text.includes(`${PROBE}_${alias}`));
      expect(named).toHaveLength(1);
      const absent = await query(`select count(*)::int as hits from pg_stat_statements where query like $1`, [
        like(`%${PROBE}_${["alpha", "beta", "gamma"].find((alias) => alias !== named[0])}%`),
      ]);
      expect(Number(absent[0].hits)).toBe(0);
    });

    it("separates statements that differ in structure and merges ones that differ in literals", async () => {
      await query(`select 7011 as ${PROBE}_shape_unused from pg_database where false`);
      const every = await probeRows();
      // The shape probe's text starts with the constant probe's text, so a prefix pattern matches both rows and a
      // comparison against "the constant row" would silently compare the shape row with itself. Structure is what
      // separates them, so the partition is done on structure.
      const shaped = every.filter((row) => / from /i.test(String(row.query)));
      const constants = every.filter((row) => !/ from /i.test(String(row.query)));
      expect(shaped).toHaveLength(1);
      expect(constants).toHaveLength(1);
      expect(String(shaped[0].queryid)).not.toBe(String(constants[0].queryid));

      // Same structure, different literal: one row, one counter, two calls. This is why a probe needs a table
      // clause or a distinctive structure rather than a more creative alias.
      await query(`select 7012 as ${PROBE}_shape_unused from pg_database where true`);
      const again = await query(`select queryid, calls from pg_stat_statements where query like $1`, [like(`%${PROBE}_shape_unused%`)]);
      expect(again).toHaveLength(1);
      expect(Number(again[0].calls)).toBe(2);
    });

    it("cleans a probe only when the reset arguments are in the order this build declares", async () => {
      const rows = await probeRows();
      expect(rows.length).toBeGreaterThan(0);
      const target = rows[0];
      const callsBefore = Number(target.calls);

      // Swapped: the mistake, made on purpose. No error, no change, and nothing in the response says so.
      const swapped = resetArgs.map((name) => (name === "dbid" ? String(target.userid) : name === "userid" ? String(target.dbid) : String(target.queryid)));
      await query(`select pg_stat_statements_reset($1, $2, $3)`, swapped);
      const still = await query(`select calls from pg_stat_statements where queryid = $1`, [String(target.queryid)]);
      expect(still, "a swapped reset must not remove anything - it silently does nothing").toHaveLength(1);
      expect(Number(still[0].calls)).toBe(callsBefore);
      expect(String((await query(`select stats_reset from pg_stat_statements_info`))[0].stats_reset)).toBe(statsResetAtBefore);

      // Declared order: the row is gone, not merely zeroed, and the shared window is untouched.
      await targetedReset(target);
      const gone = await query(`select queryid from pg_stat_statements where queryid = $1`, [String(target.queryid)]);
      expect(gone).toHaveLength(0);
      expect(String((await query(`select stats_reset from pg_stat_statements_info`))[0].stats_reset)).toBe(statsResetAtBefore);
    });
  });
