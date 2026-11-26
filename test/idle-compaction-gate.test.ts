import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createContext, createFakePi, runCommand, type FakeContext, type FakePi, type FakeUi } from "./harness.ts";

/**
 * The fleet gate: one idle summarisation at a time, and starts spaced apart.
 *
 * This file exists because of a field result, not a hypothesis. On 2026-11-26 a deploy stamp restarted every pod
 * in the fleet inside the same second, so every session's quiet window opened at the same instant, and nine of them
 * issued a summarisation request between 17:09:42Z and 17:09:50Z against `rooter` and `retainer`, which serve every
 * model here. Every one was aborted at the then-120 s deadline, each having spent the whole call and freed nothing,
 * and the session that fired forty-five seconds later died the same way:
 *
 *   rooter 88190 · camry 84917 · memebrary 74039 · macgrubernetes 90599 · pi-team-room 186420 · macker 71229
 *   home-ops 86748 · pi-bot 58877 · maclet 63058 · and pi-ed (settled trigger) 86318: 0 tokens freed each
 *
 * The two attempts in those same logs that fired outside the burst show what a solo call costs this feature:
 * slopyphus summarised 57181 tokens in 59.2 s, and pi-bot summarised 103142 in 107.2 s. Same backend, same sizes,
 * 59-107 s instead of never finishing. Concurrency was the difference. So the claims worth asserting are:
 *
 * 1. **Sessions that start in the same second do not summarise in the same minute.** Observable, not documented.
 *    The nine-name replay below asserts the gap between every pair of starts, from the logs the sessions wrote.
 * 2. **One in flight at a time**, on a lease another session can see and wait on.
 * 3. **A lease left behind by a killed pod is taken over**, so the fleet is never permanently blocked by a corpse.
 * 4. **A person asking now is not queued behind the gate**, and a returning person cancels the wait.
 *
 * The gate lives on a directory the sessions share, which is what `/workspace` is to the pods: every checkout is
 * a direct child of it. Here it is a temp directory, and each session gets its own fake repo directory underneath.
 */

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/idle-compaction.ts");

const QUIET_MS = 120000;
const SPREAD_MS = 90000;
const POLL_MS = 30000;
/** `deadlineMs` as shipped. The gate tests do not override it, and one test below runs a ceiling out to its end. */
const DEADLINE_MS = 240000;

let dirs: string[] = [];
let gateDir: string = "";

beforeEach(() => {
  vi.useFakeTimers();
  gateDir = mkdtempSync(path.join(tmpdir(), "pi-ed-gate-"));
  dirs.push(gateDir);
  process.env.IDLE_COMPACTION_GATE_DIR = gateDir;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.IDLE_COMPACTION_GATE_DIR;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Session {
  name: string;
  cwd: string;
  pi: FakePi;
  context: FakeContext;
  ui: FakeUi;
  compacts: Array<{ options: any }>;
  calls: Array<{ name: string; args: unknown[] }>;
}

/**
 * A pod in the fleet layout: a named directory under a shared parent, with its own session id.
 */
async function pod(name: string, options: { sessionId?: string; idle?: boolean } = {}): Promise<Session> {
  const parent = mkdtempSync(path.join(tmpdir(), "pi-ed-fleet-"));
  dirs.push(parent);
  const cwd = path.join(parent, name);
  mkdirSync(cwd, { recursive: true });
  const pi = createFakePi();
  const record = createContext({
    cwd,
    sessionId: options.sessionId ?? `session-${name}`,
    idle: options.idle ?? true,
    contextUsage: { percent: 60, tokens: 78000, contextWindow: 131072 },
  });
  const mod = await import(MODULE);
  (mod as { default: (api: unknown) => void }).default(pi as any);
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, record.context);
  return { name, cwd, pi, context: record.context, ui: record.ui, compacts: record.compacts, calls: record.calls };
}

function completed(after: number) {
  return { summary: "summary text", firstKeptEntryId: "entry-9", tokensBefore: 78000, estimatedTokensAfter: after, usage: { output: 2500 } };
}

/** The decision log this session wrote, parsed. Every entry carries the wall clock the extension saw. */
function log(cwd: string): Array<Record<string, any>> {
  const file = path.join(cwd, ".pi", "idle-compaction", "log.jsonl");
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  } catch {
    return [];
  }
}

/** Fake-time milliseconds of every `ctx.compact()` this fleet performed, oldest first. */
function compactTimes(sessions: Session[]): number[] {
  const times = new Set<number>();
  for (const s of sessions) {
    for (const entry of log(s.cwd)) {
      if (entry.kind === "compact") times.add(Date.parse(entry.at));
    }
  }
  return [...times].sort((a, b) => a - b);
}

describe("the fleet gate", () => {
  it("keeps sessions that started in the same second out of the same minute", async () => {
    // The deploy stamp, replayed with the nine names from the field burst: every pod starts inside one second, so
    // every startup window arms at the same instant.
    const names = ["camry", "home-ops", "maclet", "macker", "memebrary", "pi-bot", "pi-team-room", "quake", "rooter"];
    const sessions: Session[] = [];
    for (const name of names) sessions.push(await pod(name));

    // All of them reach their quiet window together, twelve minutes after start in fake time but one instant apart.
    vi.advanceTimersByTime(QUIET_MS);

    const started = sessions.filter((s) => s.compacts.length > 0);
    expect(started).toHaveLength(1);
    expect(started[0]!.compacts).toHaveLength(1);

    // Drain the queue: finish whatever is in flight, then move the clock and see who gets it next.
    const done = new Map<Session, number>();
    let finished = 0;
    for (let step = 0; step < 60 && finished < sessions.length; step += 1) {
      for (const s of sessions) {
        const completedCount = done.get(s) ?? 0;
        if (s.compacts.length > completedCount) {
          s.compacts[completedCount]!.options.onComplete(completed(31000));
          done.set(s, completedCount + 1);
          finished += 1;
        }
      }
      vi.advanceTimersByTime(POLL_MS + SPREAD_MS);
    }

    expect(sessions.every((s) => s.compacts.length === 1)).toBe(true);

    const times = compactTimes(sessions);
    expect(times).toHaveLength(sessions.length);
    const gaps = times.slice(1).map((at, i) => at - times[i]!);
    // The acceptance claim, stated as a number: no two summarisations in this fleet started inside the same minute.
    // The run measures 93.2 s to 125.6 s, which is what `spreadMs` plus the poll interval adds up to.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60000);
    // And the queue moves: a fleet that starves a session for ten minutes has not been protected, it has been stalled.
    expect(Math.max(...gaps)).toBeLessThan(180000);

    // And the mechanism is visible in the logs rather than inferred: every one of these sessions either held the
    // gate or recorded waiting on it.
    const waits = sessions.flatMap((s) => log(s.cwd).filter((entry) => entry.kind === "gate" && entry.heldBy));
    expect(waits.length).toBeGreaterThanOrEqual(sessions.length - 1);
    expect(waits.every((entry) => typeof entry.waitMs === "number" && entry.waitMs > 0)).toBe(true);
  });

  it("lets one session compact while every other session can see that it is busy", async () => {
    const holder = await pod("rooter");
    const waiter = await pod("camry");

    vi.advanceTimersByTime(QUIET_MS);
    expect(holder.compacts).toHaveLength(1);
    // Nothing calls onComplete: this is the summarisation that is still running.

    vi.advanceTimersByTime(POLL_MS * 3);
    expect(waiter.compacts).toHaveLength(0);

    const entry = log(waiter.cwd).find((line) => line.kind === "gate" && line.heldBy);
    expect(entry).toBeDefined();
    expect(entry!.heldBy).toBe("rooter");
    expect(entry!.heldMs).toBeGreaterThanOrEqual(0);

    // Release it and the waiter gets its turn.
    holder.compacts[0]!.options.onComplete(completed(31000));
    vi.advanceTimersByTime(SPREAD_MS + POLL_MS * 3);
    expect(waiter.compacts).toHaveLength(1);
  });

  it("paces the fleet after a summarisation died at its ceiling, and says which of the two it was", async () => {
    // The field shape pi-bot measured at 2026-11-26T21:11:45Z: a 98484-token attempt held the lease, ran to its
    // 240000ms deadline, was cancelled, and the spacing stamp that appeared was dated at the abort. That is
    // deliberate, and this is what it buys: a peer does not immediately re-buy the summarisation that just failed.
    const holder = await pod("home-ops");
    const peer = await pod("camry");

    vi.advanceTimersByTime(QUIET_MS);
    expect(holder.compacts).toHaveLength(1);
    expect(peer.compacts).toHaveLength(0);
    expect(log(peer.cwd).some((entry) => entry.kind === "gate" && entry.heldBy === "home-ops")).toBe(true);

    // The ceiling expires, this session's own abort wins the race, and Pi reports the cancellation.
    vi.advanceTimersByTime(DEADLINE_MS + 1);
    expect(log(holder.cwd).some((entry) => entry.kind === "deadline" && entry.elapsedMs === DEADLINE_MS)).toBe(true);

    const abortedAt = Date.now();
    holder.compacts[0]!.options.onError(new Error("Compaction cancelled"));

    // The gate is handed back, so the fleet is not blocked behind a dead lease...
    expect(() => readFileSync(path.join(gateDir, "lease.json"), "utf8")).toThrow();
    const stamp = JSON.parse(readFileSync(path.join(gateDir, "spacing.json"), "utf8")) as {
      at: number;
      repo: string;
      outcome: string;
      prior: Array<{ at: number; repo: string; outcome: string }>;
    };
    // ...and the stamp now answers who, when and why, which is the difference between "waiting for a summarisation"
    // and "waiting for one that was cancelled at a ceiling".
    expect(stamp.repo).toBe("home-ops");
    expect(stamp.at).toBe(abortedAt);
    expect(stamp.outcome).toBe("aborted at deadline");

    // A session that arms while the stamp is young is refused by the stamp rather than by a lease: nothing is
    // summarising any more, and it still has to wait. `quietMs` is what lands its arm inside the spread window.
    process.env.IDLE_COMPACTION_QUIET_MS = "20000";
    let late: Session;
    try {
      late = await pod("macker");
      vi.advanceTimersByTime(20000);
    } finally {
      delete process.env.IDLE_COMPACTION_QUIET_MS;
    }

    expect(late.compacts).toHaveLength(0);
    const refusals = log(late.cwd).filter((entry) => entry.kind === "gate" && String(entry.heldBy ?? "").startsWith("the spacing stamp left by "));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.heldBy).toBe("the spacing stamp left by home-ops");
    expect(refusals[0]!.heldMs).toBeGreaterThanOrEqual(19000);
    expect(refusals[0]!.heldMs).toBeLessThan(SPREAD_MS);
    expect(refusals[0]!.waitMs).toBeGreaterThan(0);

    // A failure paces the fleet; it does not stall it. Past the spread (plus the worst-case jitter the waiter can
    // be told), the late session gets its turn - and the shared file then holds both halves of the pair, which is
    // what it could not show tonight: every pod saw its own refusal, and nobody could read the pairing.
    vi.advanceTimersByTime(SPREAD_MS * 2 + POLL_MS * 2);
    expect(late.compacts).toHaveLength(1);
    late.compacts[0]!.options.onComplete(completed(31000));

    const history = JSON.parse(readFileSync(path.join(gateDir, "spacing.json"), "utf8")) as {
      repo: string;
      outcome: string;
      prior: Array<{ at: number; repo: string; outcome: string }>;
    };
    expect(history.repo).toBe("macker");
    expect(history.outcome).toBe("compacted");
    expect(history.prior[0]).toEqual({ at: abortedAt, repo: "home-ops", outcome: "aborted at deadline" });
  });

  it("takes over a lease left behind by a session that died mid-compaction", async () => {
    mkdirSync(gateDir, { recursive: true });
    const dead = Date.now() - 600000;
    writeFileSync(
      path.join(gateDir, "lease.json"),
      JSON.stringify({ sessionId: "gone", repo: "deleted-pod", startedAt: dead, expiresAt: dead + 60000, deadlineMs: 60000 }),
      "utf8",
    );

    const living = await pod("home-ops");
    vi.advanceTimersByTime(QUIET_MS);
    expect(living.compacts).toHaveLength(1);

    const takeover = log(living.cwd).find((entry) => entry.kind === "gate" && entry.action === "took over");
    expect(takeover).toBeDefined();
    expect(takeover!.from).toBe("deleted-pod");
    expect(takeover!.heldForMs).toBeGreaterThan(60000);
  });

  it("does not queue a person who asked now behind the gate", async () => {
    const holder = await pod("rooter");
    const asking = await pod("camry");

    vi.advanceTimersByTime(QUIET_MS);
    expect(holder.compacts).toHaveLength(1);

    await runCommand(asking.pi, "idle-compact", "run", asking.context);
    expect(asking.compacts).toHaveLength(1);
  });

  it("drops the wait when a person comes back, rather than compacting under them", async () => {
    const holder = await pod("rooter");
    const waiter = await pod("camry");

    vi.advanceTimersByTime(QUIET_MS);
    expect(holder.compacts).toHaveLength(1);
    vi.advanceTimersByTime(POLL_MS);
    expect(waiter.compacts).toHaveLength(0);

    // A turn starts: the queued wait is cancelled by anything that means a run is happening.
    await waiter.pi.emit("turn_start", { type: "turn_start", turnIndex: 2 }, waiter.context);
    vi.advanceTimersByTime(POLL_MS * 6);
    expect(waiter.compacts).toHaveLength(0);

    holder.compacts[0]!.options.onComplete(completed(31000));
    vi.advanceTimersByTime(SPREAD_MS + POLL_MS * 4);
    expect(waiter.compacts).toHaveLength(0);
  });

  it("hands the gate back when the session goes away, so a restart does not leave the fleet waiting", async () => {
    const holder = await pod("rooter");
    vi.advanceTimersByTime(QUIET_MS);
    expect(holder.compacts).toHaveLength(1);

    await holder.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, holder.context);
    expect(() => readFileSync(path.join(gateDir, "lease.json"), "utf8")).toThrow();

    // Recorded in the log, not only debugged. A reload is otherwise invisible in a pod's own log: the line people
    // look for is the next session's `trigger:"session_start:reload"`, and that only proves a reload happened if
    // this one is there to show where the previous session ended.
    const shutdown = log(holder.cwd).find((entry) => entry.kind === "session-shutdown");
    expect(shutdown?.reason).toBe("quit");
    expect(shutdown?.gate).toBe("session shutdown");

    const next = await pod("camry");
    vi.advanceTimersByTime(QUIET_MS);
    expect(next.compacts).toHaveLength(1);
  });

  it("stops queueing once the wait has outlasted the point of waiting", async () => {
    // Queueing has to end, and the give-up path is the one nobody had ever run: a session that waits past
    // gateMaxWaitMs records a skip with a reason instead of re-checking forever behind a stuck holder.
    process.env.IDLE_COMPACTION_GATE_MAX_WAIT_MS = "120000";
    try {
      const holder = await pod("rooter");
      const waiter = await pod("camry");

      vi.advanceTimersByTime(QUIET_MS);
      expect(holder.compacts).toHaveLength(1);

      // Nothing ever calls onComplete: this is the holder that will not let go, which is the situation the cap is for.
      for (let step = 0; step < 8; step += 1) vi.advanceTimersByTime(POLL_MS);

      const gaveUp = log(waiter.cwd).find((entry) => entry.kind === "skip" && String(entry.reason ?? "").includes("gave up after"));
      expect(gaveUp).toBeDefined();
      expect(gaveUp!.reason).toContain("gate held by rooter");
      expect(gaveUp!.queuedMs).toBeGreaterThan(120000);
      expect(waiter.compacts).toHaveLength(0);

      // Giving up releases nothing it held and does not resume on a timer: the next attempt needs an arm, and an arm
      // needs something to settle. That is deliberate - a session whose person is away gets one queued attempt, not
      // an eternal poll loop.
      vi.advanceTimersByTime(SPREAD_MS + POLL_MS * 4);
      expect(waiter.compacts).toHaveLength(0);

      await waiter.pi.emit("agent_settled", { type: "agent_settled", aborted: false }, waiter.context);
      vi.advanceTimersByTime(QUIET_MS + SPREAD_MS + POLL_MS * 4);
      expect(waiter.compacts).toHaveLength(1);
    } finally {
      delete process.env.IDLE_COMPACTION_GATE_MAX_WAIT_MS;
    }
  });

  it("gates a summarisation Pi started itself, which is most of what this fleet compacts", async () => {
    // Counting every `log.jsonl` on the volume on 2026-11-26: 21 completed summarisations, 12 of them
    // `trigger:"pi:threshold"` at 114803-119360 tokens, and not one of those 12 left a lease or a spacing stamp.
    // The gate cannot refuse that path - a session at 87.5% of its window that skips a summarisation pays for it at
    // the next prompt - so it holds the lease on the path's behalf and peers queue behind it.
    const busy = await pod("home-ops");
    // Something is running on home-ops: its idle window is closed, so the only summarisation it does is Pi's.
    await busy.pi.emit("turn_start", { type: "turn_start", turnIndex: 1 }, busy.context);
    const waiter = await pod("camry");

    await busy.pi.emit(
      "session_before_compact",
      { type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold", willRetry: false },
      busy.context,
    );
    expect(JSON.parse(readFileSync(path.join(gateDir, "lease.json"), "utf8")).repo).toBe("home-ops");

    // An idle attempt on another pod now queues behind a summarisation it has no visibility into, instead of
    // starting beside it - which is the contention the fleet's deadline aborts were actually read as.
    vi.advanceTimersByTime(QUIET_MS);
    expect(waiter.compacts).toHaveLength(0);
    expect(
      log(waiter.cwd).some((entry) => entry.kind === "gate" && String(entry.heldBy ?? "").includes("home-ops")),
    ).toBe(true);

    await busy.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        reason: "threshold",
        compactionEntry: { id: "c1", tokensBefore: 115412, summary: "pi wrote this one" },
      },
      busy.context,
    );
    expect(existsSync(path.join(gateDir, "lease.json"))).toBe(false);

    // The spacing stamp says *which* path ran, so a reader of the shared directory can tell a gated idle completion
    // from a Pi threshold completion without reading two pods' logs.
    const spacing = JSON.parse(readFileSync(path.join(gateDir, "spacing.json"), "utf8"));
    expect(spacing.repo).toBe("home-ops");
    expect(spacing.outcome).toBe("Pi threshold completion");

    vi.advanceTimersByTime(SPREAD_MS + POLL_MS * 4);
    expect(waiter.compacts).toHaveLength(1);
  });

  it("renews a Pi-path hold so a long summarisation cannot expire the gate out from under itself", async () => {
    // Pi's own path has no `deadlineMs`: that ceiling bounds the attempts this extension starts. And the fleet has
    // never measured a threshold summarisation's duration, because the builds that ran them stamped no start - all
    // 12 came back with no `ms` at all. So the hold is pushed forward while the compaction is in flight, and a pod
    // that dies simply stops renewing.
    const busy = await pod("home-ops");
    await busy.pi.emit("turn_start", { type: "turn_start", turnIndex: 1 }, busy.context);
    const waiter = await pod("camry");
    await busy.pi.emit(
      "session_before_compact",
      { type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold", willRetry: false },
      busy.context,
    );
    const held = JSON.parse(readFileSync(path.join(gateDir, "lease.json"), "utf8"));
    expect(held.expiresAt - held.startedAt).toBe(DEADLINE_MS + 30000);

    // Longer than that lease was ever written to live, with no completion event in between.
    vi.advanceTimersByTime(DEADLINE_MS + 120000);
    const renewed = JSON.parse(readFileSync(path.join(gateDir, "lease.json"), "utf8"));
    expect(renewed.startedAt).toBe(held.startedAt); // `heldMs` still measures from when the hold actually began
    expect(renewed.expiresAt).toBeGreaterThan(held.expiresAt + DEADLINE_MS);

    vi.advanceTimersByTime(QUIET_MS);
    expect(waiter.compacts).toHaveLength(0);

    await busy.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        reason: "threshold",
        compactionEntry: { id: "c1", tokensBefore: 119360, summary: "pi wrote this one" },
      },
      busy.context,
    );
    expect(existsSync(path.join(gateDir, "lease.json"))).toBe(false);

    vi.advanceTimersByTime(SPREAD_MS + POLL_MS * 4);
    expect(waiter.compacts).toHaveLength(1);
  });

  it("does not leave the fleet waiting when Pi's own compaction dies", async () => {
    // A compaction that never completed must not hold the fleet for a TTL nobody has evidence about: without this
    // path the wait is 240 s plus grace, which is 270 s of queue that could have run at 90.
    const busy = await pod("home-ops");
    await busy.pi.emit("turn_start", { type: "turn_start", turnIndex: 1 }, busy.context);
    const waiter = await pod("macker");
    await busy.pi.emit(
      "session_before_compact",
      { type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold", willRetry: false },
      busy.context,
    );
    expect(existsSync(path.join(gateDir, "lease.json"))).toBe(true);

    await busy.pi.emit(
      "session_compact_failed",
      { type: "session_compact_failed", reason: "threshold", aborted: true, willRetry: false },
      busy.context,
    );
    expect(existsSync(path.join(gateDir, "lease.json"))).toBe(false);
    const spacing = JSON.parse(readFileSync(path.join(gateDir, "spacing.json"), "utf8"));
    expect(spacing.outcome).toBe("Pi threshold aborted");
    const released = log(busy.cwd).find(
      (entry) => entry.kind === "gate" && entry.action === "released after Pi's compaction did not complete",
    );
    expect(released?.outcome).toBe("Pi threshold aborted");
    expect(released?.aborted).toBe(true);

    vi.advanceTimersByTime(SPREAD_MS + QUIET_MS + POLL_MS * 4);
    expect(waiter.compacts).toHaveLength(1);
  });

  it("lets go of a Pi-path hold that never got a completion, rather than renewing it forever", async () => {
    // Pi puts no timeout on its own compaction path - `_runAutoCompaction` in dist/core/agent-session.js carries an
    // `AbortController` and the file contains no `setTimeout` or `AbortSignal.timeout` at all - so a summarisation
    // that never reports back (cancelled by another extension's `session_before_compact` result, say) would renew
    // its own lease indefinitely, and every idle session in the fleet would queue behind it indefinitely.
    const busy = await pod("home-ops");
    await busy.pi.emit("turn_start", { type: "turn_start", turnIndex: 1 }, busy.context);
    const waiter = await pod("macker");
    await busy.pi.emit(
      "session_before_compact",
      { type: "session_before_compact", preparation: {}, branchEntries: [], reason: "manual", willRetry: false },
      busy.context,
    );

    // Past the bound, with no completion event and no failure event: nothing else could notice.
    vi.advanceTimersByTime(480000 + POLL_MS * 2);
    expect(existsSync(path.join(gateDir, "lease.json"))).toBe(false);
    const spacing = JSON.parse(readFileSync(path.join(gateDir, "spacing.json"), "utf8"));
    expect(spacing.repo).toBe("home-ops");
    expect(spacing.outcome).toBe("Pi hold expired");
    const expired = log(busy.cwd).find(
      (entry) => entry.kind === "gate" && entry.action === "released because Pi's compaction never reported back",
    );
    expect(expired?.heldMs).toBeGreaterThan(480000);
    expect(expired?.maxHoldMs).toBe(480000);

    vi.advanceTimersByTime(SPREAD_MS + QUIET_MS + POLL_MS * 4);
    expect(waiter.compacts).toHaveLength(1);
  });

  it("records that Pi compacted while somebody else held the gate, rather than smoothing it over", async () => {
    // The one concurrency the gate still cannot prevent: an attempt already in flight when Pi's path fires. Pi is
    // neither refused nor delayed for it - refusing a session that has already spent its window trades a fleet delay
    // for a broken prompt - so the collision gets written down instead.
    const holder = await pod("macker");
    const busy = await pod("home-ops");
    await busy.pi.emit("turn_start", { type: "turn_start", turnIndex: 1 }, busy.context);

    vi.advanceTimersByTime(QUIET_MS);
    expect(holder.compacts).toHaveLength(1); // macker holds the lease

    await busy.pi.emit(
      "session_before_compact",
      { type: "session_before_compact", preparation: {}, branchEntries: [], reason: "overflow", willRetry: true },
      busy.context,
    );
    expect(JSON.parse(readFileSync(path.join(gateDir, "lease.json"), "utf8")).repo).toBe("macker");
    expect(
      log(busy.cwd).some(
        (entry) => entry.kind === "gate" && entry.action === "Pi compacting while the gate is held elsewhere" && entry.heldBy === "macker",
      ),
    ).toBe(true);

    await busy.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        reason: "overflow",
        compactionEntry: { id: "c1", tokensBefore: 134390, summary: "pi wrote this one" },
      },
      busy.context,
    );
    // It never owned the lease, so it cannot release macker's - and it must not stamp either, since it has nothing
    // of its own to space the next fleet start after.
    expect(JSON.parse(readFileSync(path.join(gateDir, "lease.json"), "utf8")).repo).toBe("macker");
    expect(existsSync(path.join(gateDir, "spacing.json"))).toBe(false);

    holder.compacts[0]!.options.onComplete(completed(31000));
    expect(JSON.parse(readFileSync(path.join(gateDir, "spacing.json"), "utf8")).outcome).toBe("compacted");
  });

  it("runs ungated when there is no fleet to gate", async () => {
    delete process.env.IDLE_COMPACTION_GATE;
    process.env.IDLE_COMPACTION_GATE = "off";
    try {
      const a = await pod("rooter", { sessionId: "session-a" });
      const b = await pod("camry", { sessionId: "session-b" });
      vi.advanceTimersByTime(QUIET_MS);
      // Two sessions, two compactions, same instant: the old behaviour, which is what a single session wants.
      expect(a.compacts).toHaveLength(1);
      expect(b.compacts).toHaveLength(1);
    } finally {
      delete process.env.IDLE_COMPACTION_GATE;
    }
  });
});
