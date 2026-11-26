import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createContext, createFakePi, runCommand, type FakeContext, type FakePi, type FakeUi } from "./harness.ts";

/**
 * Compaction that happens while nobody is watching.
 *
 * Pi compacts at `contextWindow - reserveTokens`, and only there. Measured across this repository's own long
 * sessions: 102 compactions, `tokensBefore` clustered at 87.5% of the window, 70 s median and 226 s p90 of wall time
 * per compaction, and 100% of the ones I could attribute landed inside a run - while 92% of the wall time of those
 * same sessions sat in gaps longer than five minutes. The idle time to do the work in is already there; this file
 * uses it.
 *
 * What that makes worth asserting, in order:
 *
 * 1. **The scheduler never competes with a turn.** Anything that means a turn is happening or about to happen
 *    cancels the armed window: activity, a queued prompt, a run that is not settled, an abort.
 * 2. **The arithmetic has to be worth a call.** Pi keeps 20000 recent tokens verbatim and these summaries measure
 *    about 2500, so a compaction that would free 6000 tokens is churn and a compaction that would free 90000 is not.
 * 3. **A compaction nobody is waiting for must not become a wait.** If it is still running at the deadline, this
 *    extension aborts it and the session keeps what it had.
 * 4. **The quiet window is re-checked when it fires**, not just when it opens. Two minutes is long enough for all of
 *    it to change.
 * 5. **Stale tool output is measured before it is dropped.** Tool results are 3.40M of the 5.00M characters of
 *    transcript in those sessions - 68% - and dropping them is the one context reduction that needs no model call.
 *    The default mode counts them and touches nothing; the assertions on the `on` mode are the protections.
 *
 * Timers are fake throughout, so the numbers under test are the shipped defaults rather than test-sized stand-ins.
 */

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/idle-compaction.ts");
const ID = "01a1c4d0-2f3a-7b4c-9d5e-1f2a3b4c5d6e";

const QUIET_MS = 120000;
const URGENT_QUIET_MS = 20000;
const DEADLINE_MS = 120000;
const COOLDOWN_MS = 600000;

let dirs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Harness {
  pi: FakePi;
  cwd: string;
  context: FakeContext;
  ui: FakeUi;
  /** What `ctx.compact()` was asked for, in call order. */
  compacts: Array<{ options: any }>;
  calls: Array<{ name: string; args: unknown[] }>;
}

async function setup(
  options: {
    sessionId?: string;
    cwd?: string;
    mode?: "tui" | "rpc" | "print" | "json";
    idle?: boolean;
    pendingMessages?: boolean;
    branch?: unknown[];
    contextUsage?: { percent: number | null; tokens: number | null; contextWindow: number };
    flagOff?: boolean;
    start?: boolean;
  } = {},
): Promise<Harness> {
  const cwd = options.cwd ?? mkdtempSync(path.join(tmpdir(), "pi-ed-idle-compact-"));
  if (options.cwd === undefined) dirs.push(cwd);
  const pi = createFakePi();
  const record = createContext({
    cwd,
    sessionId: options.sessionId ?? ID,
    mode: options.mode ?? "tui",
    idle: options.idle ?? true,
    pendingMessages: options.pendingMessages ?? false,
    branch: options.branch ?? [],
    contextUsage: options.contextUsage ?? { percent: 60, tokens: 78000, contextWindow: 131072 },
  });
  const mod = await import(MODULE);
  (mod as { default: (api: unknown) => void }).default(pi as any);
  if (options.flagOff) pi.setFlag("idle-compaction-off", true);
  if (options.start !== false) {
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, record.context);
  }
  return { pi, cwd, context: record.context, ui: record.ui, compacts: record.compacts, calls: record.calls };
}

/** A settled run: the turn ends, and the quiet window is what happens next. */
async function settle(h: Harness, options: { aborted?: boolean } = {}): Promise<void> {
  await h.pi.emit("turn_start", { type: "turn_start", turnIndex: 1 }, h.context);
  await h.pi.emit("agent_settled", { type: "agent_settled", aborted: options.aborted ?? false }, h.context);
}

/** The completion Pi reports through `CompactOptions.onComplete`. */
function completed(after: number, summary = "summary text") {
  return { summary, firstKeptEntryId: "entry-9", tokensBefore: 78000, estimatedTokensAfter: after, usage: { output: 2500 } };
}

function toolResultEntry(id: string, toolName: string, chars: number, kind: "text" | "image" = "text") {
  return {
    type: "message",
    id,
    timestamp: "2026-11-26T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName,
      toolCallId: `call-${id}`,
      isError: false,
      content: kind === "text" ? [{ type: "text", text: "x".repeat(chars) }] : [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    },
  };
}

async function status(h: Harness): Promise<string> {
  await runCommand(h.pi, "idle-compact", "", h.context);
  return h.ui.notifications.at(-1)?.message ?? "";
}

/** The boundary event as Pi hands it: the entries already proposed at this boundary, and the run's outcome. */
function settleBoundary(entries: unknown[] = []) {
  return { type: "agent_before_settle", entries, continue: false, context: {}, outcome: "end" };
}

describe("idle compaction", () => {
  it("registers the surface it will be judged by", async () => {
    const h = await setup();
    expect([...h.pi.commands.keys()]).toContain("idle-compact");
    expect([...h.pi.flags.keys()]).toEqual(["idle-compaction-off"]);
    // The two events the whole design rests on: when a run stops, and the boundary where stale tool output can be
    // written out of the context.
    expect(h.pi.lifecycleEvents).toContain("agent_settled");
    expect(h.pi.lifecycleEvents).toContain("agent_before_settle");
    expect(h.pi.lifecycleEvents).toContain("session_compact");
  });

  it("compacts when the session has been quiet for the window it armed", async () => {
    const h = await setup();
    await settle(h);

    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(h.compacts).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(h.compacts).toHaveLength(1);
  });

  it("does not compact below the context floor, because a call that frees nothing is churn", async () => {
    // 12000 tokens against a 24000 floor: Pi keeps 20000 recent tokens verbatim and these summaries run about 2500,
    // so this compaction would have nothing left to free.
    const h = await setup({ contextUsage: { percent: 9, tokens: 12000, contextWindow: 131072 } });
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS * 10);
    expect(h.compacts).toHaveLength(0);
    expect(await status(h)).toContain("is under the 40% floor");
  });

  it("shortens the window to twenty seconds when the next prompt is going to pay for it anyway", async () => {
    // 87.5% is where Pi compacts on its own. Above 80% the choice is not "compact or not", it is "compact now, or
    // compact in front of the next thing Ed types".
    const h = await setup({ contextUsage: { percent: 88, tokens: 115000, contextWindow: 131072 } });
    await settle(h);

    vi.advanceTimersByTime(URGENT_QUIET_MS - 1);
    expect(h.compacts).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.compacts).toHaveLength(1);
  });

  it("cancels the armed window for anything that means a turn is happening", async () => {
    for (const [event, payload] of [
      ["tool_result", { type: "tool_result", toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "out" }], isError: false }],
      ["turn_start", { type: "turn_start", turnIndex: 2 }],
      ["message_end", { type: "message_end", message: { role: "assistant", content: [] } }],
      ["user_bash", { type: "user_bash", command: "ls", cwd: "/work" }],
      ["ui_prompt_start", { type: "ui_prompt_start", text: "what is the build status", source: "tui" }],
      ["before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "sp", systemPromptOptions: { sections: {} } }],
    ] as const) {
      const single = await setup();
      await settle(single);
      await single.pi.emit(event, payload, single.context);
      vi.advanceTimersByTime(QUIET_MS * 5);
      expect(single.compacts, event).toHaveLength(0);
    }
  });

  it("will not start a compaction in front of a queued prompt", async () => {
    const h = await setup({ pendingMessages: true });
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS * 5);
    expect(h.compacts).toHaveLength(0);
    expect(await status(h)).toContain("not armed: a message is queued");
  });

  it("re-checks idleness when the window fires, not only when it opens", async () => {
    const h = await setup();
    await settle(h);
    // Two minutes is long enough for a follow-up to arrive from elsewhere in the fleet.
    h.context.setIdle(false);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.compacts).toHaveLength(0);
    expect(await status(h)).toContain("skipped: the agent is running");
  });

  it("cannot start a second compaction while one is in flight, which is what Pi's own idleness already says", async () => {
    // Pi's isIdle is `!agentRunActive && !isCompacting`, so a settling run during a compaction cannot arm another.
    const h = await setup();
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.compacts).toHaveLength(1);
    h.context.setIdle(false);
    await settle(h);
    // Still inside the deadline: the refusal is what a person should be able to read back.
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(h.compacts).toHaveLength(1);
    expect(await status(h)).toContain("a compaction is already in flight");

    // And the deadline closes it: one compaction total, and the abort is what released the session.
    vi.advanceTimersByTime(1);
    expect(h.calls.some((call) => call.name === "abort")).toBe(true);
    expect(h.compacts).toHaveLength(1);
  });

  it("does not compact a print or JSON run, where there is no idle time and only an exit to delay", async () => {
    for (const mode of ["print", "json"] as const) {
      const h = await setup({ mode });
      await settle(h);
      vi.advanceTimersByTime(QUIET_MS * 5);
      expect(h.compacts, mode).toHaveLength(0);
    }
  });

  it("asks Pi for a single summarisation attempt and pins this session's plan verbatim", async () => {
    const h = await setup();
    mkdirSync(path.join(h.cwd, ".pi", "plan"), { recursive: true });
    writeFileSync(
      path.join(h.cwd, ".pi", "plan", `${ID}.json`),
      JSON.stringify(
        {
          v: 1,
          session_id: ID,
          goal: "Ship the idle compaction path",
          direction: "Reduce perceived latency, not token spend",
          todos: [
            { id: "t1", text: "Measure where compaction time actually goes", why: "The 5-minute median is the complaint", state: "done", at: "2026-11-26T00:00:00.000Z", done_at: "2026-11-26T01:00:00.000Z" },
            { id: "t2", text: "Arm compaction on the quiet window", state: "in_progress", at: "2026-11-26T01:00:00.000Z" },
          ],
          updated_at: "2026-11-26T01:00:00.000Z",
        },
        null,
        2,
      ),
    );

    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    const options = h.compacts[0]?.options;
    expect(options).toBeDefined();
    expect(options.customInstructions.split("\n")[0]).toBe("pi-ed:compaction-single-attempt");
    expect(options.customInstructions).toContain("Ship the idle compaction path");
    expect(options.customInstructions).toContain("[~] t2 Arm compaction on the quiet window");
    expect(options.customInstructions).toContain("Reduce perceived latency, not token spend");
    expect(typeof options.onComplete).toBe("function");
    expect(typeof options.onError).toBe("function");
  });

  it("compacts without a plan when there is no plan to pin", async () => {
    const h = await setup();
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    const instructions: string = h.compacts[0]!.options.customInstructions;
    expect(instructions.split("\n")[0]).toBe("pi-ed:compaction-single-attempt");
    expect(instructions).not.toContain("<plan>");
  });

  it("reports what a finished compaction bought", async () => {
    const h = await setup({ contextUsage: { percent: 88, tokens: 115000, contextWindow: 131072 } });
    await settle(h);
    vi.advanceTimersByTime(URGENT_QUIET_MS);
    h.compacts[0]!.options.onComplete(completed(31000));

    const notice = h.ui.notifications.at(-1);
    expect(notice?.level).toBe("info");
    expect(notice?.message).toContain("freed about 84000 tokens");
    expect(await status(h)).toContain("compacted 115000 to 31000 tokens");
  });

  it("waits for the cooldown rather than summarising an idle session over and over", async () => {
    const h = await setup();
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    h.compacts[0]!.options.onComplete(completed(40000));

    // An idle session that keeps settling keeps arming. The cooldown is what stops the second compaction.
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.compacts).toHaveLength(1);
    await runCommand(h.pi, "idle-compact", "run", h.context);
    expect(h.ui.notifications.at(-1)?.message).toMatch(/cooldown|nothing new/);
  });
  it("aborts a compaction that has run past the deadline, because an idle compaction must not become a wait", async () => {
    const h = await setup();
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.compacts).toHaveLength(1);
    // Nothing calls onComplete: this is the summarisation call that is still going.
    vi.advanceTimersByTime(DEADLINE_MS);
    expect(h.calls.some((call) => call.name === "abort")).toBe(true);
    expect(h.ui.notifications).toEqual([]);
    expect(await status(h)).toContain("aborted at the 120000ms deadline");
  });

  it("stops the deadline once the compaction reports back", async () => {
    const h = await setup();
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    h.compacts[0]!.options.onComplete(completed(40000));
    vi.advanceTimersByTime(DEADLINE_MS * 3);
    expect(h.calls.some((call) => call.name === "abort")).toBe(false);
  });

  it("treats Pi's own 'nothing to do here' as a skip rather than a fault to warn about", async () => {
    for (const message of ["Already compaction required: session already compacted", "Nothing to compact (session too small)"]) {
      const h = await setup();
      await settle(h);
      vi.advanceTimersByTime(QUIET_MS);
      h.compacts[0]!.options.onError(new Error(message));
      expect(h.ui.notifications.filter((n) => n.level === "warning"), message).toEqual([]);
      expect(await status(h)).toContain("skipped:");
    }
  });

  it("says out loud when a compaction actually failed", async () => {
    const h = await setup();
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    h.compacts[0]!.options.onError(new Error("upstream summarisation exploded"));
    const warning = h.ui.notifications.find((n) => n.level === "warning");
    expect(warning?.message).toContain("upstream summarisation exploded");
  });

  it("lets a compaction Pi started itself count against the cooldown, and records that the idle path lost", async () => {
    const h = await setup();
    await h.pi.emit(
      "session_compact",
      { type: "session_compact", compactionEntry: { type: "compaction", summary: "pi wrote this one", tokensBefore: 114688 }, reason: "threshold" },
      h.context,
    );
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.compacts).toHaveLength(0);
    expect(await status(h)).toMatch(/cooldown:|nothing new since the last compaction/);
  });

  it("counts reclaimable stale tool output without touching the context, which is the shipped default", async () => {
    // 15 large tool results, of which the newest 12 are the working set: 3 candidates, 5000 characters each.
    const branch = Array.from({ length: 15 }, (_unused, i) => toolResultEntry(`t${i + 1}`, "bash", 5000));
    const h = await setup({ branch });
    const [result] = await h.pi.emit("agent_before_settle", settleBoundary(), h.context);
    expect(result).toBeUndefined();
    const text = await status(h);
    expect(text).toContain("3 candidates");
    expect(text).toContain("about 3750 tokens reclaimable");
    expect(text).toContain("0 replaced");
    expect(text).toContain("newest 12 results kept whole");
  });

  it("replaces stale tool output with a stub that says what was dropped and how to get it back", async () => {
    const branch = Array.from({ length: 15 }, (_unused, i) => toolResultEntry(`t${i + 1}`, "read", 5000));
    const h = await setup({ branch });
    await runCommand(h.pi, "idle-compact", "prune on", h.context);
    const [result] = await h.pi.emit("agent_before_settle", settleBoundary(), h.context);

    const drafts = result.entries as any[];
    // The oldest three, newest candidate first: everything inside the keep-recent window is still the working set.
    expect(drafts.map((draft) => draft.targetId)).toEqual(["t3", "t2", "t1"]);
    for (const draft of drafts) {
      expect(draft.type).toBe("context_edit");
      // A replacement, never an omission: the tool call keeps a result, so the pairing Pi checks for survives.
      expect(draft.replacement?.content[0].type).toBe("text");
      const stub: string = draft.replacement.content[0].text;
      expect(stub).toContain("read output dropped from context");
      expect(stub).toContain("about 5k characters");
      expect(stub).toContain("re-run the command or read the file again");
    }
    expect(await status(h)).toContain("3 replaced");
  });

  it("keeps the newest tool results, images and small results out of the prune", async () => {
    const branch = [
      toolResultEntry("t1", "read", 8000),
      toolResultEntry("t2", "bash", 400, "text"), // under the size floor: an edit entry costs about what it saves
      toolResultEntry("t3", "read", 6000, "image"), // not stale output: somebody is looking at it
      toolResultEntry("t4", "bash", 5000),
      ...Array.from({ length: 12 }, (_unused, i) => toolResultEntry(`r${i + 1}`, "bash", 5000)),
    ];
    const h = await setup({ branch });
    await runCommand(h.pi, "idle-compact", "prune on", h.context);
    const [result] = await h.pi.emit("agent_before_settle", settleBoundary(), h.context);
    expect((result.entries as any[]).map((draft) => draft.targetId)).toEqual(["t4", "t1"]);
  });

  it("never edits the same target twice", async () => {
    const branch = [...Array.from({ length: 15 }, (_unused, i) => toolResultEntry(`t${i + 1}`, "bash", 5000)), { type: "context_edit", id: "ce1", parentId: "t1", targetId: "t1", replacement: { content: [{ type: "text", text: "already stubbed" }] } }];
    const h = await setup({ branch });
    await runCommand(h.pi, "idle-compact", "prune on", h.context);
    const [result] = await h.pi.emit("agent_before_settle", settleBoundary(), h.context);
    const ids = (result.entries as any[]).map((draft) => draft.targetId);
    expect(ids).toEqual(["t3", "t2"]);
  });

  it("carries whatever entries Pi brought to the boundary alongside its own", async () => {
    const branch = Array.from({ length: 15 }, (_unused, i) => toolResultEntry(`t${i + 1}`, "bash", 5000));
    const h = await setup({ branch });
    await runCommand(h.pi, "idle-compact", "prune on", h.context);
    const mine = { type: "custom", customType: "team-room-note", data: {} };
    const [result] = await h.pi.emit("agent_before_settle", settleBoundary([mine]), h.context);
    expect((result.entries as any[])[0]).toBe(mine);
    expect((result.entries as any[]).length).toBe(4);
  });

  it("does not touch the boundary at all when pruning is switched off", async () => {
    const branch = Array.from({ length: 15 }, (_unused, i) => toolResultEntry(`t${i + 1}`, "bash", 5000));
    const h = await setup({ branch });
    await runCommand(h.pi, "idle-compact", "prune off", h.context);
    const [result] = await h.pi.emit("agent_before_settle", settleBoundary(), h.context);
    expect(result).toBeUndefined();
  });

  it("does not keep paying to warm a cache the compaction is about to throw away", async () => {
    const h = await setup();
    const warm = () => h.pi.emit("cache_warming_decision", { type: "cache_warming_decision", trigger: "idle_timer", phase: "warm", usage: { tokenEstimate: 78000, input: 78000 }, idleForMs: 60000, allowed: true, reasonHint: "idle timer" }, h.context);

    expect(await warm()).toEqual([undefined]);
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    expect(await warm()).toEqual([{ action: "stop" }]);
    h.compacts[0]!.options.onComplete(completed(40000));
    expect(await warm()).toEqual([undefined]);
  });

  it("turns itself off when the flag says this session should not be compacted on its own", async () => {
    const h = await setup({ flagOff: true });
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS * 5);
    expect(h.compacts).toHaveLength(0);
    expect(await status(h)).toContain("idle-compaction: off (--idle-compaction-off)");
  });

  it("writes a settings file that the next session reads back", async () => {
    const h = await setup();
    await runCommand(h.pi, "idle-compact", "off", h.context);
    const written = JSON.parse(readFileSync(path.join(h.cwd, ".pi", "idle-compaction.json"), "utf8"));
    expect(written.enabled).toBe(false);
    expect(h.ui.notifications.at(-1)?.message).toContain(".pi/idle-compaction.json");

    // A fresh session over the same checkout: same file, same decision.
    const next = await setup({ cwd: h.cwd });
    await settle(next);
    vi.advanceTimersByTime(QUIET_MS * 5);
    expect(next.compacts).toHaveLength(0);
    expect(await status(next)).toContain("idle-compaction: off");
  });

  it("reports what it would do, and why it did not, instead of staying quiet about it", async () => {
    const h = await setup();
    const text = await status(h);
    expect(text).toContain("idle-compaction: on");
    expect(text).toContain("context 78000 of 131072 (60.0%)");
    expect(text).toContain("quiet 120s");
    expect(text).toContain("urgent 20s at 80%");
    expect(text).toContain("deadline 120s");
    expect(text).toContain("cooldown 600s");
    expect(text).toContain("plan pinned in the summary: yes");
    expect(text).toContain(".pi/idle-compaction/log.jsonl");
  });

  it("runs on command when a person asks, and refuses when the arithmetic says no", async () => {
    const blocked = await setup({ contextUsage: { percent: 9, tokens: 12000, contextWindow: 131072 } });
    await runCommand(blocked.pi, "idle-compact", "run", blocked.context);
    expect(blocked.compacts).toHaveLength(0);
    expect(blocked.ui.notifications.at(-1)?.message).toContain("would not compact right now");

    await runCommand(blocked.pi, "idle-compact", "run --force", blocked.context);
    expect(blocked.compacts).toHaveLength(1);
    expect(blocked.compacts[0]!.options.customInstructions).toContain("pi-ed:compaction-single-attempt");
  });

  it("keeps a decision log, including the decisions to do nothing", async () => {
    const h = await setup();
    await settle(h);
    // Eligible when the window opened, not eligible when it closed: the interesting decision is the skip.
    h.context.setIdle(false);
    vi.advanceTimersByTime(QUIET_MS);
    const log = readFileSync(path.join(h.cwd, ".pi", "idle-compaction", "log.jsonl"), "utf8");
    expect(log).toContain('"kind":"skip"');
    expect(log).toContain('"reason":"the agent is running"');
  });

  it("writes an arm refusal to the log once per reason, not once per settle", async () => {
    // The live run this extension first reached settled eleven times under the floor and left an empty log, which
    // reads exactly like a broken extension. Logging every settle would be the other failure.
    const h = await setup({ contextUsage: { percent: 12, tokens: 16000, contextWindow: 131072 } });
    for (let i = 0; i < 5; i += 1) {
      await settle(h);
      vi.advanceTimersByTime(QUIET_MS);
    }
    const log = readFileSync(path.join(h.cwd, ".pi", "idle-compaction", "log.jsonl"), "utf8");
    const lines = log.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"stage":"arm"');
    expect(lines[0]).toContain("under the 40% floor");
    expect(h.compacts).toHaveLength(0);
  });
});
