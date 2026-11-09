#!/usr/bin/env node
/**
 * The memory store's reading room: one HTTP server, one page, no writes.
 *
 * Why it is read-only by construction rather than by care: it connects with the same DSN the agents write with, and
 * it is behind Google sign-in on a public hostname. A write endpoint here would need authorisation this app has no
 * business doing - the writers are the agents, and their authority comes from being the agents. So the pool sets
 * `default_transaction_read_only` on connect, which makes Postgres itself refuse any write this code might grow later.
 * Every statement is also inside `readOnce`, which gives the request a deadline: an unbounded query on a store that
 * another pod is actively writing is how a reading room becomes an outage.
 *
 * Identity comes from Traefik's forwardAuth (`X-Auth-Request-*`). The app does not authenticate anybody; it checks
 * that the gate did, and says so plainly when it has not. That distinction matters: `X-Auth-Request-Email` is a header
 * Traefik copies after deleting client-supplied copies, so it is trustworthy precisely because the app never trusts it
 * to make an access decision - it only says who is looking.
 *
 *   node ui/server.mjs                        # http://127.0.0.1:8090
 *   PI_MEMORY_DSN=... PORT=8090 node ui/server.mjs
 *
 * Run the tests with: npm test (test/memory-ui.test.ts).
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = resolve(HERE, "public");
const PORT = Number(process.env.PORT ?? 8090);
const DSN = process.env.PI_MEMORY_DSN ?? "";
const EMBED_URL = (process.env.PI_MEMORY_EMBED_URL ?? "https://embeddings.dev.initialed85.cc").replace(/\/+$/, "");
const EMBED_MODEL = process.env.PI_MEMORY_EMBED_MODEL ?? "bge-base-en-v1.5";
const STATEMENT_TIMEOUT_MS = Number(process.env.PI_MEMORY_UI_STATEMENT_TIMEOUT_MS ?? 4000);
/** A ceiling on every list, so `?limit=1000000` is not an invitation to render the whole store. */
const MAX_ROWS = 500;

const pool = new pg.Pool({ connectionString: DSN, max: 4 });
pool.on("connect", (client) => {
  client.query(`set session default_transaction_read_only = on; set session statement_timeout = ${STATEMENT_TIMEOUT_MS}`).catch(() => undefined);
});
pool.on("error", (error) => console.log(`pool: ${error.message}`));

/**
 * Run one read.
 *
 * The deadline is per-query rather than per-session because the pool is shared: a session-wide timeout set by one
 * slow vector search would silently truncate the next request's table page.
 */
async function readOnce(sql, params = []) {
  const client = await pool.connect();
  try {
    const r = await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    void r;
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------- identity */

/** The gate's verdict, as reported. `null` means nothing authenticated this request. */
export function identity(headers) {
  const email = String(headers["x-auth-request-email"] ?? "").trim() || null;
  const user = String(headers["x-auth-request-user"] ?? "").trim() || null;
  // A header that is present but blank is not a vouch. Traefik only sets these after a successful gate, so an empty
  // pair means something else put them there - and "somebody is signed in as nobody" is worse than admitting nobody
  // is known.
  if (!email && !user) return null;
  return { email, user };
}

/* ------------------------------------------------------------------- queries */

/** A label for an endpoint, chosen by what the endpoint is. Long values are trimmed here, not in the browser. */
function label(type, value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/**
 * Memories, newest first, optionally narrowed by agent and by a text match.
 *
 * `match` is carried three ways - summary, subjects array, and the feel line - because the things worth finding in
 * this store are often in the feel, which is where the agent's own judgement lands.
 */
export function memoriesQuery({ agent, match, limit, offset }) {
  const params = [];
  const where = [`true`];
  if (agent) {
    params.push(agent);
    where.push(`m.agent_id = $${params.length}`);
  }
  if (match) {
    params.push(`%${match}%`);
    const p = `$${params.length}`;
    where.push(`(m.summary ilike ${p} or exists (select 1 from unnest(m.subjects) s (subject) where s.subject ilike ${p}) or m.feel ilike ${p})`);
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), MAX_ROWS));
  params.push(Math.max(Number(offset) || 0, 0));
  return {
    sql: `select m.id, m.agent_id, m.session_id, m.trigger, m.summary, m.subjects, m.feel,
                 m.created_at, m.embedding_model, m.embedding is not null as embedded,
                 m.span_first_event, m.span_last_event,
                 (select count(*) from memory.edge e where e.src_memory = m.id or e.dst_memory = m.id)::int as edges
          from memory.memory m
          where ${where.join(" and ")}
          order by m.created_at desc
          limit $${params.length - 1} offset $${params.length}`,
    values: params,
  };
}

/** Events, newest first. `kind` and `tool` are the filters that make sense on this table. */
export function eventsQuery({ agent, kind, tool, match, limit }) {
  const params = [];
  const where = [`true`];
  if (agent) {
    params.push(agent);
    where.push(`e.agent_id = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    where.push(`e.kind = $${params.length}`);
  }
  if (tool) {
    params.push(tool);
    where.push(`e.tool_name = $${params.length}`);
  }
  if (match) {
    params.push(`%${match}%`);
    where.push(`(e."text" ilike $${params.length} or e.meta::text ilike $${params.length})`);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), MAX_ROWS));
  return {
    sql: `select e.id, e.agent_id, e.session_id, e.kind, e.tool_name, e."at", e.seq, e.source_entry_id,
                 left(coalesce(e."text", ''), 240) as preview,
                 e.meta -> 'input' ->> 'action' as action,
                 (select count(*) from memory.edge ed where ed.src_event = e.id or ed.dst_event = e.id)::int as edges
          from memory.event e
          where ${where.join(" and ")}
          order by e."at" desc
          limit $${params.length}`,
    values: params,
  };
}

/**
 * Edges, with both endpoints named in the same query.
 *
 * Read from `memory.graph_edges`, the view the migration ships, rather than re-joining the endpoint tables here. The
 * reason is agreement rather than speed: if the reading room resolves an endpoint its own way, the graph tab and a
 * `select * from memory.graph_edges` in psql can show the same edge under two different names, and then the reader is
 * auditing the UI instead of the store.
 */
export function edgesQuery({ agent, kind, memory, event, limit }) {
  const params = [];
  const where = [`true`];
  if (agent) {
    params.push(agent);
    where.push(`g.asserted_by = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    where.push(`g.kind = $${params.length}`);
  }
  // `src_id`/`dst_id` are the view's own text form of whichever endpoint is populated, so a memory uuid and an event
  // bigint both arrive as strings and are matched the same way.
  if (memory) {
    params.push(String(memory));
    where.push(`(g.src_id = $${params.length} or g.dst_id = $${params.length})`);
  }
  if (event) {
    params.push(String(event));
    where.push(`(g.src_id = $${params.length} or g.dst_id = $${params.length})`);
  }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), MAX_ROWS));
  return {
    sql: `select g.id, g.kind, g."at", g.asserted_by, g.weight, g.meta,
                 g.src_type, g.src_id, g.src_label, g.dst_type, g.dst_id, g.dst_label
          from memory.graph_edges g
          where ${where.join(" and ")}
          order by g."at" desc
          limit $${params.length}`,
    values: params,
  };
}

/**
 * A vector search, or the text search it degrades to.
 *
 * `memories` keeps its own copy of the rule that made each memory: which events it was drawn from. Without it the
 * graph tab and the memories table disagree about what a memory means, and the whole point of the reading room is
 * that the two views are the same store seen two ways.
 * @param {{ vector: number[] }} search
 */
export function vectorSearchQuery({ vector, agent, limit }) {
  const params = [`[${vector.join(",")}]`];
  const where = [`m.embedding is not null`];
  if (agent) {
    params.push(agent);
    where.push(`m.agent_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
  return {
    sql: `select m.id, m.agent_id, m.trigger, m.summary, m.subjects, m.feel, m.created_at,
                 1 - (m.embedding <=> $1::vector) as similarity
          from memory.memory m
          where ${where.join(" and ")}
          order by m.embedding <=> $1::vector
          limit $${params.length}`,
    values: params,
  };
}

/** Everything a single memory can tell you, including the events it was drawn from. */
export function memoryDetailQueries(id) {
  return {
    memory: {
      sql: `select m.*, s.started_at as session_started_at, s.last_activity_at as session_last_activity_at,
                   s.repo, s.cwd, s.dream_seq
            from memory.memory m
            join memory.session s on s.id = m.session_id
            where m.id = $1`,
      values: [id],
    },
    span: {
      sql: `select e.id, e.kind, e.tool_name, e.seq, e."at", e.source_entry_id,
                   left(coalesce(e."text", ''), 400) as preview
            from memory.event e
            join memory.memory m on m.id = $1
            join memory.event f on f.id = m.span_first_event
            join memory.event l on l.id = m.span_last_event
            where e.session_id = m.session_id and e.seq between f.seq and l.seq
            order by e.seq`,
      values: [id],
    },
    edges: edgesQuery({ memory: id, limit: 200 }),
  };
}

/** The lists the filters are built from, so the UI never hard-codes a vocabulary. */
export function facetQueries() {
  return {
    agents: { sql: `select id, name, host, repos, first_seen, last_seen from memory.agent order by last_seen desc nulls last limit 200`, values: [] },
    edgeKinds: { sql: `select kind, count(*)::int as n from memory.edge group by 1 order by 1`, values: [] },
    eventKinds: { sql: `select kind, count(*)::int as n from memory.event group by 1 order by 1`, values: [] },
    tools: { sql: `select tool_name, count(*)::int as n from memory.event where tool_name is not null group by 1 order by 2 desc limit 60`, values: [] },
    triggers: { sql: `select trigger, count(*)::int as n from memory.memory group by 1 order by 2 desc`, values: [] },
  };
}

/** The counts on the header line, and the proof the store is reachable. */
export const summaryQuery = {
  sql: `select
          (select count(*) from memory.memory)::int as memories,
          (select count(*) from memory.memory where embedding is not null)::int as memories_embedded,
          (select count(*) from memory.event)::int as events,
          (select count(*) from memory.edge)::int as edges,
          (select count(*) from memory.agent)::int as agents,
          (select count(*) from memory.session)::int as sessions,
          (select count(*) from memory.edge where kind like 'room_%')::int as room_edges,
          (select max("at") from memory.edge)::text as newest_edge_at,
          (select max(created_at) from memory.memory)::text as newest_memory_at`,
  values: [],
};

/* ------------------------------------------------------------------ endpoints */

/** Ask the embedder for one vector. Same route and same body shape the writer uses, verified against the deployment. */
export async function embedQuery(text) {
  const response = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`embedder ${EMBED_URL} answered ${response.status}`);
  const payload = await response.json();
  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 768) throw new Error(`embedder returned ${vector?.length ?? 0} dimensions; the store's column is 768`);
  return vector;
}

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

/** Serve a file from `ui/public`, and nothing outside it. */
async function serveStatic(pathname, response) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, clean === "/" ? "index.html" : clean);
  // resolve() then compare: `join` alone lets `..` through, and a reading room that can serve /etc/passwd is not a
  // reading room.
  if (!resolve(file).startsWith(PUBLIC)) {
    response.writeHead(404).end("not found");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": STATIC_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

/** Turn a database error into something a reader can act on, without echoing a DSN or a full query. */
function describeQueryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres:\/\/\S+/g, "postgres://…").slice(0, 400);
}

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");
  const who = identity(request.headers);

  if (url.pathname === "/healthz") {
    try {
      const r = await readOnce("select 1 as ok");
      return json(response, 200, { ok: true, rows: r.rows.length, identity: who });
    } catch (error) {
      return json(response, 500, { ok: false, error: describeQueryError(error) });
    }
  }

  // The API is the interesting part, and it is the part the gate is for. A missing identity header means the request
  // arrived without going through Traefik - a port-forward is fine, a Service exposed the wrong way is not - so the
  // answer is a refusal that says why rather than a page full of somebody's memories.
  if (url.pathname.startsWith("/api/")) {
    if (!who) {
      return json(response, 401, {
        error: "no identity",
        detail: "no X-Auth-Request-* headers, so this request did not come through the auth gate. In-cluster access is expected only from Traefik; a port-forward should set nothing and should not be used against a store holding other agents' reflections.",
      });
    }
    if (!DSN) {
      return json(response, 503, { error: "not configured", detail: "PI_MEMORY_DSN is unset, so there is no store to read." });
    }

    const q = url.searchParams;
    try {
      if (url.pathname === "/api/summary") {
        const r = await readOnce(summaryQuery.sql);
        return json(response, 200, { identity: who, ...r.rows[0] });
      }
      if (url.pathname === "/api/facets") {
        const out = {};
        for (const [name, spec] of Object.entries(facetQueries())) out[name] = (await readOnce(spec.sql)).rows;
        return json(response, 200, { identity: who, ...out });
      }
      if (url.pathname === "/api/memories") {
        const spec = memoriesQuery({ agent: q.get("agent"), match: q.get("q"), limit: q.get("limit"), offset: q.get("offset") });
        const r = await readOnce(spec.sql, spec.values);
        return json(response, 200, { identity: who, rows: r.rows, sql: spec.sql });
      }
      if (url.pathname === "/api/events") {
        const spec = eventsQuery({ agent: q.get("agent"), kind: q.get("kind"), tool: q.get("tool"), match: q.get("q"), limit: q.get("limit") });
        const r = await readOnce(spec.sql, spec.values);
        return json(response, 200, { identity: who, rows: r.rows, sql: spec.sql });
      }
      if (url.pathname === "/api/edges") {
        const spec = edgesQuery({ agent: q.get("agent"), kind: q.get("kind"), memory: q.get("memory"), event: q.get("event"), limit: q.get("limit") });
        const r = await readOnce(spec.sql, spec.values);
        const nodes = new Map();
        const edges = [];
        for (const row of r.rows) {
          const src = `${row.src_type}:${row.src_id}`;
          const dst = `${row.dst_type}:${row.dst_id}`;
          if (!nodes.has(src)) nodes.set(src, { id: src, type: row.src_type, label: label(row.src_type, row.src_label), assertedBy: row.asserted_by });
          if (!nodes.has(dst)) nodes.set(dst, { id: dst, type: row.dst_type, label: label(row.dst_type, row.dst_label) });
          edges.push({ id: String(row.id), kind: row.kind, src, dst, weight: row.weight, at: row.at, meta: row.meta });
        }
        return json(response, 200, { identity: who, nodes: [...nodes.values()], edges, sql: spec.sql });
      }
      if (url.pathname === "/api/memory") {
        const id = q.get("id");
        if (!id) return json(response, 400, { error: "id required" });
        const specs = memoryDetailQueries(id);
        const memory = await readOnce(specs.memory.sql, specs.memory.values);
        if (!memory.rows.length) return json(response, 404, { error: "no such memory" });
        const span = await readOnce(specs.span.sql, specs.span.values);
        const edges = await readOnce(specs.edges.sql, specs.edges.values);
        return json(response, 200, { identity: who, memory: memory.rows[0], span: span.rows, edges: edges.rows, sql: specs.memory.sql });
      }
      if (url.pathname === "/api/search") {
        const text = (q.get("q") ?? "").trim();
        if (!text) return json(response, 400, { error: "q required" });
        const mode = q.get("mode") ?? "vector";
        const agent = q.get("agent");
        const limit = q.get("limit");
        if (mode === "text") {
          const spec = memoriesQuery({ agent, match: text, limit: limit ?? 50 });
          const r = await readOnce(spec.sql, spec.values);
          return json(response, 200, { identity: who, mode, rows: r.rows.map((row) => ({ ...row, similarity: null })), sql: spec.sql });
        }
        try {
          const vector = await embedQuery(text);
          const spec = vectorSearchQuery({ vector, agent, limit });
          const r = await readOnce(spec.sql, spec.values);
          return json(response, 200, { identity: who, mode, model: EMBED_MODEL, rows: r.rows, sql: spec.sql });
        } catch (error) {
          // Degraded rather than failed, and saying which: a vector search that silently becomes a text search is how
          // a reader concludes the store has nothing relevant in it.
          const spec = memoriesQuery({ agent, match: text, limit: limit ?? 50 });
          const r = await readOnce(spec.sql, spec.values);
          return json(response, 200, {
            identity: who,
            mode: "text-fallback",
            degraded: describeQueryError(error),
            rows: r.rows.map((row) => ({ ...row, similarity: null })),
            sql: spec.sql,
          });
        }
      }
      return json(response, 404, { error: "no such endpoint" });
    } catch (error) {
      return json(response, 500, { error: "query failed", detail: describeQueryError(error) });
    }
  }

  return serveStatic(url.pathname, response);
}

let server;
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!DSN) console.log("PI_MEMORY_DSN is unset: the page will load, every API call will answer 503.");
  server = (await import("node:http")).createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.log(`unhandled: ${error instanceof Error ? error.message : String(error)}`);
      try {
        json(res, 500, { error: "internal", detail: describeQueryError(error) });
      } catch {
        res.end();
      }
    });
  });
  server.listen(PORT, () => console.log(`memory reading room on :${PORT} (store ${DSN ? "configured" : "NOT configured"}, embedder ${EMBED_URL})`));
}

export { handle, pool, PUBLIC, MAX_ROWS };
