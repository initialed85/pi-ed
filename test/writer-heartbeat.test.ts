import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanStatementTraces, preCleanOwnLitter, snapshotQueryIds } from "./statements-cleanup.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one test file that talks to the real store, and it does not unless told to.
 *
 * `PI_LIVE_DSN` is deliberately a different variable from `PI_MEMORY_DSN`: CI sets the latter to a closed port to
 * prove the failure paths, and this suite must stay silent there. Run it as
 *
 *   PI_LIVE_DSN="$DSN" npx vitest run test/writer-heartbeat.test.ts
 *
 * What it is for: the heartbeat table is only worth having because someone downstream is going to alert on two
 * queries, and a query nobody has run against rows that exist is a guess. Here the rows are fabricated to the exact
 * shapes - stale-without-a-commit, healthy, recently refused, refused long ago - and the exported statements decide
 * correctly about every one of them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "parked", "memory.ts");
const liveDsn = process.env.PI_LIVE_DSN ?? "";

// A computed import path keeps this file independent of how the extension is packaged; the values are asserted by
// shape at the point of use, which is also what a downstream consumer would have to do.
async function loadModule() {
  return import(source);
}

type Client = {
  connect: () => Promise<void>;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  end: () => Promise<void>;
};
let client: Client | undefined;

async function query(sql: string, values: unknown[] = []) {
  if (!client) throw new Error("no live connection");
  return client.query(sql, values);
}

const suite = liveDsn ? describe : describe.skip;

suite("the writer heartbeat, against the store someone would alert on", () => {
  // The gate for the afterAll cleanup: ids present before this suite ran anything. A row that carries the
  // `heartbeat-probe` name and predates the suite is not this suite's, and resetting it would delete another
  // writer's counter to remove one call of ours.
  let idsAtStart: Set<string>;

  beforeAll(async () => {
    const pg = (await import("pg")) as unknown as { Client: new (options: { connectionString: string }) => Client };
    client = new pg.Client({ connectionString: liveDsn });
    await client.connect();
    // Collect this file's own litter from a run that never reached its afterAll, before the gate is armed. The one
    // shared namespace risk here is a peer that also writes `heartbeat-probe`; home-ops' markers are `sweep_probe`
    // and `zz_homeops`, and a row whose text carries this name was submitted by a run that wrote it.
    await preCleanOwnLitter(client, "heartbeat-probe");
    idsAtStart = await snapshotQueryIds(client);
    await query(`delete from memory.writer_heartbeat where agent_id like 'heartbeat-probe%'`);
  });

  afterAll(async () => {
    if (client) {
      await query(`delete from memory.writer_heartbeat where agent_id like 'heartbeat-probe%'`);
      // The rows are this suite's to delete; the tracked statements are only partly its to remove. Everything it ran
      // against `memory.writer_heartbeat` carries a `heartbeat-probe` name in its text, so the view labels those rows
      // and they can be given back. The sweep SELECTs it ran name no probe, and their structures merge into rows
      // other writers have already counted - those are left alone, because resetting a merged row would erase another
      // writer's history with it (memory/README.md, "a statement that merged is not yours to remove").
      const traces = await cleanStatementTraces(client, "heartbeat-probe", idsAtStart);
      expect(traces.leftovers, "a statement this file named must not survive the file that ran it").toBe(0);
      expect(traces.refused, "a row this suite did not create is not its to remove").toBeGreaterThanOrEqual(0);
      await client.end();
      client = undefined;
    }
  });

  it("keeps a writer that arrived and never committed visible for hours", async () => {
    const { heartbeatActivityStatement, heartbeatPageAlertStatement, heartbeatAdvisoryAlertStatement } = await loadModule();
    const activity = heartbeatActivityStatement!("heartbeat-probe-live", "pi-ed");
    await query(activity.sql, activity.values);

    const row = (await query(`select * from memory.writer_heartbeat where agent_id = 'heartbeat-probe-live'`)).rows[0];
    expect(row.agent_id).toBe("heartbeat-probe-live");
    expect(row.last_flush_at).toBeNull();
    expect(Number(row.flushes)).toBe(0);
    expect(Number(row.failures)).toBe(0);

    // A session that opened a minute ago and wrote nothing is not an incident yet, and an alert that says otherwise
    // is an alert nobody will read.
    const page = (await query(heartbeatPageAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(page).not.toContain("heartbeat-probe-live");

    // The same writer three hours later is exactly the `array_concat` class of bug: turns recorded, nothing committed.
    await query(`insert into memory.writer_heartbeat (agent_id, repo, last_activity_at) values ('heartbeat-probe-stale', 'pi-ed', now() - interval '3 hours')`);
    const pageAfter = (await query(heartbeatPageAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(pageAfter).toContain("heartbeat-probe-stale");

    // And a writer that is simply idle is not the same shape at all. Both timestamps old, matching each other.
    await query(`insert into memory.writer_heartbeat (agent_id, repo, last_activity_at, last_flush_at, flushes)
                 values ('heartbeat-probe-idle', 'pi-ed', now() - interval '9 hours', now() - interval '9 hours', 4)`);
    const pageFinal = (await query(heartbeatPageAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(pageFinal).toContain("heartbeat-probe-stale");
    expect(pageFinal).not.toContain("heartbeat-probe-idle");

    expect((await query(heartbeatAdvisoryAlertStatement!().sql)).rows.map((r) => String(r.agent_id))).not.toContain("heartbeat-probe-stale");
  });

  it("reports a refused batch without claiming it committed", async () => {
    const { heartbeatFailureStatement, heartbeatAdvisoryAlertStatement } = await loadModule();
    const failure = heartbeatFailureStatement!("heartbeat-probe-live", "pi-ed", 'syntax error at or near "array_concat"', 12);
    await query(failure.sql, failure.values);

    const row = (await query(`select * from memory.writer_heartbeat where agent_id = 'heartbeat-probe-live'`)).rows[0];
    expect(Number(row.failures)).toBe(1);
    // Classified, then verbatim: the reader gets a kind, the diagnosis gets the original text.
    expect(String(row.last_error)).toContain("sql:");
    expect(String(row.last_error)).toContain("array_concat");
    expect(Number(row.spool_rows)).toBe(12);
    expect(row.spool_since).not.toBeNull();
    // The column that means "committed" is the one column a refusal must not touch.
    expect(row.last_flush_at).toBeNull();

    const advisory = (await query(heartbeatAdvisoryAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(advisory).toContain("heartbeat-probe-live");
  });

  it("clears the backlog when a flush lands, and moves the commit watermark", async () => {
    const { heartbeatFlushStatement, heartbeatAdvisoryAlertStatement } = await loadModule();
    const flush = heartbeatFlushStatement!("heartbeat-probe-live", "pi-ed");
    await query(flush.sql, flush.values);

    const row = (await query(`select * from memory.writer_heartbeat where agent_id = 'heartbeat-probe-live'`)).rows[0];
    expect(Number(row.flushes)).toBe(1);
    expect(row.last_flush_at).not.toBeNull();
    expect(Number(row.spool_rows)).toBe(0);
    // The backlog clock stops with the backlog. The next stranding measures from then, not from this event.
    expect(row.spool_since).toBeNull();

    // The failure stays on the record - it happened - but a stale stranded-rows alert is gone: spool_rows is the
    // backlog, and the backlog is now on disk only in the sense that it is in the store.
    const advisory = (await query(heartbeatAdvisoryAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(advisory).toContain("heartbeat-probe-live"); // failures > 0 within 24h: honest about the earlier refusal
    const stranded = (await query(`select agent_id from memory.writer_heartbeat where spool_rows > 0`)).rows.map((r) => String(r.agent_id));
    expect(stranded).not.toContain("heartbeat-probe-live");
  });

  it("gives a daily sweep one result set, page rows first", async () => {
    const { heartbeatSweepStatement } = await loadModule();
    const sweep = heartbeatSweepStatement!();
    expect(sweep.values).toEqual([]);
    // The severity column is the whole point of the sweep variant: one query, and the thing that should wake someone
    // is at the top of the output rather than in whichever query the operator remembered to run.
    expect(sweep.sql).toContain(`case when`);
    expect(sweep.sql).toContain(`then 'page' else 'note' end as severity`);
    // Postgres will accept an output column name as a bare `order by` key but not inside an expression, so the
    // severity column has to be a real column of an inner select before it can be sorted on.
    expect(sweep.sql).toContain(`) as flagged`);
    expect(sweep.sql).toContain(`order by (severity = 'page') desc`);
    expect(sweep.sql).toContain(`as minutes_without_commit`);
    // Cadence, not taste: a window narrower than the interval it is read at describes when you looked rather than
    // what happened. The sweep runs daily, so its failure window is two sweep intervals and its spool condition has
    // no recency guard at all - a stranded spool gets more interesting with age, not less.
    expect(sweep.sql).toContain(`interval '48 hours'`);
    expect(sweep.sql).toContain(`or (spool_rows > 0)`);
    expect(sweep.sql).not.toContain(`spool_rows > 0 and last_activity_at`);
    // A writer that has never committed has no last commit to measure against, so its number is measured from
    // arrival. Same meaning, different clock - the sweep has to say which one it used.
    expect(sweep.sql).toContain(`when last_flush_at is null then round(extract(epoch from (now() - last_activity_at))`);

    const rows = (await query(sweep.sql)).rows;
    const byId = new Map(rows.map((row) => [String(row.agent_id), row]));
    // From the earlier tests: heartbeat-probe-stale has been "active" for 3 hours with no commit, and
    // heartbeat-probe-live was refused 12 rows ago and then committed.
    const stale = byId.get("heartbeat-probe-stale");
    expect(stale?.severity).toBe("page");
    expect(Number(stale?.minutes_without_commit)).toBeGreaterThanOrEqual(179);
    const refused = byId.get("heartbeat-probe-live");
    expect(refused?.severity).toBe("note");
    expect(Number(refused?.failures)).toBe(1);
    expect(byId.has("heartbeat-probe-idle")).toBe(false);
    const firstPage = rows.findIndex((row) => String(row.severity) === "page");
    const lastNote = rows.map((row) => String(row.severity)).lastIndexOf("note");
    expect(firstPage).toBeLessThan(lastNote);
  });

  it("keeps the age of a backlog when the failure repeats", async () => {
    const { heartbeatFailureStatement } = await loadModule();
    // Same probe, second refusal, four days after the first one started stranding rows.
    await query(`update memory.writer_heartbeat set spool_since = now() - interval '4 days', spool_rows = 12 where agent_id = 'heartbeat-probe-live'`);
    const first = (await query(`select spool_since from memory.writer_heartbeat where agent_id = 'heartbeat-probe-live'`)).rows[0];
    const failure = heartbeatFailureStatement!("heartbeat-probe-live", "pi-ed", "dns: getaddrinfo ENOTFOUND memory.pi-ed.svc.cluster.local", 20);
    await query(failure.sql, failure.values);

    const after = (await query(`select * from memory.writer_heartbeat where agent_id = 'heartbeat-probe-live'`)).rows[0];
    expect(Number(after.spool_rows)).toBe(20);
    expect(Number(after.failures)).toBeGreaterThanOrEqual(2);
    expect(String(after.last_error)).toContain("dns:");
    // The clock did not move: the backlog is four days old, not a fresh discovery.
    expect(String(after.spool_since)).toBe(String(first.spool_since));
    const ageMinutes = (Date.now() - new Date(String(after.spool_since)).getTime()) / 60_000;
    expect(ageMinutes).toBeGreaterThan(5_700);
  });

  it("lets an old refusal age out of the alert set but not out of the sweep", async () => {
    const { heartbeatAdvisoryAlertStatement, heartbeatPageAlertStatement, heartbeatSweepStatement } = await loadModule();
    await query(`insert into memory.writer_heartbeat (agent_id, repo, last_activity_at, last_flush_at, flushes, failures, last_error, last_error_at)
                 values ('heartbeat-probe-old-failure', 'pi-ed', now() - interval '10 minutes', now() - interval '10 minutes', 7, 3,
                          'connection to server failed', now() - interval '30 hours')`);
    // A refusal 30 hours old is outside the 24 h window a near-real-time evaluator reads, and inside the 48 h window a
    // daily sweep reads. Both are correct for the cadence they serve.
    const advisory = (await query(heartbeatAdvisoryAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(advisory).not.toContain("heartbeat-probe-old-failure");
    const page = (await query(heartbeatPageAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(page).not.toContain("heartbeat-probe-old-failure");
    const swept = (await query(heartbeatSweepStatement!().sql)).rows;
    const found = swept.find((row) => String(row.agent_id) === "heartbeat-probe-old-failure");
    expect(found?.severity).toBe("note");
    expect(Number(found?.failures)).toBe(3);
  });

  it("keeps a spool that has been sitting for days on the sweep, where the alert set drops it", async () => {
    const { heartbeatAdvisoryAlertStatement, heartbeatPageAlertStatement, heartbeatSweepStatement } = await loadModule();
    // The laptop closed case: a writer spooled 7 rows three days ago, committed nothing since, and never came back.
    await query(`insert into memory.writer_heartbeat (agent_id, repo, last_activity_at, last_flush_at, flushes, failures, spool_rows, spool_since, last_error, last_error_at)
                 values ('heartbeat-probe-stranded', 'pi-ed', now() - interval '3 days', now() - interval '4 days', 9, 1, 7,
                          now() - interval '3 days', 'refused: connection to server failed', now() - interval '3 days')`);

    // The advisory half of the alert set misses it on both counts: the refusal is outside 24 h, and the stranded rows
    // are outside the 2 h activity guard. That is the combination a daily sweep exists to catch, which is why the
    // sweep's advisory windows are wider and its spool condition is unguarded.
    const advisory = (await query(heartbeatAdvisoryAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(advisory).not.toContain("heartbeat-probe-stranded");

    // The page half *does* see it, and that is the correct answer rather than a false positive. A healthy writer's
    // asymmetry is a few seconds - it flushes on a debounce measured in seconds - so a one day gap between its last
    // commit and its last turn cannot come from a session that ended cleanly. It came from turns that failed to
    // commit. The agent has been gone three days, so this is a late page rather than a wrong one, and the reader
    // tells them apart by `last_activity_at`.
    const page = (await query(heartbeatPageAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(page).toContain("heartbeat-probe-stranded");

    const swept = (await query(heartbeatSweepStatement!().sql)).rows;
    const found = swept.find((row) => String(row.agent_id) === "heartbeat-probe-stranded");
    expect(found?.severity).toBe("page");
    expect(Number(found?.spool_rows)).toBe(7);
    // The age of the condition comes out of the store rather than out of a report that has to remember seeing it
    // before: `spool_days` is measured from `spool_since`, which the writer started three days ago here.
    expect(Number(found?.spool_days)).toBeGreaterThanOrEqual(2.9);
    // Measured against the last commit: activity ran a full day ahead of it.
    expect(Number(found?.minutes_without_commit)).toBeGreaterThanOrEqual(1439);
  });

  it("separates a writer that never had anything accepted from one that is failing", async () => {
    const { heartbeatSweepStatement } = await loadModule();
    // The overnight case, in its purest form: a writer registered, was seen active five days ago, and has no commit,
    // no refusal and no spool. The store cannot tell "nothing worth recording happened" from "the writer never tried",
    // and today that ambiguity arrives in the page half.
    await query(`insert into memory.writer_heartbeat (agent_id, repo, last_activity_at) values ('heartbeat-probe-never', 'pi-ed', now() - interval '5 days')`);

    const swept = (await query(heartbeatSweepStatement!().sql)).rows;
    const byId = new Map(swept.map((row) => [String(row.agent_id), row]));

    // Never attempted. `severity` is deliberately NOT changed here: home-ops deduplicates on (agent_id, severity), so
    // narrowing `page` would silently re-classify history. The column is the new condition's name, and the reader
    // decides whether to birth a severity from it.
    const never = byId.get("heartbeat-probe-never");
    expect(never?.severity, "a writer that has been active for five days without committing is a page today").toBe("page");
    expect(never?.never_attempted).toBe(true);
    expect(Number(never?.flushes)).toBe(0);
    expect(Number(never?.failures)).toBe(0);
    expect(Number(never?.spool_rows)).toBe(0);
    // And its number is measured from arrival, which is why the column has to travel with it: 7,200 "minutes without
    // commit" here is "how long since we saw it", not "how long it has been failing".
    expect(Number(never?.minutes_without_commit)).toBeGreaterThan(7_000);

    // The three-hour version the earlier tests built, same reading.
    expect(byId.get("heartbeat-probe-stale")?.never_attempted).toBe(true);

    // Attempted, and provably so: a committed batch, a refusal, or a backlog each defeat the discriminator.
    expect(byId.get("heartbeat-probe-stranded")?.never_attempted).toBe(false);
    expect(byId.get("heartbeat-probe-old-failure")?.never_attempted).toBe(false);
    expect(byId.get("heartbeat-probe-live")?.never_attempted).toBe(false);

    // The column is not a filter: it does not drop anything from the sweep.
    expect(swept.length).toBeGreaterThanOrEqual(5);
  });

  it("names an identity-drift pair from the store instead of leaving it as an inference", async () => {
    const mod = await loadModule();
    const identityPairStatement = mod.identityPairStatement;
    const upsert = `on conflict (agent_id) do update set repo = excluded.repo, first_seen_at = excluded.first_seen_at,
                    last_activity_at = excluded.last_activity_at, last_flush_at = excluded.last_flush_at,
                    flushes = excluded.flushes`;

    // A checkout that changed identity leaves two ids carrying the *same* repo - `repo` travels on every heartbeat
    // row - one that stopped moving and one that started after it. home-ops' dedup key is (agent_id, severity), so
    // the store's job is to name the pair, because a report keyed on agent ids alone can only ever say "a new agent
    // appeared".
    await query(
      `insert into memory.writer_heartbeat (agent_id, repo, first_seen_at, last_activity_at, last_flush_at, flushes)
       values ('heartbeat-probe-old', 'probe-repo', now() - interval '5 days', now() - interval '3 days',
               now() - interval '3 days', 7),
              ('heartbeat-probe-new', 'probe-repo', now() - interval '1 hour', now(), now(), 2)`,
    ).catch(async () => {
      // Two rows in one statement, so the upsert variant is applied per row if either id already exists.
      for (const [id, repo, seen, moved] of [
        ["heartbeat-probe-old", "probe-repo", "5 days", "3 days"],
        ["heartbeat-probe-new", "probe-repo", "1 hour", "0 days"],
      ]) {
        await query(
          `insert into memory.writer_heartbeat (agent_id, repo, first_seen_at, last_activity_at, last_flush_at, flushes)
           values ($1, $2, now() - interval '${seen}', now() - interval '${moved}', now() - interval '${moved}', 2)
           ${upsert}`,
          [id, repo],
        );
      }
    });

    const rows = (await query(identityPairStatement!().sql)).rows;
    const pair = rows.find((row) => String(row.stalled_id) === "heartbeat-probe-old" && String(row.arriving_id) === "heartbeat-probe-new");
    expect(pair, "both ids are on one repo and the arrival postdates the stall, so this pair has to be named").toBeTruthy();
    expect(Number(pair!.stalled_minutes)).toBeGreaterThan(2 * 24 * 60);
    expect(Number(pair!.minutes_from_stall_to_arrival)).toBeGreaterThan(4000);
    expect(Number(pair!.stalled_flushes)).toBe(7);
    expect(Number(pair!.arriving_flushes)).toBe(2);

    // The two shapes that must *not* read as drift, fabricated next to the one that must.
    //
    // A flatmate: another agent working the same checkout, active now and arrived before the stalled id went quiet.
    // Two agents sharing a repository is ordinary here, and the arrival-postdates-the-stall rule is what separates it
    // from an agent that moved.
    await query(
      `insert into memory.writer_heartbeat (agent_id, repo, first_seen_at, last_activity_at, last_flush_at, flushes)
       values ('heartbeat-probe-flatmate', 'probe-repo', now() - interval '4 days', now() - interval '30 minutes',
               now() - interval '30 minutes', 3) ${upsert}`,
    );
    // A row that predates the `first_seen_at` column: its `first_seen_at` is the migration time, which is later than
    // its own last activity. Pairing from that would be pairing about an ALTER TABLE.
    await query(
      `insert into memory.writer_heartbeat (agent_id, repo, first_seen_at, last_activity_at, flushes)
       values ('heartbeat-probe-ancient', 'probe-repo', now(), now() - interval '10 days', 4) ${upsert}`,
    );

    const after = (await query(identityPairStatement!().sql)).rows.filter((row) => String(row.repo) === "probe-repo");
    expect(after.some((row) => String(row.arriving_id) === "heartbeat-probe-flatmate"), "an agent that overlaps the stalled one's window is a flatmate, not a successor").toBe(false);
    expect(after.some((row) => String(row.stalled_id) === "heartbeat-probe-ancient"), "a row whose first_seen_at postdates its own last_activity_at predates the column and is not evidence").toBe(false);
    // Four ids on one repo, and exactly one named pair. Which of them is *one agent* is membership knowledge the
    // store does not have, and home-ops' sweep carries that list externally - this query's job ends at the candidate.
    expect(after.map((row) => `${String(row.stalled_id)}>${String(row.arriving_id)}`)).toEqual(["heartbeat-probe-old>heartbeat-probe-new"]);
  });

  it("proves a reading comes from the right database before any count in it is believed", async () => {
    const mod = await loadModule();
    const sanity = (await query(mod.storeReadingSanityStatement!().sql)).rows[0];
    expect(String(sanity.database)).toBe("pi_ed");
    expect(sanity.memory_schema_present).toBe(true);
    expect(String(sanity.memory_schema_table)).toBe("memory");
    // A table named `memory` in `public` would mean the writer's unqualified names resolve somewhere other than the
    // schema the migrations created, which is the silent version of this whole check.
    expect(sanity.public_memory_table).toBeNull();
    const roleConfig = (sanity.role_config ?? []) as string[];
    expect(roleConfig.some((entry) => entry.includes("search_path")), "the role's search_path is what the writer's unqualified names depend on; an empty rolconfig is config drift, not a pass").toBe(true);

    // The negative case run for real, on the other database in the same pod, which has no `memory` schema. This is
    // what a sweep pointed at the wrong place looks like, and it looks like *this*, not like an empty result.
    const pg = (await import("pg")) as unknown as { Client: new (options: { connectionString: string }) => Client };
    const wrongDsn = new URL(liveDsn);
    wrongDsn.pathname = "/postgres";
    const other = new pg.Client({ connectionString: wrongDsn.toString() });
    await other.connect();
    try {
      const wrong = (await other.query(mod.storeReadingSanityStatement!().sql)).rows[0];
      expect(String(wrong.database)).toBe("postgres");
      expect(wrong.memory_schema_present).toBe(false);
      expect(wrong.memory_schema_table).toBeNull();
      expect(wrong.unqualified_memory_resolves_to).toBeNull();
      // And the counting statement fails loudly there rather than returning zero, which is the direction that keeps a
      // `0` meaning what a reader thinks it means.
      await expect(other.query(mod.storeShapeCountsStatement!().sql)).rejects.toThrow(/does not exist/);
    } finally {
      await other.end();
    }
  });
});
