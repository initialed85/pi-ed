import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const source = path.join(here, "..", "extensions", "memory.ts");
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
  beforeAll(async () => {
    const pg = (await import("pg")) as unknown as { Client: new (options: { connectionString: string }) => Client };
    client = new pg.Client({ connectionString: liveDsn });
    await client.connect();
    await query(`delete from writer_heartbeat where agent_id like 'heartbeat-probe%'`);
  });

  afterAll(async () => {
    if (client) {
      await query(`delete from writer_heartbeat where agent_id like 'heartbeat-probe%'`);
      await client.end();
      client = undefined;
    }
  });

  it("keeps a writer that arrived and never committed visible for hours", async () => {
    const { heartbeatActivityStatement, heartbeatPageAlertStatement, heartbeatAdvisoryAlertStatement } = await loadModule();
    const activity = heartbeatActivityStatement!("heartbeat-probe-live", "pi-ed");
    await query(activity.sql, activity.values);

    const row = (await query(`select * from writer_heartbeat where agent_id = 'heartbeat-probe-live'`)).rows[0];
    expect(row.agent_id).toBe("heartbeat-probe-live");
    expect(row.last_flush_at).toBeNull();
    expect(Number(row.flushes)).toBe(0);
    expect(Number(row.failures)).toBe(0);

    // A session that opened a minute ago and wrote nothing is not an incident yet, and an alert that says otherwise
    // is an alert nobody will read.
    const page = (await query(heartbeatPageAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(page).not.toContain("heartbeat-probe-live");

    // The same writer three hours later is exactly the `array_concat` class of bug: turns recorded, nothing committed.
    await query(`insert into writer_heartbeat (agent_id, repo, last_activity_at) values ('heartbeat-probe-stale', 'pi-ed', now() - interval '3 hours')`);
    const pageAfter = (await query(heartbeatPageAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(pageAfter).toContain("heartbeat-probe-stale");

    // And a writer that is simply idle is not the same shape at all. Both timestamps old, matching each other.
    await query(`insert into writer_heartbeat (agent_id, repo, last_activity_at, last_flush_at, flushes)
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

    const row = (await query(`select * from writer_heartbeat where agent_id = 'heartbeat-probe-live'`)).rows[0];
    expect(Number(row.failures)).toBe(1);
    expect(String(row.last_error)).toContain("array_concat");
    expect(Number(row.spool_rows)).toBe(12);
    // The column that means "committed" is the one column a refusal must not touch.
    expect(row.last_flush_at).toBeNull();

    const advisory = (await query(heartbeatAdvisoryAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(advisory).toContain("heartbeat-probe-live");
  });

  it("clears the backlog when a flush lands, and moves the commit watermark", async () => {
    const { heartbeatFlushStatement, heartbeatAdvisoryAlertStatement } = await loadModule();
    const flush = heartbeatFlushStatement!("heartbeat-probe-live", "pi-ed");
    await query(flush.sql, flush.values);

    const row = (await query(`select * from writer_heartbeat where agent_id = 'heartbeat-probe-live'`)).rows[0];
    expect(Number(row.flushes)).toBe(1);
    expect(row.last_flush_at).not.toBeNull();
    expect(Number(row.spool_rows)).toBe(0);

    // The failure stays on the record - it happened - but a stale stranded-rows alert is gone: spool_rows is the
    // backlog, and the backlog is now on disk only in the sense that it is in the store.
    const advisory = (await query(heartbeatAdvisoryAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(advisory).toContain("heartbeat-probe-live"); // failures > 0 within 24h: honest about the earlier refusal
    const stranded = (await query(`select agent_id from writer_heartbeat where spool_rows > 0`)).rows.map((r) => String(r.agent_id));
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

  it("lets an old refusal age out of the alert set but not out of the sweep", async () => {
    const { heartbeatAdvisoryAlertStatement, heartbeatPageAlertStatement, heartbeatSweepStatement } = await loadModule();
    await query(`insert into writer_heartbeat (agent_id, repo, last_activity_at, last_flush_at, flushes, failures, last_error, last_error_at)
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
    await query(`insert into writer_heartbeat (agent_id, repo, last_activity_at, last_flush_at, flushes, failures, spool_rows, last_error, last_error_at)
                 values ('heartbeat-probe-stranded', 'pi-ed', now() - interval '3 days', now() - interval '4 days', 9, 1, 7,
                          'connection to server failed', now() - interval '3 days')`);

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
    // Measured against the last commit: activity ran a full day ahead of it.
    expect(Number(found?.minutes_without_commit)).toBeGreaterThanOrEqual(1439);
  });
});
