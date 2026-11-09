#!/usr/bin/env node
// One-off repair for the tag that never stopped.
//
// `collect()` used to treat a dream as residue until the next `user` message. A session that carried on working
// without the user speaking - a teammate steer, a scheduled prompt, a resume, or simply the agent continuing the task
// it was on - had every later row tagged `dream_turn: true`, and the memory system was told none of it was work. This
// session's own numbers: 468 tagged rows, 464 of them real work, and the store's span reading zero, which is what
// made a dream refuse to write about a stretch that was full of it.
//
// RESIDUE IS NOT ONE LONG SPAN. It is a union of short turns, and getting this wrong is how the repair ran twice,
// reported "nothing to repair", and left 1,671 rows mis-tagged on a fleet everyone believed was clean:
//
//   - a dream prompt, up to the `turn-stats` that closes the turn it opened; and separately
//   - every `memory_dream` row, up to the `turn-stats` that closes the turn it re-armed.
//
// The tagger works exactly this way - it re-arms on a `memory_dream` row and closes on the next `turn-stats` - so the
// repair has to be the same rule expressed in SQL, or the two disagree and the disagreement looks like a clean run.
//
// The previous version asked "what is the last `memory_dream` row after this prompt" and took the answer across the
// whole region. Two failures followed, both real on this fleet:
//
//   1. Uncapped, a session with three dreams reported its first two as ending after the third, so the span was empty
//      for every dream but the last.
//   2. A stray row - a `memory_dream` tool_result at seq 6930 in a session whose dream prompt sat at 6682 - dragged
//      the boundary 248 rows forward and sheltered everything behind it.
//
// Both are fixed by not looking for one boundary per dream at all. Each prompt and each dream row opens a window;
// a row is residue when some window covers it; nothing else about a dream is trusted.
//
//   node ./hack/repair-dream-tags.mjs             # dry run: what would change, per session
//   node ./hack/repair-dream-tags.mjs --apply     # write it
//
// Safe to re-run: the update only touches rows that are currently tagged.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");

// A row is over-tagged when a `turn-stats` sits between it and the nearest dream prompt behind it *and* nothing
// re-armed after that boundary. That second clause is the difference between this check and a naive one: a dream row
// late in a turn legitimately makes the rows behind it residue, and a check that ignores it reports correct data as
// damage. Deliberately written with its own correlated subqueries rather than reusing WINDOWS below, so a wrong span
// rule cannot quietly agree with itself.
const INVARIANT = `
  with tagged as (
    select e.session_id, e.seq, e.tool_name,
           (select max(m.seq) from memory.event m
              where m.session_id = e.session_id and m.seq < e.seq
                and m.kind = 'marker' and m.meta ->> 'customType' = 'memory:dream') as nearest_prompt,
           (select max(s.seq) from memory.event s
              where s.session_id = e.session_id and s.seq < e.seq
                and s.meta ->> 'customType' = 'turn-stats') as nearest_boundary
    from memory.event e
    where e.kind = 'tool_call' and coalesce(e.meta ->> 'dream_turn', 'false') = 'true'
      and e.tool_name <> 'memory_dream'
  )
  select count(*) filter (
           where nearest_prompt is not null
             and nearest_boundary is not null
             and nearest_boundary > nearest_prompt
             and not exists (
               select 1 from memory.event d
                where d.session_id = tagged.session_id and d.tool_name = 'memory_dream'
                  and d.seq < tagged.seq and d.seq > tagged.nearest_boundary
             )
         ) as tagged_past_boundary,
         count(*) as tagged_tool_rows
  from tagged`;

// One region per dream: from its prompt to the next dream's prompt. A row belongs to exactly one region, which is
// what makes the windows below safe to union - a later dream's residue can never be swallowed by an earlier one's
// window, and an earlier dream's damage can never hide behind a later one.
const WINDOWS = `
  with prompts as (
    select session_id, seq as prompt_seq,
           lead(seq) over (partition by session_id order by seq) as next_prompt_seq
    from memory.event
    where kind = 'marker' and meta ->> 'customType' = 'memory:dream'
  ),
  regions as (
    select session_id, prompt_seq, coalesce(next_prompt_seq, 2147483647) as region_end
    from prompts
  ),
  anchors as (
    select session_id, prompt_seq as anchor, region_end from regions
    union all
    select r.session_id, e.seq, r.region_end
    from regions r
    join memory.event e on e.session_id = r.session_id
      and e.seq > r.prompt_seq and e.seq < r.region_end
      and e.tool_name = 'memory_dream'
  ),
  windows as (
    select a.session_id, a.anchor, a.region_end,
           -- The turn-stats that closes this window, or the end of the region when the turn never settled - in which
           -- case the rows really are the dream's own and nothing past them is touched.
           coalesce((select min(s.seq) from memory.event s
                       where s.session_id = a.session_id and s.seq > a.anchor and s.seq < a.region_end
                         and s.meta ->> 'customType' = 'turn-stats'), a.region_end) as win_end
    from anchors a
  ),
  covered as (
    select distinct w.session_id, e.seq
    from windows w
    join memory.event e on e.session_id = w.session_id and e.seq >= w.anchor and e.seq <= w.win_end
  ),
  targets as (
    select e.id, e.session_id, e.seq
    from memory.event e
    join regions r on r.session_id = e.session_id and e.seq > r.prompt_seq and e.seq < r.region_end
    where coalesce(e.meta ->> 'dream_turn', 'false') = 'true'
      and not exists (select 1 from covered c where c.session_id = e.session_id and c.seq = e.seq)
  )`;

const dsn =
  process.env.PI_MEMORY_DSN ??
  (() => {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "secret", "pi-ed-postgres.DATABASE_URL");
    return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
  })();
if (!dsn) {
  console.error("no PI_MEMORY_DSN and no secret/pi-ed-postgres.DATABASE_URL");
  process.exit(2);
}

const pg = await import("pg");
const db = new pg.Pool({ connectionString: dsn, max: 2 });

const { rows } = await db.query(
  `${WINDOWS}
   select a.name as agent, s.id as session, count(*) as tagged_after,
          min(t.seq) as from_seq, max(t.seq) as to_seq
   from targets t
   join memory.session s on s.id = t.session_id
   join memory.agent a on a.id = s.agent_id
   group by a.name, s.id
   order by tagged_after desc`,
);

if (!rows.length) {
  // This line has already once been a lie, so the exit is no longer trusted on its own: the invariant is checked
  // independently of the windows above. If the two disagree, the repair is blind rather than the fleet clean.
  const invariant = await db.query(INVARIANT);
  const stillBad = Number(invariant.rows[0].tagged_past_boundary);
  if (stillBad > 0) {
    console.log(`NOTHING TO REPAIR IS WRONG: ${stillBad} tool row(s) are tagged as residue past a turn-stats boundary`
      + ` with nothing re-arming behind it, and this script's windows did not cover them. Fix the window rule before`
      + ` believing the clean report.`);
    await db.end();
    process.exit(1);
  }
  console.log("nothing to repair: no session has work tagged as dream residue, and the boundary invariant holds.");
  await db.end();
  process.exit(0);
}

console.table(rows);
const total = rows.reduce((sum, r) => sum + Number(r.tagged_after), 0);
console.log(`\n${total} row(s) across ${rows.length} session(s) are tagged as dream residue but sit outside every`
  + ` window a dream actually opened.`);

if (!APPLY) {
  console.log("dry run; pass --apply to write. The update clears the tag on those rows and lowers each session's dream"
    + " cursor to just before the first of them, so the work behind it is ahead of the gate again.");
  await db.end();
  process.exit(0);
}

const written = await db.query(
  `${WINDOWS} update memory.event set meta = meta - 'dream_turn' where id in (select id from targets) returning id`,
);
console.log(`untagged ${written.rowCount} row(s).`);

// The cursor move cannot re-derive its own work, and that is a trap this script has already walked into once:
// `targets` selects rows that are *tagged*, and the update above has just removed the tag, so asking the same query
// again finds nothing and the script cheerfully reports having moved zero cursors - leaving every session's work
// behind the gate it was written to push ahead of it. The target set is therefore captured first, on one connection,
// inside one transaction, so the untag and the cursor both act on the same recorded damage.
const client = await db.connect();
try {
  await client.query("begin");
  await client.query(`
    create temporary table repair_targets (id bigint primary key, session_id text not null, seq integer not null)
      on commit preserve rows`);
  await client.query(`${WINDOWS}
   insert into repair_targets (id, session_id, seq) select id, session_id, seq from targets`);
  const captured = Number((await client.query("select count(*) as n from repair_targets")).rows[0].n);
  if (captured !== written.rowCount) {
    console.log(`the damage moved underneath the script: ${written.rowCount} row(s) untagged but ${captured} captured.`
      + ` Another writer is editing this session's history while the repair runs, and a cursor lowered from a list`
      + ` that no longer matches it is worse than no repair at all.`);
  }

  // The cursor has to follow, or the work stays behind it - but to the front of the recovered work, not the end of the
  // history. Moving it to the top would mark the untagged rows as already summarized, which is the exact thing this
  // repair is trying to undo. Lowered only, never raised: a session that has legitimately dreamed since has nothing
  // to gain from being pushed forward.
  const moved = await client.query(`
    update memory.session set dream_seq = f.to_seq
    from (select session_id, min(seq) - 1 as to_seq from repair_targets group by session_id) f
    where memory.session.id = f.session_id and memory.session.dream_seq > f.to_seq
    returning memory.session.id`);
  console.log(`lowered the dream cursor on ${moved.rowCount} session(s) from ${captured} captured target row(s), so the`
    + ` untagged work is ahead of it.`);
  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
}

// The repair is only believed if it can be shown to have worked, and the proof cannot reuse the reasoning that
// produced the repair.
const after = await db.query(INVARIANT);
const left = Number(after.rows[0].tagged_past_boundary);
console.log(`boundary invariant after repair: ${left} row(s) still tagged past a turn-stats boundary with nothing`
  + ` re-arming behind it, of ${after.rows[0].tagged_tool_rows} tagged tool rows.`);
if (left > 0) process.exitCode = 1;
await db.end();
