/**
 * Idle compaction
 *
 * Pi compacts when the context crosses `contextWindow - reserveTokens`, and that is the only moment it
 * has. With the shipped defaults (reserveTokens 16384, keepRecentTokens 20000) on a 131072-token model
 * that is 114688 tokens, or 87.5% of the window, which is exactly what this repository's own session
 * shows: 56 compactions with a median `tokensBefore` of 115150. It is also why the experience is what it
 * is: 51 of those 56 were preceded by less than five minutes of dense activity, i.e. they fired in the
 * middle of a run, while somebody was waiting for the next answer. Each one blocked for a median of
 * 286 s, p90 804 s, worst 1078 s.
 *
 * What they buy is large - median 82998 tokens freed, context landing at about 32600 - so the mechanism is
 * not the problem. Timing is. The same session runs 513.6 h of wall time and 92.6% of it sits in gaps
 * longer than five minutes (445 h in gaps longer than half an hour). The idle time to do this work in is
 * already there, in enormous supply, and is currently unused.
 *
 * The measurement that shapes the rest of this file: compaction time is not a function of payload. Across
 * those 56 compactions, wall time regressed against the summarised span, the summary size and the token
 * counts with r² ≤ 0.09. Measured directly against the local backends instead, one clean summarisation call
 * over 31k input tokens is 52 s on strata and 77 s on sushi, and an output sweep (600 / 1500 / 3000 / 4500
 * tokens) took 27 / 48 / 70 / 69 s. One attempt is about a minute; a median of ~five minutes is what a retry
 * ladder on a contended shared GPU looks like. So the idle path asks for **one** attempt, and a deadline
 * aborts it if it runs long. The token bill was never the issue: summarisation was 3.12M of 353.7M tokens
 * in that session, 0.9%.
 *
 * ## What it does
 *
 * 1. **Schedule.** After a run settles - and at session start, for a session resumed already near the
 *    ceiling - arm a timer. Any activity cancels it. When it fires and the session is still idle, ask Pi to
 *    compact, with `pi-ed:compaction-single-attempt` in the instructions so
 *    `extensions/compaction-summary-guard.ts` writes one summary instead of burning two more calls, and with
 *    a deadline that aborts the compaction rather than holding a returning user.
 * 2. **Pin what matters.** The instructions name what must survive, and this session's plan is read out of
 *    `.pi/plan/<session-id>.json` and quoted verbatim, so the plan is not reconstructed from a summary of a
 *    summary.
 * 3. **Measure stale tool output** (`agent_before_settle`). Tool results are 3.40M of the 5.00M characters of
 *    transcript in that session - 68% of it - and they are the part a later turn almost never needs. Default
 *    mode only counts them, because dropping stale tool output is the one context reduction that needs no
 *    model call at all and keeps the reasoning verbatim (it is what Anthropic's context editing automates,
 *    and the 100-turn eval behind it measured an 84% token cut with task performance *up* 39%). Set
 *    `prune: "on"` to replace stale text-only tool results with a one-line stub through a `context_edit`
 *    replacement - a replacement, never an omission, so the tool call keeps a result and the pairing survives.
 *
 * ## Knobs
 *
 * `.pi/idle-compaction.json`, with `IDLE_COMPACTION_*` environment overrides. `/idle-compact
 * status|on|off|dry-run|run [--force]|prune <off|report|on>`, and `--idle-compaction-off` for one session.
 *
 * | key | default | why that number |
 * | --- | --- | --- |
 * | `quietMs` | 120000 | 96% of the gaps inside a working exchange here are under 60 s (11217 gaps under 10 s and 2945 between 10 and 60 s, out of 14802). Two silent minutes means the burst ended. |
 * | `urgentPercent` / `urgentQuietMs` | 80 / 20000 | Above 80% the next prompt pays this cost anyway (the threshold is 87.5%). Starting 20 s after the run settled is never worse than starting when the user types. |
 * | `softPercent` | 40 | Below this there is nothing worth a summarisation call: Pi keeps 20000 tokens verbatim and these summaries measure 2565 tokens median. |
 * | `minFreeTokens` / `keptFloorTokens` | 20000 / 24000 | The floor is keepRecentTokens 20000 plus the measured median summary. A compaction that would free less than 20000 tokens is churn. |
 * | `deadlineMs` | 120000 | One clean attempt measured 27-77 s locally. Two minutes is the point where an idle compaction has become a wait. |
 * | `cooldownMs` | 600000 | Stop an idle session from summarising itself over and over. |
 * | `prune` | `report` | `report` counts the reclaimable stale tool output and touches nothing. `on` writes the edits. |
 * | `pruneKeepRecentResults` | 12 | The newest tool results are the working set; everything older is a candidate. |
 * | `pruneMinChars` | 2000 | Under this, the edit entry costs about what it saves. |
 *
 * ## Hazards, and what this file does about them
 *
 * - **A user returning mid-compaction does not just wait: Pi refuses the prompt.** `prompt()` throws "Cannot submit
 *   a prompt while compaction is in progress. Wait for compaction to finish and retry." (dist/core/agent-session.js),
 *   and no extension event runs before that check, so nothing here can intercept it. The deadline is the only lever:
 *   at `deadlineMs` this extension calls `ctx.abort()`, which reaches `abortCompaction()` and aborts the controller
 *   the summarisation call is running on, and Pi writes no entry for an aborted compaction - the session keeps
 *   everything it had. A queued prompt, by contrast, is simply processed after the compaction finishes.
 * - **Summaries compound.** Each compaction re-summarises the previous one, which is the real price of
 *   compacting earlier and more often, and why `minFreeTokens` and `cooldownMs` exist instead of compacting
 *   on every lull. The pinned plan, and the fleet's Graphiti memory, are the counterweights: durable state
 *   does not have to live inside the summary.
 *   A session that is *only* idle still gets one compaction per cooldown, not one per timer tick.
 * - **Pruning can drop something a later turn needed.** Protected newest results, a size floor, text-only
 *   content (never an image somebody was looking at), never the same target twice, and the stub says what
 *   was dropped and how to get it back.
 * - **Print and JSON runs have no idle time worth compacting** and would only be slowed down by trying, so
 *   those modes are skipped.
 * - **Pi's idle cache warming** pays a cache write to keep a warm prefix alive, and a compaction is about to
 *   throw that prefix away. While one is in flight this extension answers `cache_warming_decision` with
 *   `stop`. Every model in this fleet declares no cache lifetime, so warming is inert here today; the rule is
 *   insurance for the day a session runs on a cache-aware provider.
 *
 * Side effects: compactions can happen unasked, at idle, and every decision is logged to
 * `.pi/idle-compaction/log.jsonl`. Delete this file to go back to Pi's behaviour.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONFIG_DIR_NAME,
  type AgentBeforeSettleEvent,
  type AgentBeforeSettleEventResult,
  type AgentSettledEvent,
  type BeforeAgentStartEvent,
  type ContextEditEntryDraft,
  type ContextUsage,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageEndEvent,
  type SessionBoundaryDraft,
  type ToolResultEvent,
  type TurnStartEvent,
  type UserBashEvent,
  type UIPromptStartEvent,
} from "@earendil-works/pi-coding-agent";

import { idleCompactionInstructions } from "../lib/compaction.ts";
import { planPath, readPlan, renderPlanBlock } from "../lib/plan.ts";

const MARK = "idle-compaction";
const CONFIG_FILE = "idle-compaction.json";
const LOG_FILE = join("idle-compaction", "log.jsonl");
/** The log is an operational record, not an archive: keep the tail and stop. */
const LOG_MAX_BYTES = 262144;
const LOG_KEEP_LINES = 400;

/** Provider usage is per-message; a character estimate is what a *span* costs. Same convention Pi uses. */
function tokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

type PruneMode = "off" | "report" | "on";

interface Config {
  enabled: boolean;
  quietMs: number;
  urgentQuietMs: number;
  urgentPercent: number;
  softPercent: number;
  minFreeTokens: number;
  keptFloorTokens: number;
  deadlineMs: number;
  cooldownMs: number;
  prune: PruneMode;
  pruneKeepRecentResults: number;
  pruneMinChars: number;
  pruneMaxPerBoundary: number;
  pinPlan: boolean;
}

const DEFAULT_CONFIG: Config = {
  enabled: true,
  quietMs: 120000,
  urgentQuietMs: 20000,
  urgentPercent: 80,
  softPercent: 40,
  minFreeTokens: 20000,
  keptFloorTokens: 24000,
  deadlineMs: 120000,
  cooldownMs: 600000,
  prune: "report",
  pruneKeepRecentResults: 12,
  pruneMinChars: 2000,
  pruneMaxPerBoundary: 20,
  pinPlan: true,
};

/** The keys that are numbers, spelled out so the limits map cannot drift onto a boolean key. */
type NumericKey =
  | "quietMs"
  | "urgentQuietMs"
  | "urgentPercent"
  | "softPercent"
  | "minFreeTokens"
  | "keptFloorTokens"
  | "deadlineMs"
  | "cooldownMs"
  | "pruneKeepRecentResults"
  | "pruneMinChars"
  | "pruneMaxPerBoundary";

const NUMERIC_LIMITS: Record<NumericKey, [number, number]> = {
  quietMs: [1000, 3600000],
  urgentQuietMs: [1000, 3600000],
  urgentPercent: [1, 99],
  softPercent: [1, 99],
  minFreeTokens: [0, 500000],
  keptFloorTokens: [0, 200000],
  deadlineMs: [5000, 900000],
  cooldownMs: [0, 86400000],
  pruneKeepRecentResults: [0, 200],
  pruneMinChars: [200, 200000],
  pruneMaxPerBoundary: [1, 100],
};

const ENV_NUMBERS: Array<[string, NumericKey]> = [
  ["IDLE_COMPACTION_QUIET_MS", "quietMs"],
  ["IDLE_COMPACTION_URGENT_QUIET_MS", "urgentQuietMs"],
  ["IDLE_COMPACTION_URGENT_PERCENT", "urgentPercent"],
  ["IDLE_COMPACTION_SOFT_PERCENT", "softPercent"],
  ["IDLE_COMPACTION_MIN_FREE_TOKENS", "minFreeTokens"],
  ["IDLE_COMPACTION_KEPT_FLOOR_TOKENS", "keptFloorTokens"],
  ["IDLE_COMPACTION_DEADLINE_MS", "deadlineMs"],
  ["IDLE_COMPACTION_COOLDOWN_MS", "cooldownMs"],
  ["IDLE_COMPACTION_PRUNE_KEEP_RECENT", "pruneKeepRecentResults"],
  ["IDLE_COMPACTION_PRUNE_MIN_CHARS", "pruneMinChars"],
  ["IDLE_COMPACTION_PRUNE_MAX", "pruneMaxPerBoundary"],
];

interface RuntimeConfig extends Config {
  /** Keys that were present but unusable. Reported by `/idle-compact status` rather than swallowed. */
  problems: string[];
}

/* ------------------------------------------------------------------ configuration */

function configPath(ctx: ExtensionContext): string {
  const override = process.env.IDLE_COMPACTION_STATE_FILE?.trim();
  if (override) return override.startsWith("/") ? override : join(ctx.cwd, override);
  return join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE);
}

function writeConfig(ctx: ExtensionContext, cfg: RuntimeConfig): string {
  const path = configPath(ctx);
  mkdirSync(join(path, ".."), { recursive: true });
  const { problems: _problems, ...stored } = cfg;
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return path;
}

function truthy(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function clampNumber(key: NumericKey, value: number): number {
  const [min, max] = NUMERIC_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readConfig(ctx: ExtensionContext): RuntimeConfig {
  const cfg: RuntimeConfig = { ...DEFAULT_CONFIG, problems: [] };
  const path = configPath(ctx);

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
      if (typeof parsed.enabled === "boolean") cfg.enabled = parsed.enabled;
      if (typeof parsed.pinPlan === "boolean") cfg.pinPlan = parsed.pinPlan;
      if (parsed.prune === "off" || parsed.prune === "report" || parsed.prune === "on") cfg.prune = parsed.prune;
      for (const key of Object.keys(NUMERIC_LIMITS) as NumericKey[]) {
        const value = parsed[key];
        if (typeof value === "number" && Number.isFinite(value)) cfg[key] = clampNumber(key, value);
        else if (value !== undefined) cfg.problems.push(`${key} in ${path}`);
      }
    } catch {
      // A settings file we cannot read leaves the defaults rather than guessing.
      cfg.problems.push(`unreadable ${path}`);
    }
  }

  for (const [name, key] of ENV_NUMBERS) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) cfg[key] = clampNumber(key, value);
    else cfg.problems.push(name);
  }

  const prune = process.env.IDLE_COMPACTION_PRUNE?.trim().toLowerCase();
  if (prune === "off" || prune === "report" || prune === "on") cfg.prune = prune;
  if (truthy(process.env.IDLE_COMPACTION_OFF)) cfg.enabled = false;
  if (truthy(process.env.IDLE_COMPACTION_PIN_PLAN)) cfg.pinPlan = true;

  return cfg;
}

/* ------------------------------------------------------------------ record */

function logPath(ctx: ExtensionContext): string {
  const override = process.env.IDLE_COMPACTION_LOG?.trim();
  if (!override) return join(ctx.cwd, CONFIG_DIR_NAME, LOG_FILE);
  return override.startsWith("/") ? override : join(ctx.cwd, override);
}

/**
 * One line per decision, including the decisions to do nothing. A log of only the actions cannot explain why
 * a session stayed quiet, and the whole feature is meant to be judged afterwards.
 */
function record(ctx: ExtensionContext | undefined, kind: string, data: Record<string, unknown>): void {
  if (!ctx) return;
  const path = logPath(ctx);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
      const kept = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-LOG_KEEP_LINES);
      writeFileSync(path, `${kept.join("\n")}\n`, "utf8");
    }
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), kind, ...data })}\n`, "utf8");
  } catch {
    // Recording is allowed to fail silently. It must never be the reason a session breaks.
  }
}

function debug(ctx: ExtensionContext | undefined, line: string): void {
  const path = process.env.IDLE_COMPACTION_DEBUG?.trim();
  if (!path || !ctx) return;
  try {
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // Diagnostics are allowed to fail silently.
  }
}

/* ------------------------------------------------------------------ state */

interface Stats {
  armed: number;
  /** Quiet windows that opened on a session that was not worth compacting. */
  notArmed: number;
  fired: number;
  skipped: number;
  failed: number;
  abortedAtDeadline: number;
  freedTokens: number;
  lastNote: string;
  lastAt: string | undefined;
}

interface Tally {
  candidates: number;
  candidateTokens: number;
  applied: number;
  reclaimedTokens: number;
}

interface State {
  cfg: RuntimeConfig;
  forcedOff: boolean;
  lastCtx: ExtensionContext | undefined;
  timer: NodeJS.Timeout | undefined;
  armedFor: string | undefined;
  deadline: NodeJS.Timeout | undefined;
  compacting: boolean;
  startedAt: number;
  lastCompactionAt: number | undefined;
  entriesAtCompaction: number | undefined;
  stats: Stats;
  tally: Tally;
}

function freshStats(): Stats {
  return {
    armed: 0,
    notArmed: 0,
    fired: 0,
    skipped: 0,
    failed: 0,
    abortedAtDeadline: 0,
    freedTokens: 0,
    lastNote: "nothing yet",
    lastAt: undefined,
  };
}

function freshTally(): Tally {
  return { candidates: 0, candidateTokens: 0, applied: 0, reclaimedTokens: 0 };
}

/* ------------------------------------------------------------------ eligibility */

function usageOf(ctx: ExtensionContext): ContextUsage | undefined {
  try {
    return ctx.getContextUsage();
  } catch {
    // A context handed to a timer that a reload has since invalidated.
    return undefined;
  }
}

/**
 * Why a compaction is not allowed right now, or `undefined` when it is.
 *
 * Asked twice: once when the quiet timer is armed, so a session that would never compact does not sit with a
 * timer running, and again when it fires, because two minutes is long enough for all of this to change.
 */
function blockReason(ctx: ExtensionContext, state: State, cfg: RuntimeConfig, options: { force?: boolean } = {}): string | undefined {
  if (!cfg.enabled || state.forcedOff) return "disabled";
  // Print and JSON runs have no idle time worth compacting, and a compaction there only delays the exit.
  if (ctx.mode !== "tui" && ctx.mode !== "rpc") return `mode ${ctx.mode}`;
  if (!ctx.model) return "no model selected";
  if (!ctx.isIdle()) return "the agent is running";
  if (ctx.hasPendingMessages()) return "a message is queued";
  const usage = usageOf(ctx);
  if (!usage) return "no context window known";
  if (usage.tokens === null || usage.percent === null) return "context usage unknown (right after a compaction)";
  if (options.force) return undefined;
  if (usage.percent < cfg.softPercent) return `context at ${usage.percent.toFixed(1)}% is under the ${cfg.softPercent}% floor`;
  const free = usage.tokens - cfg.keptFloorTokens;
  if (free < cfg.minFreeTokens) return `would free about ${free} tokens, under the ${cfg.minFreeTokens} minimum`;
  const branch = ctx.sessionManager.getBranch();
  if (branch.length > 0 && branch[branch.length - 1].type === "compaction") return "the last entry is already a compaction";
  if (state.entriesAtCompaction !== undefined && branch.length <= state.entriesAtCompaction) return "nothing new since the last compaction";
  if (state.lastCompactionAt !== undefined) {
    const since = Date.now() - state.lastCompactionAt;
    if (since < cfg.cooldownMs) return `cooldown: ${Math.ceil((cfg.cooldownMs - since) / 1000)}s left`;
  }
  return undefined;
}

/** This session's plan, straight out of `.pi/plan/<session-id>.json`, for the summary to carry verbatim. */
function pinnedPlan(ctx: ExtensionContext): string | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!planPath(ctx.cwd, sessionId)) return undefined;
  const read = readPlan(ctx.cwd, sessionId);
  if (!read.plan) return undefined;
  const block = renderPlanBlock(read.plan);
  return block.trim() ? block : undefined;
}

/* ------------------------------------------------------------------ extension */

export default function (pi: ExtensionAPI) {
  const state: State = {
    cfg: { ...DEFAULT_CONFIG, problems: [] },
    forcedOff: false,
    lastCtx: undefined,
    timer: undefined,
    armedFor: undefined,
    deadline: undefined,
    compacting: false,
    startedAt: 0,
    lastCompactionAt: undefined,
    entriesAtCompaction: undefined,
    stats: freshStats(),
    tally: freshTally(),
  };

  function clearTimer(): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.armedFor = undefined;
  }

  function clearDeadline(): void {
    if (state.deadline) clearTimeout(state.deadline);
    state.deadline = undefined;
  }

  /** Anything that means a turn is happening or about to happen. */
  function activity(ctx: ExtensionContext, what: string): void {
    state.lastCtx = ctx;
    if (state.timer) {
      debug(ctx, `arm cancelled (${state.armedFor}) by ${what}`);
      clearTimer();
    }
  }

  function arm(ctx: ExtensionContext, trigger: string, quietMs: number): void {
    state.lastCtx = ctx;
    if (!state.cfg.enabled || state.forcedOff) return;
    // Worth a visible refusal rather than a silent one: a settle during a compaction is the moment a user wonders
    // why nothing is happening.
    if (state.compacting) {
      state.stats.notArmed += 1;
      state.stats.lastNote = "not armed: a compaction is already in flight";
      debug(ctx, `arm refused (${trigger}): a compaction is already in flight`);
      return;
    }
    // Already armed: keep the window that is already running rather than restarting it.
    if (state.timer) return;
    const blocked = blockReason(ctx, state, state.cfg);
    if (blocked) {
      state.stats.notArmed += 1;
      state.stats.lastNote = `not armed: ${blocked}`;
      debug(ctx, `arm refused (${trigger}): ${blocked}`);
      return;
    }
    const usage = usageOf(ctx);
    state.armedFor = trigger;
    state.stats.armed += 1;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.armedFor = undefined;
      fire(trigger, quietMs, false);
    }, quietMs);
    // Housekeeping must not hold an idle session open.
    state.timer.unref?.();
    debug(ctx, `armed ${quietMs}ms after ${trigger} at ${usage?.tokens ?? "?"} tokens (${(usage?.percent ?? 0).toFixed(1)}%)`);
  }

  function fire(trigger: string, quietMs: number, force: boolean): void {
    const ctx = state.lastCtx;
    if (!ctx) return;
    const blocked = blockReason(ctx, state, state.cfg, { force });
    if (blocked) {
      state.stats.skipped += 1;
      state.stats.lastNote = `skipped: ${blocked}`;
      record(ctx, "skip", { trigger, quietMs, reason: blocked });
      return;
    }

    const usage = usageOf(ctx);
    const tokensBefore = usage?.tokens ?? 0;
    const planBlock = state.cfg.pinPlan ? pinnedPlan(ctx) : undefined;
    const startedAt = Date.now();
    state.compacting = true;
    state.startedAt = startedAt;

    clearDeadline();
    state.deadline = setTimeout(() => {
      state.deadline = undefined;
      if (!state.compacting) return;
      state.stats.abortedAtDeadline += 1;
      state.stats.lastNote = `aborted at the ${state.cfg.deadlineMs}ms deadline`;
      state.stats.lastAt = new Date().toISOString();
      record(ctx, "deadline", { trigger, quietMs, deadlineMs: state.cfg.deadlineMs, elapsedMs: Date.now() - startedAt });
      try {
        // Pi's abort() cancels an in-flight compaction. The session keeps everything it had.
        ctx.abort();
      } catch (error) {
        debug(ctx, `abort failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, state.cfg.deadlineMs);
    state.deadline.unref?.();

    record(ctx, "compact", {
      trigger,
      quietMs,
      tokens: tokensBefore,
      percent: usage?.percent,
      pinnedPlanChars: planBlock?.length ?? 0,
    });

    try {
      ctx.compact({
        customInstructions: idleCompactionInstructions(planBlock),
        onComplete: (result) => {
          const ms = Date.now() - startedAt;
          const after = result.estimatedTokensAfter;
          const freed = typeof after === "number" ? Math.max(0, tokensBefore - after) : 0;
          state.compacting = false;
          clearDeadline();
          state.stats.fired += 1;
          state.stats.freedTokens += freed;
          state.stats.lastNote = `compacted ${tokensBefore} to ${after ?? "?"} tokens (freed ${freed}) in ${Math.round(ms / 1000)}s`;
          state.stats.lastAt = new Date().toISOString();
          state.lastCompactionAt = Date.now();
          state.entriesAtCompaction = ctx.sessionManager.getBranch().length;
          ctx.ui.notify(`${MARK}: freed about ${freed} tokens in ${Math.round(ms / 1000)}s while idle; context now about ${after ?? "?"} tokens`, "info");
          record(ctx, "compacted", {
            trigger,
            ms,
            tokensBefore,
            tokensAfter: after,
            freed,
            summaryChars: result.summary.length,
            pinnedPlan: planBlock !== undefined,
          });
        },
        onError: (error) => {
          const ms = Date.now() - startedAt;
          state.compacting = false;
          clearDeadline();
          // "Already compacted" and "Nothing to compact (session too small)" are Pi saying the work was
          // already done or there is none: a skip, not a fault worth a warning.
          const benign = /already compacted|too small|cancelled/i.test(error.message);
          state.stats[benign ? "skipped" : "failed"] += 1;
          state.stats.lastNote = benign ? `skipped: ${error.message}` : `failed after ${Math.round(ms / 1000)}s: ${error.message}`;
          state.stats.lastAt = new Date().toISOString();
          if (!benign) ctx.ui.notify(`${MARK}: ${error.message}`, "warning");
          record(ctx, benign ? "skip" : "failed", { trigger, ms, error: error.message });
        },
      });
    } catch (error) {
      // A context invalidated by a reload throws instead of acting on the wrong session.
      state.compacting = false;
      clearDeadline();
      state.stats.failed += 1;
      state.stats.lastNote = `could not start: ${error instanceof Error ? error.message : String(error)}`;
      debug(ctx, state.stats.lastNote);
    }
  }

  /* ---------------------------------------------------------------- stale tool output */

  interface Candidate {
    id: string;
    toolName: string;
    chars: number;
  }

  /**
   * Tool results a later turn almost certainly does not need.
   *
   * The rules, in the order they matter: keep the newest `pruneKeepRecentResults` whole, because that is the
   * working set; only touch text (an image somebody was looking at is not stale output); only touch ones big
   * enough that an edit entry is cheaper than what it saves; never touch one already edited.
   */
  function candidatesFor(ctx: ExtensionContext, cfg: RuntimeConfig): Candidate[] {
    const branch = ctx.sessionManager.getBranch();
    const alreadyEdited = new Set<string>();
    for (const entry of branch) {
      if (entry.type === "context_edit") alreadyEdited.add(entry.targetId);
    }
    const out: Candidate[] = [];
    let seen = 0;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      seen += 1;
      if (seen <= cfg.pruneKeepRecentResults) continue;
      if (alreadyEdited.has(entry.id)) continue;
      const content = entry.message.content;
      if (!Array.isArray(content) || content.length === 0) continue;
      if (!content.every((block) => block.type === "text")) continue;
      const chars = content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
      if (chars < cfg.pruneMinChars) continue;
      out.push({ id: entry.id, toolName: entry.message.toolName || "tool", chars });
    }
    return out;
  }

  /** Short, and honest about what it replaced: the point of the stub is that the reader can get the real thing back. */
  function stubFor(candidate: Candidate, at: string): string {
    return `[${MARK} ${at}: ${candidate.toolName} output dropped from context, about ${Math.round(candidate.chars / 1000)}k characters. It was reported, read and acted on earlier in this session; re-run the command or read the file again if the detail is needed.]`;
  }

  /* ------------------------------------------------------------------ lifecycle */

  pi.on("session_start", (event, ctx) => {
    // Read the flag when a session starts rather than at load: a reload re-reads it, and `enabled` then means
    // the same thing on the second session as on the first.
    state.forcedOff = pi.getFlag("idle-compaction-off") === true;
    state.cfg = readConfig(ctx);
    clearTimer();
    clearDeadline();
    state.compacting = false;
    state.lastCtx = ctx;
    // A resumed session is the moment being described: sitting down with the context already near the ceiling.
    // Arm the ordinary quiet window rather than compacting on the spot, so the work happens when he is not
    // about to type, and does not happen at all when he is.
    arm(ctx, `session_start:${event.reason}`, state.cfg.quietMs);
    debug(
      ctx,
      `start: enabled=${state.cfg.enabled && !state.forcedOff} quiet=${state.cfg.quietMs}ms urgent=${state.cfg.urgentQuietMs}ms@${state.cfg.urgentPercent}% soft=${state.cfg.softPercent}% deadline=${state.cfg.deadlineMs}ms cooldown=${state.cfg.cooldownMs}ms prune=${state.cfg.prune}` +
        (state.cfg.problems.length ? ` problems: ${state.cfg.problems.join(", ")}` : ""),
    );
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => activity(ctx, event.type));
  pi.on("agent_start", (_event, ctx) => activity(ctx, "agent_start"));
  pi.on("turn_start", (event: TurnStartEvent, ctx) => activity(ctx, event.type));
  pi.on("tool_result", (event: ToolResultEvent, ctx) => activity(ctx, event.type));
  pi.on("message_end", (event: MessageEndEvent, ctx) => activity(ctx, event.type));
  pi.on("user_bash", (event: UserBashEvent, ctx) => activity(ctx, event.type));
  pi.on("ui_prompt_start", (event: UIPromptStartEvent, ctx) => activity(ctx, event.type));

  pi.on("agent_settled", (event: AgentSettledEvent, ctx) => {
    state.lastCtx = ctx;
    // An aborted run is a human interrupting: the next thing they do is the next thing the session does.
    if (event.aborted) {
      clearTimer();
      return;
    }
    const usage = usageOf(ctx);
    const urgent = usage !== undefined && usage.tokens !== null && usage.percent !== null && usage.percent >= state.cfg.urgentPercent;
    arm(ctx, `agent_settled${urgent ? ":urgent" : ""}`, urgent ? state.cfg.urgentQuietMs : state.cfg.quietMs);
  });

  pi.on("session_compact", (event, ctx) => {
    // A compaction Pi started itself counts against the cooldown too, and is the evidence that the idle path
    // did not get there first.
    state.lastCompactionAt = Date.now();
    state.entriesAtCompaction = ctx.sessionManager.getBranch().length;
    if (!state.compacting) {
      record(ctx, "compacted", {
        trigger: `pi:${event.reason}`,
        tokensBefore: event.compactionEntry.tokensBefore,
        summaryChars: event.compactionEntry.summary.length,
      });
      debug(ctx, `Pi compacted on its own (${event.reason}); the idle path did not get there first`);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearTimer();
    clearDeadline();
    const s = state.stats;
    debug(
      ctx,
      `shutdown: armed=${s.armed} notArmed=${s.notArmed} fired=${s.fired} skipped=${s.skipped} failed=${s.failed} deadlineAborts=${s.abortedAtDeadline} freed=${s.freedTokens} pruneCandidates=${state.tally.candidates} pruneApplied=${state.tally.applied}`,
    );
  });

  /**
   * A warm prefix is about to be replaced, so do not keep paying to hold it. Inert for models that declare no
   * cache lifetime - which is every model in this fleet - and the whole point of it is the day a session runs
   * on a cache-aware provider.
   */
  pi.on("cache_warming_decision", () => (state.compacting ? { action: "stop" as const } : undefined));

  /**
   * The stale-tool-output pass. `report` (the default) only counts. `on` writes `context_edit` replacements,
   * which Pi counts in its own idea of how full the context is, so the saving is real rather than a view that
   * has to be re-created on every request.
   */
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx): AgentBeforeSettleEventResult | undefined => {
    state.lastCtx = ctx;
    const cfg = state.cfg;
    if (!cfg.enabled || state.forcedOff || cfg.prune === "off") return undefined;

    const candidates = candidatesFor(ctx, cfg);
    if (candidates.length === 0) return undefined;

    const reclaimable = candidates.reduce((sum, candidate) => sum + tokensFromChars(candidate.chars), 0);
    state.tally.candidates += candidates.length;
    state.tally.candidateTokens += reclaimable;

    if (cfg.prune === "report") {
      record(ctx, "prune-report", { candidates: candidates.length, tokens: reclaimable, largestChars: candidates[0]?.chars ?? 0 });
      debug(ctx, `prune report: ${candidates.length} stale tool results, about ${reclaimable} tokens reclaimable`);
      return undefined;
    }

    const at = new Date().toISOString().slice(0, 16).replace("T", " ");
    const chosen = candidates.slice(0, cfg.pruneMaxPerBoundary);
    const drafts: SessionBoundaryDraft[] = chosen.map((candidate): ContextEditEntryDraft => ({
      type: "context_edit",
      targetId: candidate.id,
      // A replacement, never `null`: the tool call keeps a result, so the pairing Pi warns about survives.
      replacement: { content: [{ type: "text", text: stubFor(candidate, at) }] },
    }));
    const stubChars = chosen.reduce((sum, candidate) => sum + stubFor(candidate, at).length, 0);
    state.tally.applied += drafts.length;
    state.tally.reclaimedTokens += Math.max(0, tokensFromChars(chosen.reduce((sum, candidate) => sum + candidate.chars, 0) - stubChars));
    record(ctx, "prune-apply", { applied: drafts.length, candidates: candidates.length, tokens: state.tally.reclaimedTokens });
    debug(ctx, `prune applied: ${drafts.length} of ${candidates.length} stale tool results`);
    return { entries: [...event.entries, ...drafts] };
  });

  /* ------------------------------------------------------------------ surface */

  pi.registerFlag("idle-compaction-off", {
    description: "Do not compact this session while it is idle (Pi's own threshold compaction still applies)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("idle-compact", {
    description: "Idle compaction: status, switch it on or off, measure stale tool output, or do one now",
    handler: async (args, ctx) => {
      state.lastCtx = ctx;
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const path = configPath(ctx);

      if (sub === "on" || sub === "off" || sub === "dry-run") {
        state.cfg = { ...state.cfg, enabled: sub !== "off", prune: sub === "dry-run" ? "report" : state.cfg.prune };
        const written = writeConfig(ctx, state.cfg);
        clearTimer();
        const meaning = sub === "off" ? "off (Pi's own threshold compaction still applies)" : sub === "on" ? "on" : "dry-run: measure stale tool output, touch nothing";
        ctx.ui.notify(`${MARK}: ${meaning} for this repository (${written})`, "info");
        record(ctx, "config", { set: sub });
        return;
      }

      if (sub === "prune") {
        const mode = rest[0];
        if (mode !== "off" && mode !== "report" && mode !== "on") {
          ctx.ui.notify(`${MARK}: /idle-compact prune <off|report|on> - report counts stale tool output, on replaces it with a stub`, "info");
          return;
        }
        state.cfg = { ...state.cfg, prune: mode };
        const written = writeConfig(ctx, state.cfg);
        ctx.ui.notify(`${MARK}: stale tool output set to ${mode} (${written})`, "info");
        record(ctx, "config", { prune: mode });
        return;
      }

      if (sub === "run") {
        const force = rest.includes("--force");
        const blocked = blockReason(ctx, state, state.cfg, { force });
        if (blocked) {
          ctx.ui.notify(`${MARK}: would not compact right now: ${blocked}. Force it with "run --force"`, "info");
          return;
        }
        clearTimer();
        const forcedAgainst = force ? blockReason(ctx, state, state.cfg, { force: false }) : undefined;
        fire(forcedAgainst ? `command:forced-against-${forcedAgainst}` : "command", 0, force);
        return;
      }

      const usage = usageOf(ctx);
      const cfg = state.cfg;
      const s = state.stats;
      const tokens = usage?.tokens;
      const percent = usage?.percent;
      const lines = [
        `${MARK}: ${cfg.enabled && !state.forcedOff ? "on" : "off"}${state.forcedOff ? " (--idle-compaction-off)" : ""}`,
        `context ${tokens ?? "?"} of ${usage?.contextWindow ?? "?"} (${percent === null || percent === undefined ? "?" : percent.toFixed(1)}%) · floor ${cfg.softPercent}% · quiet ${cfg.quietMs / 1000}s · urgent ${cfg.urgentQuietMs / 1000}s at ${cfg.urgentPercent}% · deadline ${cfg.deadlineMs / 1000}s · cooldown ${Math.round(cfg.cooldownMs / 1000)}s`,
        `armed ${s.armed} · not armed ${s.notArmed} · compacted ${s.fired} · skipped ${s.skipped} · failed ${s.failed} · deadline aborts ${s.abortedAtDeadline} · freed ${s.freedTokens} tokens`,
        `last: ${s.lastNote}${s.lastAt ? ` at ${s.lastAt}` : ""}`,
        `stale tool output (${cfg.prune}): ${state.tally.candidates} candidates, about ${state.tally.candidateTokens} tokens reclaimable, ${state.tally.applied} replaced · newest ${cfg.pruneKeepRecentResults} results kept whole, ${cfg.pruneMinChars} char floor`,
        `plan pinned in the summary: ${cfg.pinPlan ? "yes, from .pi/plan/<session-id>.json" : "no"}`,
      ];
      if (state.compacting) {
        lines.push(`a compaction started ${Math.round((Date.now() - state.startedAt) / 1000)}s ago; deadline in ${Math.max(0, Math.round((state.startedAt + cfg.deadlineMs - Date.now()) / 1000))}s`);
      }
      if (state.armedFor) lines.push(`quiet timer armed ${cfg.quietMs / 1000}s after ${state.armedFor}`);
      if (cfg.problems.length) lines.push(`config problems: ${cfg.problems.join(", ")}`);
      lines.push(`decisions: ${logPath(ctx)}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  if (pi.getFlag("idle-compaction-off") === true) state.forcedOff = true;
}