import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callTool, createFakePi, createContext } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/graphiti.ts");

/**
 * A URL to a closed port, and a fetch stub.
 *
 * The graphiti door is unauthenticated HTTP in cluster, and its behaviour lives in what it puts on the wire: a
 * message without `role` is a 422 that stores nothing, and a message with a `uuid` is a 202 that stores nothing.
 * Neither is reproducible against a live Graphiti from CI, and both are exactly the failures a unit test can catch.
 * So these tests assert the request bodies, and the wording of the answers, which is what the fleet actually
 * depends on.
 */
const LIVE_URL = "http://memory-graph.invalid.test:9999";
const DEAD_URL = "http://127.0.0.1:1";

type Captured = { url: string; body: any };

let captured: Captured[];

function setEnv(url: string): void {
  process.env.MEMORY_GRAPH_URL = url;
  process.env.MEMORY_AGENT = "graphiti-test";
  delete process.env.MEMORY_GRAPH_DISABLED;
}

/** Deleting the variable is the whole test, so it gets its own function rather than a default parameter. */
function clearEnv(): void {
  delete process.env.MEMORY_GRAPH_URL;
  process.env.MEMORY_AGENT = "graphiti-test";
}

/** Stand in for the service. `respond` returns [status, body]; the request is recorded either way. */
function stubFetch(respond: (path: string) => [number, unknown] = () => [202, { status: "accepted" }]): void {
  captured = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const parsed = new URL(url);
    captured.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const [status, body] = respond(parsed.pathname);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  });
}

function stubTimeout(): void {
  captured = [];
  vi.stubGlobal("fetch", async () => {
    throw new Error("The operation timed out");
  });
}

async function load() {
  setEnv(LIVE_URL);
  const mod = await import(MODULE);
  const pi = createFakePi();
  await mod.default(pi);
  return { mod, pi };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  setEnv(LIVE_URL);
});

describe("graphiti configuration", () => {
  it("registers no memory tools at all when the door is not configured", async () => {
    // home-ops' acceptance condition: MEMORY_GRAPH_URL unset must be a clean no-op, not a hang or a crash.
    clearEnv();
    const mod = await import(MODULE);
    const pi = createFakePi();
    await mod.default(pi);
    expect([...pi.tools.keys()]).not.toContain("memory_remember");
    expect([...pi.tools.keys()]).not.toContain("memory_recall");
    expect(pi.lifecycleEvents).not.toContain("session_start");
  });

  it("offers both doors when it is configured", async () => {
    const { pi } = await load();
    expect([...pi.tools.keys()].sort()).toEqual(["memory_recall", "memory_remember"]);
    expect([...pi.commands.keys()]).toContain("graphiti");
  });

  it("names this agent's group from MEMORY_AGENT, not from a guess", async () => {
    const { pi } = await load();
    const tool = pi.tools.get("memory_remember") as any;
    expect(tool.description).toContain("graphiti-test");
  });
});

describe("writes", () => {
  it("sends role and role_type, and never sends a uuid", async () => {
    // The two traps home-ops paid an hour for. A uuid on a message makes graphiti_core re-raise
    // NodeNotFoundError *behind a 202*: an accepted memory that never existed.
    const { pi } = await load();
    stubFetch();
    const result = await callTool(pi, "memory_remember", { text: "the widget count is 7" }, createContext());
    const write = captured.find((call) => call.url.endsWith("/messages"));
    expect(write?.body.group_id).toBe("graphiti-test");
    expect(write?.body.update_mode).toBe("append");
    const message = write?.body.messages[0];
    expect(message.role).toBe("graphiti-test");
    expect(message.role_type).toBe("assistant");
    expect(message.content).toContain("the widget count is 7");
    expect(message.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(message)).not.toContain("uuid");
    expect(result.content[0].text).toContain("acknowledgement, not a memory");
  });

  it("redacts credential-shaped text before it goes on the wire", async () => {
    // Graphiti has no auth: every pod in home-dev reads every group, so this is not decoration.
    const { pi } = await load();
    stubFetch();
    const result = await callTool(
      pi,
      "memory_remember",
      { text: "the dsn is postgres://memory:hunter2aintsecret@memory.svc:5432/memory and that is the whole note" },
      createContext(),
    );
    const message = captured.find((call) => call.url.endsWith("/messages"))?.body.messages[0];
    expect(message.content).not.toContain("hunter2aintsecret");
    expect(message.content).toContain("[redacted:");
    expect(result.details.redactions).toBeGreaterThan(0);
  });

  it("writes to the named group only when an agent deliberately names one", async () => {
    const { pi } = await load();
    stubFetch();
    await callTool(pi, "memory_remember", { text: "fleet note", group: "fleet-note" }, createContext());
    expect(captured.find((call) => call.url.endsWith("/messages"))?.body.group_id).toBe("fleet-note");
  });

  it("says what a 422 means, because a 422 here means nothing was queued", async () => {
    const { pi } = await load();
    stubFetch((p) => (p === "/messages" ? [422, { detail: [{ msg: "role required" }] }] : [200, {}]));
    const result = await callTool(pi, "memory_remember", { text: "anything" }, createContext());
    expect(result.content[0].text).toContain("422");
    expect(result.content[0].text).toContain("role");
    expect(result.content[0].text).toContain("Nothing was written");
  });

  it("tells the agent that a timeout is not a failed write", async () => {
    const { pi } = await load();
    stubTimeout();
    const result = await callTool(pi, "memory_remember", { text: "anything" }, createContext());
    expect(result.content[0].text).toContain("stopped waiting");
    expect(result.content[0].text).toContain("never \"nothing was remembered\"");
  });
});

describe("reads", () => {
  it("shows the validity window so staleness is visible rather than swallowed", async () => {
    const { pi } = await load();
    stubFetch(() => [200, {
      facts: [
        { fact: "the fleet deployed cognee in 2026-11", valid_at: "2026-11-08T00:00:00+00:00", invalid_at: "2026-11-10T00:00:00+00:00" },
        { fact: "the fleet deploys graphiti", valid_at: "2026-11-10T00:00:00+00:00", invalid_at: null },
      ],
    }]);
    const result = await callTool(pi, "memory_recall", { query: "what memory backend" }, createContext());
    const text = result.content[0].text;
    expect(text).toContain("valid 2026-11-08T00:00:00+00:00, invalid 2026-11-10T00:00:00+00:00");
    expect(text).toContain("still held");
    expect(text).toContain("2 fact(s)");
  });

  it("warns that a full-looking answer can still be about something else", async () => {
    const { pi } = await load();
    stubFetch(() => [200, { facts: [{ fact: "unrelated", valid_at: "x" }] }]);
    const result = await callTool(pi, "memory_recall", { query: "anything" }, createContext());
    expect(result.content[0].text).toContain("can still be about something else");
  });

  it("reports an empty read as this door being quiet, never as the fleet having forgotten", async () => {
    const { pi } = await load();
    stubFetch(() => [200, { facts: [] }]);
    const result = await callTool(pi, "memory_recall", { query: "what is the widget count" }, createContext());
    const text = result.content[0].text;
    expect(text).toContain("not proof the fleet never wrote it down");
    expect(text).not.toContain("no memories exist");
  });

  it("scopes to this agent's group by default and drops the scope only when asked fleet-wide", async () => {
    const { pi } = await load();
    stubFetch(() => [200, { facts: [] }]);
    await callTool(pi, "memory_recall", { query: "a" }, createContext());
    expect(captured.at(-1)?.body.group_ids).toEqual(["graphiti-test"]);
    await callTool(pi, "memory_recall", { query: "a", fleetWide: true }, createContext());
    expect(captured.at(-1)?.body.group_ids).toBe(null);
  });

  it("caps max_facts at the cap, because asking harder is not a knob here", async () => {
    const { pi } = await load();
    stubFetch(() => [200, { facts: [] }]);
    await callTool(pi, "memory_recall", { query: "a", maxFacts: 400 }, createContext());
    expect(captured.at(-1)?.body.max_facts).toBe(20);
  });
});

describe("the live door, as far as CI can reach it", () => {
  it("fails as an unreachable service rather than as a missing memory", async () => {
    setEnv(DEAD_URL);
    const mod = await import(MODULE);
    const pi = createFakePi();
    await mod.default(pi);
    const result = await callTool(pi, "memory_recall", { query: "anything at all" }, createContext());
    expect(result.content[0].text).toMatch(/could not reach graphiti|stopped waiting/);
    expect(result.content[0].text).not.toContain("0 fact(s)");
  });
});
