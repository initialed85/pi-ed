#!/usr/bin/env node
// Read-only look at whether consecutive dreams in one session had real work between them.
//
// This is the shape the fleet had: a dream that wrote nothing left the watermark where it was, so the next idle window
// re-asked the same question, and each asking cost a turn and left hidden rows in the context. `memory.event` tags a
// dream's own rows `dream_turn: true`, so the count below is work rows only - what a dream should have had to be
// worth writing.
//
//   PI_MEMORY_DSN="$(kubectl --context home-dev -n slopyphus get cm config -o jsonpath='{.data.PI_MEMORY_DSN}')" \
//     node ./hack/dream-review.mjs
//
// Postures are not asserted, only printed. The DSN is read from the environment and never printed.

const pg = await import("pg");
const MIN_WORK = Number(process.argv.find((a) => a.startsWith("--min-work="))?.split("=")[1] ?? 4);
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 20);

const pool = new pg.Pool({ connectionString: process.env.PI_MEMORY_DSN, max: 1 });
const { rows } = await pool.query(
  `with dreams as (
     select m.id, m.session_id, m.created_at, m.trigger, m.summary,
            ef.seq as span_first, el.seq as span_last,
            lag(el.seq) over (partition by m.session_id order by m.created_at, m.id) as prev_last,
            row_number() over (partition by m.session_id order by m.created_at, m.id) as nth
     from memory.memory m
     join memory.event ef on ef.id = m.span_first_event
     join memory.event el on el.id = m.span_last_event
   )
   select a.name as agent, s.id as session, d.nth, d.trigger,
          to_char(d.created_at, 'MM-DD HH24:MI') as at,
          (select count(*) from memory.event e
             where e.session_id = d.session_id
               and e.seq > coalesce(d.prev_last, 0) and e.seq <= coalesce(d.span_first, 0)
               and coalesce(e.meta ->> 'dream_turn', 'false') <> 'true') as work_between,
          left(d.summary, 46) as summary
   from dreams d
   join memory.session s on s.id = d.session_id
   join memory.agent a on a.id = s.agent_id
   where d.nth > 1
   order by d.created_at desc
   limit $1`,
  [LIMIT],
);

console.table(rows);
const re_fires = rows.filter((row) => Number(row.work_between) < MIN_WORK);
console.log(`\n${rows.length} follow-on dream(s) looked at; ${re_fires.length} had fewer than ${MIN_WORK} work row(s) between it and the previous dream.`);
console.log(`a number that stays at 0 after the watermark fix means the gate is closing on a dream that wrote nothing.`);
await pool.end();
