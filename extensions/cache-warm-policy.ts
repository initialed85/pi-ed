/**
 * Cache warm policy
 *
 * Answers one question Pi asks: this prompt cache entry expires in a while, and I can spend a request to
 * keep it alive — should I?
 *
 * Pi 1.5.0 and 1.6.1 both ship the mechanism (`dist/core/cache-warmer.js`): it re-sends the last real
 * request with a one-token output cap at 90% of the declared cache lifetime, refuses to replay a request
 * it cannot replay identically, prices the decision, and calls extensions before acting. What it does not
 * know is this fleet: it prices a refresh in dollars against a $0.05 floor, and our tokens cost
 * slot-seconds instead. So its own gate always answers "stop" here, and a warm on this fleet is only ever
 * going to happen because an extension said so. This is the extension that gets to say so, and it starts
 * by saying no to everything while it measures.
 *
 * Why observe is the default: an override to `stop` sends no request at all (Pi reaches `streamSimple`
 * only for a `warm`), so logging every decision costs nothing. The fleet gets to see what the gate would
 * have armed — with Pi's economics and our evidence side by side — before anyone spends a GPU second on a
 * warm. `cacheWarmMode: "arm"` is the switch, and it is deliberately something a person sets after
 * reading `hack/warm-counter.mjs`.
 *
 * The catalyst precondition, which is the last thing to clear before an override to `warm` is allowed. Ed stated
 * the goal in Chat on 2026-11-28: idle compaction makes headroom when he sits down to a session, warming makes sure
 * that headroom is backed by a cached prefix "as long as sessions are hot enough" — and a session woken for a
 * one-off team-room question is still worth compacting, but not worth warming, "because that session will go back
 * to being dormant for some time". Arrival rhythm alone cannot express that, and the measured reason is in
 * `lib/cache-warm.ts`: on this fleet a peer wake, a scheduled job, a dream and an auto-resume persist as
 * `custom_message` entries rather than user-role messages (45 of them against 1 human arrival in the most
 * peer-driven session's last 24 hours), so the rhythm already ignores machine catalysts while the prefix a refresh
 * would protect still *ends* at one. The gate therefore names the catalyst of the newest request-opening entry —
 * `chat`, `terminal`, `peer` or `unknown` — and only lets the two human-shaped ones arm. It is a precondition on
 * the override, so a vetoed decision still runs every other rule and still writes its row; `catalystVetoed: true`
 * on a row is the count of how often this rule alone would have stopped a spend, which is what observe mode exists
 * to produce.
 *
 * Two ceilings Pi imposes, recorded here because they decide what the catalogue may say:
 *
 *   - A refresh is scheduled at `min(short × 0.9, short − 10s)`, timed from the request that opened the run, and
 *     Pi stops a run whose next refresh falls past that request + 30 minutes (60 while it streams). A declared
 *     `promptCache.short` is therefore a re-arm interval, never a claim about how long a prefix lives, and
 *     `maxIdleMs` in `lib/cache-warm.ts` is set to that same 27-minute interval so the two move together. Rooter's
 *     probe on 2026-11-27 measured a 33,761-token prefix on sushi surviving to 56.7 min (read off SSD) and missing
 *     at 77.0 min, with age counted *from the last write* — so both 1,800 and 1,500 sit well inside real survival,
 *     and the choice between them is which tier the refresh reads back from, not whether it misses. The earlier
 *     ~99-minute figure in this file's history is retired: it was age-from-first-write, and the point that
 *     produced it was an entry 24.2 minutes old at its last write.
 *   - Pi's idle `continuationProbability` is the constant 0.15, whose source comment reports that
 *     per-session estimates were not better than it. The rhythm here is logged next to that constant so
 *     the claim "busy sessions are the ones worth warming" is measured rather than assumed.
 *
 * `/cache-warm` shows the mode, the last decision and the rhythm it was judged from. Config lives in
 * `.pi/cache-warm.json` with `CACHE_WARM_*` overrides; decisions land in `.pi/cache-warm/log.jsonl`.
 */

import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  armDecision,
  DEFAULT_WARM_CONFIG,
  latestRequestCatalyst,
  parseCallEvents,
  rooterKey,
  sessionRhythm,
  type ArmDecision,
  type CallEvidence,
  type Catalyst,
  type CatalystRead,
  type WarmConfig,
} from "../lib/cache-warm.ts";

const CONFIG_FILE = "cache-warm.json";
const LOG_FILE = join(".pi", "cache-warm", "log.jsonl");
const EVENTS_PATH = "/rooter/events";
/** After a rooter read fails, do not try again for this long. A decision fires rarely; a broken rooter
 *  should not be re-probed on every one of them. */
const EVIDENCE_BACKOFF_MS = 60_000;

interface RuntimeConfig extends WarmConfig {
  problems: string[];
}

function readConfig(ctx: ExtensionContext): RuntimeConfig {
  const cfg: RuntimeConfig = { ...DEFAULT_WARM_CONFIG, problems: [] };
  const path = join(ctx.cwd, CONFIG_FILE);
  try {
    // A config file is read synchronously here on purpose: the decision handler is async but Pi awaits
    // it, and a warm that arrives before an async config read finished would be armed by defaults.
    const raw = readFileSync(path, "utf8");
    if (raw) {
      const file = JSON.parse(raw) as Partial<WarmConfig>;
      if (file.mode === "observe" || file.mode === "arm") cfg.mode = file.mode;
      for (const key of ["minRecomputeTokens", "minArrivalsPerHour", "minSavedSeconds", "vetoCacheHitRate", "maxIdleMs", "evidenceCalls", "evidenceWindowMs", "evidenceTimeoutMs", "logTimeoutMs", "logRetryMs"] as const) {
        const value = file[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) cfg[key] = value;
        else if (value !== undefined) cfg.problems.push(`${key} ignored (not a positive number)`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      cfg.problems.push(`config unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const envMode = process.env.CACHE_WARM_MODE?.trim();
  if (envMode === "observe" || envMode === "arm") cfg.mode = envMode;
  else if (envMode) cfg.problems.push(`CACHE_WARM_MODE "${envMode}" ignored (want observe or arm)`);
  const envNumber = (name: string, apply: (value: number) => void) => {
    const raw = process.env[name]?.trim();
    if (!raw) return;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) apply(value);
    else cfg.problems.push(`${name} "${raw}" ignored (not a positive number)`);
  };
  envNumber("CACHE_WARM_MIN_RECOMPUTE_TOKENS", (value) => {
    cfg.minRecomputeTokens = value;
  });
  envNumber("CACHE_WARM_MIN_ARRIVALS_PER_HOUR", (value) => {
    cfg.minArrivalsPerHour = value;
  });
  envNumber("CACHE_WARM_MIN_SAVED_SECONDS", (value) => {
    cfg.minSavedSeconds = value;
  });
  envNumber("CACHE_WARM_LOG_TIMEOUT_MS", (value) => {
    cfg.logTimeoutMs = value;
  });
  envNumber("CACHE_WARM_LOG_RETRY_MS", (value) => {
    cfg.logRetryMs = value;
  });
  envNumber("CACHE_WARM_VETO_CACHE_HIT_RATE", (value) => {
    cfg.vetoCacheHitRate = value;
  });
  envNumber("CACHE_WARM_EVIDENCE_CALLS", (value) => {
    cfg.evidenceCalls = value;
  });
  envNumber("CACHE_WARM_MAX_IDLE_MS", (value) => {
    cfg.maxIdleMs = value;
  });
  return cfg;
}

/** Same derivation idle-compaction's pre-flight uses: rooter's front door is the provider base minus /v1. */
function rooterRoot(model: { provider?: unknown; baseUrl?: unknown } | undefined): string | undefined {
  if (!model || model.provider !== "rooter") return undefined;
  const base = typeof model.baseUrl === "string" ? model.baseUrl.trim() : "";
  if (!base) return undefined;
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

interface EvidenceRead {
  ok: boolean;
  rows: CallEvidence[];
  key: string;
  error?: string;
}

let lastEvidenceFailureAt = 0;

async function readEvidence(ctx: ExtensionContext, cfg: RuntimeConfig, nowMs: number): Promise<EvidenceRead> {
  const sessionId = ctx.sessionManager.getSessionId();
  const key = rooterKey(sessionId);
  if (nowMs - lastEvidenceFailureAt < EVIDENCE_BACKOFF_MS) {
    return { ok: false, rows: [], key, error: `rooter read skipped (${Math.round((nowMs - lastEvidenceFailureAt) / 1000)}s into the ${EVIDENCE_BACKOFF_MS / 1000}s backoff)` };
  }
  const root = rooterRoot(ctx.model as { provider?: unknown; baseUrl?: unknown } | undefined);
  if (!root) return { ok: false, rows: [], key, error: "current provider is not rooter, so there is no per-call evidence" };
  try {
    let apiKey: string | undefined = (ctx.model as { apiKey?: string } | undefined)?.apiKey;
    if (!apiKey) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model as never);
      if (!auth.ok) return { ok: false, rows: [], key, error: `no rooter key: ${auth.error}` };
      apiKey = auth.apiKey;
    }
    if (!apiKey) return { ok: false, rows: [], key, error: "no rooter key resolved" };
    const url = `${root}${EVENTS_PATH}?limit=${Math.max(cfg.evidenceCalls * 4, 64)}&key=${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(cfg.evidenceTimeoutMs),
    });
    if (!response.ok) {
      lastEvidenceFailureAt = nowMs;
      return { ok: false, rows: [], key, error: `rooter events HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    return { ok: true, rows: parseCallEvents(body, key, nowMs, cfg), key };
  } catch (error) {
    lastEvidenceFailureAt = nowMs;
    const name = error instanceof Error ? error.name : String(error);
    const detail = name === "TimeoutError" || name === "AbortError" ? `timeout after ${cfg.evidenceTimeoutMs}ms` : error instanceof Error && error.message ? error.message : name;
    return { ok: false, rows: [], key, error: detail };
  }
}

interface LoggedDecision {
  at: string;
  session: string;
  rooterKey: string;
  mode: WarmConfig["mode"];
  phase?: "streaming" | "idle";
  /** Pi's own economics for this refresh. */
  warmCost: number;
  missCost: number;
  continuationProbability: number;
  actionFromPi: "warm" | "stop";
  /** What this extension told Pi to do. */
  action: "warm" | "stop";
  /** In observe mode, what the gate would have said if it were armed. */
  gateVerdict?: "warm" | "stop";
  /** Whether a summarisation was in flight, which vetoes a warm on its own. */
  compacting: boolean;
  /**
   * What opened the newest request: `chat` and `terminal` are human-shaped, `peer` is a team-room ask or
   * delegation, `unknown` is anything the gate cannot attribute. Only the first two may arm a warm.
   */
  catalyst: Catalyst;
  /** What the catalyst was read from, in words. The message text itself never reaches this file. */
  catalystBasis: string;
  reason: string;
  evidence: ArmDecision["detail"];
  evidenceSource: { ok: boolean; key: string; error?: string };
  rhythm: { arrivals: number; arrivalsPerHour: number; medianGapMs?: number; sinceLastMs?: number };
  configProblems: string[];
  /** Set when this decision could not be written, or was not attempted because an earlier write is wedged. */
  logStalled?: true;
  logSkipped?: true;
}

/**
 * The state of the log, kept apart from the decisions it records.
 *
 * A log that cannot be written must not change a decision, and it must not be able to hold a turn open either.
 * `appendFile` offers nothing to cancel - there is no signal to pass - so the ceiling is a `Promise.race` against
 * a timer rather than a timeout handed to the call. Racing returns the decision on time but leaves a blocked
 * worker in the thread pool, which is why a stall also shuts the door for `logRetryMs`: one wedged write is an
 * incident, while a fresh wedged write per decision is a leak that ends with the pool exhausted and every
 * decision paying the full ceiling.
 */
const logState = { broken: false, failures: 0, stalls: 0, skipped: 0, blockedUntilMs: 0, lastError: "" };

async function logDecision(ctx: ExtensionContext, record: LoggedDecision, cfg: RuntimeConfig, nowMs: number): Promise<void> {
  if (nowMs < logState.blockedUntilMs) {
    logState.skipped += 1;
    record.logSkipped = true;
    return;
  }
  const path = join(ctx.cwd, LOG_FILE);
  const writing = (async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<"stall">((resolve) => {
    timer = setTimeout(() => resolve("stall"), cfg.logTimeoutMs);
    // A timer that outlives a fast write must not keep the process, or a test run, waiting for it.
    timer.unref?.();
  });
  try {
    if ((await Promise.race([writing, ceiling])) === "stall") {
      logState.broken = true;
      logState.stalls += 1;
      logState.blockedUntilMs = nowMs + cfg.logRetryMs;
      logState.lastError = `no write inside ${cfg.logTimeoutMs}ms`;
      record.logStalled = true;
    } else {
      logState.broken = false;
    }
  } catch (error) {
    // A decision log that cannot be written must not change the decision, and must not look like one. It does
    // have to be *said*: an unwritable log is exactly the state in which a tool that reports nothing looks
    // healthy, so a fast failure counts too rather than only a wedged one.
    logState.broken = true;
    logState.failures += 1;
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : String(error);
    logState.lastError = code;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The last decision this process made, for `/cache-warm`. */
let lastDecision: LoggedDecision | undefined;
/** A summarisation in flight on this session, whoever asked for it. See `armDecision`. */
let compacting = false;

export default function extension(pi: ExtensionAPI): void {
  pi.on("session_before_compact", () => {
    compacting = true;
  });
  pi.on("session_compact", () => {
    compacting = false;
  });
  pi.on("session_compact_failed", () => {
    compacting = false;
  });

  pi.on("cache_warming_decision", async (event, ctx) => {
    const nowMs = Date.now();
    const cfg = readConfig(ctx);
    const branch = ctx.sessionManager.getBranch() as unknown as Parameters<typeof sessionRhythm>[0];
    const [evidence, rhythm] = [
      await readEvidence(ctx, cfg, nowMs),
      sessionRhythm(branch, nowMs, cfg.evidenceWindowMs),
    ];
    // A catalyst read that throws must not cost the session its decision, and must not be allowed to look like a
    // human turn: an unreadable tail answers `unknown`, which vetoes.
    let catalyst: CatalystRead;
    try {
      catalyst = latestRequestCatalyst(branch);
    } catch (error) {
      catalyst = { catalyst: "unknown", basis: `catalyst read failed: ${error instanceof Error ? error.name : String(error)}` };
    }
    const decision = armDecision(evidence.rows, rhythm, cfg, event.action, { compacting, catalyst });
    const record: LoggedDecision = {
      at: new Date(nowMs).toISOString(),
      session: ctx.sessionManager.getSessionName?.() || ctx.sessionManager.getSessionId(),
      rooterKey: evidence.key,
      mode: cfg.mode,
      // Pi does not put the phase on the event; its continuation probability is the phase spelled out
      // (1 while the run that sent the request is still streaming, 0.15 once the agent has settled).
      phase: event.continuationProbability >= 1 ? "streaming" : "idle",
      warmCost: event.warmCost,
      missCost: event.missCost,
      continuationProbability: event.continuationProbability,
      actionFromPi: event.action,
      action: decision.action,
      reason: decision.reason,
      gateVerdict: decision.detail.gateVerdict,
      evidence: decision.detail,
      compacting,
      catalyst: catalyst.catalyst,
      catalystBasis: catalyst.basis,
      evidenceSource: { ok: evidence.ok, key: evidence.key, ...(evidence.error ? { error: evidence.error } : {}) },
      rhythm: {
        arrivals: rhythm.arrivals,
        arrivalsPerHour: Math.round(rhythm.arrivalsPerHour * 100) / 100,
        ...(rhythm.medianGapMs === undefined ? {} : { medianGapMs: Math.round(rhythm.medianGapMs / 100) * 100 }),
        ...(rhythm.sinceLastMs === undefined ? {} : { sinceLastMs: Math.round(rhythm.sinceLastMs / 100) * 100 }),
      },
      configProblems: cfg.problems,
    };
    lastDecision = record;
    await logDecision(ctx, record, cfg, nowMs);
    // Pi falls back to its own decision if a handler throws, which is the wrong fallback here: Pi's own
    // decision is always "stop" on this fleet, so a throw would silently disable the gate instead of
    // leaving it armed. Always answer explicitly.
    return { action: decision.action };
  });

  pi.registerCommand("cache-warm", {
    description: "Show the cache warming policy: mode, the last decision, and the rhythm it was judged from",
    handler: async (_args, ctx) => {
      const cfg = readConfig(ctx);
      const lines = [`cache warm policy: ${cfg.mode}`];
      lines.push(
        `arms when the newest request was human-shaped (chat or terminal), nothing has been idle past ${Math.round(cfg.maxIdleMs / 60000)}m, median recompute >= ${cfg.minRecomputeTokens} tokens, arrivals >= ${cfg.minArrivalsPerHour}/h and the prefill avoided >= ${cfg.minSavedSeconds}s; vetoes a session already reading ${Math.round(cfg.vetoCacheHitRate * 100)}% from cache`,
      );
      for (const problem of cfg.problems) lines.push(`config: ${problem}`);
      const last = lastDecision;
      if (!last) {
        lines.push("no decision taken yet in this session (Pi has not asked, or warming never armed)");
      } else {
        lines.push(
          `last decision ${last.at}: pi ${last.actionFromPi} -> us ${last.action} (warm cost $${last.warmCost.toFixed(6)}, miss cost $${last.missCost.toFixed(6)}, pi continuation ${last.continuationProbability})`,
        );
        lines.push(`  catalyst: ${last.catalyst} (${last.catalystBasis})${last.evidence.catalystVetoed ? " - the only rule that stood in the way" : ""}`);
        lines.push(`  ${last.reason}`);
        const saved = last.evidence.coldSecondsAvoided;
        lines.push(
          `  evidence: ${last.evidence.evidenceCalls} calls, median recompute ${last.evidence.medianComputedTokens ?? "n/a"} tokens${saved === undefined ? "" : `, ~${saved}s of prefill a warm would have avoided`}`,
        );
        lines.push(`  rhythm: ${last.rhythm.arrivals} arrivals in the window, ${last.rhythm.arrivalsPerHour}/h${last.rhythm.medianGapMs === undefined ? "" : `, median gap ${Math.round(last.rhythm.medianGapMs / 1000)}s`}`);
        if (last.evidenceSource.error) lines.push(`  evidence problem: ${last.evidenceSource.error}`);
      }
      lines.push(`decisions: ${join(ctx.cwd, LOG_FILE)}`);
      if (logState.broken || logState.skipped > 0) {
        lines.push(
          `log problem: ${logState.failures + logState.stalls} write(s) failed (${logState.lastError || "no detail"}) and ${logState.skipped} decision(s) were not written while a wedged write was outstanding; the decisions still ran and still answered Pi — the log is what is missing`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
