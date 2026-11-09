/**
 * The reading room's client. No framework, no build step: four fetches and one SVG.
 *
 * Two things worth knowing when reading this file.
 *
 * The graph layout is a hand-rolled force simulation rather than a library. It is ~70 lines, it is deterministic
 * (seeded jitter, so the same query draws the same shape on the next reload), and it animates rather than solving
 * upfront - a graph that visibly settles tells you the layout is a drawing of a relationship, not a fact about it.
 *
 * Every number on screen comes from the store. The legend is built from `/api/facets`, the filter options are built
 * from the same place, and nothing here hard-codes the edge vocabulary: a new kind in the migration appears in the
 * dropdown and the legend without a client change, which is the difference between a view of a store and a view of a
 * snapshot someone typed out.
 */
const KIND_COLOURS = {
  memory_about: "#f0b429",
  dreamed_from: "#e07a5f",
  shares_subject: "#d97b7b",
  room_reply: "#8b7dd8",
  room_ask: "#a78bda",
  room_delegate: "#6f5fc0",
  room_update: "#b6a8e8",
  wakes: "#5fb3a5",
};
const TYPE_COLOURS = { memory: "#f0b429", event: "#7f8ea3", agent: "#4fb3a5" };

const state = { view: "memories", rows: [], nodes: [], edges: [], facets: null, selected: null, sim: null };

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, text) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
};

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const payload = await response.json().catch(() => ({ error: "unreadable response" }));
  if (!response.ok) throw new Error(`${payload.error ?? response.status}${payload.detail ? `: ${payload.detail}` : ""}`);
  return payload;
}

function status(text, warn = false) {
  const node = $("status");
  node.textContent = text;
  node.className = warn ? "status warn" : "status";
}

const filters = () => ({
  agent: $("agent").value,
  kind: $("kind").value,
  limit: $("limit").value,
  q: $("q").value.trim(),
  mode: $("mode").value,
});

/* --------------------------------------------------------------------- header */

async function loadChrome() {
  const [summary, facets] = await Promise.all([api("/api/summary"), api("/api/facets")]);
  state.facets = facets;
  $("summary").textContent = [
    `${fmt(summary.memories)} memories (${fmt(summary.memories_embedded)} vectorised)`,
    `${fmt(summary.events)} events`,
    `${fmt(summary.edges)} edges`,
    `${fmt(summary.agents)} agents`,
    `${fmt(summary.room_edges)} room edges`,
    summary.newest_edge_at ? `newest edge ${ago(summary.newest_edge_at)}` : "",
  ].filter(Boolean).join(" · ");
  $("store").textContent = `store reachable`;
  const who = summary.identity ?? facets.identity ?? {};
  $("who").textContent = who.email ? `signed in as ${who.email}` : who.user ? `signed in as ${who.user}` : `no identity header`;

  fill($("agent"), facets.agents.map((a) => [a.id, `${a.id} (${fmt(countOf(facets, a.id))})`]), "all agents");
  fill($("kind"), facets.edgeKinds.map((k) => [k.kind, `${k.kind} (${fmt(k.n)})`]), "all edge kinds");
  drawLegend();
}

function countOf(facets, agentId) {
  return facets.agents.find((a) => a.id === agentId)?.n ?? 0;
}

function fill(select, options, placeholder) {
  const existing = select.value;
  select.replaceChildren(el("option", { value: "" }, placeholder));
  for (const [value, label] of options) select.append(el("option", { value }, label));
  select.value = existing || "";
}

function drawLegend() {
  const legend = $("legend");
  legend.replaceChildren();
  const kinds = state.facets?.edgeKinds ?? [];
  for (const k of kinds) {
    const span = el("span");
    span.append(el("i", { style: `background:${KIND_COLOURS[k.kind] ?? "#888"}` }), document.createTextNode(`${k.kind} ${fmt(k.n)}`));
    legend.append(span);
  }
  for (const [type, colour] of Object.entries(TYPE_COLOURS)) {
    const span = el("span");
    span.append(el("i", { style: `background:${colour}` }), document.createTextNode(type));
    legend.append(span);
  }
}

/* ---------------------------------------------------------------------- views */

async function run() {
  const f = filters();
  try {
    if (state.view === "memories") {
      const payload = f.q
        ? await api("/api/search", { q: f.q, mode: f.mode, agent: f.agent, limit: f.limit })
        : await api("/api/memories", { agent: f.agent, limit: f.limit });
      state.rows = payload.rows;
      renderMemories(payload);
      const mode = payload.mode === "vector" ? `vector · ${payload.model}` : payload.mode === "text-fallback" ? `text fallback (${payload.degraded})` : f.q ? "text" : "newest";
      status(`${payload.rows.length} memories · ${mode}`, payload.mode === "text-fallback");
    } else if (state.view === "events") {
      const payload = await api("/api/events", { agent: f.agent, kind: "tool_call", q: f.q, limit: f.limit });
      state.rows = payload.rows;
      renderEvents(payload);
      status(`${payload.rows.length} events`);
    } else {
      const payload = await api("/api/edges", { agent: f.agent, kind: f.kind, limit: f.limit });
      state.nodes = payload.nodes;
      state.edges = payload.edges;
      if (state.view === "edges") renderEdges(payload);
      else drawGraph();
      status(`${payload.nodes.length} nodes · ${payload.edges.length} edges`);
    }
  } catch (error) {
    status(String(error.message ?? error), true);
  }
}

function renderMemories(payload) {
  const table = el("table");
  table.append(
    head(["when", "agent", "trigger", "summary", "subjects", "similarity", "edges"]),
    body(payload.rows.map((row) => {
      const tr = el("tr");
      tr.append(
        el("td", { class: "dim" }, when(row.created_at)),
        el("td", { class: "dim" }, row.agent_id),
        el("td", { class: "dim" }, row.trigger),
        el("td", { class: "prose" }, row.summary),
        el("td", {}, chips(row.subjects)),
        el("td", { class: "sim" }, row.similarity === null ? "" : Number(row.similarity).toFixed(3)),
        el("td", { class: "num" }, String(row.edges ?? "")),
      );
      tr.addEventListener("click", () => openMemory(row.id));
      return tr;
    })),
  );
  show("table");
  $("table").replaceChildren(table);
}

function renderEvents(payload) {
  const table = el("table");
  table.append(
    head(["when", "agent", "kind", "tool", "action", "text", "edges"]),
    body(payload.rows.map((row) => {
      const tr = el("tr");
      tr.append(
        el("td", { class: "dim" }, when(row.at)),
        el("td", { class: "dim" }, row.agent_id),
        el("td", { class: "dim" }, row.kind),
        el("td", { class: "kind" }, row.tool_name ?? ""),
        el("td", { class: "dim" }, row.action ?? ""),
        el("td", { class: "prose" }, truncate(row.preview, 160)),
        el("td", { class: "num" }, String(row.edges ?? "")),
      );
      tr.addEventListener("click", () => openNode(`event:${row.id}`));
      return tr;
    })),
  );
  show("table");
  $("table").replaceChildren(table);
}

function renderEdges(payload) {
  const table = el("table");
  table.append(
    head(["when", "kind", "from", "to", "asserted by", "weight", "meta"]),
    body(payload.edges.map((edge) => {
      const from = state.nodes.find((n) => n.id === edge.src);
      const to = state.nodes.find((n) => n.id === edge.dst);
      const tr = el("tr");
      tr.style.borderLeft = `3px solid ${KIND_COLOURS[edge.kind] ?? "#555"}`;
      tr.append(
        el("td", { class: "dim" }, when(edge.at)),
        el("td", { class: "kind" }, edge.kind),
        el("td", { class: "prose" }, `${from?.type ?? "?"} · ${truncate(from?.label ?? edge.src, 70)}`),
        el("td", { class: "prose" }, `${to?.type ?? "?"} · ${truncate(to?.label ?? edge.dst, 70)}`),
        el("td", { class: "dim" }, edge.assertedBy ?? from?.assertedBy ?? ""),
        el("td", { class: "num" }, edge.weight === null ? "" : String(edge.weight)),
        el("td", { class: "dim" }, edge.meta ? truncate(JSON.stringify(edge.meta), 120) : ""),
      );
      tr.addEventListener("click", () => openNode(edge.src));
      return tr;
    })),
  );
  show("table");
  $("table").replaceChildren(table);
}

const head = (columns) => el("thead", {}, el("tr", {}, ...columns.map((c) => el("th", {}, c))));
const body = (rows) => el("tbody", {}, ...rows);
function chips(items) {
  const wrap = el("div", { class: "chips" });
  for (const item of items ?? []) wrap.append(el("span", { class: "chip" }, item));
  return wrap;
}

/* ---------------------------------------------------------------------- graph */

/** The SVG namespace, spelled once. Getting it wrong produces an element that exists and renders nothing, which is a
 *  confusing way to spend an afternoon. */
const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

function drawGraph() {
  show("graph");
  const canvas = $("canvas");
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width || 900, 400);
  const h = Math.max(rect.height || 560, 300);
  canvas.replaceChildren();
  canvas.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const view = svgEl("g");
  canvas.append(view);

  // A seeded start so the same query draws the same picture. `Math.random()` makes every reload a different graph,
  // which reads as instability in the data when it is only the layout.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };
  const degree = new Map();
  for (const e of state.edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  const nodes = state.nodes.map((n, i) => {
    const angle = (i / Math.max(state.nodes.length, 1)) * Math.PI * 2;
    const radius = Math.min(w, h) * (0.22 + rand() * 0.16);
    return {
      ...n,
      x: w / 2 + Math.cos(angle) * radius,
      y: h / 2 + Math.sin(angle) * radius,
      vx: 0, vy: 0,
      r: baseRadius(n.type, degree.get(n.id) ?? 0),
      fixed: false,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = state.edges.filter((e) => byId.has(e.src) && byId.has(e.dst));

  const gEdges = svgEl("g");
  const gNodes = svgEl("g");
  view.append(gEdges, gNodes);

  const edgeNodes = edges.map((e) => {
    const line = svgEl("line", { class: "edge", stroke: KIND_COLOURS[e.kind] ?? "#666", "data-kind": e.kind });
    gEdges.append(line);
    return { e, line };
  });
  const nodeNodes = nodes.map((n) => {
    const g = svgEl("g", { class: "node", "data-id": n.id });
    const shape = n.type === "event"
      ? svgEl("rect", { x: -n.r * 0.8, y: -n.r * 0.8, width: n.r * 1.6, height: n.r * 1.6, rx: 1.5 })
      : svgEl("circle", { r: n.r });
    shape.setAttribute("fill", TYPE_COLOURS[n.type] ?? "#888");
    shape.setAttribute("fill-opacity", n.type === "memory" ? "0.95" : "0.8");
    const label = svgEl("text", { class: "label", x: n.r + 4, y: 3.5 });
    label.textContent = labelFor(n);
    g.append(shape, label);
    gNodes.append(g);
    return { n, g, label };
  });

  const sim = { nodes, edges, byId, view, w, h, alpha: 1, frame: 0, scale: 1, x: 0, y: 0 };
  state.sim = sim;

  const step = () => {
    if (sim.alpha < 0.02 || sim.frame > 900) return false;
    sim.frame += 1;
    sim.alpha *= 0.985;
    // Repulsion. O(n²) and deliberately unoptimised: the query is capped at 500 edges, and a spatial index for a
    // graph this size would be more code than it saves.
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (rand() - 0.5) * 2; dy = (rand() - 0.5) * 2; d2 = 4; }
        const force = 1100 / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        if (!a.fixed) { a.vx += fx; a.vy += fy; }
        if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
      }
    }
    for (const { e } of edgeNodes) {
      const a = byId.get(e.src);
      const b = byId.get(e.dst);
      // Room edges are the interesting ones and the sparsest, so they pull harder than a subject match, which can
      // fan out into a hundred memories that should not be squeezed into one clump.
      const target = e.kind.startsWith("room_") || e.kind === "dreamed_from" ? 70 : e.kind === "memory_about" ? 55 : 110;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(Math.hypot(dx, dy), 1);
      const pull = ((d - target) / d) * 0.06 * sim.alpha;
      if (!a.fixed) { a.vx += dx * pull; a.vy += dy * pull; }
      if (!b.fixed) { b.vx -= dx * pull; b.vy -= dy * pull; }
    }
    for (const n of nodes) {
      if (n.fixed) continue;
      n.vx += (sim.w / 2 - n.x) * 0.004;
      n.vy += (sim.h / 2 - n.y) * 0.004;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += Math.max(-12, Math.min(12, n.vx * sim.alpha));
      n.y += Math.max(-12, Math.min(12, n.vy * sim.alpha));
    }
    paint();
    return true;
  };

  const paint = () => {
    for (const { e, line } of edgeNodes) {
      const a = byId.get(e.src);
      const b = byId.get(e.dst);
      line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
      line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    }
    for (const { n, g, label } of nodeNodes) {
      g.setAttribute("transform", `translate(${n.x} ${n.y})`);
      // Event labels are only drawn when the node is picked or the view is zoomed in: a store where events outnumber
      // memories 100:1 labels into illegibility otherwise.
      const hot = state.selected === n.id || sim.scale > 1.4;
      label.setAttribute("class", `label${hot ? " hot" : ""}`);
      label.textContent = hot || n.type === "agent" ? labelFor(n) : n.type === "memory" ? labelFor(n) : "";
    }
    sim.view.setAttribute("transform", `translate(${sim.x} ${sim.y}) scale(${sim.scale})`);
  };

  const tick = () => {
    if (!state.sim || state.sim !== sim) return;
    if (step()) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  wireCanvas(canvas, sim, byId, () => paint(), () => { sim.alpha = Math.max(sim.alpha, 0.45); requestAnimationFrame(tick); });
}

const baseRadius = (type, edges) => (type === "agent" ? 9 : type === "memory" ? 6 : 3.5) + Math.min(7, edges * 0.5);
const labelFor = (n) => truncate(n.label ?? n.id, n.type === "agent" ? 28 : 44);

function wireCanvas(canvas, sim, byId, paint, reheat) {
  let drag = null;
  let pan = null;

  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const toWorld = (p) => ({ x: (p.x - sim.x) / sim.scale, y: (p.y - sim.y) / sim.scale });

  canvas.addEventListener("pointerdown", (event) => {
    const target = event.target.closest("[data-id]");
    const p = point(event);
    if (target) {
      const n = byId.get(target.getAttribute("data-id"));
      if (n) {
        drag = { n, dx: n.x - toWorld(p).x, dy: n.y - toWorld(p).y, moved: false };
        n.fixed = true;
      }
    } else {
      pan = { x: p.x - sim.x, y: p.y - sim.y };
      canvas.classList.add("dragging");
    }
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    const p = point(event);
    if (drag) {
      const world = toWorld(p);
      drag.n.x = world.x + drag.dx;
      drag.n.y = world.y + drag.dy;
      drag.n.vx = 0; drag.n.vy = 0;
      drag.moved = true;
      reheat();
      paint();
    } else if (pan) {
      sim.x = p.x - pan.x;
      sim.y = p.y - pan.y;
      paint();
    }
  });

  const release = (event) => {
    if (drag) {
      // A click is a drag that went nowhere. Treating them separately is what makes a node both movable and
      // selectable without a second control.
      if (!drag.moved) openNode(drag.n.id);
      drag.n.fixed = false;
      drag = null;
    }
    pan = null;
    canvas.classList.remove("dragging");
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const p = point(event);
    const before = toWorld(p);
    sim.scale = Math.min(6, Math.max(0.25, sim.scale * (event.deltaY < 0 ? 1.12 : 0.89)));
    // Keep the world point under the cursor where it was, or zooming drifts the graph away from what you aimed at.
    sim.x = p.x - before.x * sim.scale;
    sim.y = p.y - before.y * sim.scale;
    paint();
  }, { passive: false });
}

/* --------------------------------------------------------------------- detail */

async function openNode(id) {
  const [type, value] = String(id).split(/:(.*)/s);
  if (type === "memory") return openMemory(value);
  state.selected = id;
  try {
    const params = type === "agent" ? { agent: value, limit: 200 } : { event: value, limit: 200 };
    const payload = await api("/api/edges", params);
    state.nodes = payload.nodes;
    state.edges = payload.edges;
    renderDetail(el("h2", {}, `${type} · ${truncate(value, 60)}`), [
      el("p", { class: "feel" }, `${payload.edges.length} edges · graph reseeded from this node`),
      edgeTable(payload),
    ]);
    if (state.view === "graph") drawGraph();
  } catch (error) {
    status(String(error.message ?? error), true);
  }
}

async function openMemory(id) {
  state.selected = `memory:${id}`;
  try {
    const payload = await api("/api/memory", { id });
    const m = payload.memory;
    const nodes = [
      el("h2", {}, truncate(m.summary, 200)),
      kv([
        ["agent", m.agent_id],
        ["session", m.session_id],
        ["trigger", m.trigger],
        ["created", when(m.created_at)],
        ["repo", m.repo ?? ""],
        ["cwd", m.cwd ?? ""],
        ["vector", m.embedding_model ? `${m.embedding_model} · ${m.embedding_dim}-dim` : "none"],
        ["span", `${m.span_first_event} → ${m.span_last_event}`],
        ["dream_seq", m.dream_seq],
      ]),
      el("h3", {}, "subjects"),
      chips(m.subjects),
      el("h3", {}, "feel"),
      el("p", { class: "feel" }, m.feel ?? ""),
      el("h3", {}, `edges (${payload.edges.length})`),
      edgeTable({ nodes: [], edges: payload.edges }),
      el("h3", {}, `events in the span (${payload.span.length})`),
      eventTable(payload.span),
    ];
    if (m.detail && Object.keys(m.detail).length) {
      nodes.push(el("h3", {}, "detail"));
      for (const [key, value] of Object.entries(m.detail)) nodes.push(kv([[key, truncate(typeof value === "string" ? value : JSON.stringify(value), 400)]]));
    }
    renderDetail(...nodes);
  } catch (error) {
    status(String(error.message ?? error), true);
  }
}

function edgeTable(payload) {
  const table = el("table");
  table.append(
    head(["kind", "from", "to", "at", "meta"]),
    body(payload.edges.map((edge) => {
      const tr = el("tr");
      tr.style.borderLeft = `3px solid ${KIND_COLOURS[edge.kind] ?? "#555"}`;
      tr.append(
        el("td", { class: "kind" }, edge.kind),
        el("td", { class: "prose" }, truncate(edge.src_label ?? edge.src ?? "", 60)),
        el("td", { class: "prose" }, truncate(edge.dst_label ?? edge.dst ?? "", 60)),
        el("td", { class: "dim" }, when(edge.at)),
        el("td", { class: "dim" }, edge.meta ? truncate(JSON.stringify(edge.meta), 90) : ""),
      );
      return tr;
    })),
  );
  return table;
}

function eventTable(rows) {
  const table = el("table");
  table.append(
    head(["seq", "kind", "tool", "text"]),
    body(rows.map((row) => {
      const tr = el("tr");
      tr.append(
        el("td", { class: "num" }, String(row.seq)),
        el("td", { class: "dim" }, row.kind),
        el("td", { class: "kind" }, row.tool_name ?? ""),
        el("td", { class: "prose" }, truncate(row.preview, 200)),
      );
      return tr;
    })),
  );
  return table;
}

function kv(pairs) {
  const wrap = el("div", { class: "kv" });
  for (const [k, v] of pairs) {
    wrap.append(el("b", {}, k));
    wrap.append(el("span", {}, String(v ?? "")));
  }
  return wrap;
}

function renderDetail(...nodes) {
  const detail = $("detail");
  detail.replaceChildren();
  const close = el("button", { class: "close" }, "close");
  close.addEventListener("click", () => { detail.classList.add("hidden"); state.selected = null; });
  detail.append(close, ...nodes);
  detail.classList.remove("hidden");
}

/* -------------------------------------------------------------------- plumbing */

function show(which) {
  $("table").classList.toggle("hidden", which !== "table");
  $("graph").classList.toggle("hidden", which !== "graph");
}

for (const button of $("tabs").querySelectorAll("button")) {
  button.addEventListener("click", () => {
    for (const other of $("tabs").querySelectorAll("button")) other.classList.toggle("on", other === button);
    state.view = button.dataset.view;
    $("detail").classList.add("hidden");
    run();
  });
}
$("go").addEventListener("click", run);
$("q").addEventListener("keydown", (event) => { if (event.key === "Enter") run(); });
for (const id of ["agent", "kind", "limit", "mode"]) $(id).addEventListener("change", run);

function fmt(n) { return Number(n ?? 0).toLocaleString("en-GB"); }
function truncate(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("en-GB", { hour12: false });
}
function ago(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const minutes = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

loadChrome()
  .then(run)
  .catch((error) => status(`${error.message ?? error} — the store or the auth gate is not reachable from here`, true));
