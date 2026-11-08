import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.PI_MEMORY_DSN, max: 1 });
const r = await pool.query(
  `select e.seq, e.kind, e.tool_name, coalesce(e.meta ->> 'customType', '') as marker,
          coalesce(e.meta ->> 'dream_turn', 'false') as dt, e.at
   from memory.event e
   join memory.session s on s.id = e.session_id
   join memory.agent a on a.id = s.agent_id
   where a.name = $1 and e.seq > s.dream_seq order by e.seq limit 14`,
  [process.argv[2] ?? "home-ops"],
);
console.table(r.rows.map((x) => ({ seq: x.seq, kind: x.kind, tool: x.tool_name, marker: x.marker, dt: x.dt, at: x.at.toISOString().slice(11, 19) })));
await pool.end();
