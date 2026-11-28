import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The stall fixture below needs a FIFO. Where mkfifo does not exist the test is skipped rather than failed:
// a missing coreutil is not a defect in the ceiling it is trying to prove.
const HAVE_MKFIFO = (() => {
  try {
    execFileSync("mkfifo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

import { createContext, createFakePi } from "./harness.ts";

import {
  armDecision,
  classifyCatalystText,
  coldSeconds,
  DEFAULT_WARM_CONFIG,
  isHumanCatalyst,
  latestRequestCatalyst,
  parseCallEvents,
  rooterKey,
  sessionRhythm,
  type CallEvidence,
  type CatalystRead,
  type WarmConfig,
} from "../lib/cache-warm.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/cache-warm-policy.ts");

const NOW = Date.parse("2026-11-27T10:00:00.000Z");

function cfg(over: Partial<WarmConfig> = {}): WarmConfig {
  return { ...DEFAULT_WARM_CONFIG, ...over };
}

function row(over: Partial<CallEvidence> = {}): CallEvidence {
  return {
    atMs: NOW - 60_000,
    backend: "strata",
    model: "qwen3.8-flash-next-iq3_xxs",
    promptTokens: 42000,
    computedTokens: 12000,
    cacheHitRate: 0.71,
    aborted: false,
    ...over,
  };
}

/** A session that comes back every six minutes. */
const BUSY = { windowMs: 60 * 60_000, arrivals: 10, humanArrivalsPerHour: 10, medianGapMs: 360_000, lastArrivalMs: NOW - 120_000, sinceLastMs: 120_000 };
/** A session that wakes once and has been quiet since. */
const WAKE_ONCE = { windowMs: 60 * 60_000, arrivals: 1, humanArrivalsPerHour: 1, medianGapMs: undefined, lastArrivalMs: NOW - 50 * 60_000, sinceLastMs: 50 * 60_000 };

/**
 * Catalysts, in the shape `armDecision` takes.
 *
 * Every other rule in the gate can pass and still not justify a warm, so the fixtures say who opened the run. The
 * default when a caller passes none is `unknown`, which vetoes: a gate that armed on an unattributed turn would be
 * spending a re-prefill because nobody could say who it was for.
 */
const cat = (catalyst: CatalystRead["catalyst"], basis: string) => ({ compacting: false, catalyst: { catalyst, basis } });
const HUMAN = cat("terminal", "no peer or chat marker on a user-role turn");
const CHAT = cat("chat", "marker [pi-chat:");
const PEER = cat("peer", "customType pi-team-room-wake");

describe("catalyst of the newest request", () => {
  it("names a peer wake, a scheduled job and an auto-resume as machine turns, from the entry type alone", () => {
    // These are the customTypes this session's own transcript actually carries, so the mapping is against live
    // shapes rather than against names this file would have invented.
    const entry = (customType: string, minutes: number): unknown => ({
      type: "custom_message",
      customType,
      content: "whatever the peer asked for",
      timestamp: new Date(NOW - minutes * 60_000).toISOString(),
    });
    expect(latestRequestCatalyst([entry("pi-team-room-wake", 40), entry("pi-team-room-wake", 5)] as never)).toMatchObject({
      catalyst: "peer",
      basis: "customType pi-team-room-wake",
    });
    expect(latestRequestCatalyst([entry("pi-team-room-wake", 40), entry("schedule-run", 5)] as never).catalyst).toBe("unknown");
    expect(latestRequestCatalyst([entry("pi-team-room-wake", 40), entry("auto-resume-prompt", 5)] as never).catalyst).toBe("unknown");
    expect(latestRequestCatalyst([entry("pi-team-room-wake", 40), entry("memory:dream", 5)] as never).catalyst).toBe("unknown");
    // A pulse is peer chatter arriving alongside a wake, and it is the newest entry more often than the wake is.
    expect(latestRequestCatalyst([entry("pi-team-room-wake", 40), entry("pi-team-room-pulse", 5)] as never).catalyst).toBe("peer");
  });

  it("reads markers off a user-role turn, because on other pods the bridge delivers text rather than typed entries", () => {
    const user = (text: string, minutes: number): unknown => ({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }] },
      timestamp: new Date(NOW - minutes * 60_000).toISOString(),
    });
    expect(latestRequestCatalyst([user("carry on with the roll", 60), user("[pi-chat:c3a58f38a1f27b91] Ed: turn the warming on", 20)] as never)).toMatchObject({
      catalyst: "chat",
    });
    expect(latestRequestCatalyst([user("[pi-chat:abc] a question", 60), user("[Team inbox — steer]\n[owns: pi-bot]\ndelegation", 10)] as never)).toMatchObject({
      catalyst: "peer",
      basis: "marker [Team inbox",
    });
    expect(latestRequestCatalyst([user("[Team inbox — steer] old", 60), user("please just finish the task", 5)] as never).catalyst).toBe("terminal");
    // A harness note that lands on a user-role turn is still not a human coming back.
    expect(latestRequestCatalyst([user("[background job complete] Background job mwzxhszq-sw3wgn succeeded", 5)] as never).catalyst).toBe("unknown");
    expect(latestRequestCatalyst([user("(auto-resume) This session stopped and was resumed.", 5)] as never).catalyst).toBe("unknown");
  });

  it("prefers the newest of the two shapes, since that is the turn the prefix now ends at", () => {
    const humanAt = new Date(NOW - 60_000).toISOString();
    const peerAt = new Date(NOW - 30_000).toISOString();
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "do the thing" }] }, timestamp: humanAt },
      { type: "custom_message", customType: "pi-team-room-wake", content: "peer asked", timestamp: peerAt },
    ];
    expect(latestRequestCatalyst(branch as never).catalyst).toBe("peer");
    // And the other way round: a person typing after the peer wake is a human turn again.
    const later = new Date(NOW - 10_000).toISOString();
    expect(latestRequestCatalyst([...branch, { type: "message", message: { role: "user", content: "thanks, now ship it" }, timestamp: later }] as never).catalyst).toBe(
      "terminal",
    );
  });

  it("answers unknown instead of throwing when the tail is unreadable, and never carries the text", () => {
    expect(latestRequestCatalyst([] as never)).toEqual({ catalyst: "unknown", basis: "no user or custom_message entry on the branch" });
    expect(latestRequestCatalyst([null, {}, { type: "message" }] as never).catalyst).toBe("unknown");
    expect(latestRequestCatalyst([{ type: "message", message: { role: "user", content: 42 }, timestamp: NOW }] as never).catalyst).toBe("unknown");
    expect(latestRequestCatalyst(undefined as never).catalyst).toBe("unknown");
    // The basis is what lands in the log, so it must not repeat the turn: a peer question can carry anything.
    const read = latestRequestCatalyst([{ type: "custom_message", customType: "pi-team-room-wake", content: "secret-ish text", timestamp: NOW }] as never);
    expect(JSON.stringify(read)).not.toContain("secret-ish");
    expect(classifyCatalystText("   \n  ").catalyst).toBe("unknown");
    expect(isHumanCatalyst("chat")).toBe(true);
    expect(isHumanCatalyst("terminal")).toBe(true);
    expect(isHumanCatalyst("peer")).toBe(false);
    expect(isHumanCatalyst("unknown")).toBe(false);
    expect(isHumanCatalyst(undefined)).toBe(false);
  });

  it("vetoes a warm the other rules would have armed, and says so on the row", () => {
    // The rest of the fixture is a textbook arm: 22,000 median recompute on sushi, 10 arrivals/h, 93s avoided.
    const rows = [row({ computedTokens: 20000, backend: "sushi" }), row({ computedTokens: 24000, backend: "sushi", cacheHitRate: 0.43 })];
    for (const catalyst of [PEER, { compacting: false, catalyst: { catalyst: "unknown" as const, basis: "customType schedule-run" } }]) {
      const decision = armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", catalyst);
      expect(decision.action).toBe("stop");
      expect(decision.reason).toContain("not a human coming back");
      expect(decision.reason).toContain("the other rules cleared, and a refresh would have avoided (93s at sushi's measured 236 tok/s)");
      // The point of putting this last: observe can count how often the rule alone mattered.
      expect(decision.detail.catalystVetoed).toBe(true);
      expect(decision.detail.medianComputedTokens).toBe(22000);
      expect(decision.detail.coldSecondsAvoided).toBe(93);
    }
    // A human catalyst on the same evidence still arms, so the precondition is a filter and not a kill switch.
    expect(armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", HUMAN).action).toBe("warm");
    expect(armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", CHAT).action).toBe("warm");
    // Omitting the catalyst is not the same as claiming one.
    expect(armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop").action).toBe("stop");
  });
});

describe("rooter key", () => {
  it("is rooter's truncation of the Pi session id, which is what live rows are keyed by", () => {
    // `h:01a1a9b1-7` is the key this session's own rows arrive under; the session id is
    // `01a1a9b1-795c-7190-862e-cde05ddd7bc0`.
    expect(rooterKey("01a1a9b1-795c-7190-862e-cde05ddd7bc0")).toBe("h:01a1a9b1-7");
    expect(rooterKey(" 01a1a9b1-795c-7190 ")).toBe("h:01a1a9b1-7");
  });
});

describe("cold seconds", () => {
  it("prices recompute from rooter's measured cold rates, which are slower than the old assumption", () => {
    // 42,000 tokens is 178s on sushi at 236.7 tok/s and 20s on strata at 2,147 tok/s (rooter
    // /rooter/backends, 2026-11-27). The earlier table said 91s for sushi.
    expect(coldSeconds(42000, "sushi")).toBe(178);
    expect(coldSeconds(42000, "strata")).toBe(20);
    expect(coldSeconds(42000, "unknown-box")).toBeUndefined();
    expect(coldSeconds(0, "sushi")).toBeUndefined();
    // A caller that has the live counters uses them instead of the shipped table.
    expect(coldSeconds(42000, "sushi", { sushi: 4000 })).toBe(11);
  });
});

describe("parseCallEvents", () => {
  const body = {
    events: [
      { ts: "2026-11-27T09:59:00Z", kind: "gen", key: "h:01a1a9b1-7", backend: "strata", prompt_tokens: 40000, prompt_tokens_computed: 15000, cache_hit_rate: 0.62, status: 200 },
      { ts: "2026-11-27T09:58:00Z", kind: "gen", key: "h:01a1a9b1-7", backend: "strata", prompt_tokens: 38000, prompt_tokens_computed: 11000, cache_hit_rate: 0.71, status: 499, aborted: true },
      // Another session's rows, a health probe, and a stale row must not enter the median.
      { ts: "2026-11-27T09:57:00Z", kind: "gen", key: "h:01a1f966-8", backend: "sushi", prompt_tokens: 90000, prompt_tokens_computed: 90000, cache_hit_rate: 0, status: 200 },
      { ts: "2026-11-27T09:56:00Z", kind: "health", key: "h:01a1a9b1-7", prompt_tokens: 0, prompt_tokens_computed: 0 },
      { ts: "2026-11-26T09:00:00Z", kind: "gen", key: "h:01a1a9b1-7", backend: "strata", prompt_tokens: 12000, prompt_tokens_computed: 12000, cache_hit_rate: 0, status: 200 },
      { ts: "2026-11-27T09:55:00Z", kind: "gen", key: "h:01a1a9b1-7", backend: "strata", prompt_tokens: 36000, cache_hit_rate: 0.9 },
    ],
  };

  it("keeps this session's generations inside the window, oldest first", () => {
    const rows = parseCallEvents(body, "h:01a1a9b1-7", NOW, cfg());
    expect(rows.map((r) => r.computedTokens)).toEqual([11000, 15000]);
    expect(rows[0]?.aborted).toBe(true);
    expect(rows[1]?.backend).toBe("strata");
  });

  it("accepts a bare list too, and rejects a body that is neither", () => {
    expect(parseCallEvents(body.events, "h:01a1a9b1-7", NOW, cfg()).length).toBe(2);
    expect(parseCallEvents(null, "h:01a1a9b1-7", NOW, cfg())).toEqual([]);
    expect(parseCallEvents({ events: "nope" }, "h:01a1a9b1-7", NOW, cfg())).toEqual([]);
  });
});

describe("sessionRhythm", () => {
  const branch = [
    { type: "message", message: { role: "user" }, timestamp: "2026-11-27T09:00:00Z" },
    { type: "message", message: { role: "assistant" }, timestamp: "2026-11-27T09:01:00Z" },
    { type: "message", message: { role: "toolResult" }, timestamp: "2026-11-27T09:02:00Z" },
    { type: "message", message: { role: "user" }, timestamp: "2026-11-27T09:30:00Z" },
    { type: "custom", customType: "turn-stats", timestamp: "2026-11-27T09:31:00Z" },
    // A peer wake inside the window, which is exactly the entry that must not move the rate: machine catalysts
    // persist as custom_message, and a bar that counted them would warm prefixes nobody is coming back to read.
    { type: "custom_message", customType: "pi-team-room-wake", timestamp: "2026-11-27T09:35:00Z" },
    { type: "message", message: { role: "user" }, timestamp: "2026-11-26T09:30:00Z" },
    { type: "compaction", timestamp: "2026-11-27T09:40:00Z", tokensBefore: 100000 },
  ];

  it("counts human turns, not traffic: only user messages are arrivals", () => {
    const rhythm = sessionRhythm(branch, NOW, 60 * 60_000);
    expect(rhythm.arrivals).toBe(2);
    expect(rhythm.humanArrivalsPerHour).toBe(2);
    expect(rhythm.medianGapMs).toBe(1_800_000);
    expect(rhythm.sinceLastMs).toBe(30 * 60_000);
  });

  it("reports an empty rhythm honestly rather than as a busy session", () => {
    const rhythm = sessionRhythm([], NOW, 60 * 60_000);
    expect(rhythm.arrivals).toBe(0);
    expect(rhythm.humanArrivalsPerHour).toBe(0);
    expect(rhythm.medianGapMs).toBeUndefined();
    expect(rhythm.lastArrivalMs).toBeUndefined();
    expect(rhythm.sinceLastMs).toBeUndefined();
  });
});

describe("armDecision", () => {
  it("observe mode stops everything and says that is why", () => {
    const decision = armDecision([row(), row()], BUSY, cfg(), "warm", HUMAN);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("pi said warm");
    expect(decision.reason).toContain("observe mode");
    expect(decision.detail.mode).toBe("observe");
  });

  it("vetoes a session already reading its prompt from cache, because a warm there saves nothing", () => {
    const decision = armDecision([row({ computedTokens: 12000 }), row({ cacheHitRate: 0.998, computedTokens: 219 })], BUSY, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("99% cache read");
    expect(decision.reason).toContain("saves nothing");
  });

  it("stops when the median recompute is under the floor, and prices what it would have saved", () => {
    // This session's real numbers: 219-924 tokens recomputed on a 91k prompt. Nothing to warm.
    const rows = [row({ computedTokens: 329 }), row({ computedTokens: 646 }), row({ computedTokens: 504 })];
    const decision = armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("stop");
    expect(decision.detail.medianComputedTokens).toBe(504);
    expect(decision.reason).toContain("under the 10000 floor");
    expect(decision.reason).toContain("(0s at strata's measured 2147 tok/s)");
  });

  it("refuses a session that has already been silent longer than a refresh would have to cover", () => {
    // The sharpest bar, checked first: a warm protects the entry until the next call, and this session has gone
    // 50 minutes without one against a 33-minute interval.
    const decision = armDecision([row({ computedTokens: 40000 })], WAKE_ONCE, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("nothing has arrived for 50m, longer than the 27m a refresh would have to cover");
    expect(decision.detail.sinceLastMs).toBe(3_000_000);
  });

  it("refuses a warm whose saving is noise, because a refresh replays the whole prompt", () => {
    // ~29,000 recomputed tokens on strata is 14 seconds at its measured 2,147 tok/s: real recompute, over the
    // token floor, on a session that keeps arriving - and not worth a replay of a 42,000-token prompt.
    const rows = [row({ computedTokens: 30000, backend: "strata" }), row({ computedTokens: 28000, backend: "strata", cacheHitRate: 0.3 })];
    const decision = armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("a refresh avoids only (14s at strata's measured 2147 tok/s), under the 30s a replay of 42000 prompt tokens is worth");
    expect(decision.detail.coldSecondsAvoided).toBe(14);
  });

  it("does not let an unpriced box pass as a cheap one", () => {
    // An unknown backend has no rate, so there is no seconds figure to trip the bar on: the gate cannot claim a
    // saving it never priced, and it must not veto for a reason it does not have.
    const rows = [row({ computedTokens: 24000, backend: "unheardof", cacheHitRate: 0.4 })];
    const decision = armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("warm");
    expect(decision.reason).not.toContain("avoids");
    expect(decision.detail.coldSecondsAvoided).toBeUndefined();
  });

  it("refuses a session nobody has written to in the last hour, even one still arriving", () => {
    // 1 human turn spread over a two-hour window, and fresh enough that the idle bar is not what stops it.
    const slow = { ...WAKE_ONCE, windowMs: 2 * 60 * 60_000, arrivals: 1, humanArrivalsPerHour: 0.5, sinceLastMs: 60_000, lastArrivalMs: NOW - 60_000 };
    const decision = armDecision([row({ computedTokens: 40000 })], slow, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("0.50 human arrivals/h is under the 1/h bar");
  });

  it("arms on the case the bar exists for: one human message in the last hour, then idle", () => {
    // Ed's pattern, stated in Chat: he sits down, sends something, idle compaction makes headroom, and warming
    // should follow it. One arrival in an hour is 1/h, and at the old floor of 2 that exact case was refused by
    // the bar whose job was to permit it.
    const justBack = {
      ...WAKE_ONCE,
      arrivals: 1,
      humanArrivalsPerHour: 1,
      lastArrivalMs: NOW - 10 * 60_000,
      sinceLastMs: 10 * 60_000,
    };
    const decision = armDecision([row({ computedTokens: 40000, backend: "sushi" })], justBack, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("warm");
    expect(decision.reason).toContain("1.00 human arrivals/h");
    expect(decision.detail.humanArrivalsPerHour).toBe(1);
  });

  it("arms when a busy session is doing the cold work a warm would have avoided", () => {
    const rows = [row({ computedTokens: 20000, backend: "sushi" }), row({ computedTokens: 24000, backend: "sushi", cacheHitRate: 0.43 })];
    const decision = armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("warm");
    expect(decision.reason).toContain("median recompute 22000 tokens over 2 calls");
    expect(decision.reason).toContain("a refresh avoids (93s at sushi's measured 236 tok/s)");
    expect(decision.detail.coldSecondsAvoided).toBe(93);
    expect(decision.detail.coldSource).toBe("rate table");
    expect(decision.detail.humanArrivalsPerHour).toBe(10);
  });

  it("prices a warm from what the session's own calls actually cost, when rooter timed them", () => {
    // prefill_ms is measured per call, so a session that already paid for a cold recompute in this window
    // states its own price: 61s observed beats any table.
    const rows = [row({ computedTokens: 20000, backend: "sushi", prefillMs: 61_000 }), row({ computedTokens: 24000, backend: "sushi", prefillMs: 84_000 })];
    const decision = armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", HUMAN);
    expect(decision.action).toBe("warm");
    expect(decision.detail.coldSecondsAvoided).toBe(73);
    expect(decision.detail.coldSource).toBe("observed");
    expect(decision.reason).toContain("a refresh avoids (73s of sushi prefill this session already paid in this window)");
  });

  it("ignores a cache reload's prefill time when pricing a cold refresh", () => {
    // A 300-token recompute at 2,000ms of prefill is a prefix reload, not a re-prefill. Pricing a 22,000-token
    // warm from it would claim a warm is free.
    const rows = [row({ computedTokens: 300, backend: "sushi", prefillMs: 2000, cacheHitRate: 0.999 }), row({ computedTokens: 24000, backend: "sushi", cacheHitRate: 0.45 })];
    const decision = armDecision(rows, BUSY, cfg({ mode: "arm" }), "stop", HUMAN);
    // 12,150 is the median recompute of the two calls, priced from the table because the only measured prefill
    // in the window was a reload, not a re-prefill.
    expect(decision.detail.medianComputedTokens).toBe(12150);
    expect(decision.detail.coldSecondsAvoided).toBe(51);
    expect(decision.detail.coldSource).toBe("rate table");
  });

  it("stops with no evidence rather than arming on an empty median", () => {
    const decision = armDecision([], BUSY, cfg({ mode: "arm" }), "warm", HUMAN);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("no rooter call rows for this session");
    expect(decision.detail.evidenceCalls).toBe(0);
  });
});

describe("cache-warm-policy extension", () => {
  let cwd = "";

  beforeEach(async () => {
    // A fresh cwd per test: the decision log is append-only, so a second test reading it would otherwise
    // read the first test's decision and pass on someone else's evidence.
    cwd = await mkdtemp(path.join(os.tmpdir(), "cache-warm-"));
    // The suite promises "everything here runs without infrastructure" (.woodpecker/ci.yaml), and this file
    // broke that promise twice over. (a) A test that took no position on fetch reached the real rooter, which
    // resolved in a dev pod and hung in a CI step pod for ~30s (the OS resolver's own timeout, which a fetch
    // abort does not interrupt), failing pipelines 167-170 as a timeout rather than an assertion. (b) The mode
    // came from the ambient environment, and the fleet now sets CACHE_WARM_MODE=arm in the shared `config`
    // ConfigMap (home-ops 0cbefe7), so a suite run inside a pod inherited "arm" and a test named "in observe
    // mode" asserted against a mode it never chose. Every test starts from observe and no network.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CACHE_WARM_")) delete process.env[key];
    }
    stubFetch(() => ({ ok: true, status: 200, body: { events: [] } }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function load(): Promise<any> {
    vi.resetModules();
    return await import(MODULE);
  }

  function stubFetch(handler: (url: string) => { ok: boolean; status?: number; body?: unknown }) {
    vi.stubGlobal(
      "fetch",
      async (url: string) => {
        const result = handler(String(url));
        return {
          ok: result.ok,
          status: result.status ?? 200,
          json: async () => result.body,
        };
      },
    );
  }

  async function readLog(): Promise<any[]> {
    const text = await readFile(path.join(cwd, ".pi", "cache-warm", "log.jsonl"), "utf8");
    return text.trim().split("\n").map((line) => JSON.parse(line));
  }

  const rooterModel = { provider: "rooter", id: "auto", baseUrl: "https://rooter.dev.initialed85.cc/v1", apiKey: "sk-test" };

  // Rooter rows and branch entries are stamped relative to the real clock: the extension judges evidence
  // against Date.now(), and absolute timestamps would age out of its window whenever the suite runs later
  // in the day than the fixtures assume.
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  /**
   * A branch whose arrivals are a person typing, at `minutes` ago.
   *
   * The gate will not arm on a turn it cannot attribute to a human, so a fixture that wants a warm has to say who
   * asked for it. Entries carry text the way Pi persists them - a user-role message with a content block - which is
   * also what `latestRequestCatalyst` reads on a pod.
   */
  function humanBranch(...minutesAgo: number[]): unknown[] {
    return minutesAgo.map((minutes) => ({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: `what I wanted next (${minutes}m ago)` }] },
      timestamp: ago(minutes),
    }));
  }

  it("answers every decision explicitly, in observe mode, and logs both sides of it", async () => {
    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);
    expect(pi.lifecycleEvents).toContain("cache_warming_decision");

    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c-7190-862e-cde05ddd7bc0", model: rooterModel });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.0219,
      continuationProbability: 0.15,
      action: "stop",
    }, ctx.context);

    // A handler that returned nothing would make Pi fall back to its own answer, which on this fleet is
    // always "stop" - so the gate would silently never exist. The answer has to be explicit.
    expect(result).toEqual({ action: "stop" });

    const [record] = await readLog();
    expect(record.mode).toBe("observe");
    expect(record.actionFromPi).toBe("stop");
    expect(record.action).toBe("stop");
    expect(record.warmCost).toBe(0.0041);
    expect(record.continuationProbability).toBe(0.15);
    expect(record.phase).toBe("idle");
    expect(record.rooterKey).toBe("h:01a1a9b1-7");
    // Observe mode still runs the gate, because the point of shipping dark is to see what the gate would have
    // armed. `action` is what happened; `gateVerdict` is what the policy thought.
    expect(record.reason).toContain("observe mode sends nothing; the gate would have said stop:");
    expect(record.gateVerdict).toBe("stop");
  });

  it("records a would-warm verdict while shipping dark, so observe mode can prove the gate arms something", async () => {
    stubFetch(() => ({
      ok: true,
      body: {
        events: [
          { ts: ago(8), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 44000, prompt_tokens_computed: 24000, prefill_ms: 101000, cache_hit_rate: 0.45, status: 200 },
        ],
      },
    }));
    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);
    const branch = humanBranch(30, 12, 9);
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c", model: rooterModel, branch });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.09,
      continuationProbability: 0.15,
      action: "warm",
    }, ctx.context);
    expect(result).toEqual({ action: "stop" });
    const [record] = await readLog();
    expect(record.gateVerdict).toBe("warm");
    expect(record.reason).toContain("the gate would have said warm");
    // 101s of prefill was measured on this session's own call, so no rate table was needed.
    expect(record.evidence.coldSource).toBe("observed");
    expect(record.evidence.coldSecondsAvoided).toBe(101);
  });

  it("reads this session's evidence from rooter keyed by the session id, and arms when it clears the bars", async () => {
    process.env.CACHE_WARM_MODE = "arm";
    stubFetch((url) => {
      expect(url).toContain("/rooter/events?limit=64&key=h%3A01a1a9b1-7");
      expect(url.startsWith("https://rooter.dev.initialed85.cc")).toBe(true);
      return {
        ok: true,
        body: {
          events: [
            { ts: ago(10), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 42000, prompt_tokens_computed: 20000, cache_hit_rate: 0.52, status: 200 },
            { ts: ago(5), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 44000, prompt_tokens_computed: 24000, cache_hit_rate: 0.45, status: 200 },
          ],
        },
      };
    });

    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);

    const branch = humanBranch(50, 30, 10);
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c-7190-862e-cde05ddd7bc0", model: rooterModel, branch });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.0219,
      continuationProbability: 0.15,
      action: "stop",
    }, ctx.context);

    expect(result).toEqual({ action: "warm" });
    const [record] = await readLog();
    expect(record.evidence.medianComputedTokens).toBe(22000);
    expect(record.evidence.coldSecondsAvoided).toBe(93);
    expect(record.rhythm.humanArrivalsPerHour).toBe(3);
    // The name is the point: the old key read like all traffic, and it never was.
    expect(record.rhythm).not.toHaveProperty("arrivalsPerHour");
    expect(record.evidenceSource.ok).toBe(true);
    delete process.env.CACHE_WARM_MODE;
  });

  it("refuses to arm a warm when the turn that opened the run came from a peer, and still writes the row", async () => {
    // Ed's case, in arm mode, on evidence that clears every other bar: the prefix at the end of this run is the
    // one a peer's one-off question was built on, and the session goes back to dormant after it answers.
    process.env.CACHE_WARM_MODE = "arm";
    stubFetch(() => ({
      ok: true,
      body: {
        events: [
          { ts: ago(10), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 42000, prompt_tokens_computed: 20000, cache_hit_rate: 0.52, status: 200 },
          { ts: ago(5), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 44000, prompt_tokens_computed: 24000, cache_hit_rate: 0.45, status: 200 },
        ],
      },
    }));
    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);

    const branch = [
      ...humanBranch(50, 30, 10),
      // The newest thing on the session is a team-room delegation, which is what the run replays.
      { type: "custom_message", customType: "pi-team-room-wake", content: "[Team inbox - steer] implement the catalyst rule", timestamp: ago(2) },
    ];
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c-7190-862e-cde05ddd7bc0", model: rooterModel, branch });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.0219,
      continuationProbability: 0.15,
      action: "stop",
    }, ctx.context);

    expect(result).toEqual({ action: "stop" });
    const [record] = await readLog();
    expect(record.catalyst).toBe("peer");
    expect(record.catalystBasis).toBe("customType pi-team-room-wake");
    expect(record.reason).toContain("not a human coming back");
    expect(record.reason).toContain("left to expire");
    // The row says the rule was the only thing that stopped a spend, which is the number observe mode collects.
    expect(record.evidence.catalystVetoed).toBe(true);
    expect(record.evidence.medianComputedTokens).toBe(22000);
    expect(record.evidence.coldSecondsAvoided).toBe(93);
    expect(record.rhythm.humanArrivalsPerHour).toBe(3);
    // And no text from the turn reached the log.
    expect(JSON.stringify(record)).not.toContain("implement the catalyst rule");
    delete process.env.CACHE_WARM_MODE;
  });

  it("leaves a chat-catalysed run to the existing rules, and names the catalyst on the row either way", async () => {
    // The other half of the acceptance check: a `[pi-chat:...]` turn behaves exactly as it did before this rule
    // existed, so the recompute / savedSeconds / arrivals bars are what decide it.
    process.env.CACHE_WARM_MODE = "arm";
    stubFetch(() => ({
      ok: true,
      body: {
        events: [
          { ts: ago(10), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 42000, prompt_tokens_computed: 20000, cache_hit_rate: 0.52, status: 200 },
          { ts: ago(5), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 44000, prompt_tokens_computed: 24000, cache_hit_rate: 0.45, status: 200 },
        ],
      },
    }));
    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);

    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "old turn" }] }, timestamp: ago(50) },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "previous turn" }] }, timestamp: ago(30) },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "[pi-chat:c3a58f38a1f27b91] Ed: is the warming thing on?" }] }, timestamp: ago(10) },
    ];
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c-7190-862e-cde05ddd7bc0", model: rooterModel, branch });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.0219,
      continuationProbability: 0.15,
      action: "stop",
    }, ctx.context);

    expect(result).toEqual({ action: "warm" });
    const [record] = await readLog();
    expect(record.catalyst).toBe("chat");
    expect(record.catalystBasis).toBe("marker [pi-chat:");
    expect(record.action).toBe("warm");
    expect(record.reason).toContain("catalyst chat");
    expect(record.evidence.catalystVetoed).toBeUndefined();
    delete process.env.CACHE_WARM_MODE;
  });

  it("keeps the row and Pi's stop in observe mode when the catalyst vetoes", async () => {
    stubFetch(() => ({
      ok: true,
      body: {
        events: [{ ts: ago(6), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 44000, prompt_tokens_computed: 24000, prefill_ms: 101000, cache_hit_rate: 0.45, status: 200 }],
      },
    }));
    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);
    const branch = [
      ...humanBranch(40, 25),
      { type: "custom_message", customType: "pi-team-room-wake", content: "a peer asked", timestamp: ago(4) },
    ];
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c-7190", model: rooterModel, branch });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.09,
      continuationProbability: 0.15,
      action: "stop",
    }, ctx.context);

    expect(result).toEqual({ action: "stop" });
    const [record] = await readLog();
    expect(record.mode).toBe("observe");
    expect(record.action).toBe("stop");
    expect(record.catalyst).toBe("peer");
    expect(record.reason).toContain("observe mode sends nothing; the gate would have said stop:");
    expect(record.reason).toContain("not a human coming back");
    expect(record.evidence.catalystVetoed).toBe(true);
  });

  it("fails closed when rooter is unreadable, and records why rather than guessing", async () => {
    process.env.CACHE_WARM_MODE = "arm";
    stubFetch(() => ({ ok: false, status: 503 }));

    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);

    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c-7190-862e-cde05ddd7bc0", model: rooterModel });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.0219,
      continuationProbability: 0.15,
      action: "warm",
    }, ctx.context);

    expect(result).toEqual({ action: "stop" });
    const [record] = await readLog();
    expect(record.evidenceSource.error).toBe("rooter events HTTP 503");
    expect(record.reason).toContain("no rooter call rows for this session");
    delete process.env.CACHE_WARM_MODE;
  });

  it("stops when the provider is not rooter, since there is no per-call evidence to judge from", async () => {
    process.env.CACHE_WARM_MODE = "arm";
    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);

    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c", model: { provider: "retainer", id: "auto", baseUrl: "https://retainer.dev.initialed85.cc/v1" } });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0,
      missCost: 0,
      continuationProbability: 0.15,
      action: "stop",
    }, ctx.context);

    expect(result).toEqual({ action: "stop" });
    const [record] = await readLog();
    expect(record.evidenceSource.error).toBe("current provider is not rooter, so there is no per-call evidence");
    delete process.env.CACHE_WARM_MODE;
  });

  it("/cache-warm reports the mode, the last decision and the rhythm it came from", async () => {
    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c", model: rooterModel });

    await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.0219,
      continuationProbability: 1,
      action: "warm",
    }, ctx.context);

    await pi.commands.get("cache-warm")?.handler?.("", ctx.context);
    const notice = ctx.ui.notifications.at(-1)?.message ?? "";
    expect(notice).toContain("cache warm policy: observe");
    expect(notice).toContain("pi warm -> us stop");
    expect(notice).toContain("median recompute n/a");
    // continuationProbability 1 is Pi's streaming phase, which the log has to show rather than assume idle.
    expect(notice).toContain("last decision");
    expect(notice).toContain(".pi/cache-warm/log.jsonl");
  });

  it("vetoes a warm while a summarisation is in flight, whichever extension noticed first", async () => {
    process.env.CACHE_WARM_MODE = "arm";
    stubFetch(() => ({
      ok: true,
      body: {
        events: [
          { ts: ago(6), kind: "gen", key: "h:01a1a9b1-7", backend: "sushi", prompt_tokens: 60000, prompt_tokens_computed: 40000, cache_hit_rate: 0.3, status: 200 },
        ],
      },
    }));
    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);

    const branch = humanBranch(20, 10, 3);
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c", model: rooterModel, branch });

    await pi.emit("session_before_compact", { type: "session_before_compact" }, ctx.context);
    const [during] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.09,
      continuationProbability: 0.15,
      action: "warm",
    }, ctx.context);
    expect(during).toEqual({ action: "stop" });

    await pi.emit("session_compact", { type: "session_compact" }, ctx.context);
    const [after] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.09,
      continuationProbability: 0.15,
      action: "warm",
    }, ctx.context);
    expect(after).toEqual({ action: "warm" });

    const records = await readLog();
    expect(records[0]?.compacting).toBe(true);
    expect(records[0]?.reason).toContain("a summarisation is in flight");
    expect(records[1]?.compacting).toBe(false);
    delete process.env.CACHE_WARM_MODE;
  });

  it("keeps a log it cannot write from changing the decision", async () => {
    // Not "/proc/something", which asserted nothing on a privileged runner: a CI container running as root
    // reaches paths a dev pod does not, so the write never failed there and the test waited 30s for an error
    // that never arrived. A directory sitting where the log file should be fails for any uid, always EISDIR.
    const logDir = path.join(cwd, ".pi", "cache-warm");
    await mkdir(logDir, { recursive: true });
    await mkdir(path.join(logDir, "log.jsonl"));

    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c", model: rooterModel });
    const [result] = await pi.emit("cache_warming_decision", {
      type: "cache_warming_decision",
      warmCost: 0.0041,
      missCost: 0.0219,
      continuationProbability: 0.15,
      action: "warm",
    }, ctx.context);
    expect(result).toEqual({ action: "stop" });

    // The failure has to be visible somewhere, because an unwritable log is exactly the state in which a tool
    // that says nothing looks healthy.
    await pi.commands.get("cache-warm")?.handler?.("", ctx.context);
    const notice = ctx.ui.notifications.at(-1)?.message ?? "";
    expect(notice).toContain("log problem: 1 write(s) failed");
    // EISDIR, not a permission error: the point of the fixture is that it fails for any uid.
    expect(notice).toContain("EISDIR");
  });

  it.skipIf(!HAVE_MKFIFO)("returns the decision inside the ceiling when the log write never comes back", async () => {
    // A FIFO with no reader blocks on open, which is the shape that would actually hurt: a wedged volume
    // turning a dark build into a turn-end stall. appendFile cannot be cancelled, so what is being asserted is
    // the race - the decision lands on time and the wedged write is not re-bought on the next decision.
    const logDir = path.join(cwd, ".pi", "cache-warm");
    await mkdir(logDir, { recursive: true });
    execFileSync("mkfifo", [path.join(logDir, "log.jsonl")]);

    const mod = await load();
    const pi = createFakePi();
    mod.default(pi as any);
    const ctx = createContext({ cwd, sessionId: "01a1a9b1-795c", model: rooterModel });
    const decide = () =>
      pi.emit("cache_warming_decision", {
        type: "cache_warming_decision",
        warmCost: 0.0041,
        missCost: 0.0219,
        continuationProbability: 0.15,
        action: "warm",
      }, ctx.context);

    const firstStart = Date.now();
    const [first] = await decide();
    const firstMs = Date.now() - firstStart;
    expect(first).toEqual({ action: "stop" });
    // At or above the ceiling (that is the race firing) and far below a 30s stall.
    expect(firstMs).toBeGreaterThanOrEqual(1900);
    expect(firstMs).toBeLessThan(6000);

    const secondStart = Date.now();
    const [second] = await decide();
    const secondMs = Date.now() - secondStart;
    expect(second).toEqual({ action: "stop" });
    // The stall latch: the second decision does not queue a second wedged write and pay the ceiling again.
    expect(secondMs).toBeLessThan(500);

    await pi.commands.get("cache-warm")?.handler?.("", ctx.context);
    const notice = ctx.ui.notifications.at(-1)?.message ?? "";
    expect(notice).toContain("log problem: 1 write(s) failed (no write inside 2000ms) and 1 decision(s) were not written while a wedged write was outstanding");
  });
});
