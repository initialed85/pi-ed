/**
 * The reading room's guards.
 *
 * These tests do not look at pixels. They check the four things that make a read-only window onto a live store safe
 * to put behind a public hostname:
 *
 *   1. nothing a caller types reaches the SQL text - only `$n` placeholders;
 *   2. every list has a ceiling, so `?limit=999999` cannot turn a page load into a full export;
 *   3. the static handler cannot be walked out of `ui/public`;
 *   4. the API answers 401 when no gate vouched for the request.
 *
 * Plus one live check, because it is the only one that cannot be proved by reading: that the pool really is
 * read-only, so a future write endpoint fails rather than succeeds.
 *
 *   PI_LIVE_DSN="$DSN" npx vitest run test/memory-ui.test.ts
 */
import { afterAll, describe, expect, it } from "vitest";

import { MAX_ROWS, edgesQuery, eventsQuery, handle, identity, memoryDetailQueries, memoriesQuery, pool, vectorSearchQuery } from "../ui/server.mjs";
import type { QuerySpec } from "../ui/server.mjs";

const liveDsn = process.env.PI_LIVE_DSN ?? "";

/** The response is captured rather than sent, and `writeHead` returns `this` because that is what node's does. */
function fakeResponse() {
  const sent: { status: number; headers: Record<string, string>; body: string } = { status: 0, headers: {}, body: "" };
  return {
    sent,
    writeHead(status: number, headers: Record<string, string> = {}) {
      sent.status = status;
      sent.headers = headers;
      return this;
    },
    end(body: string | Buffer | Uint8Array = "") {
      sent.body = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
      return this;
    },
  };
}

async function call(url: string, headers: Record<string, string> = {}) {
  const response = fakeResponse();
  await handle({ url, headers }, response);
  return response.sent;
}

afterAll(async () => {
  await pool.end();
});

describe("query builders", () => {
  // Typed as a uniform list on purpose. Left to inference this array is a tuple of four different shapes, and the loop
  // that walks it then has to call a union of function signatures - which TypeScript refuses, correctly, because the
  // compiler cannot know which builder it is holding. Naming the element type once is cheaper than arguing per call.
  const cases: Array<{ name: string; build: () => QuerySpec; expected: unknown[] }> = [
    { name: "memories", build: () => memoriesQuery({ agent: "pi-ed", match: "dream'; drop table", limit: "10", offset: "0" }), expected: ["pi-ed", "%dream'; drop table%", 10, 0] },
    { name: "events", build: () => eventsQuery({ agent: "ocr", kind: "tool_call", tool: "bash", match: "rm -rf", limit: "5" }), expected: ["ocr", "tool_call", "bash", "%rm -rf%", 5] },
    { name: "edges", build: () => edgesQuery({ agent: "pi-ed", kind: "wakes", memory: "uuid-1", event: "43912", limit: "20" }), expected: ["pi-ed", "wakes", "uuid-1", "43912", 20] },
    { name: "vector", build: () => vectorSearchQuery({ vector: [0.1, -0.2], agent: "pi-ed", limit: "10" }), expected: ["[0.1,-0.2]", "pi-ed", 10] },
  ];

  it("sends every caller-supplied value as a parameter and none of it as SQL", () => {
    for (const { name, build, expected } of cases) {
      const spec = build();
      // Only string payloads are checked, and only a leading slice of them. A number is worthless as a fragment:
      // `limit 5` appears in the statement as `$5` anyway, so asserting on it makes the test fail on correct SQL -
      // which is what it first did.
      for (const value of expected.slice(1)) {
        if (typeof value !== "string") continue;
        const fragment = value.replace(/^%|%$/g, "").slice(0, 12);
        if (fragment.length < 4) continue;
        expect(spec.sql, `${name} inlined ${fragment}`).not.toContain(fragment);
      }
      expect(spec.values.slice(0, expected.length)).toEqual(expected);
    }
  });

  it("numbers placeholders to match the values it produced", () => {
    for (const { build } of cases) {
      const spec = build();
      const highest = Math.max(...[...spec.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(highest).toBe(spec.values.length);
    }
  });

  it("clamps every row limit to the ceiling", () => {
    // The limit's slot is stated per builder rather than found by scanning the values, because a builder's values array
    // also holds an offset, and an offset of zero is correct and would trip any "all numbers are positive" rule.
    // Naming the slot is the honest version of the assertion.
    const clamped: Array<{ name: string; build: (limit: string) => QuerySpec; slot: number }> = [
      { name: "memories", build: (limit) => memoriesQuery({ limit }), slot: -2 },
      { name: "events", build: (limit) => eventsQuery({ limit }), slot: -1 },
      { name: "edges", build: (limit) => edgesQuery({ limit }), slot: -1 },
      { name: "vector", build: (limit) => vectorSearchQuery({ vector: [0], limit }), slot: -1 },
    ];
    for (const { name, build, slot } of clamped) {
      for (const requested of ["999999", "0", "-5", "abc", ""]) {
        const limit = Number(build(requested).values.at(slot));
        expect(limit, `${name} asked for ${JSON.stringify(requested)}`).toBeGreaterThan(0);
        expect(limit, `${name} asked for ${JSON.stringify(requested)}`).toBeLessThanOrEqual(MAX_ROWS);
      }
    }
  });

  it("selects, and never writes", () => {
    const specs = [
      memoriesQuery({}),
      eventsQuery({}),
      edgesQuery({}),
      vectorSearchQuery({ vector: [0] }),
      ...Object.values(memoryDetailQueries("uuid")),
    ];
    for (const spec of specs) {
      const sql = spec.sql.toLowerCase();
      expect(sql.trim().startsWith("select")).toBe(true);
      for (const verb of ["insert ", "update ", "delete ", "drop ", "alter ", "truncate "]) expect(sql, sql.slice(0, 60)).not.toContain(verb);
    }
  });
});

describe("the identity gate", () => {
  it("reports who the gate vouched for", () => {
    expect(identity({ "x-auth-request-email": "ed@initialed85.cc", "x-auth-request-user": "ed" })).toEqual({ email: "ed@initialed85.cc", user: "ed" });
    expect(identity({ "x-auth-request-email": "  " })).toBeNull();
    expect(identity({})).toBeNull();
  });

  it("refuses the API when nothing vouched for the request", async () => {
    for (const path of ["/api/summary", "/api/memories", "/api/edges", "/api/search?q=dream"]) {
      const sent = await call(path);
      expect(sent.status, path).toBe(401);
      expect(JSON.parse(sent.body).error, path).toBe("no identity");
    }
    // 401 rather than the 503 an unconfigured store would earn: the ordering is the point. Being outside the gate is
    // the more urgent fact about a request, and an unconfigured store is not information a caller who was never
    // let in needs from us.
    if (!liveDsn) {
      const configured = await call("/api/summary", { "x-auth-request-email": "someone@example.com" });
      expect(configured.status).toBe(503);
      expect(JSON.parse(configured.body).error).toBe("not configured");
    }
  });

  it("still serves the page and the health check without one", async () => {
    // The page itself holds no memories, and a health check you cannot run from a port-forward is a health check you
    // do not run.
    expect((await call("/")).status).toBe(200);
    // What the health check SAYS depends on whether there is a store to be healthy about. This is the assertion the CI
    // lane wrote for me: it runs with no DSN, expected 200, and got a 500 manufactured by a driver complaining about a
    // connection string nobody supplied. "Not configured" and "the store is broken" are different facts, and a probe
    // that cannot tell them apart is a probe that reports a config error as an outage.
    const health = await call("/healthz");
    const payload = JSON.parse(health.body);
    if (liveDsn) {
      expect(health.status).toBe(200);
      expect(payload.ok).toBe(true);
    } else {
      expect(health.status).toBe(503);
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe("not configured");
    }
  });
});

describe("the static handler", () => {
  it("serves the three files the page needs", async () => {
    for (const path of ["/", "/app.js", "/styles.css"]) {
      const sent = await call(path);
      expect(sent.status, path).toBe(200);
      expect(sent.headers["content-type"], path).toContain("text/");
    }
  });

  it("cannot be walked out of ui/public", async () => {
    for (const path of ["/../package.json", "/..%2f..%2fpackage.json", "/%2e%2e%2f%2e%2e%2fetc/passwd", "/../../etc/passwd", "/ui/server.mjs"]) {
      const sent = await call(path);
      expect(sent.status, path).toBe(404);
      expect(sent.body).not.toContain("pi-ed");
    }
  });
});

describe("the API against the real store", () => {
  it("holds the pool to read-only, so a future write endpoint fails rather than succeeds", async () => {
    if (!liveDsn) return;
    const client = await pool.connect();
    try {
      await expect(client.query("create table memory.ui_guard_must_never_exist (n int)")).rejects.toThrow(/read-only/i);
      await expect(client.query("insert into memory.edge (kind, asserted_by) values ('wakes', 'nobody')")).rejects.toThrow(/read-only/i);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("answers the endpoints a browser will actually call", async () => {
    if (!liveDsn) return;
    const headers = { "x-auth-request-email": "ed@initialed85.cc" };
    const summary = JSON.parse((await call("/api/summary", headers)).body);
    expect(summary.edges).toBeGreaterThan(0);
    const edges = JSON.parse((await call("/api/edges?limit=25", headers)).body);
    expect(edges.edges.length).toBeGreaterThan(0);
    // Every edge must have two named, typed ends: an unnamed node is how a graph renders as a scatter of dots.
    for (const node of edges.nodes) {
      expect(node.id).toMatch(/^(memory|event|agent):/);
      expect(["memory", "event", "agent"]).toContain(node.type);
    }
    const search = JSON.parse((await call("/api/search?q=memory&mode=vector&limit=5", headers)).body);
    expect(["vector", "text-fallback"]).toContain(search.mode);
    if (search.mode === "vector") expect(Number(search.rows[0].similarity)).toBeGreaterThan(0);
  });
});
