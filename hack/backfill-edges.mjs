#!/usr/bin/env node
// Derive every edge kind from what the store already holds.
//
// Retro-processing, not new instrumentation: every kind here is built from rows that were written before the edge
// table existed, which is what makes the graph worth having on day one rather than in six weeks. Run it once, run it
// twice, run it after a restore - `edge_distinct` (unique ... nulls not distinct) means a re-run proves the first run
// happened instead of growing the table.
//
//   node hack/backfill-edges.mjs            # count what each derivation would create, write nothing
//   node hack/backfill-edges.mjs --apply    # write it
//   node hack/backfill-edges.mjs --check    # verify what is stored, with checks written differently from the writes
//
// The rule carried over from hack/repair-dream-tags.mjs: the query that measures a derivation and the query that
// performs it are the SAME text. A dry run written separately is a second opinion you have to audit as well.
//
//   export PI_MEMORY_DSN=$(kubectl --context home-dev -n slopyphus get cm config -o jsonpath='{.data.PI_MEMORY_DSN}')

import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const CHECK = process.argv.includes("--check");

/** One derivation per kind. Each returns the columns `memory.edge` needs, in the same order. */
export const DERIVATIONS = [
  {
    kind: "memory_about",
    note: "every event inside a memory's span, in its own session, dream residue excluded",
    select: `
      select m.agent_id as asserted_by,
             m.created_at as "at",
             null as src_event,
             e.id as dst_event,
             m.id as src_memory,
             null as dst_memory,
             null as src_agent,
             null as dst_agent,
             null as weight,
             jsonb_build_object('seq_from', f.seq, 'seq_to', l.seq) as meta
      from memory.memory m
      join memory.event f on f.id = m.span_first_event
      join memory.event l on l.id = m.span_last_event
      join memory.event e on e.session_id = m.session_id and e.seq between f.seq and l.seq
      where m.span_first_event is not null
        and m.span_last_event is not null
        -- The bounds are ids; membership is sequences. Reading the id range instead counts every other agent's rows
        -- that happen to fall between them, which on this store inflated 32,097 real memberships to 2,851,945.
        and coalesce(e.meta ->> 'dream_turn', 'false') <> 'true'`,
  },
  {
    kind: "dreamed_from",
    note: "the memory_dream tool_call that produced a memory, matched on the summary it asked for",
    select: `
      select m.agent_id as asserted_by,
             m.created_at as "at",
             null as src_event,
             c.id as dst_event,
             m.id as src_memory,
             null as dst_memory,
             null as src_agent,
             null as dst_agent,
             null as weight,
             jsonb_build_object('matched_on', 'summary', 'trigger', m.trigger) as meta
      from memory.memory m
      join memory.event c
        on c.kind = 'tool_call' and c.tool_name = 'memory_dream'
       and c.session_id = m.session_id
       and c.meta -> 'input' ->> 'summary' = m.summary
      -- A dream retried after a store fault leaves two calls with the same summary and one memory. The memory is not
      -- the child of each attempt, but it is honestly traceable to any of them, so keep both and say which matched.
      where c.id is not null`,
  },
  {
    kind: "shares_subject",
    note: "memories that use the same canonical subject label, across agents and within one agent's own history",
    select: `
      with labelled as (
        select m.id, m.agent_id, m.created_at,
               coalesce(
                 (select sm.canonical from memory.subject_merge sm where sm.label = s.subject order by sm.applied_at desc limit 1),
                 s.subject
               ) as subject
        from memory.memory m
        cross join lateral unnest(m.subjects) as s (subject)
      ),
      pairs as (
        select a.id as a_id, a.agent_id as a_agent, a.created_at as a_at, b.id as b_id,
               count(*) as shared,
               array_agg(a.subject order by a.subject) as subjects
        from labelled a
        join labelled b on a.subject = b.subject and a.id < b.id
        group by 1, 2, 3, 4
      )
      select p.a_agent as asserted_by,
             p.a_at as "at",
             null as src_event,
             null as dst_event,
             p.a_id as src_memory,
             p.b_id as dst_memory,
             null as src_agent,
             null as dst_agent,
             p.shared as weight,
             jsonb_build_object('subjects', p.subjects, 'same_agent', a.agent_id = b.agent_id) as meta
      from pairs p
      join memory.memory a on a.id = p.a_id
      join memory.memory b on b.id = p.b_id`,
  },
  {
    kind: "room",
    note: "team-room messages aimed at somebody: reply, ask, delegate, and update-with-a-named-recipient",
    select: `
      with room as (
        select e.id, e.agent_id, e."at", e.meta -> 'input' as input,
               e.meta -> 'input' ->> 'action' as action
        from memory.event e
        where e.kind = 'tool_call' and e.tool_name = 'team_room'
          and e.meta -> 'input' ->> 'action' in ('reply', 'ask', 'delegate', 'update')
      ),
      named as (
        select r.*,
               nullif(r.input ->> 'agent', '') as meta_agent,
               case when coalesce(r.input ->> 'text', '') ~ '^@'
                    then split_part(regexp_replace(r.input ->> 'text', '^@', ''), ' ', 1)
               end as mention,
               -- A delivered message lands in the recipient's session as a wake marker holding the message verbatim,
               -- so a message can be traced to its arrival without the sender having recorded who it was aimed at.
               -- This is the derivation that works on OLD rows, which is the point of it: 125 of 232 traceable this
               -- way, against 33 that named a target in metadata.
               (select w.agent_id from memory.event w
                 where w.tool_name = 'pi-team-room-wake' and w.agent_id <> r.agent_id
                   and length(coalesce(r.input ->> 'text', '')) > 40
                   and position(left(r.input ->> 'text', 120) in w."text") > 0
                 order by w."at" limit 1) as arrival_agent,
               (select w.id from memory.event w
                 where w.tool_name = 'pi-team-room-wake' and w.agent_id <> r.agent_id
                   and length(coalesce(r.input ->> 'text', '')) > 40
                   and position(left(r.input ->> 'text', 120) in w."text") > 0
                 order by w."at" limit 1) as arrival_event
        from room r
      )
      select n.action as action,
             n.agent_id as asserted_by,
             n."at" as "at",
             n.id as src_event,
             n.arrival_event as dst_event,
             null as src_memory,
             null as dst_memory,
             null as src_agent,
             coalesce(n.meta_agent, n.arrival_agent, n.mention) as dst_agent,
             null as weight,
             jsonb_build_object(
               'action', n.action,
               'target', n.input ->> 'target',
               'messageId', n.input ->> 'messageId',
               'evidence', case
                 when n.meta_agent is not null then 'metadata'
                 when n.arrival_agent is not null then 'arrival_text'
                 when n.mention is not null then 'mention'
               end
             ) as meta
      from named n
      where coalesce(n.meta_agent, n.arrival_agent, n.mention) is not null`,
  },
  {
    kind: "wakes",
    note: "who delivered a wake: parsed from the wake marker's own text, which names the sender",
    select: `
      with parsed as (
        select e.id, e.agent_id, e."at",
               coalesce(
                 (regexp_match(e."text", '\\n\\s*([a-z][a-z0-9-]+):'))[1],
                 (regexp_match(e."text", 'delegation from ([a-z][a-z0-9-]+)'))[1]
               ) as sender
        from memory.event e
        where e.tool_name = 'pi-team-room-wake'
      )
      select p.agent_id as asserted_by,
             p."at" as "at",
             p.id as src_event,
             null as dst_event,
             null as src_memory,
             null as dst_memory,
             null as src_agent,
             p.sender as dst_agent,
             null as weight,
             jsonb_build_object('parsed_from', 'wake_text') as meta
      from parsed p
      -- A name that matches no agent in the store is a parsing artefact, not a relationship: 145 wake rows, 134 with
      -- a sender-prefixed line and 12 in the delegation form, and every name recovered (camry, home-ops,
      -- macgrubernetes, ocr, pi-ed, slopyphus) is a real one. Requiring the match keeps a bad regex out of the graph.
      where p.sender is not null and exists (select 1 from memory.agent a where a.id = p.sender)`,
  },
];

const COLUMNS = `asserted_by, "at", src_event, dst_event, src_memory, dst_memory, src_agent, dst_agent, weight, meta`;

// Cast on the way in, per column. A bare `null as src_event` in a derivation comes out of Postgres as text, and the
// insert then refuses a perfectly good row with "column src_event is of type bigint but expression is of type text".
// Naming the type here also means a derivation cannot quietly start producing a string where an id should be.
const TYPED_SELECT = [
  ["asserted_by", "text"],
  ['"at"', "timestamptz"],
  ["src_event", "bigint"],
  ["dst_event", "bigint"],
  ["src_memory", "uuid"],
  ["dst_memory", "uuid"],
  ["src_agent", "text"],
  ["dst_agent", "text"],
  ["weight", "numeric"],
  ["meta", "jsonb"],
];
const SELECT_LIST = TYPED_SELECT.map(([column, type]) => `derived.${column}::${type}`).join(", ");

async function countOf(client, select) {
  const r = await client.query(`select count(*)::int as n from (${select}) derived`);
  return r.rows[0].n;
}

/**
 * Write one derivation.
 *
 * The room derivation emits four kinds in one statement because `'room_' || action` is exactly the kind vocabulary the
 * table's CHECK accepts. Writing it as four CASE ladders would be four chances to disagree with the constraint.
 */
async function insertOf(client, select, kindExpression) {
  const r = await client.query(
    `insert into memory.edge (kind, ${COLUMNS})
     select ${kindExpression}, ${SELECT_LIST}
     from (${select}) derived
     on conflict on constraint edge_distinct do nothing
     returning id`,
  );
  return r.rowCount;
}

/**
 * The kind a derivation writes, in the form the table's CHECK accepts.
 *
 * The room derivation emits four kinds from one statement because `'room_' || action` is exactly the vocabulary the
 * constraint lists; writing it as four CASE ladders would be four chances to disagree with it.
 */
export function kindExpressionFor(derivation) {
  return derivation.kind === "room" ? "'room_' || derived.action" : `'${derivation.kind}'`;
}

/**
 * Write one derivation through the shipped insert path.
 *
 * Exported so `test/edges.test.ts` can run the reconciler against a transaction it then throws away. A test that
 * retyped the INSERT would be proving its own transcription.
 */
export async function insertDerivation(client, derivation) {
  return insertOf(client, derivation.select, kindExpressionFor(derivation));
}

/**
 * Count what each rule derives, optionally write it, or audit what is already stored.
 *
 * Exported as a function rather than run at import: `test/edges.test.ts` reads `DERIVATIONS` to prove that re-running
 * the rules closes the gap between what is stored and what they derive, and a module that opens a pool the moment it
 * is imported is a script pretending to be a library.
 */
export async function run() {
const pool = new pg.Pool({ connectionString: process.env.PI_MEMORY_DSN, max: 2 });
const client = await pool.connect();

try {
  if (CHECK) {
    console.log(`edge table: ${(await client.query("select count(*)::int as n from memory.edge")).rows[0].n} rows`);
    const byKind = await client.query("select kind, count(*)::int as n from memory.edge group by 1 order by kind");
    for (const r of byKind.rows) console.log(`  ${r.kind.padEnd(16)} ${String(r.n).padStart(6)}`);

    // An independently written count of span membership: a correlated subquery per memory rather than the join the
    // backfill used. Two shapes of the same question, so a wrong membership rule cannot agree with itself.
    const independent = await client.query(`
      select coalesce(sum((
        select count(*)
        from memory.event e
        where e.session_id = m.session_id
          and e.seq between (select seq from memory.event where id = m.span_first_event)
                        and (select seq from memory.event where id = m.span_last_event)
          and coalesce(e.meta ->> 'dream_turn', 'false') <> 'true'
      )), 0) as memberships
      from memory.memory m where m.span_first_event is not null`);
    const stored = await client.query(`select count(*)::int as n from memory.edge where kind = 'memory_about'`);
    const agree = Number(independent.rows[0].memberships) === stored.rows[0].n;
    console.log(`\nmemory_about cross-check: stored ${stored.rows[0].n}, counted independently ${independent.rows[0].memberships} -> ${agree ? "agree" : "DISAGREE"}`);

    // Every span edge must sit in the memory's own session. This is the defect the table exists to fix, so it is
    // worth asserting directly rather than trusting the derivation that avoided it.
    const strays = await client.query(`
      select count(*) as n from memory.edge e
      join memory.memory m on m.id = e.src_memory
      join memory.event ev on ev.id = e.dst_event
      where e.kind = 'memory_about' and ev.session_id <> m.session_id`);
    console.log(`span edges pointing outside their own memory's session: ${strays.rows[0].n}`);

    const badShape = await client.query(`
      select count(*) as n from memory.edge e join memory.event ev on ev.id = e.src_event
      where e.kind in ('room_reply','room_ask','room_delegate','room_update','wakes')
        and ev.kind <> 'tool_call' and ev.tool_name <> 'pi-team-room-wake'`);
    console.log(`room/wake edges whose source row is not a room message or a wake: ${badShape.rows[0].n}`);

    const orphans = await client.query(`
      select count(*) as n from memory.edge where dst_agent is not null
        and dst_agent not in (select id from memory.agent)`);
    console.log(`edges aimed at a name no agent has registered (legal, but worth counting): ${orphans.rows[0].n}`);

    const degenerate = await client.query(`
      select count(*) as n from memory.edge
      where (src_event is not null and dst_event is not null and src_event = dst_event)
         or (src_memory is not null and dst_memory is not null and src_memory = dst_memory)`);
    console.log(`self-edges: ${degenerate.rows[0].n}`);
    process.exitCode = agree ? 0 : 1;
  } else {
    console.log(APPLY ? "applying backfill" : "dry run: counting what each derivation would create, writing nothing");
    let total = 0;
    for (const d of DERIVATIONS) {
      const kindExpression = kindExpressionFor(d);
      const would = await countOf(client, d.select);
      total += would;
      // The per-action breakdown is printed for the room derivation because "125 rows" hides that updates contribute
      // none of them, which is a fact about the room rather than about this script.
      const split = d.kind === "room"
        ? (await client.query(`select derived.action, count(*)::int as n from (${d.select}) derived group by 1 order by n desc`, )).rows.map((r) => `${r.action}=${r.n}`).join(" ")
        : "";
      const written = APPLY ? await insertDerivation(client, d) : 0;
      console.log(`  ${d.kind.padEnd(16)} ${String(would).padStart(6)} rows${APPLY ? `  inserted ${written}` : ""}   ${split || d.note}`);
      if (APPLY && written !== would) console.log(`    note: ${would - written} already present, so this derivation has run before`);
    }
    if (APPLY) {
      const after = await client.query("select kind, count(*)::int as n from memory.edge group by 1 order by kind");
      console.log("\nstored per kind:");
      for (const r of after.rows) console.log(`  ${r.kind.padEnd(16)} ${String(r.n).padStart(6)}`);
      console.log(`total derived: ${total}`);
    }
  }
} finally {
  client.release();
  await pool.end();
}
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) await run();
