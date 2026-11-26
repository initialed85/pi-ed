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
 * | `deadlineMs` | 240000 | A solo attempt measured 27-77 s locally, and this feature's own logs measured 59.2 s for
 *   57181 tokens and 107.2 s for 103142 tokens. Pi's trigger point runs median 71 s and p90 226 s, and every
 *   concurrent attempt died at the old 120 s. A deadline below the p90 cancels work that was going to finish. |
 * | `cooldownMs` | 600000 | Stop an idle session from summarising itself over and over. |
 * | `spreadMs` | 90000 | The gap between fleet compactions. The same logs show a solo run of this feature costing
 *   59-107 s, so a 90 s gap keeps the local backends serving one summarisation at a time without making a session
 *   wait for the fleet. |
 * | `gateMaxWaitMs` | 1800000 | Queueing has to end. Thirty minutes of waiting is a skip with a reason, not a session
 *   that never compacts. |
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
 * - **The contention is the fleet, not the transcript.** Every model in this fleet is served by two backends, and a
 *   deploy stamp restarts every pod inside the same second, so every session's quiet window opens at the same
 *   instant. Nine of them did that on 2026-11-26 (58877 to 186420 tokens each) and every one was aborted at the
 *   deadline having freed nothing, while the sessions that fired outside that burst summarised the same sizes in
 *   59-107 s. Hence the gate: one lease file at the parent of the checkout
 *   (`/workspace/.pi/idle-compaction/lease.json`), a spacing stamp
 *   so the next fleet start is at least `spreadMs` later, a bounded poll while waiting, and a takeover path for a
 *   lease left behind by a pod that died mid-compaction. A person who runs `/idle-compact run` is not queued behind
 *   it, and a person who comes back cancels the wait.
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
 * Side effects: compactions can happen unasked, at idle. Every compaction decision is logged to
 * `.pi/idle-compaction/log.jsonl`, and an arm refusal is logged once per reason rather than once per settle, so a
 * session that never compacts still leaves evidence without filling the log with the same line. Delete this file to go
 * back to Pi's behaviour.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
  type SessionEntry,
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
  spreadMs: number;
  gateMaxWaitMs: number;
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
  deadlineMs: 240000,
  cooldownMs: 600000,
  spreadMs: 90000,
  gateMaxWaitMs: 1800000,
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
  | "spreadMs"
  | "gateMaxWaitMs"
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
  spreadMs: [1000, 3600000],
  gateMaxWaitMs: [1000, 21600000],
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
  ["IDLE_COMPACTION_SPREAD_MS", "spreadMs"],
  ["IDLE_COMPACTION_GATE_MAX_WAIT_MS", "gateMaxWaitMs"],
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

/**
 * When this session last read its config file, and how new that file was at the time. `readConfig` runs at
 * session start on purpose (a reload re-reads it, a running session does not change its own rules mid-flight),
 * which means a person who edits `.pi/idle-compaction.json` while working has no way to tell from the log that
 * their edit did nothing. This is the line that tells them.
 */
function configMtimeMs(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : undefined;
  } catch {
    return undefined;
  }
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

/* ------------------------------------------------------------------ the fleet gate
 *
 * Why this exists is a measured fact, not a guess. On 2026-11-26 a deploy stamp restarted every pod inside the same
 * second, so every session's quiet window opened at the same instant, and nine of them issued a summarisation
 * request between 17:09:42Z and 17:09:50Z against `rooter` and `retainer`, which serve every model in this fleet.
 * Every one of them was aborted at the then-120 s deadline having spent the whole call and freed nothing, and the
 * session that fired forty-five seconds later was aborted too:
 *
 *   session          fired at        tokens summarised   freed
 *   rooter           17:09:42Z       88190               0
 *   camry            17:09:42Z       84917               0
 *   memebrary        17:09:44Z       74039               0
 *   macgrubernetes   17:09:44Z       90599               0
 *   pi-team-room     17:09:45Z       186420              0
 *   macker           17:09:45Z       71229               0
 *   home-ops         17:09:48Z       86748               0
 *   pi-bot           17:09:48Z       58877               0
 *   maclet           17:09:50Z       63058               0
 *   pi-ed            17:10:37Z       86318               0
 *
 * The two attempts in the same logs that did not fire inside that burst show what a solo call costs this feature:
 * slopyphus summarised 57181 tokens in 59.2 s, and pi-bot summarised 103142 in 107.2 s. Same sizes as the burst,
 * 59-107 s instead of "never finished". Concurrency is the difference, so the gate makes an idle summarisation a
 * fleet resource with two rules: **one in flight at a time** (a lease file) and **a minimum gap between
 * starts** (a spacing stamp), both on the shared `/workspace` root every pod mounts.
 */

const GATE_DIR_NAME = "idle-compaction";
const LEASE_FILE = "lease.json";
const SPACING_FILE = "spacing.json";
/** A lease older than its deadline plus this is a pod that died mid-compaction, and may be taken over. */
const GATE_GRACE_MS = 30000;
/**
 * How often a waiting session re-checks. The holder usually finishes long before its lease expires, and a waiter
 * that slept for the whole TTL would sit out a compaction that ended two minutes ago. Polling at 30 s costs one
 * filesystem read per session per half minute, which is what `arm` and `blockReason` already cost.
 */
const GATE_POLL_MS = 30000;

interface GateLease {
  sessionId: string;
  repo: string;
  startedAt: number;
  expiresAt: number;
  deadlineMs: number;
}

interface GateHeld {
  heldBy: string;
  heldMs: number;
  waitMs: number;
}

/**
 * Where the gate lives. Every agent checkout in this fleet is a direct child of the shared `/workspace`, so the
 * gate belongs to the shared root rather than to one repo: `/workspace/.pi/idle-compaction/`. That directory is
 * outside every git tree, so it cannot dirty a working copy. Anywhere else it stays inside the repo's own `.pi`.
 * `IDLE_COMPACTION_GATE_DIR` overrides it; `IDLE_COMPACTION_GATE=off` removes it, which is what a single session
 * on a laptop wants.
 */
function gateDir(cwd: string): string | undefined {
  // Checked before the directory override: `off` is the unambiguous statement, and a leftover directory should
  // not overrule it.
  if (process.env.IDLE_COMPACTION_GATE?.trim().toLowerCase() === "off") return undefined;
  const override = process.env.IDLE_COMPACTION_GATE_DIR?.trim();
  if (override) return override.startsWith("/") ? override : join(cwd, override);
  const parent = join(cwd, "..");
  if (basename(parent) === "workspace" && existsSync(parent)) return join(parent, ".pi", GATE_DIR_NAME);
  return join(cwd, CONFIG_DIR_NAME, GATE_DIR_NAME);
}

/** Deterministic, not random: a deferral must be reproducible when it is read back in the log. */
function jitterMs(seed: string, spreadMs: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % Math.max(1, spreadMs);
}

function readGateFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function gateSpacing(dir: string): { at: number; repo: string } | undefined {
  const raw = readGateFile(join(dir, SPACING_FILE));
  if (!raw || typeof raw.at !== "number") return undefined;
  return { at: raw.at, repo: typeof raw.repo === "string" ? raw.repo : "unknown" };
}

function readLease(leasePath: string): GateLease | undefined {
  const raw = readGateFile(leasePath);
  if (!raw || typeof raw.sessionId !== "string") return undefined;
  return {
    sessionId: raw.sessionId,
    repo: typeof raw.repo === "string" ? raw.repo : "unknown",
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : 0,
    deadlineMs: typeof raw.deadlineMs === "number" ? raw.deadlineMs : 0,
  };
}

/** A lease that is still being honoured. A dead one is not a holder, it is debris. */
function gateLease(dir: string, now: number): GateLease | undefined {
  const lease = readLease(join(dir, LEASE_FILE));
  if (!lease) return undefined;
  if (lease.expiresAt + GATE_GRACE_MS <= now) return undefined;
  return lease;
}

type GateClaim =
  | { ok: true; tookOver?: { repo: string; heldMs: number } }
  | { ok: false; held: GateHeld; ioError?: string };

/**
 * Claim the gate, or say how long to wait. `O_EXCL` on creation is the mutual exclusion. Whatever a shared
 * filesystem does under a genuine race, the worst case is two sessions compacting at once, which is exactly what
 * happens today with no gate at all.
 */
function claimGate(
  dir: string,
  sessionId: string,
  repo: string,
  deadlineMs: number,
  spreadMs: number,
  now: number,
): GateClaim {
  const leasePath = join(dir, LEASE_FILE);
  const write = (lease: { startedAt: number }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      leasePath,
      JSON.stringify({
        sessionId,
        repo,
        startedAt: lease.startedAt,
        expiresAt: now + deadlineMs + GATE_GRACE_MS,
        deadlineMs,
      }),
      { flag: "wx" },
    );
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = readLease(leasePath);
    const live = raw && raw.expiresAt + GATE_GRACE_MS > now ? raw : undefined;

    if (live && live.sessionId !== sessionId) {
      // Poll rather than sleeping to the TTL, and jitter the poll so a fleet that started together does not
      // re-check together.
      return {
        ok: false,
        held: {
          heldBy: live.repo,
          heldMs: now - live.startedAt,
          waitMs: Math.min(Math.max(0, live.expiresAt - now), GATE_POLL_MS) + jitterMs(sessionId, GATE_POLL_MS),
        },
      };
    }

    const spacing = gateSpacing(dir);
    if (!live && spacing && now < spacing.at + spreadMs) {
      return {
        ok: false,
        held: {
          heldBy: `the spacing stamp left by ${spacing.repo}`,
          heldMs: now - spacing.at,
          waitMs: spacing.at + spreadMs - now + jitterMs(sessionId, GATE_POLL_MS),
        },
      };
    }

    // A pod that died mid-compaction leaves a file no one can release, and `wx` would fail on it forever. Debris
    // is removed, and the takeover is reported so the log says which session was taken over and for how long.
    let tookOver: { repo: string; heldMs: number } | undefined;
    if (raw && !live) {
      tookOver = { repo: raw.repo, heldMs: Math.max(0, now - raw.startedAt) };
      try {
        unlinkSync(leasePath);
      } catch {
        /* a peer already removed it; the write below will say so */
      }
    }

    if (live && live.sessionId === sessionId) {
      try {
        unlinkSync(leasePath);
        write({ startedAt: live.startedAt });
        return { ok: true };
      } catch {
        continue;
      }
    }

    try {
      write({ startedAt: now });
      return { ok: true, tookOver };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue; // a peer won the race; re-read it next iteration
      return { ok: false, held: { heldBy: "gate io error", heldMs: 0, waitMs: 0 }, ioError: String(code ?? error) };
    }
  }

  const live = gateLease(dir, now);
  return {
    ok: false,
    held: {
      heldBy: live?.repo ?? "unknown",
      heldMs: live ? now - live.startedAt : 0,
      waitMs: (live ? Math.min(Math.max(0, live.expiresAt - now), GATE_POLL_MS) : spreadMs) + jitterMs(sessionId, GATE_POLL_MS),
    },
  };
}

/** Give the gate back, and stamp when it was handed back so peers space their starts after it. Only a holder may release it. */
function releaseGate(dir: string, sessionId: string, repo: string, now: number): void {
  try {
    const lease = readGateFile(join(dir, LEASE_FILE));
    if (lease && lease.sessionId === sessionId) unlinkSync(join(dir, LEASE_FILE));
    writeFileSync(join(dir, SPACING_FILE), JSON.stringify({ at: now, repo }), "utf8");
  } catch {
    // A gate that cannot be released expires by itself; it must never become the reason a session breaks.
  }
}

/** Stamp when a compaction let go, so peers space their starts after it. */
function stampGate(dir: string, repo: string, now: number): void {
  try {
    writeFileSync(join(dir, SPACING_FILE), JSON.stringify({ at: now, repo }), "utf8");
  } catch {
    /* a stamp that cannot be written costs nothing */
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
  gateWaits: number;
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
  /** Set while this session holds the shared gate file. */
  gateHeld: boolean;
  /** When a compaction began, whichever asked for it: `session_before_compact` fires on Pi's own path too, and this
   *  is what makes Pi's compaction duration computable when its completion event carries no duration. */
  compactionHookAt: number | undefined;
  gateDir: string | undefined;
  gateNote: string;
  /** Wall time spent queueing for the gate in the current chain. Reset on release and on session start. */
  gateWaitedMs: number;
  /** Set when a forced run went ahead without holding the lease: it still gets to stamp the spacing. */
  gateStamp: boolean;
  /** What was read from `.pi/idle-compaction.json` and when. `readConfig` runs at session start on purpose, and a
   *  person editing that file mid-session is entitled to know that their edit is not live yet. */
  configStamp: { path: string; readAt: string | undefined; mtimeMs: number | undefined };
  lastCompactionAt: number | undefined;
  entriesAtCompaction: number | undefined;
  stats: Stats;
  tally: Tally;
  /** The latest measurement, not a running total: the same stale result is still one result after four settles. */
  lastPruneReport: { candidates: number; tokens: number };
  /** The arm refusal already written to the decision log, so a session that keeps refusing writes one line, not one per settle. */
  lastLoggedArmReason: string | undefined;
}

function freshStats(): Stats {
  return {
    armed: 0,
    notArmed: 0,
    fired: 0,
    skipped: 0,
    failed: 0,
    abortedAtDeadline: 0,
    gateWaits: 0,
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
    gateHeld: false,
    gateDir: undefined,
    gateNote: "not claimed",
    gateWaitedMs: 0,
    gateStamp: false,
    compactionHookAt: undefined,
    lastCompactionAt: undefined,
    entriesAtCompaction: undefined,
    stats: freshStats(),
    tally: freshTally(),
    lastPruneReport: { candidates: 0, tokens: 0 },
    configStamp: { path: "", readAt: undefined, mtimeMs: undefined },
    lastLoggedArmReason: undefined,
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

  /**
   * An arm refusal goes in the decision log, but only when the reason changes.
   *
   * A session that never compacts still has to leave evidence - the live run that first exercised this extension
   * settled eleven times under the floor and left an empty log, which reads exactly like a broken extension. Logging
   * every settle would be the other failure: the same line, over and over, pushing the interesting ones out of the
   * tail the log keeps.
   */
  function logArmRefusal(ctx: ExtensionContext, trigger: string, reason: string): void {
    if (state.lastLoggedArmReason === reason) return;
    state.lastLoggedArmReason = reason;
    record(ctx, "skip", { stage: "arm", trigger, reason });
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
      logArmRefusal(ctx, trigger, "a compaction is already in flight");
      return;
    }
    // Already armed: keep the window that is already running rather than restarting it.
    if (state.timer) return;
    const blocked = blockReason(ctx, state, state.cfg);
    if (blocked) {
      state.stats.notArmed += 1;
      state.stats.lastNote = `not armed: ${blocked}`;
      debug(ctx, `arm refused (${trigger}): ${blocked}`);
      logArmRefusal(ctx, trigger, blocked);
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

  function sessionIdOf(ctx: ExtensionContext): string {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return "unknown-session";
    }
  }

  /** Only a holder hands the gate back, and it stamps when it let go. */
  function handBackGate(note: string): void {
    const ctx = state.lastCtx;
    if (!ctx || !state.gateDir) return;
    if (state.gateHeld) {
      releaseGate(state.gateDir, sessionIdOf(ctx), basename(ctx.cwd), Date.now());
      state.gateHeld = false;
    } else if (state.gateStamp) {
      // It never owned the lease, so it cannot release one; but a compaction just happened here, and peers
      // should space their next starts after it all the same.
      stampGate(state.gateDir, basename(ctx.cwd), Date.now());
      state.gateStamp = false;
    } else {
      return;
    }
    state.gateWaitedMs = 0;
    state.gateNote = note;
    debug(ctx, `gate released (${note})`);
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

    // The gate is claimed here, at the moment of the decision, not when the quiet window opened: ten sessions
    // that armed in the same second must still end up summarising one at a time.
    if (state.gateDir && !state.gateHeld) {
      const claim = claimGate(
        state.gateDir,
        sessionIdOf(ctx),
        basename(ctx.cwd),
        state.cfg.deadlineMs,
        state.cfg.spreadMs,
        Date.now(),
      );
      const askedNow = force || trigger.startsWith("command:") || trigger === "command";
      if (!claim.ok && askedNow) {
        // A person who asked now is not queued behind a peer. The claim failed, so this session does not hold
        // the lease and must not remove somebody else's; it only reports that it went ahead.
        record(ctx, "gate", { trigger, quietMs, action: "asked now", ...claim.held, dir: state.gateDir });
        state.gateNote = `went ahead while ${claim.held.heldBy} held the gate`;
        state.gateStamp = true;
      } else if (!claim.ok) {
        if (claim.ioError) {
          record(ctx, "gate", { trigger, error: claim.ioError, dir: state.gateDir });
          state.gateNote = `gate unavailable (${claim.ioError}); running ungated`;
        } else {
          state.stats.gateWaits += 1;
          state.gateWaitedMs += claim.held.waitMs;
          if (state.gateWaitedMs > state.cfg.gateMaxWaitMs) {
            state.stats.skipped += 1;
            state.stats.lastNote = `skipped: queueing for the gate passed ${Math.round(state.cfg.gateMaxWaitMs / 60000)} minutes`;
            record(ctx, "skip", {
              trigger,
              quietMs,
              reason: `gate held by ${claim.held.heldBy}; gave up after ${Math.round(state.gateWaitedMs / 1000)}s of queueing`,
              queuedMs: state.gateWaitedMs,
            });
            return;
          }
          state.gateNote = `waiting on ${claim.held.heldBy} for ${Math.round(claim.held.waitMs / 1000)}s`;
          state.stats.lastNote = `gate wait ${state.stats.gateWaits}: ${state.gateNote}`;
          record(ctx, "gate", { trigger, quietMs, ...claim.held, dir: state.gateDir });
          debug(ctx, `gate held by ${claim.held.heldBy} (${claim.held.heldMs}ms); waiting ${claim.held.waitMs}ms`);
          // The wait is cancellable by anything that means a turn is happening, which is the point: a
          // returning person always beats an idle compaction.
          state.timer = setTimeout(() => {
            state.timer = undefined;
            fire(trigger, quietMs, false);
          }, claim.held.waitMs);
          state.timer.unref?.();
          return;
        }
      } else {
        state.gateHeld = true;
        state.gateWaitedMs = 0;
        state.gateNote = "held";
        if (claim.tookOver) {
          // Worth reading back: this session started because it took over a lease nobody released.
          record(ctx, "gate", {
            trigger,
            quietMs,
            action: "took over",
            from: claim.tookOver.repo,
            heldForMs: claim.tookOver.heldMs,
            dir: state.gateDir,
          });
          debug(ctx, `took over a stale lease from ${claim.tookOver.repo} (held ${claim.tookOver.heldMs}ms)`);
        }
      }
    }

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
      // The ceiling this attempt actually ran under. Without it, a session that aborts at a deadline cannot tell
      // anybody which ceiling it hit - which is how one pod's five-hour experiment came back void.
      deadlineMs: state.cfg.deadlineMs,
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
          handBackGate(`compacted in ${ms}ms`);
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
          handBackGate(`error after ${ms}ms`);
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
      handBackGate("could not start");
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
   *
   * Measured over what Pi would actually send, which is not the whole session file. `getBranch()` is every entry
   * ever written; `buildContextEntries()` is the compaction-aware view Pi builds: the newest compaction entry,
   * everything from its `firstKeptEntryId` to that boundary, and everything after it. A tool result behind that
   * boundary is already out of the request, and counting it invents a saving - pi-bot's pod reported 405 candidates
   * and 409532 "tokens" reclaimable on an 83819-token window, which was the file rather than the reclaimable part.
   */
  function candidatesFor(ctx: ExtensionContext, cfg: RuntimeConfig): Candidate[] {
    const window = windowEntries(ctx);
    const alreadyEdited = new Set<string>();
    for (const entry of window) {
      if (entry.type === "context_edit") alreadyEdited.add((entry as { targetId: string }).targetId);
    }
    const out: Candidate[] = [];
    let seen = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      const entry = window[i];
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

  /** The entries a reclaim could reach, and the size of the file they sit in, so a reader never confuses the two. */
  function windowEntries(ctx: ExtensionContext): SessionEntry[] {
    const manager = ctx.sessionManager as { buildContextEntries?: () => SessionEntry[]; getBranch: () => SessionEntry[] };
    try {
      return manager.buildContextEntries ? manager.buildContextEntries() : manager.getBranch();
    } catch {
      return manager.getBranch();
    }
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
    state.configStamp = { path: configPath(ctx), readAt: new Date().toISOString(), mtimeMs: configMtimeMs(configPath(ctx)) };
    // A new session may be starting because a deploy restarted the pod, i.e. at the same instant as every other
    // session in the fleet. The gate is re-resolved here rather than at load so `IDLE_COMPACTION_GATE_DIR` and a
    // changed cwd both take effect on reload.
    state.gateDir = gateDir(ctx.cwd);
    state.gateHeld = false;
    state.gateNote = "not claimed";
    state.gateWaitedMs = 0;
    state.gateStamp = false;
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

  /**
   * A compaction is starting, whoever asked for it. No decision is taken here - the guard for Pi's own path is
   * `compaction-summary-guard.ts`, and this extension's own path already has its ceiling. This exists so the two
   * biggest compactions in the fleet (116325 and 119360 tokens) stop contributing zero duration data: Pi's own
   * completion event has no duration, and a start stamp makes the millisecond computable after the fact.
   */
  pi.on("session_before_compact", () => {
    state.compactionHookAt = Date.now();
    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    // A compaction Pi started itself counts against the cooldown too, and is the evidence that the idle path
    // did not get there first.
    state.lastCompactionAt = Date.now();
    state.entriesAtCompaction = ctx.sessionManager.getBranch().length;
    if (!state.compacting) {
      const ms = state.compactionHookAt ? Date.now() - state.compactionHookAt : undefined;
      state.compactionHookAt = undefined;
      record(ctx, "compacted", {
        trigger: `pi:${event.reason}`,
        tokensBefore: event.compactionEntry.tokensBefore,
        summaryChars: event.compactionEntry.summary.length,
        // `msSource` says where the number came from, because it is a measured span here and a caller's own clock
        // on the idle path, and a reader should be able to tell which one they are comparing.
        ...(ms === undefined ? {} : { ms, msSource: "session_before_compact to session_compact" }),
      });
      debug(ctx, `Pi compacted on its own (${event.reason}${ms === undefined ? "" : `, ${ms}ms`}); the idle path did not get there first`);
    }
  });

  /**
   * Which config this session is running on, and whether the file has moved since it was read.
   *
   * The fleet proved why this line is needed: pi-bot wrote `deadlineMs: 600000` into its own config file at 17:29,
   * watched an attempt abort at 17:39 with the 120 s default, and could only prove afterwards, by reading the
   * source, that the edit had never been read. Saying "defaults" is not enough when a person is mid-experiment.
   */
  function describeConfig(ctx: ExtensionContext): string {
    const path = state.configStamp.path;
    const shown = path.startsWith(ctx.cwd) ? path.slice(ctx.cwd.length + 1) : path;
    const written = state.configStamp.mtimeMs;
    if (written === undefined) return `config: ${shown} does not exist; this session runs on the built-in defaults`;
    const at = (ms: number) => new Date(ms).toISOString().slice(11, 19);
    const now = configMtimeMs(path);
    const changed = now !== undefined && now > written;
    return `config: ${shown}, read at session start (${at(written)})${
      state.configStamp.readAt ? ` this session read it at ${state.configStamp.readAt.slice(11, 19)}` : ""
    }${changed ? ` - and the file was written again at ${at(now)}: those values are NOT applied to this session, reload to apply them` : ""}`;
  }

  /** The shared gate as the fleet sees it, read from disk rather than remembered. */
  function describeGate(): string {
    if (!state.gateDir) return "fleet gate: off (IDLE_COMPACTION_GATE=off); this session compacts ungated";
    const now = Date.now();
    const lease = gateLease(state.gateDir, now);
    const spacing = gateSpacing(state.gateDir);
    const parts: string[] = [];
    if (state.gateHeld) parts.push("held by this session");
    else if (lease) parts.push(`held by ${lease.repo} for ${Math.round((now - lease.startedAt) / 1000)}s`);
    else parts.push("free");
    if (!state.gateHeld && spacing) {
      const left = spacing.at + state.cfg.spreadMs - now;
      parts.push(left > 0 ? `next start allowed in ${Math.round(left / 1000)}s (after ${spacing.repo})` : `spacing clear`);
    }
    parts.push(`spread ${state.cfg.spreadMs / 1000}s`);
    if (state.stats.gateWaits) parts.push(`waited ${state.stats.gateWaits}x`);
    return `fleet gate (${state.gateDir}): ${parts.join(" · ")}`;
  }

  pi.on("session_shutdown", (_event, ctx) => {
    clearTimer();
    clearDeadline();
    // A pod killed mid-compaction would otherwise leave the fleet waiting on a lease nobody can release.
    // The TTL is the backstop; this is the prompt one.
    handBackGate("session shutdown");
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
    state.lastPruneReport = { candidates: candidates.length, tokens: reclaimable };

    if (cfg.prune === "report") {
      record(ctx, "prune-report", {
        candidates: candidates.length,
        tokens: reclaimable,
        largestChars: candidates[0]?.chars ?? 0,
        // Both counts, because the difference is the whole point of the label.
        contextEntries: windowEntries(ctx).length,
        sessionEntries: ctx.sessionManager.getBranch().length,
      });
      debug(ctx, `prune report: ${candidates.length} stale tool results in the context Pi would send, about ${reclaimable} tokens reclaimable`);
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
      const planBlock = pinnedPlan(ctx);
      /*
       * Two lines this readout used to get wrong, both caught in a live run rather than in a test.
       *
       * Pi has no measurement for `getContextUsage()` right after a compaction - it re-measures on the next turn -
       * and the readout printed `context ? of 131072 (?%)`, which looks like a broken extension rather than an
       * answer of "not measured yet". And the plan line said `yes, from .pi/plan/<session-id>.json` for a session
       * that had no plan file at all, one line above its own decision log recording `pinnedPlanChars: 0`.
       */
      const contextLine = !usage
        ? "context usage unknown: no context window known for this model"
        : usage.tokens === null || usage.percent === null
          ? "context usage not measured yet: Pi re-measures on the next turn, which right after a compaction is exactly when it is asked"
          : `context ${usage.tokens} of ${usage.contextWindow} (${usage.percent.toFixed(1)}%)`;
      const planLine = !cfg.pinPlan
        ? "plan pinned in the summary: off"
        : planBlock
          ? `plan pinned in the summary: yes, ${planBlock.length} chars from .pi/plan/${ctx.sessionManager.getSessionId()}.json`
          : "plan pinned in the summary: on, but nothing to pin - this session has no plan file";
      const lines = [
        `${MARK}: ${cfg.enabled && !state.forcedOff ? "on" : "off"}${state.forcedOff ? " (--idle-compaction-off)" : ""}`,
        `${contextLine} · floor ${cfg.softPercent}% · quiet ${cfg.quietMs / 1000}s · urgent ${cfg.urgentQuietMs / 1000}s at ${cfg.urgentPercent}% · deadline ${cfg.deadlineMs / 1000}s · cooldown ${Math.round(cfg.cooldownMs / 1000)}s`,
        `armed ${s.armed} · not armed ${s.notArmed} · compacted ${s.fired} · skipped ${s.skipped} · failed ${s.failed} · deadline aborts ${s.abortedAtDeadline} · freed ${s.freedTokens} tokens`,
        `last: ${s.lastNote}${s.lastAt ? ` at ${s.lastAt}` : ""}`,
        `stale tool output (${cfg.prune}): ${state.lastPruneReport.candidates} candidates, about ${state.lastPruneReport.tokens} tokens reclaimable in the context Pi would send now, ${state.tally.applied} replaced this session · newest ${cfg.pruneKeepRecentResults} results kept whole, ${cfg.pruneMinChars} char floor`,
        planLine,
        describeConfig(ctx),
      ];
      if (state.compacting) {
        lines.push(`a compaction started ${Math.round((Date.now() - state.startedAt) / 1000)}s ago; deadline in ${Math.max(0, Math.round((state.startedAt + cfg.deadlineMs - Date.now()) / 1000))}s`);
      }
      if (state.armedFor) lines.push(`quiet timer armed ${cfg.quietMs / 1000}s after ${state.armedFor}`);
      lines.push(describeGate());
      if (cfg.problems.length) lines.push(`config problems: ${cfg.problems.join(", ")}`);
      lines.push(`decisions: ${logPath(ctx)}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  if (pi.getFlag("idle-compaction-off") === true) state.forcedOff = true;
}