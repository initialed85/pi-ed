import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.PI_MEMORY_DSN, max: 1 });

// The claim under test: a team_room call made inside a dream turn is tagged as residue and so is invisible to the
// span the dream summarises. If the count is zero, the boundary fix already covers it; if it is not, item 2 is real.
const r = await pool.query(
  `select a.name as agent,
          count(*) filter (where coalesce(e.meta ->> 'dream_turn', 'false') = 'true') as tagged,
          count(*) filter (where coalesce(e.meta ->> 'dream_turn', 'false') <> 'true') as untagged
   from memory.event e
   join memory.session s on s.id = e.session_id
   join memory.agent a on a.id = s.agent_id
   where e.tool_name = 'team_room'
   group by 1 order by 2 desc`,
);
console.log("=== team_room tool rows, tagged as dream residue vs not ===");
console.table(r.rows);

// The exact shape of the complaint: a dream turn whose span contains teammate work.
const s = await pool.query(
  `select a.name as agent, e.seq, e.kind, e.tool_name, e.meta ->> 'action' as action,
          coalesce(e.meta ->> 'dream_turn', 'false') as dt, e.at
   from memory.event e
   join memory.session s2 on s2.id = e.session_id
   join memory.agent a on a.id = s2.agent_id
   where e.tool_name = 'team_room' and coalesce(e.meta ->> 'dream_turn', 'false') = 'true'
   order by e.at desc limit 12`,
);
console.log("\n=== most recent residue-tagged teammate work ===");
console.table(s.rows);
await pool.end();
