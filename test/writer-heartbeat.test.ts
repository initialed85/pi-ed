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

  it("lets an old refusal age out of the advisory set", async () => {
    const { heartbeatAdvisoryAlertStatement, heartbeatPageAlertStatement } = await loadModule();
    await query(`insert into writer_heartbeat (agent_id, repo, last_activity_at, last_flush_at, flushes, failures, last_error, last_error_at)
                 values ('heartbeat-probe-old-failure', 'pi-ed', now() - interval '10 minutes', now() - interval '10 minutes', 7, 3,
                          'connection to server failed', now() - interval '30 hours')`);
    const advisory = (await query(heartbeatAdvisoryAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(advisory).not.toContain("heartbeat-probe-old-failure");
    const page = (await query(heartbeatPageAlertStatement!().sql)).rows.map((r) => String(r.agent_id));
    expect(page).not.toContain("heartbeat-probe-old-failure");
  });
});
