/**
 * Warming evidence, and the decision to arm a warm or refuse one.
 *
 * Pi already owns the mechanism. `dist/core/cache-warmer.js` keeps one prompt-cache entry alive by
 * re-sending the last real request with a one-token output cap, and it hands every scheduled refresh
 * to extensions as a `cache_warming_decision` event carrying its own economics. This module does not
 * implement warming. It decides, from measured evidence about *this* session, whether Pi should send
 * the refresh it is about to send, and it records both numbers even when the answer is no.
 *
 * Why the decision has to be ours rather than Pi's, in three measured facts:
 *
 *   0. On this fleet Pi is not asked at all. It starts a warming run by reading the lifetime of the entry it
 *      would refresh (`getPromptCacheTtlMs`, from the model's `promptCache` tier), no entry in
 *      `/root/.pi/agent/models.json` declares `promptCache`, and the warmer stops with
 *      `{action: "stop", reason: "cache lifetime unavailable"}`. There is no decision event to policy on until a
 *      lifetime is declared. A missing `cost` block does not error: the 1.6.1 config loader defaults it to zeros,
 *      so `evaluateCacheWarming` answers `economicsAvailable: false`, `warmCost: 0`, `missCost: 0`, `action: stop`
 *      — which is a stop Pi reaches *while still asking extensions*, and is the hole this policy stands in.
 *   1. Pi warms only when `continuationProbability × missCost − warmCost ≥ $0.05`, and for an idle
 *      session `continuationProbability` is the constant 0.15. On a 42,000-token prompt that needs a
 *      miss worth about $8.8 per million input tokens. Our tokens are not priced in dollars, they are
 *      priced in slot-seconds, so Pi's gate is unreachable here and will always answer "stop".
 *   2. Pi schedules a refresh at 90% of the declared cache lifetime (`min(ttl × 0.9, ttl − 10s)`) and
 *      enforces a hard 30-minute horizon once the agent settles (60 while it streams). Rooter measured
 *      sushi's real prefix lifetime at 5,957,400 ms (~99 minutes), which schedules a refresh 89 minutes
 *      out — past both horizons, so warming stops the moment the session goes idle, which is exactly
 *      when a warm would be wanted. The catalogue value therefore has to be a *re-arm interval* Pi can
 *      actually schedule, not a statement about how long a prefix lives: 2,000s is the largest number whose
 *      refresh (1,800s) merely touches the idle horizon, and it is measured from the request that started the
 *      run, so any elapsed time puts it past. `1,800` is the value that schedules a refresh 27 minutes out
 *      with headroom, and `maxIdleMs` below is set to that interval.
 *   3. Upstream tested the busyness idea already, and their own comment on that constant says
 *      "per-session estimates were not better than this constant". A score only earns its complexity
 *      if it beats a flat 0.15, so the score is measured and logged, and the arm itself rests on
 *      something harder: what this session's last calls actually had to recompute.
 *
 * The arm rule, and the two corrections it carries. An earlier draft required a *high* cache hit rate as a
 * precondition, which is backwards: a session already reading 99% of its prompt from cache is a session a warm
 * cannot help. High recompute is the signal that wants warming, and a high hit rate is a veto. A second draft
 * gated on the gap between turns against the measured prefix lifetime, which pi-bot correctly shot down: with a
 * 99-minute lifetime almost every session clears that bar, so it discriminates nothing.
 *
 *   - nothing has arrived for longer than `maxIdleMs`, because a refresh only protects the entry until the next
 *     call, and a session already silent for longer than the interval a warm runs on has nothing to protect;
 *   - median `prompt_tokens_computed` over the session's recent calls >= `minRecomputeTokens`, because that is
 *     the work a refresh would actually have avoided - and that avoided work must itself clear
 *     `minSavedSeconds`, because a warm that saves 7 seconds of prefill is not a saving, it is noise. This is the
 *     gate's own version of Pi's `$0.05` minimum expected savings, in the currency we actually trade in;
 *   - the session keeps arriving (`arrivalsPerHour`), because a warm spent on a session that woke once and then
 *     sleeps for a day is a warm spent on nobody;
 *   - and never when the most recent call already read the prompt from cache (`vetoCacheHitRate`).
 *
 * The catalyst precondition, which is the last of those four and answers a question none of them can. Ed stated
 * the goal in Chat on 2026-11-28: idle compaction makes headroom when he sits down to a session, warming makes
 * sure that headroom is backed by a cached prefix "as long as sessions are hot enough", and a session woken for a
 * one-off team-room question "is probably not worth doing a warming for it (because that session will go back to
 * being dormant for some time)". Arrival rhythm alone cannot express that, and *why* it cannot is measured rather
 * than argued - the newest entries of this session's own transcript, over its last 24 hours of activity:
 *
 *     22  custom_message  pi-team-room-pulse
 *     17  custom_message  pi-team-room-wake        (peer asks and delegations)
 *      5  custom_message  auto-resume-prompt
 *      3  custom_message  schedule-run
 *      1  message         role=user                (the only human-shaped arrival)
 *
 * Forty-five machine turns to one human turn, on the most peer-driven session in the fleet. So the confound runs
 * the other way from the one it was described as: in Pi 1.7.0 a team-room wake, a scheduled job and an auto-resume
 * are injected as `custom_message` entries, not as user-role messages, and `sessionRhythm` only counts user-role
 * messages - which means the rhythm already ignores machine catalysts, and what it cannot see is that the prefix
 * being kept alive *ends* at a machine turn. A warm replays the last request, whatever opened it; the last request
 * here is usually a peer's question, and the expensive prefix a refresh would hold open is the one that question
 * was built on. Hence a separate precondition on the override: name the catalyst of the newest request-opening
 * entry, and only let a `chat` or `terminal` one turn the gate's stop into a warm. `peer`, and `unknown` when the
 * entry cannot be attributed, veto - which is also the safe direction for the shapes that arrive as user-role text
 * on other pods (`[background job complete]` notes, and an unreadable tail).
 *
 * What the fleet measured against that gate on 2026-11-27 (`hack/warm-counter.mjs`, rooter boot d7f15035b14e,
 * 347 generations over 144 minutes, 24 session keys): **0 sessions warmable**. The three dense Pi sessions had
 * median recompute of 259, 285 and 993 tokens against a 10,000-token floor, because their prefixes were already
 * resident; every session that did recompute 10,000-51,000 tokens was a single call followed by 100+ minutes of
 * silence. That is the case for the gate being strict and for the extension shipping dark: on this fleet the
 * prefix stays hot on its own, and the expensive recomputes belong to callers that never come back.
 *
 * The evidence comes from rooter's per-call rows (`GET /rooter/events?limit=N&key=h:<session>`), whose
 * session key is `h:` plus the first ten characters of the Pi session id — verified against live rows
 * for this session, and the reason this module has no polling loop: a decision fires at most once per
 * re-arm window, so it is fetched when a decision is actually pending.
 */

/** Rooter truncates the Pi session id to this many characters when it builds its binding key. */
export const ROOTER_KEY_PREFIX = 10;

/** Below this, a call's `prefill_ms` is a cache reload, not a re-prefill, and cannot price a warm. */
export const COLD_OBSERVED_MIN_TOKENS = 5000;

/**
 * Fallback cold prefill rates, tokens per second, from rooter's own `/rooter/backends` counters on
 * 2026-11-27 (strata 2,147 tok/s over 19 cold samples; sushi 236.7 tok/s over 8). They are a fallback only:
 * rooter reports `prefill_ms` per call, so a session's own observed cost is used whenever it is present.
 *
 * They replaced hand-copied figures that were flattering in the dangerous direction: sushi was assumed at
 * 460-470 tok/s from pi-ed's own probes and measures 236.7 tok/s at the router, which prices a 42,000-token
 * cold refresh at 178 seconds rather than 91.
 */
export const COLD_PREFILL_TOK_S: Record<string, number> = {
  strata: 2147,
  sushi: 236,
};

/**
 * What `tokens` of cold recompute would have cost on `backend`, when no observation is available.
 *
 * Every figure this returns is **box work**, not wall time, and the two differ by the queue: rooter measured a
 * warm restore of a 33,761-token prefix at 0.585 s of work that took 97 s on the wire, because the box reported
 * `running=2 waiting=1` when it arrived and `running=7` when it finished. So "a refresh avoids 178s" is a claim
 * about GPU seconds this fleet would not spend, and no claim about latency anyone would notice - which is the
 * right basis for a policy that trades in capacity, and the wrong basis for a promise about response time.
 * Where deadline arithmetic is involved (idle-compaction), the number to size against is rooter's queue bound,
 * not this.
 */
export function coldSeconds(tokens: number, backend: string | undefined, rates: Record<string, number> = COLD_PREFILL_TOK_S): number | undefined {
  const rate = backend ? rates[backend] : undefined;
  if (!rate || tokens <= 0) return undefined;
  return Math.round(tokens / rate);
}

export interface WarmConfig {
  /**
   * "observe" logs every decision and stops all of them. "arm" lets the gate warm.
   * Observe is the default on purpose: the measurement is free, because a `stop` sends no request at
   * all, and the fleet should see what the gate would have done before it pays for a single warm.
   */
  mode: "observe" | "arm";
  /** Median recomputed tokens a session must show before a warm is worth spending. */
  minRecomputeTokens: number;
  /** Turn arrivals per hour a session must show to be worth warming. */
  minArrivalsPerHour: number;
  /**
   * How long a decision may wait for its own log line, in ms. The log is a diagnostic: it must never be able to
   * hold a turn open. `appendFile` is not cancellable, so the ceiling is a race rather than a timeout passed to
   * the call, and a write that blows the ceiling is recorded as a stall instead of being retried on every
   * decision. This is the guard against the shape that actually hurts: a full or wedged volume turning a dark
   * build into a turn-end stall.
   */
  logTimeoutMs: number;
  /** After a log write stalls, stop trying to write for this long (one blocked worker, not a queue of them). */
  logRetryMs: number;
  /**
   * The least prefill a refresh must avoid to be worth sending, in seconds. The gate already trades in seconds
   * rather than dollars, so it needs the equivalent of Pi's `$0.05`: a refresh costs a replay of the session's
   * whole prompt, and avoiding a 7-second prefill is not a saving, it is noise. This bar is what caught two
   * single-call sessions arming on 2026-11-27 because rooter had just restarted and the observation window was
   * 40 minutes short, which made one call read as 2.55 arrivals/hour.
   */
  minSavedSeconds: number;
  /** A last call at or above this cache read share veto the warm: there is nothing to save. */
  vetoCacheHitRate: number;
  /**
   * How long a session may be silent and still be worth a refresh. Deliberately a separate bar from
   * `minArrivalsPerHour`: a session that made twenty calls in ten minutes and then went quiet for two hours is
   * busy *and* stale, and the second number is the one that decides whether a warm pays.
   *
   * It is read against the interval a warm would run on: a refresh only protects the entry until the next call
   * arrives, so a session already silent for longer than that interval is a session the refresh would have
   * protected nobody. The default is 27 minutes because that is what a refresh interval actually is on this
   * fleet: Pi schedules the idle refresh at `min(short x 0.9, short - 10s)` and refuses a run whose next refresh
   * falls past 30 minutes after the request started, so a catalogue declaring `promptCache.short: 1800` re-arms
   * every 1,620s and nothing larger can be scheduled at all. A bar wider than the interval would be a bar that
   * never fires, which is how this knob must not be written.
   */
  maxIdleMs: number;
  /** How many of the session's most recent calls the median is taken over. */
  evidenceCalls: number;
  /** Ignore evidence older than this. A stale median describes a session that no longer exists. */
  evidenceWindowMs: number;
  /** How long to wait for rooter before giving up on evidence and logging the decision anyway. */
  evidenceTimeoutMs: number;
}

export const DEFAULT_WARM_CONFIG: WarmConfig = {
  mode: "observe",
  minRecomputeTokens: 10000,
  minArrivalsPerHour: 2,
  logTimeoutMs: 2000,
  logRetryMs: 120000,
  minSavedSeconds: 30,
  vetoCacheHitRate: 0.99,
  maxIdleMs: 1_620_000,
  evidenceCalls: 8,
  evidenceWindowMs: 60 * 60_000,
  evidenceTimeoutMs: 1500,
};

/** One generation rooter recorded for this session. */
export interface CallEvidence {
  atMs: number;
  backend?: string;
  model?: string;
  promptTokens: number;
  /** Tokens the runner actually evaluated: prompt minus the cached prefix it reused. */
  computedTokens: number;
  cacheHitRate?: number;
  /** Rooter's own measured time to make that prompt available, milliseconds. */
  prefillMs?: number;
  aborted: boolean;
}

/** The session's arrival rhythm, from the entries it already wrote. */
export interface SessionRhythm {
  windowMs: number;
  arrivals: number;
  arrivalsPerHour: number;
  medianGapMs?: number;
  lastArrivalMs?: number;
  /** Idle time since the last arrival, at `nowMs`. */
  sinceLastMs?: number;
}

/** A session entry, narrowed to the only parts this module reads. */
export interface RhythmEntry {
  type: string;
  customType?: string;
  timestamp?: string | number;
  message?: { role?: string; content?: unknown };
  /** `custom_message` entries carry their text here rather than under `message`. */
  content?: unknown;
}

/**
 * What opened a session's newest request.
 *
 * `chat` and `terminal` are the human-shaped ones and the only two that may turn the gate's stop into a warm.
 * `peer` is a team-room ask or delegation, and `unknown` is anything the gate cannot attribute - an unreadable
 * entry, a harness note, a scheduled job, an auto-resume. `unknown` vetoes for the same reason the others do:
 * nobody has been shown to want this prefix kept.
 */
export type Catalyst = "chat" | "terminal" | "peer" | "unknown";

/** What the gate read the catalyst from, in words. Never the message itself: the log must not carry prompt text. */
export interface CatalystRead {
  catalyst: Catalyst;
  basis: string;
  /** Timestamp of the entry it was read from, when one was found. */
  atMs?: number;
}

const HUMAN_CATALYSTS: ReadonlySet<Catalyst> = new Set<Catalyst>(["chat", "terminal"]);

export function isHumanCatalyst(catalyst: Catalyst | undefined): boolean {
  return catalyst !== undefined && HUMAN_CATALYSTS.has(catalyst);
}

/**
 * Classify the text of a turn by its leading markers, from what the agent actually receives.
 *
 * Pure, synchronous, no fs and no network, and it never returns the text it read. pi-bot's bridge tags
 * Chat-originated user messages with a leading `[pi-chat:<digest>]`; the team-room extension delivers peer
 * follow-ups as `[Team inbox ...]` and replies/delegations with an `[owns: <agent>;` line; a person typing at a
 * terminal carries neither. Machine notes that do reach a user-role message (`[background job complete]`, the
 * `(auto-resume)` prompt) are named rather than allowed, because a note arriving on a human's turn is still not a
 * human coming back.
 */
export function classifyCatalystText(text: string | undefined): { catalyst: Catalyst; basis: string } {
  const body = typeof text === "string" ? text : "";
  if (!body.trim()) return { catalyst: "unknown", basis: "no readable text on the entry" };
  const stripped = body.replace(/^\s+/, "");
  const firstLine = stripped.split("\n", 1)[0] ?? stripped;
  if (firstLine.includes("[pi-chat:")) return { catalyst: "chat", basis: "marker [pi-chat:" };
  if (/^\[Team (inbox|message)/.test(stripped)) return { catalyst: "peer", basis: "marker [Team inbox" };
  if (firstLine.includes("[owns:")) return { catalyst: "peer", basis: "peer message header [owns:" };
  if (/^\((auto-resume|scheduled|dream)\b/i.test(stripped)) return { catalyst: "unknown", basis: "harness nudge" };
  if (/^\[background job (complete|failed|cancelled)\]/i.test(stripped)) return { catalyst: "unknown", basis: "background job note" };
  return { catalyst: "terminal", basis: "no peer or chat marker on a user-role turn" };
}

/** `custom_message` types that open a request from a peer rather than from a person. */
const PEER_CUSTOM_TYPES: readonly string[] = ["pi-team-room-wake", "pi-team-room-pulse"];

function entryText(entry: RhythmEntry): string | undefined {
  const raw = (entry.content ?? entry.message?.content) as unknown;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts = raw
      .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? (block as { text?: unknown }).text : undefined))
      .filter((part): part is string => typeof part === "string");
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

function stampMs(entry: RhythmEntry): number | undefined {
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
  const parsed = Date.parse(String(entry.timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The catalyst of the newest entry that opened a request on this session.
 *
 * Both shapes have to be consulted, and that is the whole point of the function: a person's turn persists as a
 * user-role message, while a peer wake, a scheduled job, a dream and an auto-resume persist as `custom_message`
 * (measured 45 of those against 1 user-role message in this session's last 24 h of activity). Whichever of the two
 * is newest is the turn the prefix now ends at, and is therefore the thing a refresh would be keeping alive.
 *
 * Never throws and never reads the filesystem: Pi hands the branch to extensions in memory, and a decision must not
 * be lost because an entry was shaped unexpectedly. An empty or unreadable branch answers `unknown`.
 */
export function latestRequestCatalyst(entries: RhythmEntry[]): CatalystRead {
  let best: { atMs: number; read: CatalystRead } | undefined;
  const consider = (atMs: number | undefined, read: CatalystRead) => {
    if (atMs === undefined) return;
    if (!best || atMs >= best.atMs) best = { atMs, read: { ...read, atMs } };
  };
  for (const entry of entries ?? []) {
    if (entry?.type === "custom_message") {
      const customType = typeof entry.customType === "string" ? entry.customType : "";
      const basis = `customType ${customType || "<unnamed>"}`;
      const catalyst: Catalyst = PEER_CUSTOM_TYPES.includes(customType)
        ? "peer"
        : customType === "pi-chat"
          ? "chat"
          : "unknown";
      consider(stampMs(entry), { catalyst, basis });
      continue;
    }
    if (entry?.type === "message" && entry.message?.role === "user") {
      consider(stampMs(entry), classifyCatalystText(entryText(entry)));
    }
  }
  return best ? best.read : { catalyst: "unknown", basis: "no user or custom_message entry on the branch" };
}

export interface ArmDecision {
  action: "warm" | "stop";
  reason: string;
  /** Everything the decision was made from, so the log can be re-judged later. */
  detail: {
    mode: WarmConfig["mode"];
    compacting?: boolean;
    /** What opened the newest request. Only a human-shaped one may arm. See `latestRequestCatalyst`. */
    catalyst?: Catalyst;
    /** What the catalyst was read from, in words - never the message text. */
    catalystBasis?: string;
    /**
     * The other rules all cleared and the catalyst vetoed the warm. This is the number observe mode exists to
     * produce: how often Ed's rule would have mattered, without spending a GPU second to find out.
     */
    catalystVetoed?: boolean;
    medianComputedTokens?: number;
    lastComputedTokens?: number;
    lastCacheHitRate?: number;
    coldSecondsAvoided?: number;
    /** Whether that figure was measured on this session's calls or priced from the fallback table. */
    coldSource?: "observed" | "rate table";
    evidenceCalls: number;
    arrivalsPerHour?: number;
    medianGapMs?: number;
    sinceLastMs?: number;
    /** In observe mode, what the gate would have said. `action` is what actually happened. */
    gateVerdict?: "warm" | "stop";
  };
}

/** Rooter's binding key for a Pi session id. */
export function rooterKey(sessionId: string): string {
  return `h:${sessionId.trim().slice(0, ROOTER_KEY_PREFIX)}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Rooter's event rows, filtered to this session and to the calls that can carry evidence.
 *
 * Non-generation rows (`kind` other than "gen") and rows with no token accounting are dropped: rooter
 * also logs health probes and proxied calls that never touched a prompt, and a median over those reads
 * as a session that never recomputes anything.
 */
export function parseCallEvents(body: unknown, key: string, nowMs: number, cfg: WarmConfig): CallEvidence[] {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { events?: unknown })?.events)
      ? ((body as { events: unknown[] }).events)
      : [];
  const out: CallEvidence[] = [];
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (row.key !== key) continue;
    if (typeof row.kind === "string" && row.kind !== "gen") continue;
    const promptTokens = numberOrUndefined(row.prompt_tokens);
    const computedTokens = numberOrUndefined(row.prompt_tokens_computed);
    if (promptTokens === undefined || computedTokens === undefined) continue;
    const stamp: unknown = typeof row.ts === "string" ? Date.parse(row.ts) : row.ts;
    const atMs = typeof stamp === "number" && Number.isFinite(stamp) ? stamp : undefined;
    if (atMs === undefined) continue;
    if (nowMs - atMs > cfg.evidenceWindowMs) continue;
    out.push({
      atMs,
      backend: typeof row.backend === "string" ? row.backend : undefined,
      model: typeof row.model === "string" ? row.model : undefined,
      promptTokens,
      computedTokens,
      cacheHitRate: numberOrUndefined(row.cache_hit_rate),
      prefillMs: numberOrUndefined(row.prefill_ms),
      aborted: row.aborted === true || numberOrUndefined(row.status) === 499,
    });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Turn arrivals, taken from the user-role messages on the branch.
 *
 * Machine catalysts are already excluded here, which is not what an earlier version of this comment claimed: a
 * team-room wake, a scheduled job, a dream and an auto-resume persist as `custom_message` entries and are not
 * counted as arrivals, while a Chat message and a person typing persist as user-role messages. Measured on this
 * session's own transcript over its last 24 h of activity: 45 `custom_message` injections (22 pulse, 17 wake, 5
 * auto-resume, 3 schedule-run) against 1 user-role arrival. So this rhythm is close to a count of human turns,
 * and it is *not* a count of how often the session is woken - which is why the catalyst of the newest request is
 * a separate question, answered by `latestRequestCatalyst`, and why a session that is busy with peer traffic reads
 * as quiet here. That is the right direction for a warm: the prefix a refresh protects is the one the last request
 * was built on, and if the last request was a peer's one-off question there is nobody coming back to read it.
 */
export function sessionRhythm(entries: RhythmEntry[], nowMs: number, windowMs: number): SessionRhythm {
  const stamps: number[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const at = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(String(entry.timestamp ?? ""));
    if (!Number.isFinite(at)) continue;
    if (nowMs - at > windowMs) continue;
    stamps.push(at);
  }
  stamps.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
  const last = stamps.length > 0 ? stamps[stamps.length - 1] : undefined;
  const hours = Math.max(1 / 60, windowMs / 3_600_000);
  return {
    windowMs,
    arrivals: stamps.length,
    arrivalsPerHour: stamps.length / hours,
    medianGapMs: median(gaps),
    lastArrivalMs: last,
    sinceLastMs: last === undefined ? undefined : Math.max(0, nowMs - last),
  };
}

/**
 * Whether to let Pi send the refresh it has scheduled.
 *
 * `evidence` must be in chronological order (`parseCallEvents` guarantees it) and is the session's own
 * recent generations, not the fleet's.
 */
function gateDecision(
  evidence: CallEvidence[],
  rhythm: SessionRhythm,
  cfg: WarmConfig,
  piAction: "warm" | "stop",
  session: { compacting: boolean; catalyst?: CatalystRead },
): ArmDecision {
  const recent = evidence.slice(-cfg.evidenceCalls);
  const detail: ArmDecision["detail"] = {
    mode: cfg.mode,
    compacting: session.compacting,
    catalyst: session.catalyst?.catalyst ?? "unknown",
    catalystBasis: session.catalyst?.basis ?? "not supplied to the gate",
    evidenceCalls: recent.length,
    arrivalsPerHour: Math.round(rhythm.arrivalsPerHour * 100) / 100,
    medianGapMs: rhythm.medianGapMs === undefined ? undefined : Math.round(rhythm.medianGapMs / 100) * 100,
    sinceLastMs: rhythm.sinceLastMs === undefined ? undefined : Math.round(rhythm.sinceLastMs / 100) * 100,
  };
  const stop = (reason: string): ArmDecision => ({ action: "stop", reason, detail });
  // Pi's own economics are kept visible even when they are not what we act on, because the difference between
  // "Pi said stop" and "we said stop for a measured reason" is the whole point of the log.
  const base = `pi said ${piAction}`;

  // A refresh mid-summarisation replays the pre-compaction prompt against a box the summarisation is already
  // queued on, and Pi's `cacheReplayable` guard does not catch it because the replay request is still identical
  // to the last one it sent. idle-compaction vetoes the same thing; it is stated here as well so the veto does
  // not depend on which of the two extensions Pi happened to load first.
  if (session.compacting) {
    return stop(`${base}; a summarisation is in flight, so a refresh would replay the pre-compaction prompt onto a busy box`);
  }

  // Checked before the recompute evidence, because it is the sharper of the two questions. A warm protects the
  // entry until the next call arrives; a session that has already been silent for longer than the interval a
  // warm runs on has nothing left to protect.
  if (rhythm.sinceLastMs !== undefined && rhythm.sinceLastMs > cfg.maxIdleMs) {
    return stop(
      `${base}; nothing has arrived for ${Math.round(rhythm.sinceLastMs / 60000)}m, longer than the ${Math.round(cfg.maxIdleMs / 60000)}m a refresh would have to cover`,
    );
  }
  if (recent.length === 0) {
    return stop(`${base}; no rooter call rows for this session in the last ${Math.round(cfg.evidenceWindowMs / 60000)}m`);
  }

  const last = recent[recent.length - 1] as CallEvidence;
  const medians = median(recent.map((row) => row.computedTokens)) as number;
  detail.medianComputedTokens = Math.round(medians);
  detail.lastComputedTokens = last.computedTokens;
  detail.lastCacheHitRate = last.cacheHitRate;

  // The observed cost beats the rate table: rooter times the prefill of every call it proxies, so a session that
  // has already paid for a cold recompute in this window has stated its own price.
  const observed = median(
    recent.filter((row) => row.computedTokens >= COLD_OBSERVED_MIN_TOKENS && row.prefillMs !== undefined).map((row) => row.prefillMs as number),
  );
  let coldSec: number | undefined;
  if (observed !== undefined) {
    coldSec = Math.round(observed / 1000);
    detail.coldSource = "observed";
  } else {
    coldSec = coldSeconds(medians, last.backend);
    if (coldSec !== undefined) detail.coldSource = "rate table";
  }
  if (coldSec !== undefined) detail.coldSecondsAvoided = coldSec;

  // The two figures mean different things and must not read alike: an observed cost is time this session already
  // paid, a priced cost is what its cold calls would cost on that box.
  const costNote =
    coldSec === undefined
      ? ""
      : detail.coldSource === "observed"
        ? ` (${coldSec}s of ${last.backend ?? "box"} prefill this session already paid in this window)`
        : ` (${coldSec}s at ${last.backend ?? "box"}'s measured ${COLD_PREFILL_TOK_S[last.backend ?? ""] ?? "?"} tok/s)`;

  const hitText = last.cacheHitRate === undefined ? "no hit rate" : `${Math.floor(last.cacheHitRate * 100)}% cache read`;
  if (last.cacheHitRate !== undefined && last.cacheHitRate >= cfg.vetoCacheHitRate) {
    return stop(`${base}; the last call was ${hitText} on ${last.promptTokens} prompt tokens, so the prefix is resident and a refresh saves nothing`);
  }
  if (medians < cfg.minRecomputeTokens) {
    return stop(`${base}; median recompute ${Math.round(medians)} tokens over ${recent.length} calls is under the ${cfg.minRecomputeTokens} floor${costNote}`);
  }
  if (rhythm.arrivalsPerHour < cfg.minArrivalsPerHour) {
    return stop(
      `${base}; ${rhythm.arrivalsPerHour.toFixed(2)} arrivals/h is under the ${cfg.minArrivalsPerHour}/h bar (this session woke and is unlikely to return again inside the re-arm interval)`,
    );
  }
  // Last, because it is the summary of everything above: a refresh replays the session's whole prompt, and a
  // saving this small does not pay for it. An unknown price does not trip the bar, since absence of a rate is not
  // evidence of a cheap warm - it is evidence of an unpriced box.
  if (coldSec !== undefined && coldSec < cfg.minSavedSeconds) {
    return stop(`${base}; a refresh avoids only${costNote}, under the ${cfg.minSavedSeconds}s a replay of ${last.promptTokens} prompt tokens is worth`);
  }

  const cold = coldSec === undefined ? "" : ` a refresh avoids${costNote}`;
  // The last gate, and a precondition on the *override* only: everything above can arm a warm on evidence, and
  // this is the one question evidence cannot answer - whether a person is the reason the prefix exists. It runs
  // after the evidence rules so that a vetoed decision still records what the evidence said, and so observe mode
  // can count how often this rule alone would have stopped a spend.
  if (!isHumanCatalyst(detail.catalyst)) {
    detail.catalystVetoed = true;
    const avoid = coldSec === undefined ? "" : ` (the other rules cleared, and a refresh would have avoided${costNote})`;
    return stop(
      `${base}; the turn that opened this run was a ${detail.catalyst} catalyst (${detail.catalystBasis ?? "unnamed"}), not a human coming back, so the prefix it was built on is left to expire${avoid}`,
    );
  }
  return {
    action: "warm",
    reason: `${base}; median recompute ${Math.round(medians)} tokens over ${recent.length} calls, ${rhythm.arrivalsPerHour.toFixed(2)} arrivals/h, catalyst ${detail.catalyst}${cold}`,
    detail,
  };
}

/**
 * What to tell Pi. In "arm" mode the gate's answer is the answer. In "observe" mode the gate still runs and its
 * verdict is recorded, but the action is stop: a `stop` sends no request, so measuring what the gate would have
 * armed costs the fleet nothing, and that is the order the fleet should do these things in.
 */
export function armDecision(
  evidence: CallEvidence[],
  rhythm: SessionRhythm,
  cfg: WarmConfig,
  piAction: "warm" | "stop",
  session: { compacting: boolean; catalyst?: CatalystRead } = { compacting: false },
): ArmDecision {
  const gate = gateDecision(evidence, rhythm, cfg, piAction, session);
  if (cfg.mode === "arm") return gate;
  return {
    action: "stop",
    reason: `observe mode sends nothing; the gate would have said ${gate.action}: ${gate.reason}`,
    detail: { ...gate.detail, gateVerdict: gate.action },
  };
}
