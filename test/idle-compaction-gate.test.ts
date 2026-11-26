import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    const next = await pod("camry");
    vi.advanceTimersByTime(QUIET_MS);
    expect(next.compacts).toHaveLength(1);
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
