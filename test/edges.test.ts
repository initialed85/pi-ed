/**
 * The edge layer: what the schema will accept, what the writer tries to write, and whether the two agree.
 *
 * Three separate jobs, in escalating order of what they need:
 *
 *   offline     the kind vocabulary in extensions/memory.ts and the CHECK constraint in the migration are the same
 *               set, and every edge statement targets `memory.edge` with the conflict clause that makes a re-run a
 *               no-op. A kind the code invents and the schema refuses is a failed flush; a statement missing the
 *               conflict clause is a backfill that doubles the table every time it runs.
 *   live SQL    each statement is executed against the real schema inside a transaction that is rolled back, so the
 *               typing, the constraint names and the joins are proved against the store rather than argued about.
 *   live wiring a dream written through the tool leaves edges behind, and the rows the test created are removed.
 *
 * Run the live half with:
 *   PI_LIVE_DSN="$DSN" npx vitest run test/edges.test.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DERIVATIONS, insertDerivation } from "../hack/backfill-edges.mjs";

const liveDsn = process.env.PI_LIVE_DSN ?? "";
const liveSuite = liveDsn ? describe : describe.skip;

const migration = readFileSync(fileURLToPath(new URL("../memory/schema/005_edges.sql", import.meta.url)), "utf8");
const source = readFileSync(fileURLToPath(new URL("../parked/memory.ts", import.meta.url)), "utf8");

const loadModule = async () => import("../parked/memory.ts");

/** The kinds the migration's CHECK enumerates, read out of the migration text. */
function kindsInSchema(): string[] {
  const match = migration.match(/kind in \(([^)]*)\)/);
  if (!match) throw new Error("no kind CHECK found in 005_edges.sql - the guard has nothing to compare against");
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe("the edge vocabulary", () => {
  it("keeps the writer's kinds and the schema's CHECK the same set", async () => {
    const mod = await loadModule();
    const fromCode = [...(mod.EDGE_KINDS as unknown as string[])].sort();
    // Written twice on purpose: one is what the store accepts, the other is what the code attempts. A kind that
    // exists in only one of them fails at the worst moment - mid-flush, on somebody else's pod.
    expect(fromCode).toEqual(kindsInSchema());
  });

  it("routes every edge statement through the qualified table and the conflict clause", async () => {
    const mod = await loadModule();
    // Viewed as a record rather than as the module namespace: the point of the test is to look each builder up by
    // name, and a namespace cannot be indexed by a string. The cast states the shape being looked for, so a renamed
    // or missing builder still fails the assertion rather than the compile.
    const statements = mod as unknown as Record<string, (...a: unknown[]) => { sql: string; values: unknown[] }>;
    const builders = [
      "memorySpanEdgesStatement",
      "dreamCallEdgeStatement",
      "subjectEdgesStatement",
      "messageEdgesStatement",
      "wakeEdgesStatement",
    ];
    const args: unknown[][] = [["uuid-ish"], ["uuid-ish"], ["uuid-ish"], ["session-id", ["entry-1"]], ["session-id", ["entry-1"]]];
    for (let i = 0; i < builders.length; i += 1) {
      const statement = statements[builders[i]](...args[i]);
      expect(statement.sql, builders[i]).toContain("insert into memory.edge");
      expect(statement.sql, builders[i]).toContain("on conflict on constraint edge_distinct do nothing");
      // An edge statement that cannot say who asserted it is untraceable, which is the whole point of the column.
      expect(statement.sql, builders[i]).toContain("asserted_by");
    }
  });

  it("writes edges where a failure cannot damage the record", () => {
    // The derived layer sits OUTSIDE the transaction that writes events. Read from the file rather than from a
    // database because this is a structural promise, and the failure it prevents - a graph fault spooling perfectly
    // good events - is not observable in a happy path.
    const commitAt = source.indexOf('await client.query("commit");');
    const edgeInFlush = source.indexOf("messageEdgesStatement(rowSession, entryIds)");
    expect(commitAt).toBeGreaterThan(-1);
    expect(edgeInFlush).toBeGreaterThan(commitAt);
    expect(source).toContain("events written, edges incomplete");
  });

  it("derives span membership from sequences, not from the gap between ids", () => {
    // The defect this table exists to fix, pinned as a test: `span_last_event - span_first_event` is a difference
    // between two global ids and counts other agents' rows. On the live store it read 2,851,945 memberships against
    // 32,097 real ones. A statement that subtracts the ids is the bug, not a cheaper way of writing the same thing.
    expect(source).toContain("e.seq between f.seq and l.seq");
    expect(source).not.toContain("span_last_event - span_first_event");
  });
});

liveSuite("edge statements against the live schema", () => {
  let client: import("pg").Client;

  beforeAll(async () => {
    const pg = await import("pg");
    client = new pg.Client({ connectionString: liveDsn });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it("re-derives exactly what the backfill derived, and writes nothing when rolled back", async () => {
    const mod = await loadModule();
    // Not simply the newest memory: the newest one in the store right now was written by this very session before
    // the edge wiring existed, so it legitimately has no edges. The test needs a memory that has some, and the
    // newest such one is the most likely to look like the ones the writer will produce next.
    const memory = (
      await client.query(`select m.id, m.session_id from memory.memory m
                          where exists (select 1 from memory.edge e where e.src_memory = m.id or e.dst_memory = m.id)
                          order by m.created_at desc limit 1`)
    ).rows[0];
    expect(memory, "the store has no memories to test against").toBeTruthy();

    const before = await client.query(
      `select kind, count(*)::int as n from memory.edge
       where src_memory = $1 or dst_memory = $1
       group by kind order by kind`,
      [memory.id],
    );
    const beforeCounts = Object.fromEntries(before.rows.map((r: { kind: string; n: number }) => [r.kind, r.n]));
    expect(Object.keys(beforeCounts).length, "this memory has no edges to re-derive").toBeGreaterThan(0);

    // `on conflict do nothing` reports the rows it actually inserted, so running the statements against a store that
    // already holds these edges proves nothing - every count would be zero. Removing the target's edges inside the
    // transaction, re-deriving them, and comparing against what was there is the test that matters: the writer's SQL
    // must reproduce the backfill's SQL, and the rollback means the store ends exactly where it began.
    await client.query("begin");
    await client.query("delete from memory.edge where src_memory = $1 or dst_memory = $1", [memory.id]);
    for (const statement of [
      mod.memorySpanEdgesStatement!(memory.id),
      mod.dreamCallEdgeStatement!(memory.id),
      mod.subjectEdgesStatement!(memory.id),
    ]) {
      await client.query(statement.sql, statement.values);
    }
    const after = await client.query(
      `select kind, count(*)::int as n from memory.edge
       where src_memory = $1 or dst_memory = $1
       group by kind order by kind`,
      [memory.id],
    );
    await client.query("rollback");

    const afterCounts = Object.fromEntries(after.rows.map((r: { kind: string; n: number }) => [r.kind, r.n]));

    // `memory_about` and `dreamed_from` are asserted equal because the rows they are derived from are fixed: a
    // memory's span and the call that produced it cannot change after the fact. `shares_subject` is only asserted
    // not to shrink, because subjects are matched against every memory in the store and the fleet keeps dreaming -
    // a memory written since the backfill can legitimately add one. Demanding exact equality there would be a test
    // that fails whenever the store is healthy.
    for (const kind of ["memory_about", "dreamed_from"]) {
      expect(afterCounts[kind] ?? 0, `${kind} re-derived differently from the backfill`).toBe(beforeCounts[kind] ?? 0);
    }
    expect((afterCounts.shares_subject ?? 0) >= (beforeCounts.shares_subject ?? 0), "re-derivation lost subject matches").toBe(true);

    const total = await client.query("select count(*)::int as n from memory.edge");
    expect(total.rows[0].n, "a rolled-back test wrote edges").toBe(await storedCount());
  });

  it("holds the invariants the backfill claims, counted a different way", async () => {
    const storedBefore = (await client.query(`select count(*)::int as n from memory.edge where kind = 'memory_about'`)).rows[0].n;
    // A correlated subquery per memory rather than the join the backfill used. Two shapes asking the same question,
    // so a wrong membership rule cannot agree with itself.
    const independent = await client.query(`
      select coalesce(sum((
        select count(*) from memory.event e
        where e.session_id = m.session_id
          and e.seq between (select seq from memory.event where id = m.span_first_event)
                        and (select seq from memory.event where id = m.span_last_event)
          and coalesce(e.meta ->> 'dream_turn', 'false') <> 'true'
      )), 0) as memberships
      from memory.memory m where m.span_first_event is not null`);
    const derived = Number(independent.rows[0].memberships);

    // Not `expect(stored).toBe(derived)`. The store is live: memories and events land continuously, so the stored
    // count is a snapshot of when the backfill last ran and the derived count is now. Equality would fail every day,
    // for reasons that say nothing about correctness - which is how the assertion failed the first time it ran.
    // What is worth asserting is that the reconciler closes the gap, so the derivation is run for real inside a
    // transaction that is then thrown away.
    await client.query("begin");
    const span = DERIVATIONS.find((d) => d.kind === "memory_about");
    if (!span) throw new Error("the backfill no longer derives memory_about");
    await insertDerivation(client, span);
    const storedAfter = (await client.query(`select count(*)::int as n from memory.edge where kind = 'memory_about'`)).rows[0].n;
    await client.query("rollback");

    expect(storedAfter, "re-running the derivation did not reach what the rules derive").toBe(derived);
    expect(storedAfter).toBeGreaterThanOrEqual(storedBefore);

    const restored = (await client.query(`select count(*)::int as n from memory.edge where kind = 'memory_about'`)).rows[0].n;
    expect(restored, "a rolled-back reconciler run left edges behind").toBe(storedBefore);

    const strays = await client.query(`
      select count(*)::int as n from memory.edge e
      join memory.memory m on m.id = e.src_memory
      join memory.event ev on ev.id = e.dst_event
      where e.kind = 'memory_about' and ev.session_id <> m.session_id`);
    expect(strays.rows[0].n, "span edges leaving their own session").toBe(0);

    const self = await client.query(`
      select count(*)::int as n from memory.edge
      where (src_memory is not null and dst_memory is not null and src_memory = dst_memory)
         or (src_event is not null and dst_event is not null and src_event = dst_event)`);
    expect(self.rows[0].n).toBe(0);
  });

  it("links a message to the peer it reached, including rows written before edges existed", async () => {
    // The counts are cast because an uncast Postgres `count` is a bigint, which the driver hands back as a string,
    // and `toBeGreaterThan` on a string is a test that fails for the wrong reason.
    const r = await client.query(`
      select count(*)::int as n,
             count(*) filter (where meta ->> 'evidence' = 'arrival_text')::int as by_arrival
      from memory.edge where kind like 'room_%'`);
    expect(r.rows[0].n).toBeGreaterThan(0);
    // The arrival-text derivation is the one that works on old rows, which is what makes the graph worth having on
    // the day it is created rather than a few weeks later.
    expect(r.rows[0].by_arrival, "no room edge was derived from an arrival").toBeGreaterThan(0);
  });
});

async function storedCount(): Promise<number> {
  const pg = await import("pg");
  const c = new pg.Client({ connectionString: liveDsn });
  await c.connect();
  const r = await c.query("select count(*)::int as n from memory.edge");
  await c.end();
  return r.rows[0].n;
}
