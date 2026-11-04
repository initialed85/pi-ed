import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { visibleWidth } from "@earendil-works/pi-tui";

import { createFakeFooterData, createFakePi, createContext, fakeTheme, type FakePi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/turn-stats.ts");

/** Load the extension against a fresh module registry, so its module-level state starts empty. */
async function load(): Promise<FakePi> {
  // Same-file reloads need the module registry cleared, and turn-stats keeps its per-turn state at
  // module scope exactly as Pi would load it once per process.
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}


const WIDTH = 100;

/** The headers rooter actually sends, spelled the way Go spells them on the wire. */
function rooterHeaders(over: Record<string, string> = {}): Record<string, string> {
  return {
    "x-rooter-request-id": "1ab2cbe1ffc2/37",
    "x-rooter-backend": "strata",
    "x-rooter-model": "qwen3.8-flash-next-iq3_xxs",
    "x-rooter-route": "gen",
    "x-rooter-wait-ms": "0.004",
    "x-rooter-ttft-ms": "181.5",
    "x-rooter-completion-tokens": "8",
    "x-rooter-prefill-tok-s": "27",
    "x-rooter-decode-tok-s": "48.2",
    "x-rooter-cache-hit-rate": "0.9074074074074074",
    ...over,
  };
}

interface Installed {
  component: any;
  footerData: ReturnType<typeof createFakeFooterData>;
}

/** Drive the extension the way Pi does: session start, then a provider call, then turn end. */
async function drive(
  pi: FakePi,
  options: {
    headers?: Record<string, string>;
    streamEvents?: Array<{ data: Record<string, unknown>; advanceMs?: number }>;
    requestStartToHeadersMs?: number;
    headersToMessageEndMs?: number;
    messageEndToTurnEndMs?: number;
    assistant?: { model?: string; responseModel?: string; output?: number };
    hasUI?: boolean;
    cwd?: string;
    statuses?: Array<[string, string]>;
    branch?: string | null;

  } = {},
): Promise<Installed | undefined> {
  const session = createContext({ hasUI: options.hasUI ?? true, cwd: options.cwd ?? "/home/edward/Projects/Home/rooter" });
  await pi.emit("session_start", { type: "session_start" }, session.context);
  const factory = session.ui.footerFactory;
  if (!factory) return undefined;

  const footerData = createFakeFooterData({ branch: options.branch ?? "master", statuses: options.statuses ?? [] });
  const component = factory({} as any, fakeTheme, footerData);

  await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, session.context);

  // The extension times a call with Date.now(), so the test owns the clock: a virtual one that
  // starts at a fixed instant and steps by whatever the test says. Without this every measured
  // duration in every test would be "however long vitest took to run four lines".
  const real = Date.now;
  let virtual = 1_730_000_000_000;
  const step = (ms: number) => {
    virtual += ms;
  };
  Date.now = () => virtual;
  try {
    await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, session.context);
    step(options.requestStartToHeadersMs ?? 0);
    await pi.emit(
      "after_provider_response",
      { type: "after_provider_response", status: 200, headers: options.headers ?? rooterHeaders() },
      session.context,
    );
    for (const event of options.streamEvents ?? []) {
      step(event.advanceMs ?? 0);
      await pi.emit(
        "provider_stream_event",
        { type: "provider_stream_event", provider: "openai", api: "openai-completions", model: "auto", data: event.data },
        session.context,
      );
    }
    step(options.headersToMessageEndMs ?? 0);
    await pi.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          model: options.assistant?.model ?? "auto",
          responseModel: options.assistant?.responseModel,
          usage: { output: options.assistant?.output ?? 8, input: 54, totalTokens: 62 },
        },
      },
      session.context,
    );
    step(options.messageEndToTurnEndMs ?? 0);
    await pi.emit("turn_end", { type: "turn_end", turnIndex: 0 }, session.context);
  } finally {
    Date.now = real;
  }

  return { component, footerData };
}

/** The footer renders exactly one line; tests read it without the colour tags the fake theme adds. */
function line(component: any, width = WIDTH): string {
  const lines = component.render(width);
  expect(lines).toHaveLength(1);
  // pi-tui's own truncateToWidth can emit an SGR reset, and the fake theme tags every fragment with
  // a bracketed colour name. Neither is content a reader sees, so neither belongs in an assertion.
  return lines[0]
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\[[a-zA-Z]+\]|\[\/[a-zA-Z]+\]/g, "");
}

describe("turn-stats", () => {
  let pi: FakePi;

  beforeEach(async () => {
    pi = await load();
  });

  it("registers only the lifecycle events it needs, and no commands or tools", () => {
    expect(pi.commands.size).toBe(0);
    expect(pi.tools.size).toBe(0);
    expect(pi.flags.size).toBe(0);
  });

  it("draws nothing where there is no footer to draw", async () => {
    const session = createContext({ hasUI: false, mode: "print" });
    await pi.emit("session_start", { type: "session_start" }, session.context);
    expect(session.ui.footerFactory).toBeUndefined();
  });

  it("renders one dim line with the time, the wait, the rate, the model and the box", async () => {
    const installed = await drive(pi, { branch: "master" });
    expect(installed).toBeDefined();
    // Wide enough for both halves. At 100 columns the stats win the space and the path is dropped,
    // which is the priority the footer states; asserting the path here is asserting the layout, not
    // the numbers.
    const text = line(installed!.component, 120);

    expect(text).toContain("master");
    expect(text).toContain("Projects/Home/rooter");
    // Rooter said 48.2 tok/s and 8 tokens out; both are the runner's numbers, not this extension's.
    expect(text).toContain("48.2 tok/s");
    expect(text).toContain("qwen3.8-flash-next-iq3_xxs");
    expect(text).toContain("→ strata");
    // A clock to the second is the whole of "when", and it costs one token of width.
    expect(text).toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
    // The three extras that live on /rooter/metrics and in Grafana are deliberately not here: the
    // line is five fields wide so the model name does not have to share it with a cache ratio.
    expect(text).not.toContain("cache");
    expect(text).not.toContain("prefill");
    expect(text).not.toContain(" out ");
  });

  it("right-aligns the stats and drops the path before it drops a number", async () => {
    const installed = await drive(pi);
    expect(installed).toBeDefined();

    // Wide enough for both halves: the line is padded out to the viewport and the stats sit at the
    // right edge, which is the only way a single line can be right-aligned.
    const wide = line(installed!.component, 120);
    expect(visibleWidth(wide)).toBe(120);
    expect(wide.endsWith("→ strata")).toBe(true);
    expect(wide).toContain("Projects/Home/rooter");

    // Not wide enough for both: the path goes, the numbers stay.
    const narrow = line(installed!.component, 70);
    expect(narrow).toContain("48.2 tok/s");
    expect(narrow).not.toContain("Projects/Home/rooter");
    expect(narrow.endsWith("→ strata")).toBe(true);
  });

  it("names the model that answered rather than the alias that was requested", async () => {
    // Rooter cannot know at header time which model `auto` will land on, and says so by sending
    // `auto` back. The runner's own chunk is the answer.
    const installed = await drive(pi, {
      headers: rooterHeaders({ "x-rooter-model": "auto", "x-rooter-streamed": "1" }),
      streamEvents: [{ data: { model: "beamster/Qwen3.8-Flash-Next-Sushi-2.6bpw" } }],
      assistant: { model: "auto", output: 8 },
    });
    expect(installed).toBeDefined();
    const text = line(installed!.component);
    expect(text).toContain("beamster/Qwen3.8-Flash-Next-Sushi-2.6bpw");
    expect(text).not.toContain(" auto ");
  });

  it("marks a locally measured number so it is not read as the server's", async () => {
    // A stream has no server-measured time to first byte, so this extension times its own arrival.
    // That is a different kind of number and has to look different.
    // Rooter cannot publish a measurement it did not make, so on a stream it publishes the routing
    // headers only and every number here is this extension's own. Deleting the measurement headers is
    // what the wire actually looks like, not a shortcut.
    const headers = rooterHeaders({ "x-rooter-streamed": "1" });
    for (const key of ["x-rooter-ttft-ms", "x-rooter-decode-tok-s", "x-rooter-prefill-tok-s", "x-rooter-completion-tokens", "x-rooter-cache-hit-rate"]) {
      delete headers[key];
    }
    // Twelve tokens arriving two hundred milliseconds apart is a decoding window the extension can
    // actually measure; twelve tokens and no timestamps would be a number out of nothing.
    const installed = await drive(pi, {
      headers,
      assistant: { model: "auto", output: 12 },
      requestStartToHeadersMs: 400,
      streamEvents: [
        { data: { model: "qwen-model" }, advanceMs: 100 },
        ...Array.from({ length: 11 }, () => ({ data: { choices: [{ delta: { content: "x" } }] }, advanceMs: 200 })),
      ],
    });
    expect(installed).toBeDefined();
    const text = line(installed!.component);
    expect(text).toMatch(/ttft ~500ms/);
    // 12 tokens over the 2.2s they arrived in, not over the 2.7s the call existed for.
    expect(text).toMatch(/~5\.5 tok\/s/);
  });

  it("publishes no measured rate for a held body it cannot time", async () => {
    // No runner rate and no arrival window is not license to divide tokens by wall clock. That
    // number has queueing and prefill in it and would be a decode rate in name only.
    const headers = rooterHeaders();
    delete headers["x-rooter-decode-tok-s"];
    const installed = await drive(pi, {
      headers,
      assistant: { model: "auto", output: 8 },
      requestStartToHeadersMs: 300,
      headersToMessageEndMs: 9_000,
    });
    expect(installed).toBeDefined();
    const text = line(installed!.component);
    expect(text).not.toContain("tok/s");
    expect(text).toContain("182ms");
  });

  it("trusts the runner's rate over its own arithmetic", async () => {
    const installed = await drive(pi, { headers: rooterHeaders({ "x-rooter-decode-tok-s": "12.5" }) });
    expect(installed).toBeDefined();
    const text = line(installed!.component);
    expect(text).toContain("12.5 tok/s");
    expect(text).not.toContain("~12.5");
  });

  it("keeps working against a backend that publishes nothing", async () => {
    // Not every model is behind rooter, and a footer that only works when a proxy cooperates is a
    // footer that breaks when one is removed.
    const installed = await drive(pi, { headers: {}, assistant: { model: "some-model", responseModel: "some-model", output: 12 } });
    expect(installed).toBeDefined();
    const text = line(installed!.component);
    expect(text).toContain("some-model");
    expect(text).not.toContain("→");
    expect(text).toContain("some-model");
  });

  it("shows other extensions' statuses, because owning the footer does not mean evicting them", async () => {
    const installed = await drive(pi, { statuses: [["tags", "tags #rooter #wip"]] });
    expect(installed).toBeDefined();
    const text = line(installed!.component);
    expect(text).toContain("tags #rooter #wip");
  });

  it("sums the provider calls in a turn rather than showing only the last one", async () => {
    const session = createContext();
    await pi.emit("session_start", { type: "session_start" }, session.context);
    const footerData = createFakeFooterData({ branch: "master" });
    const component = session.ui.footerFactory!({} as any, fakeTheme, footerData);

    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, session.context);
    for (const tokens of [8, 12]) {
      await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, session.context);
      await pi.emit(
        "after_provider_response",
        { type: "after_provider_response", status: 200, headers: rooterHeaders({ "x-rooter-completion-tokens": String(tokens) }) },
        session.context,
      );
      await pi.emit(
        "message_end",
        { type: "message_end", message: { role: "assistant", model: "auto", usage: { output: tokens } } },
        session.context,
      );
    }
    await pi.emit("turn_end", { type: "turn_end", turnIndex: 0 }, session.context);

    const text = line(component, 140);
    // Two calls answered and both rates are the runner's own, so the aggregate the footer is allowed
    // to show is total tokens over total time, which is measurably not "48.2".
    expect(text).toContain("tok/s");
    expect(text).not.toContain("48.2 tok/s");
  });

  it("starts a fresh turn instead of carrying the previous one's numbers", async () => {
    const first = await drive(pi, { headers: rooterHeaders({ "x-rooter-completion-tokens": "8" }) });
    expect(first).toBeDefined();
    expect(line(first!.component)).toContain("48.2 tok/s");

    const session = createContext();
    await pi.emit("session_start", { type: "session_start" }, session.context);
    const footerData = createFakeFooterData({ branch: "master" });
    const component = session.ui.footerFactory!({} as any, fakeTheme, footerData);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, session.context);
    await pi.emit("turn_end", { type: "turn_end", turnIndex: 1 }, session.context);
    // A turn with no provider call has nothing to report, and inventing the last turn's numbers
    // would be the worst thing a stats line could do.
    const fresh = line(component);
    expect(fresh).not.toContain("tok/s");
    expect(fresh).not.toContain("ttft");
    expect(fresh).not.toContain("strata");
  });

  it("notices a branch change instead of rendering the branch it happened to start on", async () => {
    const installed = await drive(pi, { branch: "master" });
    expect(installed).toBeDefined();
    expect(line(installed!.component, 120)).toContain("master");
    installed!.footerData.setBranch("feature/rooter-catalog");
    installed!.component.invalidate();
    const text = line(installed!.component, 120);
    expect(text).toContain("feature/rooter-catalog");
    expect(text).not.toContain(" master");
  });

  it("unsubscribes from branch changes when Pi disposes the footer", async () => {
    const installed = await drive(pi);
    expect(installed).toBeDefined();
    expect(installed!.footerData.subscribers).toHaveLength(1);
    installed!.component.dispose?.();
    expect(installed!.footerData.subscribers).toHaveLength(0);
  });
});
