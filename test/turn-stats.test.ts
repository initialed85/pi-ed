import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { visibleWidth } from "@earendil-works/pi-tui";

import { createContext, createFakePi, fakeTheme, type FakePi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/turn-stats.ts");
const ENTRY_TYPE = "turn-stats";

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

/**
 * Drop the measurement headers the way rooter does on a stream.
 *
 * Rooter cannot publish a time-to-first-byte it did not observe, and a stream's headers and its first
 * byte are the same instant, so the wire genuinely carries only the routing headers. Deleting them
 * here is what the proxy sends, not a test shortcut.
 */
function streamHeaders(over: Record<string, string> = {}): Record<string, string> {
  const headers = rooterHeaders({ "x-rooter-streamed": "1", ...over });
  for (const key of ["x-rooter-ttft-ms", "x-rooter-decode-tok-s", "x-rooter-prefill-tok-s", "x-rooter-completion-tokens", "x-rooter-cache-hit-rate"]) {
    delete headers[key];
  }
  return headers;
}

interface DriveOptions {
  headers?: Record<string, string>;
  streamEvents?: Array<{ data: Record<string, unknown>; advanceMs?: number }>;
  /** Wall clock from the request to the response headers arriving. */
  requestStartToHeadersMs?: number;
  headersToMessageEndMs?: number;
  assistant?: { model?: string; responseModel?: string; output?: number; stopReason?: string };
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "print" | "json";
}

/**
 * Drive the extension the way Pi does, and return the rows it wrote to the transcript.
 *
 * The extension times a call with `Date.now()`, so this owns the clock: a virtual one that starts at
 * a fixed instant and steps by whatever the test says. Without it, every measured duration in every
 * test would be "however long vitest took to run four lines".
 */
async function drive(pi: FakePi, options: DriveOptions = {}): Promise<any[]> {
  const session = createContext({
    hasUI: options.hasUI ?? true,
    mode: options.mode,
    cwd: "/home/edward/Projects/Home/rooter",
  });
  await pi.emit("session_start", { type: "session_start" }, session.context);

  await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, session.context);

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
          stopReason: options.assistant?.stopReason,
          usage: { output: options.assistant?.output ?? 8, input: 54, totalTokens: 62 },
        },
      },
      session.context,
    );
    await pi.emit("agent_end", { type: "agent_end", messages: [] }, session.context);
  } finally {
    Date.now = real;
  }

  return pi.appendedEntries.filter((entry) => entry.type === ENTRY_TYPE);
}

/** Draw one appended row the way Pi would, and return the plain text it painted. */
function paint(pi: FakePi, entry: any, width = WIDTH, expanded = false): string {
  const renderer = pi.entryRenderers.get(ENTRY_TYPE);
  if (!renderer) throw new Error("test: extension registered no entry renderer");
  const component = renderer({ type: "custom", customType: ENTRY_TYPE, data: entry.data }, { expanded }, fakeTheme);
  expect(component).toBeDefined();
  const lines = component.render(width);
  expect(lines.length).toBeGreaterThanOrEqual(1);
  // The fake theme tags every fragment with a bracketed colour name and pi-tui's own
  // truncateToWidth can emit an SGR reset. Neither is content a reader sees.
  return lines
    .join("\n")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\[[a-zA-Z]+\]|\[\/[a-zA-Z]+\]/g, "")
    .trimEnd();
}

/** The single row a drive produced, painted. Fails loudly if the turn produced more than one. */
function one(pi: FakePi, entries: any[], width = WIDTH, expanded = false): string {
  expect(entries).toHaveLength(1);
  return paint(pi, entries[0], width, expanded);
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
    expect(pi.entryRenderers.has(ENTRY_TYPE)).toBe(true);
  });

  it("writes the row as a session entry, so the model never sees it", async () => {
    const entries = await drive(pi);
    expect(entries).toHaveLength(1);
    // The alternative API renders identically and then hands the whole thing to the model as a user
    // turn. A stats line that costs context tokens is a stats line that gets you fired.
    expect(pi.sentUserMessages).toHaveLength(0);
    expect(pi.messageRenderers.size).toBe(0);
  });

  it("draws nothing where there is no transcript to draw into", async () => {
    const entries = await drive(pi, { hasUI: false, mode: "print" });
    expect(entries).toHaveLength(0);
  });

  it("shows the time, the wait, the rate, the model and the box", async () => {
    const text = one(pi, await drive(pi));
    // Rooter said 48.2 tok/s and 8 tokens out; both are the runner's numbers, not this extension's.
    expect(text).toContain("48.2 tok/s");
    expect(text).toContain("qwen3.8-flash-next-iq3_xxs");
    expect(text).toContain("→ strata");
    // A clock to the second is the whole of "when", and it costs one token of width.
    expect(text).toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
    // The extras that live on /rooter/metrics and in Grafana are deliberately not here: the line is
    // five fields wide so the model name does not have to share it with a cache ratio.
    expect(text).not.toContain("cache");
    expect(text).not.toContain("prefill");
    expect(text).not.toContain("8 tok");
  });

  it("pushes the row to the right edge of the transcript", async () => {
    const text = one(pi, await drive(pi), 120);
    expect(visibleWidth(text)).toBe(120);
    expect(text.endsWith("→ strata")).toBe(true);
    // Narrower than the row: the padding goes, the numbers stay, and the tail is what gets cut.
    // A fresh extension, because a second drive on the same one would add a second row.
    const second = await load();
    const cut = one(second, await drive(second), 40);
    expect(cut).toContain("48.2 tok/s");
    expect(visibleWidth(cut)).toBeLessThanOrEqual(40);
  });

  it("is dim, because it is a margin note and not an answer", async () => {
    const entries = await drive(pi);
    const renderer = pi.entryRenderers.get(ENTRY_TYPE)!;
    const component = renderer({ type: "custom", customType: ENTRY_TYPE, data: entries[0].data }, { expanded: false }, fakeTheme);
    const raw = component.render(100)[0];
    expect(raw).toContain("[dim]");
  });

  it("names the model that answered rather than the alias that was requested", async () => {
    // Rooter cannot know at header time which model `auto` will land on, and says so by sending
    // `auto` back. The runner's own chunk is the answer.
    const entries = await drive(pi, {
      headers: rooterHeaders({ "x-rooter-model": "auto", "x-rooter-streamed": "1" }),
      streamEvents: [{ data: { model: "beamster/Qwen3.8-Flash-Next-Sushi-2.6bpw" } }],
      assistant: { model: "auto", output: 8 },
    });
    const text = one(pi, entries);
    expect(text).toContain("beamster/Qwen3.8-Flash-Next-Sushi-2.6bpw");
    expect(text).not.toContain(" auto ");
  });

  it("marks a locally measured number so it is not read as the server's", async () => {
    // Twelve tokens arriving two hundred milliseconds apart is a decoding window the extension can
    // actually measure; twelve tokens and no timestamps would be a number out of nothing.
    const entries = await drive(pi, {
      headers: streamHeaders(),
      assistant: { model: "auto", output: 12 },
      requestStartToHeadersMs: 400,
      streamEvents: [
        { data: { model: "qwen-model" }, advanceMs: 100 },
        ...Array.from({ length: 11 }, () => ({ data: { choices: [{ delta: { content: "x" } }] }, advanceMs: 200 })),
      ],
    });
    const text = one(pi, entries);
    expect(text).toMatch(/ttft ~700ms/);
    // 12 tokens over the 2.0s they actually arrived in: not the 2.7s the call existed for, and not
    // the 2.2s from the empty opening chunk either.
    expect(text).toMatch(/~6\.0 tok\/s/);
  });

  it("does not call an empty opening chunk a first token", async () => {
    // llama.cpp opens every stream with content:"". Timing to it reports 99ms for a response nobody
    // has read yet, when the first word was six seconds away.
    const entries = await drive(pi, {
      headers: streamHeaders(),
      assistant: { model: "auto", output: 4 },
      streamEvents: [
        { data: { choices: [{ delta: { role: "assistant", content: "" } }] }, advanceMs: 60 },
        { data: { choices: [{ delta: { content: "" } }] }, advanceMs: 40 },
        // What a thinking model actually says first, from a live sushi response.
        { data: { choices: [{ delta: { reasoning_content: "The" } }] }, advanceMs: 6_000 },
        { data: { choices: [{ delta: { content: "one" } }] }, advanceMs: 3_000 },
        { data: { choices: [{ delta: { content: "two" } }] }, advanceMs: 300 },
        { data: { choices: [{ delta: { content: "three" } }] }, advanceMs: 300 },
        { data: { choices: [{ delta: { content: "four" } }] }, advanceMs: 300 },
      ],
    });
    const text = one(pi, entries);
    expect(text).toMatch(/ttft ~6\.10s/);
    expect(text).not.toMatch(/ttft ~\d\dms/);
    // Not the first content delta either: the thinking arrived nine seconds before it,
    // and thinking is something the reader watches.
    expect(text).not.toMatch(/ttft ~9/);
    // 4 tokens over the 3.9s between the first word and the last.
    expect(text).toMatch(/~1\.0 tok\/s/);
  });

  it("publishes no measured rate for a held body it cannot time", async () => {
    // No runner rate and no arrival window is not license to divide tokens by wall clock. That
    // number has queueing and prefill in it and would be a decode rate in name only.
    const headers = rooterHeaders();
    delete headers["x-rooter-decode-tok-s"];
    const entries = await drive(pi, {
      headers,
      assistant: { model: "auto", output: 8 },
      requestStartToHeadersMs: 300,
      headersToMessageEndMs: 9_000,
    });
    const text = one(pi, entries);
    expect(text).not.toContain("tok/s");
    expect(text).toContain("182ms");
  });

  it("trusts the runner's rate over its own arithmetic", async () => {
    const text = one(pi, await drive(pi, { headers: rooterHeaders({ "x-rooter-decode-tok-s": "12.5" }) }));
    expect(text).toContain("12.5 tok/s");
    expect(text).not.toContain("~12.5");
  });

  it("keeps working against a backend that publishes nothing", async () => {
    // Not every model is behind rooter, and a line that only works when a proxy cooperates is a
    // line that breaks when one is removed.
    const text = one(pi, await drive(pi, { headers: {}, assistant: { model: "some-model", responseModel: "some-model", output: 12 } }));
    expect(text).toContain("some-model");
    expect(text).not.toContain("→");
  });

  it("adds the numbers worth having occasionally to the expanded view", async () => {
    const entries = await drive(pi);
    const compact = one(pi, entries, 200, false);
    const expanded = one(pi, entries, 200, true);
    expect(compact).not.toContain("cache");
    expect(expanded).toContain("8 tok");
    expect(expanded).toContain("cache 91%");
    expect(expanded).toContain("pre 27.0 tok/s");
    // rooter said 0.004ms, which is four microseconds and is not the same claim as "no wait".
    expect(expanded).toContain("queued <1ms");
  });

  it("writes one row per answer, so scrollback keeps the pairing", async () => {
    const session = createContext();
    await pi.emit("session_start", { type: "session_start" }, session.context);
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
    const entries = pi.appendedEntries.filter((entry) => entry.type === ENTRY_TYPE);
    expect(entries).toHaveLength(2);
    // Each row describes the call that produced it, so neither is an average of the other.
    expect(paint(pi, entries[0], 200, true)).toContain("8 tok");
    expect(paint(pi, entries[1], 200, true)).toContain("12 tok");
    expect(paint(pi, entries[0], 200, true)).not.toContain("12 tok");
  });

  it("reports a turn that ended without an answer, rather than nothing", async () => {
    const session = createContext();
    await pi.emit("session_start", { type: "session_start" }, session.context);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, session.context);
    await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, session.context);
    // Aborted before a message ever landed. The wait was real and it is the interesting one.
    await pi.emit("agent_end", { type: "agent_end", messages: [] }, session.context);
    const entries = pi.appendedEntries.filter((entry) => entry.type === ENTRY_TYPE);
    expect(entries).toHaveLength(1);
    expect((entries[0].data as { aborted?: boolean }).aborted).toBe(true);
  });

  it("does not invent a row for a turn that made no provider call", async () => {
    const session = createContext();
    await pi.emit("session_start", { type: "session_start" }, session.context);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, session.context);
    await pi.emit("agent_end", { type: "agent_end", messages: [] }, session.context);
    expect(pi.appendedEntries.filter((entry) => entry.type === ENTRY_TYPE)).toHaveLength(0);
  });

  it("starts a fresh turn instead of carrying the previous one's numbers", async () => {
    const first = await drive(pi, { headers: rooterHeaders({ "x-rooter-completion-tokens": "8" }) });
    expect(one(pi, first)).toContain("48.2 tok/s");

    const session = createContext();
    await pi.emit("session_start", { type: "session_start" }, session.context);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, session.context);
    await pi.emit("agent_end", { type: "agent_end", messages: [] }, session.context);
    // A second turn with no provider call has nothing to report, and repeating the last turn's
    // numbers would be the worst thing a stats line could do.
    expect(pi.appendedEntries.filter((entry) => entry.type === ENTRY_TYPE)).toHaveLength(1);
  });
});
