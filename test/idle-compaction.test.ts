import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const DEADLINE_MS = 240000;
const COOLDOWN_MS = 600000;

let dirs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  // The keys a test may set to drive a ceiling: they belong to that test, not to the ones that follow it.
  for (const key of ["IDLE_COMPACTION_RATE_TOKENS_PER_SECOND", "IDLE_COMPACTION_MAX_DEADLINE_MS", "IDLE_COMPACTION_RETRY_COOLDOWN_MS"]) delete process.env[key];
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
  // The ceiling scales from the token count, so a test that asserts *when* an abort lands pins a rate where the
  // configured `deadlineMs` floor governs. The scaling itself has its own test below.
  if (process.env.IDLE_COMPACTION_RATE_TOKENS_PER_SECOND === undefined) process.env.IDLE_COMPACTION_RATE_TOKENS_PER_SECOND = "100000";
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

/** The decision log this session wrote, parsed. Needed by the tests that assert *why* an attempt was refused. */
function logOf(h: Harness): any[] {
  return readFileSync(path.join(h.cwd, ".pi", "idle-compaction", "log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
    expect(await status(h)).toContain("is under the 25% floor");
  });

  it("states the eligibility bar that actually bites at this fleet's window", async () => {
    // The bar is `keptFloorTokens` 24000 + `minFreeTokens` 30000 = 54000 tokens, and 30000 is a measured number, not
    // a preference: a completed idle summarisation re-sends the prefix uncached and re-reads the kept tail, so one
    // completion costs about 28000-35000 cache-write tokens (pi-bot's 2026-11-27 measurement: 20513 freed against
    // 34286 re-sent) and an aborted one costs 15-33k for nothing. Measured across 15 sessions that cleared the old
    // 20000 minimum, only 8 would have paid for themselves; camry freed 3388 against a 31843 re-send - ten hours of
    // re-sending a prompt to save a third of one prompt.
    const justUnder = await setup({ contextUsage: { percent: 40.4, tokens: 53000, contextWindow: 131072 } });
    await settle(justUnder);
    vi.advanceTimersByTime(QUIET_MS * 10);
    expect(justUnder.compacts).toHaveLength(0);
    expect(await status(justUnder)).toContain("would free about 29000 tokens, under the 30000 minimum");

    const justOver = await setup({ contextUsage: { percent: 42, tokens: 55000, contextWindow: 131072 } });
    await settle(justOver);
    vi.advanceTimersByTime(QUIET_MS);
    expect(justOver.compacts).toHaveLength(1);

    // The percent bar still refuses a session that is simply small, whatever the margin arithmetic says.
    const small = await setup({ contextUsage: { percent: 22, tokens: 29000, contextWindow: 131072 } });
    await settle(small);
    vi.advanceTimersByTime(QUIET_MS * 10);
    expect(small.compacts).toHaveLength(0);
    expect(await status(small)).toContain("is under the 25% floor");
  });

  it("scales an attempt's ceiling from the context it is summarising, because a flat one is a guess", async () => {
    // The measured band: 400-816 tok/s on an idle path, 255-540 tok/s once Pi's own path runs beside it. The scaling
    // uses the poor end (300 tok/s) so a big session gets room to finish - macgrubernetes at 90599 tokens and
    // home-ops at 82704 each ran the full 480 s on 2026-11-27 and freed 1231 and 1920 tokens between them - while a
    // small session keeps the floor it has always had, and nothing runs past `maxDeadlineMs`.
    process.env.IDLE_COMPACTION_RATE_TOKENS_PER_SECOND = "300";
    const big = await setup({ contextUsage: { percent: 87, tokens: 90000, contextWindow: 103418 } });
    await settle(big);
    vi.advanceTimersByTime(URGENT_QUIET_MS);
    expect(big.compacts).toHaveLength(1);
    // ceil(90000 / 300 * 1000) = 300000, above the 240000 floor this session would previously have been killed at.
    vi.advanceTimersByTime(240000);
    expect(big.calls.some((call) => call.name === "abort")).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(big.calls.some((call) => call.name === "abort")).toBe(true);
    const aborted = logOf(big).find((entry) => entry.kind === "deadline");
    expect(aborted?.deadlineMs).toBe(300000);

    // The floor still governs a small context: scaling never shortens a ceiling, and never exceeds the cap.
    process.env.IDLE_COMPACTION_MAX_DEADLINE_MS = "900000";
    const huge = await setup({ contextUsage: { percent: 95, tokens: 131072, contextWindow: 131072 } });
    await settle(huge);
    vi.advanceTimersByTime(URGENT_QUIET_MS);
    expect(logOf(huge).find((entry) => entry.kind === "compact")?.deadlineMs).toBe(436907);
  });

  it("holds off a session whose last attempt burned its ceiling without finishing", async () => {
    // The expensive failure mode of this feature is an attempt that holds the fleet gate, re-sends the prefix and
    // frees nothing - which is what two of the 2026-11-27 aborts did, on 90599 and 82704 token contexts. A session
    // that just did that does not get to try again inside its success cooldown; it waits longer.
    process.env.IDLE_COMPACTION_RATE_TOKENS_PER_SECOND = "300";
    process.env.IDLE_COMPACTION_RETRY_COOLDOWN_MS = "1800000";
    const h = await setup({ contextUsage: { percent: 87, tokens: 90000, contextWindow: 103418 } });
    await settle(h);
    vi.advanceTimersByTime(URGENT_QUIET_MS);
    expect(h.compacts).toHaveLength(1);
    vi.advanceTimersByTime(300000); // the scaled ceiling for 90000 tokens at 300 tok/s, no completion reported
    expect(h.calls.some((call) => call.name === "abort")).toBe(true);
    h.compacts[0]!.options.onError(new Error("Compaction cancelled"));

    // A fresh settle inside the retry window is refused, and says which of the two it is facing. The usage has not
    // moved, so this is the same candidate the session was already eligible for.
    await settle(h);
    vi.advanceTimersByTime(URGENT_QUIET_MS);
    expect(h.compacts).toHaveLength(1);
    expect(await status(h)).toContain("last attempt did not finish at its deadline");
    expect(await status(h)).toContain("cooldown after an attempt that did not finish at its deadline");

    // And past the retry window it may try again, because the point is to stop a loop, not to stop compacting.
    vi.advanceTimersByTime(1800000);
    await settle(h);
    vi.advanceTimersByTime(URGENT_QUIET_MS);
    expect(h.compacts).toHaveLength(2);
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
    vi.advanceTimersByTime(DEADLINE_MS - 1);
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
    expect(await status(h)).toContain("aborted at the 240000ms deadline");
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

  it("compacts a session that is over its window even when the cooldown says no", async () => {
    // pi-bot on 2026-11-26: compacted to 31480 at 21:49, back to 135735 tokens (103.55%) 17 minutes later, and the
    // answer Ed got was a provider 400 - "This endpoint's maximum context length is 131072 tokens. However, you
    // requested about 135838 tokens." A long peer turn refills a window faster than a 10 minute cooldown protects
    // it, and a cooldown is a brake on self-churn, not a reason to leave a session out of room.
    const branch = [{ type: "message", id: "e1", message: { role: "user", content: "back to work" } }];
    const h = await setup({
      contextUsage: { percent: 103.55, tokens: 135735, contextWindow: 131072 },
      branch,
    });
    await h.pi.emit(
      "session_compact",
      { type: "session_compact", compactionEntry: { type: "compaction", summary: "pi wrote this one", tokensBefore: 115693 }, reason: "threshold" },
      h.context,
    );
    // Seven minutes of a peer's turn: inside the 600 s cooldown. (pi-bot's refill took 17 minutes, which is past
    // the cooldown entirely - the fragile window is the one inside it, and that is the one this asserts on.)
    branch.push({ type: "message", id: "e2", message: { role: "assistant", content: "x".repeat(400) } });
    vi.advanceTimersByTime(7 * 60 * 1000);
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.compacts).toHaveLength(1);

    // And it says so in the log, so a reader does not have to conclude the cooldown was missed.
    const attempt = logOf(h).find((entry) => entry.kind === "compact");
    expect(attempt.overWindow).toBe(true);
    expect(attempt.tokens).toBe(135735);

    // The mirror, so this is a rule and not a free pass: the same shape under its window is still refused.
    const underBranch = [{ type: "message", id: "u1", message: { role: "user", content: "still busy" } }];
    const under = await setup({
      sessionId: "under-window",
      contextUsage: { percent: 92, tokens: 120000, contextWindow: 131072 },
      branch: underBranch,
    });
    await under.pi.emit(
      "session_compact",
      { type: "session_compact", compactionEntry: { type: "compaction", summary: "pi wrote this one", tokensBefore: 110000 }, reason: "threshold" },
      under.context,
    );
    underBranch.push({ type: "message", id: "u2", message: { role: "assistant", content: "more work" } });
    vi.advanceTimersByTime(60 * 1000);
    await settle(under);
    vi.advanceTimersByTime(QUIET_MS);
    expect(under.compacts).toHaveLength(0);
    expect(logOf(under).some((entry) => entry.kind === "skip" && String(entry.reason).includes("cooldown"))).toBe(true);
  });

  it("lets the token bars decide when the percent bar disagrees with them", async () => {
    // Pi carries a `contextWindow` per alias and it is not always the window the model ran: pi-team-room answered a
    // genuine 186420-token prompt (185898 of it cacheRead) under a 131072 constant, i.e. 142.23% of too small a
    // number. Percent may arm a session too eagerly, which is only waste; refusing one the token bars cleared is
    // the direction where a legitimate candidate is skipped and never learns it was skipped.
    process.env.IDLE_COMPACTION_SOFT_PERCENT = "40";
    try {
      // 34.33% of a declared 175000 window, and 60000 - 24000 = 36000 free: the margin bars clear, so the floor
      // does not refuse it. The declared window is the wrong one on purpose - that is the pi-team-room shape.
      const h = await setup({ contextUsage: { percent: 34.33, tokens: 60000, contextWindow: 175000 } });
      await settle(h);
      vi.advanceTimersByTime(QUIET_MS);
      expect(h.compacts).toHaveLength(1);

      // The floor still means something below the margin bars: 20000 tokens frees about -4000, and the reason a
      // person sees is still the floor they configured.
      const small = await setup({
        sessionId: "under-floor",
        contextUsage: { percent: 15.25, tokens: 20000, contextWindow: 131072 },
      });
      await settle(small);
      vi.advanceTimersByTime(QUIET_MS);
      expect(small.compacts).toHaveLength(0);
      const skip = logOf(small).find((entry) => entry.kind === "skip");
      expect(skip.reason).toContain("under the 40% floor");
    } finally {
      delete process.env.IDLE_COMPACTION_SOFT_PERCENT;
    }
  });

  it("stands aside while Pi is compacting this session, and does not stay stood aside", async () => {
    // "Turn ends - Pi schedules an auto-compaction - agent_settled arms - the quiet timer fires 120 s later" is a
    // race for the same summarisation. Calling compact() behind Pi's own would log a `compact` line for a
    // summarisation that never appears, which is the false success this fleet has already been burned by.
    const h = await setup();
    await h.pi.emit(
      "session_before_compact",
      { type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold", willRetry: false },
      h.context,
    );
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.compacts).toHaveLength(0);
    expect(logOf(h).some((entry) => entry.kind === "skip" && String(entry.reason).includes("stands aside"))).toBe(true);

    // Pi's compaction dies without ever having held the gate here. If the stand-aside were tied to the hold it
    // would never clear, and the session would refuse to compact for the rest of its life.
    await h.pi.emit(
      "session_compact_failed",
      { type: "session_compact_failed", reason: "threshold", aborted: false, errorMessage: "provider said no" },
      h.context,
    );
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.compacts).toHaveLength(1);
    const attempt = logOf(h).find((entry) => entry.kind === "compact");
    expect(attempt).toBeDefined();
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
    expect(text).toContain("deadline 240s");
    expect(text).toContain("cooldown 600s");
    expect(text).toContain(".pi/idle-compaction/log.jsonl");
    // The live run this extension first reached printed `plan pinned in the summary: yes` for a session that had no
    // plan file, one line above its own decision log recording `pinnedPlanChars: 0`.
    expect(text).toContain("plan pinned in the summary: on, but nothing to pin - this session has no plan file");
  });

  it("names the plan it would actually pin, in the file it came from", async () => {
    const h = await setup();
    mkdirSync(path.join(h.cwd, ".pi", "plan"), { recursive: true });
    writeFileSync(
      path.join(h.cwd, ".pi", "plan", `${ID}.json`),
      JSON.stringify(
        {
          v: 1,
          session_id: ID,
          goal: "Ship the idle compaction path",
          todos: [{ id: "t1", text: "Arm compaction on the quiet window", state: "in_progress", at: "2026-11-26T01:00:00.000Z" }],
          updated_at: "2026-11-26T01:00:00.000Z",
        },
        null,
        2,
      ),
    );
    const text = await status(h);
    expect(text).toMatch(/plan pinned in the summary: yes, \d+ chars from \.pi\/plan\/.+\.json/);
    expect(text).toContain(ID);
  });

  it("says a context is not measured yet rather than printing a question mark", async () => {
    // Right after a compaction Pi reports no usage at all: it re-measures on the next turn. Asked in that window the
    // live readout said `context ? of 131072 (?%)`, which reads like a broken extension instead of an answer.
    const h = await setup({ contextUsage: { percent: null, tokens: null, contextWindow: 131072 } });
    const text = await status(h);
    expect(text).toContain("context usage not measured yet");
    expect(text).not.toContain("?");
    expect(text).toContain("floor 25%");
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
    // The session's own start line is not part of what this test counts; what must not multiply is the refusal.
    const refusals = lines.filter((line) => line.includes('"stage":"arm"'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('"stage":"arm"');
    expect(refusals[0]).toContain("under the 25% floor");
    expect(h.compacts).toHaveLength(0);
  });
});

describe("every number it reports is the number it claims to be", () => {
  /**
   * Three field results shaped these assertions.
   *
   * pi-bot's pod reported `{"kind":"prune-report","candidates":405,"tokens":409532}` on a session whose live
   * context was 83819 tokens: the scan had walked the whole session file, including the tool results behind a
   * compaction boundary that Pi does not send, and a reader would size a reclaim against a number five times the
   * window. The fix is `sessionManager.buildContextEntries()` - Pi's own compaction-aware view - and the assertion
   * is the difference between the two counts.
   *
   * The same pod wrote `deadlineMs: 600000` into its config at 17:29, watched an attempt abort at the 120 s default
   * at 17:39, and could only prove afterwards, from the source, that `readConfig` had never re-read the file. And
   * the fleet's two largest completed compactions (116325 and 119360 tokens, Pi's own threshold path) contributed
   * no duration at all, because Pi's completion event carries none.
   */
  function logLines(h: Harness): any[] {
    return readFileSync(path.join(h.cwd, ".pi", "idle-compaction", "log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function writeConfig(cwd: string, values: Record<string, unknown>, writtenAt: Date): string {
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const file = path.join(cwd, ".pi", "idle-compaction.json");
    writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`, "utf8");
    // The mtime is pinned, not now(): the staleness check compares a file's mtime against the stamp taken at
    // session start, and a test that relied on two writes landing on different milliseconds would be flaky.
    utimesSync(file, writtenAt, writtenAt);
    return file;
  }

  it("counts stale output over what Pi would send, not over the whole session file", async () => {
    // A session compacted once already: t1..t7 are behind the boundary and Pi drops them, t8..t10 were kept,
    // t11..t16 are new. The file holds 16 large tool results; the context Pi builds holds 9.
    const branch = [
      ...Array.from({ length: 10 }, (_unused, i) => toolResultEntry(`t${i + 1}`, "bash", 5000)),
      { type: "compaction", id: "c1", parentId: "t10", timestamp: "2026-11-26T00:00:00.000Z", summary: "summary text", firstKeptEntryId: "t8", tokensBefore: 60000 },
      ...Array.from({ length: 6 }, (_unused, i) => toolResultEntry(`t${11 + i}`, "bash", 5000)),
    ];
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-idle-window-"));
    dirs.push(cwd);
    // The keep-recent window is narrowed so the arithmetic has an answer worth asserting: 9 tool results in the
    // context, 3 kept whole, 6 reclaimable. Over the whole file it would have claimed 13.
    writeConfig(cwd, { pruneKeepRecentResults: 3, pruneMinChars: 1000 }, new Date("2026-11-26T10:00:00.000Z"));
    const h = await setup({ cwd, branch });

    await h.pi.emit("agent_before_settle", settleBoundary(), h.context);
    const report = logLines(h).find((line) => line.kind === "prune-report");
    expect(report.candidates).toBe(6);
    // 6 x 5000 characters, at the same characters/4 estimate every other number in this file uses.
    expect(report.tokens).toBe(7500);
    expect(report.contextEntries).toBe(10);
    expect(report.sessionEntries).toBe(17);

    const text = await status(h);
    expect(text).toContain("6 candidates, about 7500 tokens reclaimable in the context Pi would send now");
  });

  it("never writes a context edit against an entry Pi is not sending", async () => {
    const branch = [
      ...Array.from({ length: 10 }, (_unused, i) => toolResultEntry(`t${i + 1}`, "read", 5000)),
      { type: "compaction", id: "c1", parentId: "t10", timestamp: "2026-11-26T00:00:00.000Z", summary: "summary text", firstKeptEntryId: "t8", tokensBefore: 60000 },
      ...Array.from({ length: 6 }, (_unused, i) => toolResultEntry(`t${11 + i}`, "read", 5000)),
    ];
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-idle-window-apply-"));
    dirs.push(cwd);
    writeConfig(cwd, { prune: "on", pruneKeepRecentResults: 3, pruneMinChars: 1000 }, new Date("2026-11-26T10:00:00.000Z"));
    const h = await setup({ cwd, branch });

    const [result] = await h.pi.emit("agent_before_settle", settleBoundary(), h.context);
    const ids = (result.entries as any[]).map((draft) => draft.targetId);
    // Newest candidates first, and t1..t7 absent: they are already out of the request, and editing them would
    // spend a boundary entry to save nothing.
    expect(ids).toEqual(["t13", "t12", "t11", "t10", "t9", "t8"]);
  });

  it("says which config this session is running, and says so when the file has moved since it was read", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-idle-config-"));
    dirs.push(cwd);
    writeConfig(cwd, { deadlineMs: 600000 }, new Date("2026-11-26T17:04:31.000Z"));
    const h = await setup({ cwd });

    const before = await status(h);
    expect(before).toContain("config: .pi/idle-compaction.json");
    expect(before).toContain("read at session start (17:04:31)");
    expect(before).toContain("deadline 600s");
    expect(before).not.toContain("NOT applied");

    // The exact sequence that voided one pod's experiment: a config edit made after the session started.
    writeConfig(cwd, { deadlineMs: 30000 }, new Date("2026-11-26T17:29:02.000Z"));
    const after = await status(h);
    expect(after).toContain("written again at 17:29:02");
    expect(after).toContain("NOT applied to this session, reload to apply them");
    // And the readout still describes the values actually in force, because that is what a deadline line is for.
    expect(after).toContain("deadline 600s");
  });

  it("records a session's own config in the log line it was measured under", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-idle-deadline-"));
    dirs.push(cwd);
    writeConfig(cwd, { deadlineMs: 600000 }, new Date("2026-11-26T17:04:31.000Z"));
    const h = await setup({ cwd });

    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    const attempt = logLines(h).find((line) => line.kind === "compact");
    expect(attempt?.deadlineMs).toBe(600000);
    expect(attempt?.quietMs).toBe(QUIET_MS);
  });

  it("makes a compaction Pi started itself measurable in milliseconds", async () => {
    const h = await setup();
    // Pi's own threshold path fires both hooks, so a duration becomes computable even though the completion event
    // carries none. A turn is what a threshold compaction happens during, so the idle timer is cancelled first -
    // otherwise the quiet window fires mid-test and the completion looks like the idle path's own. This is the size class nobody had measured: 116325 tokens and 119360 tokens contributed zero
    // duration data to the fleet's own logs.
    await h.pi.emit("turn_start", { type: "turn_start", turnIndex: 1 }, h.context);
    await h.pi.emit("session_before_compact", { type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold" }, h.context);
    vi.advanceTimersByTime(184000);
    await h.pi.emit("session_compact", { type: "session_compact", reason: "threshold", compactionEntry: { id: "c1", tokensBefore: 116325, summary: "x".repeat(19253) } }, h.context);

    const line = logLines(h).find((entry) => entry.kind === "compacted" && entry.trigger === "pi:threshold");
    expect(line.tokensBefore).toBe(116325);
    expect(line.summaryChars).toBe(19253);
    // `tailMs`, not `ms`: the span left over after an earlier handler did the summarising. A reader comparing it to
    // the idle path's genuine `ms` has to be able to see that they are two different measurements.
    expect(line.tailMs).toBe(184000);
    expect(line.tailMsSource).toContain("the summarisation ran in an earlier handler");
    expect(line.ms).toBeUndefined();
    // Pi's completion event carries no landing size, so the log carries this session's own estimate, labelled.
    expect(line.tokensAfter).toBe(78000);
    expect(line.tokensAfterSource).toBe("getContextUsage at session_compact");
    expect(line.freed).toBe(116325 - 78000);
  });

  it("says which build and which config a session is running, on the line it opens its log with", async () => {
    // Every build identity question this fleet has had was answered by guessing from which fields a line happened
    // to carry. A pod that never compacts now still reports what it is running.
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-idle-build-"));
    dirs.push(cwd);
    writeConfig(cwd, { softPercent: 30, gateMaxWaitMs: 3600000 }, new Date("2026-11-27T03:00:00.000Z"));
    const h = await setup({ cwd });

    const start = logLines(h).find((entry) => entry.kind === "start");
    expect(start?.trigger).toBe("session_start:startup");
    expect(String(start?.build)).toMatch(/^[0-9a-f]{7,12}$/);
    expect(start?.cfgFrom).toBe(path.join(cwd, ".pi", "idle-compaction.json"));
    expect(start?.cfg.softPercent).toBe(30);
    expect(start?.cfg.gateMaxWaitMs).toBe(3600000);
    expect(start?.cfg.deadlineMs).toBe(240000); // the shipped default, untouched by this test's config file

    // And the arm line repeats the two things that identify it, so a single line is enough to judge a decision.
    await settle(h);
    vi.advanceTimersByTime(QUIET_MS);
    const attempt = logLines(h).find((entry) => entry.kind === "compact");
    expect(attempt?.build).toBe(start?.build);
    expect(attempt?.cfgFrom).toBe(start?.cfgFrom);
    expect(attempt?.cfg.softPercent).toBe(30);
  });
});
