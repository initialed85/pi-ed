import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { targetedReset as resetTracked } from "./statements-cleanup.ts";

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
// A relation unique to this run, created once as a temp table. Three probes that differ only in their alias MUST land
// on one row - that is the finding this file exists to assert - and a shared store makes that finding expensive: a
// merged bucket is a counter other agents' statements can join, and `pg_stat_statements_reset` clears a whole bucket,
// not one variant. Probing a relation nobody else queries keeps the collision inside this run, where cleaning it up
// cannot reach across a boundary.
const bucket = `probe_bucket_${Date.now()}`;
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

/*
 * Statements carrying this file's own probe name. The name scope is what makes the cleanup safe rather than merely
 * convenient: a targeted reset clears a whole merged bucket, so it must only ever be aimed at a name another agent
 * could not have written. `stat_probe` belongs to this file; home-ops' markers are `sweep_probe`, and neither reads
 * the other's counters.
 */
const probeRows = async () =>
  query(`select queryid, dbid, userid, calls, total_exec_time, query from pg_stat_statements where query like $1 order by queryid`, [
    like(`%${PROBE}_%`),
  ]);

/** Every statement this file ran against its own temp relation, including the DDL that created it. */
const bucketRows = async () =>
  query(`select queryid, dbid, userid from pg_stat_statements where query like $1`, [like(`%${bucket}%`)]);

/** Removes one tracked statement, in the argument order *this build* declares. The helper is shared with
 * `statements-prepare.test.ts`, which needs the same cleanup for the labels its own sweep creates. */
const targetedReset = async (row: Record<string, unknown>) => {
  await resetTracked(client, row, resetArgs);
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

      // Session-scoped, so it dies with the client. Temp relations are resolved to their own OID, which is what makes
      // a probe against one structurally unreachable from any other reader's statement.
      await query(`create temp table ${bucket} (agent_id text, repo text)`);

      // A previous run's probes, cleared through the only route that exists: the view is not deletable in this
      // version, so the targeted reset is the cleanup - and it doubles as the first measurement below.
      for (const row of await probeRows()) await targetedReset(row);
    });

    afterAll(async () => {
      await query(`drop table if exists ${bucket}`);
      for (const row of await probeRows()) await targetedReset(row);
      for (const row of await bucketRows()) await targetedReset(row);
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

    it("holds one counter for three probes that differ only in their alias", async () => {
      for (const [literal, alias] of [
        [7001, "alpha"],
        [7002, "beta"],
        [7003, "gamma"],
      ]) {
        await query(`select ${literal} as ${PROBE}_${alias} from ${bucket}`);
      }

      const rows = await probeRows();
      const merged = rows.filter((row) => /^select \$1 as stat_probe_/.test(String(row.query)) && !/ where /.test(String(row.query)));
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
      await query(`select 7011 as ${PROBE}_shape_unused from ${bucket} where false`);
      const every = await probeRows();
      // Both families now carry a table clause, so the partition cannot be "has a FROM" - a shared table clause
      // merges just as happily as a bare one, which is the half of the lesson a table clause alone does not teach.
      // The partition is the filter clause, which is the structure that actually separated them.
      const shaped = every.filter((row) => / where \$2$/.test(String(row.query)));
      const constants = every.filter((row) => !/ where /.test(String(row.query)));
      expect(shaped).toHaveLength(1);
      expect(constants).toHaveLength(1);
      expect(String(shaped[0].queryid)).not.toBe(String(constants[0].queryid));

      // Same structure, different literal: one row, one counter, two calls. What separates a probe is structure - a
      // filter, a join, a relation only this reader queries - not a distinct literal and not a more creative alias.
      await query(`select 7012 as ${PROBE}_shape_unused from ${bucket} where true`);
      const again = await query(`select queryid, calls from pg_stat_statements where query like $1`, [like(`%${PROBE}_shape_unused%`)]);
      expect(again).toHaveLength(1);
      expect(Number(again[0].calls)).toBe(2);
    });

    it("splits a select * statement's own history when a column is added, and leaves a named-column statement alone", async () => {
      // A temp table, so the mechanism is measured rather than asserted about this store: what splits is decided by how
      // `queryid` is computed from the analysed query, not by which database you are in. The table disappears with the
      // session, and the view rows it created are removed with the same targeted reset the other probes use.
      // A name unique to this run. pg_stat_statements rows outlive the session that produced them, so a fixed probe
      // name would read history from earlier runs as if it were this run's - which is the same trap as reading an old
      // queryid row as a current cost, one level down.
      const table = `probe_split_${Date.now()}`;
      const star = `select * from ${table} where agent_id = 'split-probe'`;
      const named = `select agent_id from ${table} where agent_id = 'split-probe'`;
      const mine = async () =>
        query(`select queryid, dbid, userid, calls, md5(query) as text_md5, query from pg_stat_statements where query like $1 order by queryid`, [
          like(`select%from ${table} where agent_id = $1`),
        ]);

      await query(`create temp table ${table} (agent_id text, repo text)`);
      await query(`insert into ${table} values ('split-probe', 'r')`);

      await query(star);
      await query(named);
      const beforeAlter = await mine();
      expect(new Set(beforeAlter.map((row) => String(row.queryid)))).toHaveLength(2);

      await query(`alter table ${table} add column first_seen_at timestamptz`);

      // Same text, run again, with the table's column list changed underneath it.
      await query(star);
      await query(named);

      const rows = await mine();
      const starRows = rows.filter((row) => String(row.query).startsWith(`select * from ${table}`));
      const namedRows = rows.filter((row) => String(row.query).startsWith(`select agent_id from ${table}`));

      // The `select *` half: identical text, two rows, two counters. `*` is expanded to concrete columns during
      // analysis, and `queryid` is computed from the analysed tree, so adding a column changes the structure the hash
      // sees. Nothing about the statement's text changed - the table did.
      expect(new Set(starRows.map((row) => String(row.text_md5)))).toHaveLength(1);
      expect(starRows.length).toBe(2);

      // The named-column half: identical text across the same ALTER, one row, one counter, two calls.
      expect(namedRows.length).toBe(1);
      expect(Number(namedRows[0].calls)).toBe(2);

      await query(`drop table ${table}`);

      // Every statement this test ran, not just the two selects: the `create temp table`, `insert`, `alter` and `drop`
      // are tracked too, and a test that leaves nine clutter rows behind teaches the next reader that probes are
      // permanent. The reset is surgical, so the shared window and every other statement's counter are untouched.
      // The drop comes first so its own row is inside the set being cleaned.
      const leftovers = await query(`select queryid, dbid, userid from pg_stat_statements where query like $1`, [like(`%${table}%`)]);
      for (const row of leftovers) await targetedReset(row);
      expect(await mine()).toHaveLength(0);
      expect(await query(`select queryid from pg_stat_statements where query like $1`, [like(`%${table}%`)])).toHaveLength(0);
    });

    it("keeps two generations of a statement whose text changed as two rows", async () => {
      // The counterpart of the `select *` split above, and the one that broke a baseline in another repository for
      // real: pi-ed `79b0202` added one column to the heartbeat sweep's select list, and the reader of that
      // statement's cost went from one row to five. The text change is a new statement to Postgres, so the old
      // generation keeps its counter and the new one starts at 1 - and a reader who does not know the column was
      // added sees the number fall, with nothing in their own diff to explain it.
      const table = `probe_sibling_${Date.now()}`;
      await query(`create temp table ${table} (agent_id text, repo text)`);
      const generation1 = `select agent_id, repo from ${table}`;
      const generation2 = `select agent_id, repo, (agent_id is null) as never_attempted from ${table}`;

      await query(generation1);
      await query(generation1);
      await query(generation2);

      const selects = await query(
        `select queryid::text as queryid, calls::int as calls, query from pg_stat_statements where query like $1 and query ilike $2`,
        [like(`%${table}%`), `select%agent_id%from%${like(table)}%`],
      );
      expect(selects).toHaveLength(2);
      const old1 = selects.find((row) => row.query === generation1);
      const old2 = selects.find((row) => row.query === generation2);
      expect(Number(old1!.calls)).toBe(2);
      expect(Number(old2!.calls)).toBe(1);
      expect(String(old1!.queryid)).not.toBe(String(old2!.queryid));
      // What the two rows share, and what they do not, is exactly why the sibling report needs both keys: the
      // relation clause is identical (so the clause key groups them), while the leading 40 characters already
      // differ at the comma (so a head-only key would have missed the re-baseline). home-ops' five rows shared
      // their first 70 characters only because their added column sat further down the list.
      const clause = (text: string) => text.slice(/\b(from|into|update|join|using)\b/i.exec(text)!.index);
      expect(clause(String(old2!.query))).toBe(clause(String(old1!.query)));
      expect(String(old2!.query).slice(0, 40)).not.toBe(String(old1!.query).slice(0, 40));

      // A third submission, differing only in an alias, does not add a generation: the alias is outside the hash
      // while the expression is inside it, which is the whole distinction in one pair of assertions. The pattern is
      // bound as a parameter here rather than interpolated, because the name inside the checking statement's own
      // text is what makes an absence check unable to report zero about itself - and this check would have counted
      // its own SQL as a third generation.
      await query(`select agent_id as zzz_sibling_alias, repo from ${table}`);
      const afterAlias = await query(
        `select queryid::text as queryid, calls::int as calls, query from pg_stat_statements where query like $1 and query ilike $2`,
        [like(`%${table}%`), `select%agent_id%from%${like(table)}%`],
      );
      expect(afterAlias).toHaveLength(2);
      expect(Number(afterAlias.find((row) => String(row.queryid) === String(old1!.queryid))!.calls)).toBe(3);

      const leftovers = await query(`select queryid, dbid, userid from pg_stat_statements where query like $1`, [like(`%${table}%`)]);
      for (const row of leftovers) await targetedReset(row);
      expect(await query(`select queryid from pg_stat_statements where query like $1`, [like(`%${table}%`)])).toHaveLength(0);
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

    it("cannot clean a probe by a queryid it rounded on the way in", async () => {
      // `queryid` is bigint, and this store's are around 1e19 - four orders of magnitude past 2^53, the largest integer
      // a JS number holds exactly. An id that passes through a number is a different id, and the failure is not an
      // error: the reset removes nothing, and every "assert absent by id" line then prints `absent` about an id that
      // never existed. Measured first by home-ops on this store (home-ops `0baf3ec`): -6049891011141795458 arrived as
      // -6049891011141796000, the probe rows sat there at 1 and 2 calls, and the cleanup reported itself clean.
      const rows = await probeRows();
      expect(rows.length).toBeGreaterThan(0);
      const target = rows[0];
      const asText = String(target.queryid);

      // The driver is the safe half: node-postgres hands `bigint` back as a string, so the corruption is what a reader
      // does with the id, not what the database sent.
      expect(typeof target.queryid, "the driver returns bigint as text; a number here is already the bug").toBe("string");
      expect(await query(`select queryid::text as t from pg_stat_statements where queryid = $1`, [asText])).toHaveLength(1);

      // The mistake, made on purpose.
      const rounded = Number(asText);
      expect(String(rounded)).not.toBe(asText);
      await targetedReset({ ...target, queryid: rounded });

      // The row survives, because the reset was aimed at an identity that does not exist.
      const survived = await query(`select calls from pg_stat_statements where queryid = $1`, [asText]);
      expect(survived, "a reset aimed at a rounded id must not remove the row it was aiming at").toHaveLength(1);

      // And this is the line that would have reported success: absence checked against the rounded id.
      const absentByCorruptedId = await query(`select queryid from pg_stat_statements where queryid = $1`, [String(rounded)]);
      expect(absentByCorruptedId, "absence by a rounded id is a check against an id that never existed").toHaveLength(0);

      // The check that cannot lie is the name scope: the probe is still in the store, and says so.
      const byName = await query(`select queryid from pg_stat_statements where query like $1`, [like(`%${PROBE}_%`)]);
      expect(byName.length, "the probe is still there - name scope is what reports it").toBeGreaterThan(0);
    });

    it("name-scopes a probe by an identifier, because the view replaces literal values with placeholders", async () => {
      // Measured while cleaning up after a demo: an insert whose agent id was a literal string left no trace findable
      // by that string, because the stored text is `values ($1, $2, now() - interval $3)`. The view normalises
      // *constants*, so a run name that lives in a value is invisible to `query like '%run-name%'` - and the counter
      // it lands on is the shared one for that shape, which belongs to every writer that uses it.
      //
      // Identifiers are different - but only partly. The relation name, the alias, and the prepared-statement label
      // all survive in the stored text, which is why the fence recipe and the cleanup recipe work off them. What
      // `test/statements-prepare.test.ts` measures is the limit: the identifier is in the row's *text* and not in its
      // *hash*, so a name finds only the row that first saw the shape, and a run that merged into an older row is
      // invisible to its own name.
      const stamp = Date.now();
      const marker = `stat_probe_literal_${stamp}`;
      const alias = `stat_probe_litalias_${stamp}`;
      await query(`select count(*)::int as ${alias}, '${marker}' as marker_value from pg_stat_statements`);

      // The name that was passed as a value: gone from the stored text.
      expect(await query(`select queryid from pg_stat_statements where query like $1`, [like(`%${marker}%`)]),
        "a literal run name is replaced by $n, so name scope cannot find it").toHaveLength(0);

      // The name that was an identifier: present, and therefore removable by this suite's own afterAll sweep.
      const found = await query(
        `select queryid::text as queryid, dbid::text as dbid, userid::text as userid from pg_stat_statements where query like $1`,
        [like(`%${alias}%`)],
      );
      expect(found, "an identifier in the statement text is what a name-scoped cleanup can actually see").toHaveLength(1);
    });

    it("loses a row without moving stats_reset, which is what a peer's cleanup looks like from the outside", async () => {
      // This file's README used to say that a tracked statement which disappeared had been evicted by the view. On
      // the numbers, that explanation does not hold: the view holds a few hundred rows against a `max` of 5000, and
      // there is a second, far more mundane way to lose a row on a shared store - another agent's name-scoped
      // cleanup, which calls the three-argument reset and, by design, leaves `stats_reset` exactly where it was.
      // Both agents in this fleet run such a cleanup, so a vanishing row is most likely a peer, not capacity.
      const before = await query(`select stats_reset from pg_stat_statements_info`);
      const occupancy = await query(`select count(*)::int as present from pg_stat_statements`);
      // `max` is a setting, not a column of the view; `select max from pg_stat_statements` fails with
      // errorMissingColumn, which is why this reads the GUC instead.
      const capacity = await query(`show pg_stat_statements.max`);
      const max = Number(Object.values(capacity[0])[0]);
      const present = Number(occupancy[0].present);
      expect(max, "this build exposes pg_stat_statements.max").toBeGreaterThan(0);
      expect(present, "the view is nowhere near capacity, so eviction is not the explanation on offer").toBeLessThan(max / 4);

      const bucket = `stat_probe_vanish_${Date.now()}`;
      await query(`create temp table ${bucket} (n int)`);
      await query(`insert into ${bucket} (n) values (1)`);
      await query(`select count(*)::int as n from ${bucket}`);
      const mine = await query(
        `select queryid::text as queryid, dbid::text as dbid, userid::text as userid, calls from pg_stat_statements where query like $1`,
        [like(`%${bucket}%`)],
      );
      expect(mine.length, "the probe's statements are tracked, DDL included").toBeGreaterThan(0);

      // The peer's action, performed by this file's own cleanup helper.
      //
      // The count is taken twice, and the reason is the same trap this file keeps documenting: the first read of
      // `select count(*)::int as present from pg_stat_statements` creates its own row in the view, so a "before"
      // taken early and an "after" taken late measure the probe's own statements as well as the removal. The two
      // reads here land on one row, so the delta is the removal.
      const immediatelyBefore = await query(`select count(*)::int as present from pg_stat_statements`);
      for (const row of mine) await targetedReset(row);

      const after = await query(`select stats_reset from pg_stat_statements_info`);
      expect(String(after[0].stats_reset), "a targeted reset leaves stats_reset exactly where it was").toBe(
        String(before[0].stats_reset),
      );
      expect(await query(`select queryid from pg_stat_statements where query like $1`, [like(`%${bucket}%`)]),
        "the rows are gone").toHaveLength(0);
      const shrunk = await query(`select count(*)::int as present from pg_stat_statements`);
      expect(Number(shrunk[0].present), "the view shrank, with no reset anywhere to explain it")
        .toBeLessThan(Number(immediatelyBefore[0].present));
      await query(`drop table if exists ${bucket}`);
    });
  });
