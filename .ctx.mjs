import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.PI_MEMORY_DSN, max: 1 });
const r = await pool.query(
  `select e.seq, e.kind, e.tool_name, coalesce(e.meta ->> 'customType', '') as marker,
          coalesce(e.meta ->> 'dream_turn', 'false') as dt, to_char(e.at, 'HH24:MI:SS') as at
   from memory.event e
   join memory.session s on s.id = e.session_id
   join memory.agent a on a.id = s.agent_id
   where a.name = $1 and e.seq between $2::int - 6 and $3::int + 6 order by e.seq`,
  [process.argv[2], process.argv[3], process.argv[4]],
);
console.table(r.rows);
await pool.end();
