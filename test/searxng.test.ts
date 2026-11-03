import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createContext, fakeTheme, painted, callTool, createFakePi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/searxng.ts");

const DEFAULT_BASE = "https://searxng.dev.initialed85.cc";

interface FetchRecord {
  url: URL;
  options: RequestInit | undefined;
}

const fetches: FetchRecord[] = [];

/** A canned SearXNG `/search?format=json` body, shaped like the real thing. */
function searxngPayload(overrides: Record<string, unknown> = {}) {
  return {
    query: "k3s certificate rotation",
    number_of_results: 12,
    results: [
      {
        title: "K3s | Certificate Rotation",
        url: "https://docs.k3s.io/security/certificate-rotation",
        content: "  Learn\nhow   to rotate\nthe certificates.  ",
        engines: ["google", "duckduckgo"],
        parsed_url: ["https", "docs.k3s.io", "/", ""],
      },
      {
        title: "Certificate rotation - Rancher",
        url: "https://rancher.com/docs/k3s/latest/en/install/certificate-rotation/",
        content: "x".repeat(500),
        engines: ["bing"],
      },
    ],
    answers: [],
    suggestions: [],
    unresponsive_engines: [
      ["brave", "too many requests"],
      ["mojeek", "timed out"],
    ],
    ...overrides,
  };
}

async function load(options: { url?: string; response?: unknown } = {}) {
  const restore = { ...process.env };
  if (options.url === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = options.url;
  vi.resetModules();
  try {
    const mod = await import(MODULE);
    const pi = createFakePi();
    mod.default(pi as any);
    return pi;
  } finally {
    process.env = restore;
  }
}

function respondWith(body: unknown, init: { status?: number; json?: boolean } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, options?: RequestInit) => {
      fetches.push({ url: new URL(String(input)), options });
      const status = init.status ?? 200;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return new Response(text, {
        status,
        headers: { "content-type": init.json === false ? "text/html" : "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  fetches.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web_search (searxng)", () => {
  let pi: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    pi = await load();
  });

  it("owns the built-in tool name so it replaces DuckDuckGo", () => {
    const tool = pi.tools.get("web_search")!;
    expect(tool.label).toBe("web_search");
    expect(tool.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
    expect(tool.parameters).toMatchObject({
      required: ["query"],
      properties: {
        query: { type: "string" },
        count: { type: "number" },
        categories: { type: "string" },
        time_range: { type: "string", enum: ["day", "week", "month", "year"] },
        pageno: { type: "number" },
      },
    });
  });

  it("queries the JSON API on the home instance", async () => {
    respondWith(searxngPayload());
    const { context } = createContext();
    await callTool(pi, "web_search", { query: "k3s certificate rotation" }, context);

    expect(fetches).toHaveLength(1);
    const url = fetches[0]!.url;
    expect(url.origin).toBe(DEFAULT_BASE);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("k3s certificate rotation");
    // The format is the reason the tool works at all: the ConfigMap must list json in `formats`.
    expect(url.searchParams.get("format")).toBe("json");
    expect(fetches[0]!.options?.headers).toMatchObject({ accept: "application/json" });
  });

  it("only sends the optional parameters the caller set", async () => {
    respondWith(searxngPayload());
    const { context } = createContext();
    await callTool(pi, "web_search", { query: "x" }, context);
    expect([...fetches[0]!.url.searchParams.keys()].sort()).toEqual(["format", "q"]);

    await callTool(
      pi,
      "web_search",
      { query: "x", categories: "it,news", time_range: "week", pageno: 3 },
      context,
    );
    const params = fetches[1]!.url.searchParams;
    expect(params.get("categories")).toBe("it,news");
    expect(params.get("time_range")).toBe("week");
    expect(params.get("pageno")).toBe("3");
  });

  it("formats the results the LLM sees, and keeps the structured detail", async () => {
    respondWith(searxngPayload());
    const { context } = createContext();
    const result = await callTool(pi, "web_search", { query: "k3s certificate rotation" }, context);

    expect(result.content[0].text).toBe(
      [
        "1. K3s | Certificate Rotation",
        "   https://docs.k3s.io/security/certificate-rotation",
        "   Learn how to rotate the certificates.",
        "2. Certificate rotation - Rancher",
        "   https://rancher.com/docs/k3s/latest/en/install/certificate-rotation/",
        `   ${"x".repeat(400)}`,
        "",
        "(unresponsive engines: brave: too many requests, mojeek: timed out)",
      ].join("\n"),
    );

    expect(result.structuredContent).toMatchObject({
      query: "k3s certificate rotation",
      results: [
        {
          title: "K3s | Certificate Rotation",
          url: "https://docs.k3s.io/security/certificate-rotation",
          snippet: "Learn how to rotate the certificates.",
          engines: "google,duckduckgo",
        },
        {
          title: "Certificate rotation - Rancher",
          url: "https://rancher.com/docs/k3s/latest/en/install/certificate-rotation/",
          snippet: "x".repeat(400),
          engines: "bing",
        },
      ],
      unresponsive_engines: ["brave: too many requests", "mojeek: timed out"],
    });
    expect(result.details).toEqual({
      query: "k3s certificate rotation",
      count: 2,
      unresponsive: ["brave: too many requests", "mojeek: timed out"],
    });
  });

  it("clamps the result count to 1..25 and defaults to 8", async () => {
    const many = {
      ...searxngPayload(),
      results: Array.from({ length: 40 }, (_unused, i) => ({
        title: `r${i}`,
        url: `https://example.com/${i}`,
        content: "",
        engines: ["google"],
      })),
    };
    respondWith(many);
    const { context } = createContext();

    expect((await callTool(pi, "web_search", { query: "x" }, context)).details.count).toBe(8);
    expect((await callTool(pi, "web_search", { query: "x", count: 100 }, context)).details.count).toBe(25);
    expect((await callTool(pi, "web_search", { query: "x", count: 0 }, context)).details.count).toBe(1);
    expect((await callTool(pi, "web_search", { query: "x", count: 2.9 }, context)).details.count).toBe(2);
  });

  it("survives a thin or malformed payload", async () => {
    respondWith({ unresponsive_engines: [] });
    const { context } = createContext();
    const result = await callTool(pi, "web_search", { query: "nothing" }, context);
    expect(result.content[0].text).toBe('No results for "nothing".');
    expect(result.structuredContent.query).toBe("nothing");
    expect(result.structuredContent.results).toEqual([]);
  });

  it("says when a result has no title", async () => {
    respondWith(searxngPayload({ results: [{ url: "https://example.com", content: "body" }] }));
    const { context } = createContext();
    const result = await callTool(pi, "web_search", { query: "x" }, context);
    expect(result.structuredContent.results[0]).toMatchObject({ title: "(untitled)", engines: "" });
  });

  it("explains the gate on 403 instead of passing it through", async () => {
    respondWith("forbidden", { status: 403, json: false });
    const { context } = createContext();
    await expect(callTool(pi, "web_search", { query: "x" }, context)).rejects.toThrow(
      /403: the ingress allowlist \(traefik-common-lan-tailscale-only\)/,
    );
  });

  it("names other HTTP failures", async () => {
    respondWith("boom", { status: 502, json: false });
    const { context } = createContext();
    await expect(callTool(pi, "web_search", { query: "x" }, context)).rejects.toThrow(/HTTP 502/);
  });

  it("diagnoses a disabled json format", async () => {
    respondWith("<html><body>formats: json is not enabled</body></html>", { json: false });
    const { context } = createContext();
    await expect(callTool(pi, "web_search", { query: "x" }, context)).rejects.toThrow(/formats.*configmap\.yaml/);
  });

  it("diagnoses an unreachable instance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:443");
      }),
    );
    const { context } = createContext();
    await expect(callTool(pi, "web_search", { query: "x" }, context)).rejects.toThrow(
      new RegExp(`searxng unreachable at ${DEFAULT_BASE.replace(/\./g, "\\.")}`),
    );
  });

  it("aborts when the agent cancels the call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: URL | string, options?: RequestInit) => {
        fetches.push({ url: new URL(String(_input)), options });
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }),
    );
    const controller = new AbortController();
    const { context } = createContext();
    const pending = callTool(pi, "web_search", { query: "x" }, context, { signal: controller.signal });
    // The extension combines the caller's signal with its own 30s timeout; aborting the caller's
    // has to be enough to stop the request.
    await vi.waitFor(() => expect(fetches.length).toBe(1));
    controller.abort();
    await expect(pending).rejects.toThrow(/searxng unreachable/);
  });

  it("honours SEARXNG_URL", async () => {
    const withUrl = await load({ url: "http://127.0.0.1:8888///" });
    respondWith(searxngPayload({ results: [], unresponsive_engines: [] }));
    const { context } = createContext();
    await callTool(withUrl, "web_search", { query: "x" }, context);
    expect(fetches[0]!.url.toString()).toBe("http://127.0.0.1:8888/search?q=x&format=json");
  });

  it("renders the call and the result in the TUI", async () => {
    respondWith(searxngPayload());
    const { context } = createContext();
    const tool = pi.tools.get("web_search")!;
    const result = await callTool(pi, "web_search", { query: "k3s", categories: "it" }, context);

    expect(painted(tool.renderCall!({ query: "k3s", categories: "it" }, fakeTheme, {}))).toBe(
      "[toolTitle]*web_search *[/toolTitle][accent]k3s[/accent][dim] [it][/dim]",
    );
    expect(painted(tool.renderResult!(result, { expanded: false }, fakeTheme, {}))).toBe(
      '[success]2 results for [/success][accent]"k3s certificate rotation"[/accent][warning] (2 engines unresponsive)[/warning]',
    );
    expect(painted(tool.renderResult!(result, { expanded: true }, fakeTheme, {}))).toContain(
      "https://docs.k3s.io/security/certificate-rotation",
    );
    expect(painted(tool.renderCall!({ query: "k3s", time_range: "week" }, fakeTheme, {}))).toContain(
      "[dim] <week>[/dim]",
    );
  });

  it("renders nothing when the result carries no details", () => {
    const tool = pi.tools.get("web_search")!;
    expect(painted(tool.renderResult!({ content: [], details: undefined }, { expanded: true }, fakeTheme, {}))).toBe(
      "",
    );
  });
});
