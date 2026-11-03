import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext } from "./harness.ts";

const MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../extensions/compaction-summary-guard.ts",
);

// The guard's whole job is to call Pi's own compaction with different request parameters, so the
// summarisation call itself is the one thing this suite has to stand in for. Everything else in the
// module (including the CompactionResult type it returns) is the real package.
const mockCompact = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, compact: mockCompact };
});

const SUMMARY_TARGET_TOKENS = 4000;
const SUMMARY_OUTPUT_TOKENS = 8192;
// Mirrors the extension's own derivation, so a test that measures the trim boundary in characters is
// using the same number the guard is.
const SUMMARY_MAX_CHARS = SUMMARY_TARGET_TOKENS * 4;

function makeCompaction(summary: string, usage: Record<string, number> = { output: 900 }) {
  return {
    summary,
    firstKeptEntryId: "entry-7",
    tokensBefore: 120000,
    usage,
    details: { readFiles: ["/work/old.ts"], modifiedFiles: [] },
  };
}

function makePreparation() {
  return {
    firstKeptEntryId: "entry-7",
    messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "do the thing" }] }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 120000,
    previousSummary: "earlier summary of the same task",
    fileOps: { read: new Set<string>(["/work/kept.ts"]), written: new Set<string>(), edited: new Set<string>() },
    // The session's real settings: a threshold of 16384 reserve tokens, which is what makes the
    // default 13107-token cap too small for a reasoning model.
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 12000 },
  };
}

function makeEvent(options: { aborted?: boolean; customInstructions?: string; branchEntries?: unknown[] } = {}) {
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  return {
    type: "session_before_compact",
    preparation: makePreparation(),
    branchEntries: options.branchEntries ?? [],
    customInstructions: options.customInstructions,
    reason: "threshold",
    willRetry: false,
    signal: controller.signal,
  };
}

async function load() {
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}

/** Run the guard, returning the result it handed Pi plus the context it ran in. */
async function run(
  event: ReturnType<typeof makeEvent>,
  options: Parameters<typeof createContext>[0] = {},
) {
  const pi = await load();
  const { context, ui } = createContext({
    model: { provider: "sushi", id: "qwen3.8-flash-next", maxTokens: 32000 },
    ...options,
  });
  const [result] = await pi.emit("session_before_compact", event, context);
  return { result, ui, context, event };
}

const GOOD = "goal: ship it; state: tests green; next: push";

beforeEach(() => {
  mockCompact.mockReset();
  mockCompact.mockResolvedValue(makeCompaction(GOOD));
});

describe("compaction summary guard", () => {
  it("summarises with a bounded response and no thinking", async () => {
    const { event, result } = await run(makeEvent());
    expect(result).toEqual({ compaction: expect.objectContaining({ summary: GOOD }) });
    expect(mockCompact).toHaveBeenCalledTimes(1);

    const args = mockCompact.mock.calls[0]!;
    expect(args[1]).toMatchObject({ id: "qwen3.8-flash-next" });
    expect(args[2]).toBe("test-api-key");
    // reserveTokens is only read here to size the response cap; the copy keeps the session's
    // real trigger threshold intact.
    expect(args[0].settings.reserveTokens).toBe(Math.ceil(SUMMARY_OUTPUT_TOKENS / 0.8));
    expect(event.preparation.settings.reserveTokens).toBe(16384);
    // The preparation handed to Pi is a copy, so the session's settings are untouched.
    expect(args[0]).not.toBe(event.preparation);
    expect(args[5]).toBe(event.signal);
    expect(args[6]).toBe("off");
  });

  it("keeps the caller's focus and adds the length budget", async () => {
    await run(makeEvent({ customInstructions: "focus on the deploy" }));
    const instructions = mockCompact.mock.calls[0]![4] as string;
    expect(instructions.startsWith("focus on the deploy\n\n")).toBe(true);
    expect(instructions).toContain(`Length budget (hard requirement): keep the whole summary under ${SUMMARY_TARGET_TOKENS} tokens`);
    expect(instructions).toContain("never let it grow just because the conversation or a previous summary is long");
  });

  it("passes the model's auth, headers and env through", async () => {
    const { result } = await run(makeEvent(), {
      apiKeyResult: {
        ok: true,
        apiKey: "sk-from-registry",
        headers: { "x-provider": "laya", "x-numeric": 7 as unknown as string, "x-null": null as unknown as string },
        env: { LAYA_KEY: "sk-from-registry" },
      },
    });
    const args = mockCompact.mock.calls[0]!;
    // Only string header values survive: the rest would be rejected by the provider anyway.
    expect(args[3]).toEqual({ "x-provider": "laya" });
    expect(args[8]).toEqual({ LAYA_KEY: "sk-from-registry" });
    expect(result).toBeDefined();
  });

  it("leaves the headers argument undefined when the registry returned none", async () => {
    await run(makeEvent());
    expect(mockCompact.mock.calls[0]![3]).toBeUndefined();
  });

  it("falls back to Pi's default compaction when the model has no auth", async () => {
    const { result, ui } = await run(makeEvent(), {
      apiKeyResult: { ok: false, error: "no key" },
    });
    expect(mockCompact).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(ui.notifications.map((n) => n.message)).toEqual([
      "Compaction summary guard: no auth for sushi/qwen3.8-flash-next, using default compaction",
    ]);
    expect(ui.notifications[0]!.level).toBe("warning");
  });

  it("does nothing without a model, or when the run is already aborted", async () => {
    const noModel = await run(makeEvent(), { model: undefined });
    expect(noModel.result).toBeUndefined();
    expect(mockCompact).not.toHaveBeenCalled();

    const aborted = await run(makeEvent({ aborted: true }));
    expect(aborted.result).toBeUndefined();
    expect(mockCompact).not.toHaveBeenCalled();
    expect(aborted.ui.notifications).toHaveLength(0);
  });

  it("compresses an oversized summary instead of failing compaction", async () => {
    mockCompact
      .mockResolvedValueOnce(makeCompaction(GOOD, { output: 9000 }))
      .mockResolvedValueOnce(makeCompaction("shorter", { output: 1800 }));

    const { result, ui } = await run(makeEvent());

    expect(result).toEqual({ compaction: expect.objectContaining({ summary: "shorter" }) });
    expect(mockCompact).toHaveBeenCalledTimes(2);
    expect(mockCompact.mock.calls[1]![4]).toContain("Rewrite it from scratch, targeting under 2000 tokens");
    expect(ui.notifications.map((n) => n.message)).toEqual([
      "Compaction summary compressed to budget after 1 retries in threshold compaction",
    ]);
  });

  // The case that kept firing in practice: ~5000 against a 4000 budget. The old code retried twice and
  // then fell back to the default path, which is the thing this extension exists to avoid.
  it("accepts a slightly over-budget summary instead of spending two more calls", async () => {
    mockCompact.mockResolvedValue(makeCompaction(GOOD, { output: Math.round(SUMMARY_TARGET_TOKENS * 1.25) }));
    const { result, ui } = await run(makeEvent());

    expect(result).toEqual({ compaction: expect.objectContaining({ summary: GOOD }) });
    expect(mockCompact).toHaveBeenCalledTimes(1);
    expect(ui.notifications.map((n) => n.message)).toEqual([
      "Compaction summary guard: summary used 5000 output tokens (limit 4000); accepted rather than spending two more summarisation calls",
    ]);
    expect(ui.notifications.at(-1)!.level).toBe("info");
  });

  it("applies the same tolerance to the length estimate when there is no usage", async () => {
    const slightlyOver = "y".repeat(Math.round(SUMMARY_TARGET_TOKENS * 1.25) * 4);
    mockCompact.mockResolvedValue(makeCompaction(slightlyOver, {}));
    const { result } = await run(makeEvent());
    expect(result).toEqual({ compaction: expect.objectContaining({ summary: slightlyOver }) });
    expect(mockCompact).toHaveBeenCalledTimes(1);
  });

  it("takes the second, harder compression when the first is still too long", async () => {
    mockCompact
      .mockResolvedValueOnce(makeCompaction(GOOD, { output: 9000 }))
      .mockResolvedValueOnce(makeCompaction(GOOD, { output: 8000 }))
      .mockResolvedValueOnce(makeCompaction("tiny", { output: 400 }));

    const { result } = await run(makeEvent());
    expect(result).toEqual({ compaction: expect.objectContaining({ summary: "tiny" }) });
    expect(mockCompact).toHaveBeenCalledTimes(3);
    expect(mockCompact.mock.calls[2]![4]).toContain("at most 1000 tokens");
  });

  it("judges oversize by length when the provider reports no usage", async () => {
    const oversized = "y".repeat(SUMMARY_TARGET_TOKENS * 4 * 3);
    mockCompact
      .mockResolvedValueOnce(makeCompaction(oversized, {}))
      .mockResolvedValueOnce(makeCompaction(GOOD, {}));
    const { result } = await run(makeEvent());
    expect(result).toEqual({ compaction: expect.objectContaining({ summary: GOOD }) });
    expect(mockCompact).toHaveBeenCalledTimes(2);
  });

  // The behaviour change. An over-budget summary is still a summary, and the alternative is Pi's
  // default compaction, which is the path that was failing on the token cap.
  it("keeps the over-budget summary rather than falling back to default compaction", async () => {
    mockCompact.mockResolvedValue(makeCompaction(GOOD, { output: 9999 }));
    const { result, ui } = await run(makeEvent());

    expect(result).toEqual({ compaction: expect.objectContaining({ summary: GOOD }) });
    expect(mockCompact).toHaveBeenCalledTimes(3);
    expect(ui.notifications.at(-1)?.message).toBe(
      `Compaction summary guard: summary used 9999 output tokens (limit 4000); using the ${Math.ceil(GOOD.length / 4)}-token summary rather than default compaction`,
    );
    expect(ui.notifications.at(-1)!.level).toBe("warning");
  });

  it("keeps the smallest summary it managed, not the last one", async () => {
    mockCompact
      .mockResolvedValueOnce(makeCompaction("x".repeat(9000), { output: 9000 }))
      .mockResolvedValueOnce(makeCompaction("y".repeat(6000), { output: 6000 }))
      .mockResolvedValueOnce(makeCompaction("z".repeat(30000), { output: 30000 }));
    const { result } = await run(makeEvent());

    expect(result).toEqual({
      compaction: expect.objectContaining({ summary: expect.stringContaining("y".repeat(500)) }),
    });
    expect((result as any).compaction.summary).not.toContain("z".repeat(500));
  });

  it("trims a summary that is silly rather than passing it through whole", async () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"x".repeat(80)}`).join("\n");
    expect(huge.length).toBeGreaterThan(SUMMARY_MAX_CHARS * 2);
    mockCompact.mockResolvedValue(makeCompaction(huge, { output: 60000 }));
    const { result, ui } = await run(makeEvent());

    const summary = (result as any).compaction.summary as string;
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(summary).toContain("truncated by compaction-summary-guard to fit the 4000-token budget");
    // A line boundary, not a character count: the tail of the last kept line is intact.
    expect(summary.split("\n").every((line) => /^line \d+: x{80}$/.test(line) || line === "" || line.startsWith("(truncated")))
      .toBe(true);
    expect(ui.notifications.at(-1)?.message).toContain("trimmed to budget");
  });

  it("still falls back when there is no summary to keep", async () => {
    mockCompact.mockRejectedValue(new Error("429 rate limited"));
    const { result, ui } = await run(makeEvent());
    expect(result).toBeUndefined();
    expect(ui.notifications.at(-1)?.message).toContain("falling back to default compaction");
  });

  it("does not retry an empty summary", async () => {
    mockCompact.mockResolvedValue(makeCompaction("   ", { output: 10 }));
    const { result, ui } = await run(makeEvent());
    expect(result).toBeUndefined();
    expect(mockCompact).toHaveBeenCalledTimes(1);
    expect(ui.notifications.at(-1)?.message).toContain("summary was empty; falling back to default compaction");
  });

  it("retries the token-cap failure that started all of this", async () => {
    mockCompact
      .mockRejectedValueOnce(new Error("Summarization failed: generation hit the token cap and the summary is incomplete"))
      .mockResolvedValueOnce(makeCompaction(GOOD));

    const { result, ui } = await run(makeEvent());
    expect(result).toEqual({ compaction: expect.objectContaining({ summary: GOOD }) });
    expect(mockCompact).toHaveBeenCalledTimes(2);
    // The second attempt is the COMPRESS_HARDER one, and the success is reported.
    expect(mockCompact.mock.calls[1]![4]).toContain("Rewrite it from scratch, targeting under 2000 tokens");
    expect(ui.notifications.map((n) => n.message)).toEqual([
      "Compaction summary compressed to budget after 1 retries in threshold compaction",
    ]);
  });

  it("does not retry an unrelated failure", async () => {
    mockCompact.mockRejectedValue(new Error("429 rate limited"));
    const { result, ui } = await run(makeEvent());
    expect(result).toBeUndefined();
    expect(mockCompact).toHaveBeenCalledTimes(1);
    expect(ui.notifications.at(-1)?.message).toContain("429 rate limited; falling back to default compaction");
  });

  it("stops retrying when the run is aborted mid-flight", async () => {
    const controller = new AbortController();
    mockCompact.mockImplementation(async () => {
      controller.abort();
      throw new Error("generation hit the token cap");
    });
    const event = makeEvent();
    event.signal = controller.signal;

    const { result, ui } = await run(event);
    expect(result).toBeUndefined();
    expect(mockCompact).toHaveBeenCalledTimes(1);
    // Aborted means the user moved on, not that the guard failed: stay quiet.
    expect(ui.notifications).toHaveLength(0);
  });

  it("uses Pi's own request retry policy for the summarisation call", async () => {
    await run(makeEvent());
    expect(mockCompact.mock.calls[0]![9]).toEqual({
      enabled: true,
      maxRetries: 2,
      baseDelayMs: 2000,
      maxAgentDelayMs: 15000,
    });
  });

  it("carries the previous compaction's file lists forward", async () => {
    const branchEntries = [
      { type: "message", message: { role: "user" } },
      {
        type: "compaction",
        summary: "older",
        details: { readFiles: ["/work/older.ts"], modifiedFiles: ["/work/older-edit.ts"] },
      },
      {
        type: "compaction",
        summary: "newest",
        details: { readFiles: ["/work/newest.ts", 42], modifiedFiles: "not an array" },
      },
    ];
    const { result } = await run(makeEvent({ branchEntries }));

    const prepared = mockCompact.mock.calls[0]![0];
    expect([...prepared.fileOps.read]).toEqual(["/work/kept.ts", "/work/newest.ts"]);
    expect([...prepared.fileOps.edited]).toEqual([]);
    // Only the newest previous compaction is merged; Pi already carries anything older than that.
    expect(prepared.fileOps.read).not.toContain("/work/older.ts");
    expect(result).toBeDefined();
  });

  it("tolerates a compaction entry with no details at all", async () => {
    const { result } = await run(makeEvent({ branchEntries: [{ type: "compaction" }] }));
    expect(result).toBeDefined();
    expect([...mockCompact.mock.calls[0]![0].fileOps.read]).toEqual(["/work/kept.ts"]);
  });

  it("merges the file lists even when it cannot summarise", async () => {
    // The merge happens before the auth check, and it mutates the preparation in place, so a
    // fallback compaction still carries the files forward.
    const event = makeEvent({ branchEntries: [{ type: "compaction", details: { readFiles: ["/x.ts"] } }] });
    const { result } = await run(event, { apiKeyResult: { ok: false, error: "no key" } });
    expect(result).toBeUndefined();
    expect(mockCompact).not.toHaveBeenCalled();
    expect([...event.preparation.fileOps.read]).toEqual(["/work/kept.ts", "/x.ts"]);
  });
});
