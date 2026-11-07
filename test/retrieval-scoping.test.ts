import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext, callTool } from "./harness.ts";

/**
 * Retrieval *scope*, against the real store.
 *
 * The crossover finding - a teammate memory has to be about 1.54x closer to outrank your own - answers "is this
 * memory good enough". This file answers the question home-ops pointed at next to it: **is this the right agent's
 * memory at all**. That one is the failure class where the store looks perfectly healthy while an agent is handed
 * somebody else's recollection, because "rows came back" reads like retrieval working.
 *
 * Two shapes produce it, and they need different responses:
 *
 *   1. the agent's own rows exist and are simply not near the query, so a nearer teammate row fills the window; and
 *   2. the agent's own rows exist *under a different id*, because identity drifted (a session renamed, a checkout
 *      moved, a different host - `agentIdentity` falls back to `host:directory` when there is no session name).
 *
 * Shape 2 is a scoping bug and shape 1 is a quality question, and the live suite asserts both rather than
 * describing them. Run it as:
 *
 *   PI_LIVE_DSN="$DSN" npx vitest run test/retrieval-scoping.test.ts
 *
 * Vectors here are fabricated rather than embedded on purpose: the point being tested is which rows come back and
 * whose they are labelled, which does not depend on a model, and a test that needs the embedder fails for a reason
 * unrelated to retrieval scope.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "extensions", "memory.ts");
const liveDsn = process.env.PI_LIVE_DSN ?? "";

const DIMENSIONS = 768;
const PROBE = "scoping-probe";

type Client = {
  connect: () => Promise<void>;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  end: () => Promise<void>
};
let client: Client | undefined;

async function query(sql: string, values: unknown[] = []) {
  if (!client) throw new Error("no live connection");
  return client.query(sql, values);
}

/** A unit vector in dimension `axis`, and a vector pulled mostly towards axis 0 with `tilt` of another dimension. */
function basis(axis: number): number[] {
  const vector = new Array(DIMENSIONS).fill(0);
  vector[axis] = 1;
  return vector;
}

function near(axis: number, tilt: number): number[] {
  const vector = basis(0);
  vector[axis] = tilt;
  return vector;
}

function literal(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function plant(agentId: string, summary: string, vector: number[] | null): Promise<void> {
  await query(
    `insert into agent (id, name, notes) values ($1, $1, '{"probe": true}'::jsonb)
     on conflict (id) do update set notes = excluded.notes`,
    [agentId],
  );
  await query(
    `insert into session (id, agent_id, source, started_at, last_activity_at)
     values ($2, $1, 'probe', now(), now())
     on conflict (id) do update set last_activity_at = now()`,
    [agentId, `${agentId}-session`],
  );
  await query(
    `insert into memory (agent_id, session_id, trigger, summary, subjects, feel, embedding, embedding_model, embedding_dim)
     values ($1, $2, 'manual', $3, array['scoping', 'probe'], 'deliberate', $4::vector, 'fabricated-for-test', $5::int)`,
    [agentId, `${agentId}-session`, summary, vector === null ? null : literal(vector), vector === null ? null : DIMENSIONS],
  );
}

async function ownCount(agentId: string): Promise<number> {
  const mod = await import(source);
  const statement = mod.ownRowCountStatement!(agentId);
  return Number((await query(statement.sql, statement.values)).rows[0]?.own ?? 0);
}

const suite = liveDsn ? describe : describe.skip;

suite("retrieval scope, against the store", () => {
  beforeAll(async () => {
    const pg = (await import("pg")) as unknown as { Client: new (options: { connectionString: string }) => Client };
    client = new pg.Client({ connectionString: liveDsn });
    await client.connect();
    await clean();
  });

  afterAll(async () => {
    await clean();
    if (client) {
      await client.end();
      client = undefined;
    }
  });

  async function clean(): Promise<void> {
    if (!client) return;
    // The same discipline as the heartbeat probes: whatever a test invents, the test removes, and everything it
    // invents carries a name that makes a leftover findable in one query.
    await query(`delete from memory where agent_id like $1`, [`${PROBE}%`]);
    await query(`delete from session where agent_id like $1`, [`${PROBE}%`]);
    await query(`delete from agent where id like $1`, [`${PROBE}%`]);
  }

  it("shows what an identity change does to a store that is not broken in any way", async () => {
    const mod = await import(source);
    // The rows belong to the agent as it was when they were written. The search runs as the agent as it is now.
    await plant(`${PROBE}-owner`, "the scoping probe alpha memory, written under the id this agent used then", basis(5));

    const statement = mod.vectorSearch!(`${PROBE}-stray`, basis(5), { limit: 5 });
    const rows = (await query(statement.sql, statement.values)).rows;

    // Exactly one row, and the store's own `mine` flag says it is not the searcher's - which is the correct answer to
    // a correct query. Nothing is broken: the vector matched perfectly, the row is labelled with the id that wrote
    // it, and the searcher has nothing of its own to find.
    expect(rows.length).toBe(1);
    expect(rows[0]!.mine).toBe(false);
    expect(String(rows[0]!.agent_id)).toBe(`${PROBE}-owner`);
    expect(Number(rows[0]!.similarity)).toBeGreaterThan(0.99);
    expect(Number(rows[0]!.weight)).toBe(0.65);

    // The pair a reader needs to tell identity drift from a missing memory, and the pair the tool's coverage note is
    // built from: rows exist for the old id, none exist for the current one.
    expect(await ownCount(`${PROBE}-stray`)).toBe(0);
    expect(await ownCount(`${PROBE}-owner`)).toBe(1);
  });

  it("can return a teammate row while the agent's own row sits outside the candidate window", async () => {
    const mod = await import(source);
    const ownAgent = `${PROBE}-own`;
    // One own row, orthogonal to the query. Six teammate rows, all nearer it. hnsw takes `limit * 5` neighbours
    // before the weighting is applied, so with limit 1 the window is five rows wide and the own row cannot enter it.
    await plant(ownAgent, "the scoping probe beta memory, this agent's own and further away than the rest", basis(1));
    for (let index = 0; index < 6; index += 1) {
      await plant(`${PROBE}-near-${index}`, `the scoping probe alpha neighbour ${index}`, near(2, 0.2 + index * 0.05));
    }

    const statement = mod.vectorSearch!(ownAgent, basis(0), { limit: 1 });
    const rows = (await query(statement.sql, statement.values)).rows;

    expect(rows.length).toBe(1);
    expect(rows[0]!.mine, "the own row is orthogonal to the query and the window is five wide, so it should be crowded out").toBe(false);
    expect(String(rows[0]!.agent_id)).toContain(`${PROBE}-near`);
    // The store is healthy and the agent has a memory. Both facts are true and neither is visible in the row that
    // came back, which is why the tool asks for the count rather than trusting the ranking.
    expect(await ownCount(ownAgent)).toBe(1);
  });

  it("makes a memory written without a vector visible as a number", async () => {
    const mod = await import(source);
    const scoped = () => {
      const statement = mod.vectorCoverageStatement!({ agentLike: `${PROBE}%` });
      return query(statement.sql, statement.values).then((result) => result.rows[0] ?? {});
    };
    const before = await scoped();
    // null on purpose: `embedding` is nullable in 001_init.sql, which is what a failed embedder leaves behind, and an
    // empty vector literal would be a malformed-vector error instead of the shape being tested.
    await plant(`${PROBE}-unembedded`, "the scoping probe gamma memory, written while the embedder was unavailable", null);
    const after = await scoped();

    // A dream written during an embedder outage is not corruption and is not backfilled either: the row is findable
    // by text forever after and by meaning never. The only way that is visible is a count, which is why the exported
    // statement exists and why it is a count rather than a heartbeat severity.
    expect(Number(after.memories) - Number(before.memories)).toBe(1);
    expect(Number(after.without_vector) - Number(before.without_vector)).toBe(1);
    expect(Number(after.without_vector_24h)).toBe(1);
    // The rest of this file's probes all carry vectors, so the scoped store shows exactly one vectorless row and a
    // reader can tell "one checkout is failing" from "embeddings are off here".
    expect(Number(after.without_vector)).toBe(1);
  });

  it("tells the agent which kind of absence it is looking at", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-ed-retrieval-config-"));
    const spool = path.join(dir, "spool.jsonl");
    // Embeddings off: this test is about which rows come back and what the tool says about them, and the text recall
    // path answers the same question without making the suite depend on a model service.
    const config = path.join(dir, "memory.json");
    writeFileSync(config, JSON.stringify({ embeddings: false, dreams: false }));

    process.env.PI_MEMORY_DSN = liveDsn;
    process.env.PI_MEMORY_CONFIG = config;
    process.env.PI_MEMORY_SPOOL = spool;
    delete process.env.PI_MEMORY_DISABLED;
    vi.resetModules();
    const mod = await import(source);
    const pi = createFakePi();
    mod.default(pi as any);

    // Shape 2, through the tool: this agent id has nothing, and the row that comes back belongs to somebody else.
    const { context: stray } = createContext({ sessionName: `${PROBE}-stray`, sessionId: `${PROBE}-stray-session`, cwd: "/workspace/pi-ed" });
    const strayResult = await callTool(pi, "memory_search", { query: "scoping probe alpha" }, stray);
    const strayText = String(strayResult.content[0]?.text ?? "");
    // The row that came back is named, and named with the id that wrote it - which is what makes the note above
    // checkable instead of a vague warning.
    expect(Number(strayResult.details?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(strayText).toContain(`${PROBE}-owner`);
    expect(strayText).toContain(`no memories in the store under the id "${PROBE}-stray"`);
    expect(strayText).toContain("belongs to another id");
    expect(strayText).toContain("host:directory");
    expect(strayResult.details?.ownReturned).toBe(0);

    // Shape 1, through the tool: this agent id has a memory, and the query found nothing near enough to report it.
    const { context: own } = createContext({ sessionName: `${PROBE}-own`, sessionId: `${PROBE}-own-session`, cwd: "/workspace/pi-ed" });
    const ownResult = await callTool(pi, "memory_search", { query: "an unrelated question about kubernetes rollouts" }, own);
    const ownText = String(ownResult.content[0]?.text ?? "");
    expect(ownText).toContain("1 memory in the store and none of them came back");
    expect(ownText).toContain("Nothing matched for anyone");
    expect(ownResult.details?.ownReturned).toBe(0);
    // The distinction the whole section exists for: two different notes for two different problems, chosen by the
    // store's own counts rather than by how the result looked.
    expect(ownText).not.toContain("no memories in the store under the id");
    expect(strayText).not.toContain("none of them came back for this query");

    delete process.env.PI_MEMORY_DSN;
    delete process.env.PI_MEMORY_CONFIG;
    delete process.env.PI_MEMORY_SPOOL;
  });
});
