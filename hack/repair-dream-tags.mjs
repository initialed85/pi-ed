#!/usr/bin/env node
// One-off repair for the tag that never stopped.
//
// `collect()` used to treat a dream as residue until the next `user` message. A session that carried on working
// without the user speaking - a teammate steer, a scheduled prompt, a resume, or simply the agent continuing the task
// it was on - had every later row tagged `dream_turn: true`, and the memory system was told none of it was work. This
// session's own numbers: 468 tagged rows, 464 of them real work, and the store's span reading zero, which is what
// made a dream refuse to write about a stretch that was full of it.
//
// The dream's own turn is recoverable from the history, because the harness closes every turn with a `turn-stats`
// marker: the boundary is the first `turn-stats` marker after the last `memory_dream` row, or after the prompt marker
// when the agent declined to call the tool. Everything after that is work.
//
//   node ./hack/repair-dream-tags.mjs             # dry run: what would change, per session
//   node ./hack/repair-dream-tags.mjs --apply     # write it
//
// Safe to re-run: the update only touches rows that are currently tagged.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
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
const pool = new pg.Pool({ connectionString: dsn, max: 1 });

// Where every dream turn actually ended, and where the next one began. A row is residue only of the dream it follows,
// so the boundary is per-dream: the first turn-stats after this dream, capped by the next dream's prompt.
const BOUNDARIES = `
  with prompts as (
    select session_id, seq,
           lead(seq) over (partition by session_id order by seq) as next_prompt_seq
    from memory.event e
    where e.kind = 'marker' and e.meta ->> 'customType' = 'memory:dream'
  ),
  bounds as (
    select p.session_id, p.seq as prompt_seq, p.next_prompt_seq,
           (select coalesce(max(t.seq), 0) from memory.event t
              where t.session_id = p.session_id and t.seq > p.seq and t.tool_name = 'memory_dream') as last_tool_row
    from prompts p
  ),
  edges as (
    select b.session_id, b.prompt_seq, b.next_prompt_seq,
           -- A dream that called the tool ends at the first turn-stats after the tool's own row; a dream that
           -- declined ends at the first turn-stats after the prompt. Either way it is the harness closing the turn,
           -- which is the only thing in the history that says an agent stopped talking.
           (select coalesce(min(s.seq), 0) from memory.event s
              where s.session_id = b.session_id and s.seq > greatest(b.last_tool_row, b.prompt_seq)
                and s.meta ->> 'customType' = 'turn-stats') as dream_end
    from bounds b
  )
  -- A dream with no turn-stats after it at all is a turn that never settled, and its rows really are the dream's; the
  -- boundary stays at the dream itself and nothing past it is untagged.
  , spans as (
    select session_id, prompt_seq, dream_end, coalesce(next_prompt_seq, 2147483647) as span_end
    from edges where dream_end > 0
  )`;

const { rows } = await pool.query(
  `${BOUNDARIES}
   select a.name as agent, s.id as session, count(*) as tagged_after,
          count(*) filter (where e.kind = 'user') as user_rows_after,
          min(e.seq) as from_seq, max(e.seq) as to_seq
   from spans l
   join memory.session s on s.id = l.session_id
   join memory.agent a on a.id = s.agent_id
   join memory.event e on e.session_id = l.session_id and e.seq > l.dream_end and e.seq < l.span_end
   where coalesce(e.meta ->> 'dream_turn', 'false') = 'true'
   group by a.name, s.id
   order by tagged_after desc`,
);

if (!rows.length) {
  console.log("nothing to repair: no session has work tagged as dream residue.");
  await pool.end();
  process.exit(0);
}

console.table(rows);
const total = rows.reduce((sum, r) => sum + Number(r.tagged_after), 0);
console.log(`\n${total} row(s) across ${rows.length} session(s) are tagged as dream residue but come after the harness closed the dream turn.`);
console.log(`a user row after the boundary is a session where the old rule was already correct, so it is counted, not trusted.`);

if (!APPLY) {
  console.log("dry run; pass --apply to write. The update clears the tag on those rows and moves each session's dream cursor back to the first boundary, so the work behind it is ahead of the gate again.");
  await pool.end();
  process.exit(0);
}

const written = await pool.query(
  `${BOUNDARIES}
   , targets as (
     select e.id from memory.event e join spans l on l.session_id = e.session_id
     where e.seq > l.dream_end and e.seq < l.span_end and coalesce(e.meta ->> 'dream_turn', 'false') = 'true'
   )
   update memory.event set meta = meta - 'dream_turn' where id in (select id from targets) returning id`,
);
console.log(`untagged ${written.rowCount} row(s).`);

// The cursor has to follow, or the work stays behind it - but to the front of the work, not the end of the history.
// Moving it to the top would mark the untagged rows as already summarized, which is the exact thing the repair is
// trying to undo.
const moved = await pool.query(
  `${BOUNDARIES}
   , firsts as (select session_id, min(dream_end) as from_seq from spans group by session_id)
   update memory.session set dream_seq = (select from_seq from firsts where firsts.session_id = session.id)
   where id in (select distinct session_id from spans)
   returning id`,
);
console.log(`moved the dream cursor on ${moved.rowCount} session(s) so the untagged work is ahead of it.`);
await pool.end();
