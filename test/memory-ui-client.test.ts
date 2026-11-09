// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" /> // NodeListOf is only spreadable with it, and the test spreads nodes into arrays
/**
 * The reading room's client, rendered.
 *
 * This file exists because a human saw the bug, not a test. The reading room shipped with tables that rendered as
 * `[object HTMLTableRowElement]` and a detail pane that rendered as
 * `[object HTMLParagraphElement],[object HTMLTableElement]`, and the entire suite was green throughout, because every
 * test in it is a server test: the client had never been rendered anywhere. That is the honest lesson here, and it is
 * why this file mounts the real page and runs the real client against a canned store.
 *
 * What it asserts is deliberately blunt - a row is a row, a cell contains text and not the stringification of a node,
 * and the string `[object ` appears nowhere in the rendered document. A helper that confuses a node with a string
 * produces exactly that substring, and no clever assertion is needed to catch it.
 *
 * `jsdom` is the dependency, not a hand-rolled DOM stub: a stub is a second implementation of the API under test, and
 * the whole defect was about how the real `Element.append` treats a non-node.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Resolved from the project root rather than `import.meta.url`: in the jsdom environment vitest rewrites
// `import.meta.url` to a non-file URL, and `readFileSync` then refuses it. The suite runs from the repo root.
const PAGE = readFileSync(join(process.cwd(), "ui/public/index.html"), "utf8");
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";

const identity = { email: "ed@initialed85.cc", user: null, group: null };

const summary = {
  identity,
  memories: 84,
  memories_embedded: 84,
  events: 30944,
  edges: 32246,
  agents: 1,
  sessions: 1,
  room_edges: 139,
  newest_edge_at: "2026-11-09T04:52:39.875Z",
  newest_memory_at: "2026-11-09T05:32:32.046Z",
};

const facets = {
  identity,
  agents: [{ id: "pi-ed", n: 84 }],
  edgeKinds: [
    { kind: "memory_about", n: 31755 },
    { kind: "dreamed_from", n: 79 },
    { kind: "wakes", n: 12 },
  ],
};

const memories = {
  mode: "newest",
  model: null,
  rows: [
    {
      id: MEMORY_ID,
      agent_id: "pi-ed",
      session_id: "01a1a9b1",
      trigger: "idle10m",
      summary: "Shipped the memory reading room: the UI, the Woodpecker lane, and the trust bit that was missing.",
      subjects: ["memory-ui", "pi-ed", "woodpecker ci"],
      feel: "Good stretch.",
      similarity: null,
      edges: 7,
      created_at: "2026-11-09T05:32:32.046Z",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      agent_id: "slopyphus",
      session_id: "01a1a6d9",
      trigger: "manual",
      summary: "tmux wheel scrolling, settled by measurement.",
      subjects: ["tmux"],
      feel: "Tidy.",
      similarity: 0.6235,
      edges: 2,
      created_at: "2026-11-08T02:02:02.000Z",
    },
  ],
};

const memoryDetail = {
  memory: {
    id: MEMORY_ID,
    agent_id: "pi-ed",
    session_id: "01a1a9b1",
    trigger: "idle10m",
    summary: "Shipped the memory reading room: the UI, the Woodpecker lane, and the trust bit that was missing.",
    subjects: ["memory-ui", "pi-ed", "woodpecker ci"],
    feel: "Good stretch: two failures that were real rather than flaky.",
    repo: "pi-ed",
    cwd: "/workspace/pi-ed",
    embedding_model: "bge-base-en-v1.5",
    embedding_dim: 768,
    span_first_event: 475670,
    span_last_event: 475901,
    dream_seq: 12,
    detail: { model: "claude-opus-5" },
    created_at: "2026-11-09T05:32:32.046Z",
  },
  edges: [
    {
      id: "31756",
      kind: "memory_about",
      src: "memory:11111111-1111-4111-8111-111111111111",
      dst: "event:475774",
      src_label: "Shipped the memory reading room",
      dst_label: "turn-stats",
      at: "2026-11-09T05:32:32.046Z",
      meta: { asserted_by: "pi-ed" },
    },
    {
      id: "31757",
      kind: "dreamed_from",
      src: "memory:11111111-1111-4111-8111-111111111111",
      dst: "memory:22222222-2222-4222-8222-222222222222",
      src_label: "Shipped the memory reading room",
      dst_label: "tmux wheel scrolling",
      at: "2026-11-09T05:32:32.046Z",
      meta: null,
    },
  ],
  span: [
    { seq: 475770, kind: "user", tool_name: null, preview: "not bad mate, its tidy" },
    { seq: 475771, kind: "tool_call", tool_name: "read", preview: "ui/public/app.mjs" },
  ],
};

/** The canned store: enough surface for the client to build its filters, its table and its detail pane. */
function installStore() {
  const routes: Record<string, unknown> = {
    "/api/summary": summary,
    "/api/facets": facets,
    "/api/memories": memories,
    "/api/search": { ...memories, mode: "vector", model: "bge-base-en-v1.5" },
    "/api/memory": memoryDetail,
    "/api/events": { rows: [] },
    "/api/edges": { nodes: [], edges: [] },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), "http://localhost:3000");
      const payload = routes[url.pathname];
      if (payload === undefined) return new Response(JSON.stringify({ error: `unstubbed route ${url.pathname}` }), { status: 404 });
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

/** Mount the real page minus its module script, so `boot()` can be called against it. */
function mountPage() {
  const body = PAGE.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1];
  if (!body) throw new Error("ui/public/index.html has no <body> to mount");
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
}

async function client() {
  vi.resetModules();
  return await import("../ui/public/app.mjs");
}

beforeEach(() => {
  mountPage();
  installStore();
});

describe("the render helper", () => {
  it("appends nodes instead of stringifying them", async () => {
    const { el } = await client();
    const cell = el("td", {}, el("span", { class: "chip" }, "memory-ui"));
    expect(cell.innerHTML).toBe('<span class="chip">memory-ui</span>');
    expect(cell.textContent).toBe("memory-ui");
    expect(cell.textContent).not.toContain("[object ");
  });

  it("flattens arrays, so a list cannot arrive as one child", async () => {
    const { el } = await client();
    const p = el("p", {}, ["dreamed_from", el("b", {}, "79")]);
    expect(p.querySelectorAll("b").length).toBe(1);
    expect(p.textContent).toBe("dreamed_from79");
  });

  it("keeps numbers and empty cells honest", async () => {
    const { el } = await client();
    expect(el("td", {}, 0).textContent).toBe("0");
    expect(el("td", {}, "").innerHTML).toBe("");
    expect(el("td", {}, null).innerHTML).toBe("");
  });

  it("builds a thead whose header row is a row, not the words 'HTMLTableRowElement'", async () => {
    const { el, head, body } = await client();
    const thead = head(["when", "agent", "summary"]);
    expect(thead.querySelectorAll("tr").length).toBe(1);
    expect(thead.querySelectorAll("th").length).toBe(3);
    expect(thead.textContent).toBe("whenagentsummary");

    // The defect this file was written for: `el("tbody", {}, ...rows)` with a helper that accepted one `text`
    // argument discarded every row, so a table of 87 memories rendered as a header and nothing else.
    const tbody = body([el("tr", {}, el("td", {}, "a")), el("tr", {}, el("td", {}, "b"))]);
    expect(tbody.querySelectorAll("tr").length).toBe(2);
    expect(tbody.textContent).toBe("ab");
  });
});

describe("the memories view, mounted", () => {
  it("renders one row per memory, with cells that are cells", async () => {
    const { boot } = await client();
    boot();
    await vi.waitFor(() => expect(document.querySelectorAll("#table tbody tr").length).toBe(2));

    const rows = [...document.querySelectorAll("#table tbody tr")];
    const cells = [...rows[0]!.querySelectorAll("td")].map((td) => td.textContent);
    expect(cells).toContain("pi-ed");
    expect(cells).toContain("idle10m");
    expect(cells.some((c) => c?.includes("memory reading room"))).toBe(true);
    expect(rows[0]!.querySelectorAll(".chip").length).toBe(3);
    expect(rows[1]!.querySelector(".sim")!.textContent).toBe("0.624");
    expect(rows[0]!.querySelector(".num")!.textContent).toBe("7");

    // The header row exists too: `[object HTMLTableElement]` was the other half of the same bug.
    expect([...document.querySelectorAll("#table thead th")].map((th) => th.textContent)).toEqual([
      "when", "agent", "trigger", "summary", "subjects", "similarity", "edges",
    ]);
    expect(document.body.textContent).not.toContain("[object ");
  });

  it("states the store's own numbers rather than a snapshot typed into the client", async () => {
    const { boot } = await client();
    boot();
    await vi.waitFor(() => expect(document.getElementById("summary")!.textContent).toContain("32,246 edges"));
    expect(document.getElementById("store")!.textContent).toContain("reachable");
    expect(document.getElementById("who")!.textContent).toContain("ed@initialed85.cc");
    // Filters and legend are built from /api/facets: a new edge kind appears without a client change.
    expect([...document.querySelectorAll("#kind option")].map((o) => o.textContent)).toContain("wakes (12)");
    expect([...document.querySelectorAll("#legend span")].length).toBe(3 + 3);
  });
});

describe("the detail pane", () => {
  it("opens on a row click with a paragraph and two tables, not their stringifications", async () => {
    const { boot } = await client();
    boot();
    await vi.waitFor(() => expect(document.querySelectorAll("#table tbody tr").length).toBe(2));

    (document.querySelector("#table tbody tr") as HTMLElement).click();
    await vi.waitFor(() => expect(document.getElementById("detail")!.classList.contains("hidden")).toBe(false));

    const detail = document.getElementById("detail")!;
    expect(detail.querySelector("h2")!.textContent).toContain("memory reading room");
    expect(detail.textContent).toContain("bge-base-en-v1.5 · 768-dim");
    expect(detail.textContent).toContain("475670 → 475901");
    expect(detail.querySelectorAll(".chip").length).toBe(3);
    expect(detail.textContent).toContain("Good stretch: two failures that were real rather than flaky.");

    // One table for the edges, one for the span, each with its own rows.
    const tables = [...detail.querySelectorAll("table")];
    expect(tables.length).toBe(2);
    expect(tables[0]!.querySelectorAll("tbody tr").length).toBe(2);
    expect(tables[0]!.querySelectorAll("thead th").length).toBe(5);
    expect(tables[1]!.querySelectorAll("tbody tr").length).toBe(2);
    expect(detail.textContent).toContain("asserted_by");

    // This is the exact string Ed's screenshot showed, produced by passing an array where nodes were expected.
    expect(detail.textContent).not.toContain("[object ");
    expect(document.body.textContent).not.toContain("[object ");
  });
});

describe("the page's contract with the client", () => {
  it("loads the client as a module and boots it by name", () => {
    expect(PAGE).toContain('<script type="module">');
    expect(PAGE).toContain('import { boot } from "/app.mjs"');
    expect(PAGE).not.toContain("src=\"/app.js\"");
  });
});
