import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.PI_MEMORY_DSN, max: 1 });

// Which agents have more than one identity in the store? That is the blast radius of an identity that moves.
const ids = await pool.query(
  `select id, name, notes ->> 'repo' as repo,
          (select count(*) from memory.agent p2 where p2.name = p1.name and p2.id <> p1.id) as siblings_with_same_name,
          (select count(*) from memory.memory m where m.agent_id = p1.id) as memories,
          (select count(*) from memory.session s where s.agent_id = p1.id) as sessions
   from memory.agent p1 order by name, id`,
);
console.table(ids.rows);

// Do any two identities differ only by the host prefix? That is what a moved pod or an unnamed checkout looks like.
const drift = await pool.query(
  `select name, count(distinct id) as ids, array_agg(distinct id) as id_list
   from memory.agent group by name having count(distinct id) > 1 order by name`,
);
console.log("identities with more than one id:", drift.rows.length);
console.table(drift.rows);

// Host-prefixed ids at all? Those are the unnamed checkouts.
const hosty = await pool.query(
  `select id, name from memory.agent where id like '%:%' order by id limit 20`,
);
console.log("host:directory ids (unnamed checkouts):", hosty.rows.length);
console.table(hosty.rows);
await pool.end();
