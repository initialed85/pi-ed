/**
 * Auto-resume
 *
 * A resumed session does not know what it was doing.
 *
 * `pi -c` hands the agent a transcript and a prompt box. Nothing in that says whether the session
 * stopped with work in flight or with nothing left to do, so a resumed session guesses — usually by
 * re-running the last visible step, which is the step that already happened. "Continue the unfinished
 * task from the latest verified state" is the most repeated sentence in this fleet, and it is a human
 * typing it by hand every morning.
 *
 * This writes one line on each side of the gap:
 *
 *   On the way out — a run started, a run settled, the process quit while idle or mid-task — as quiet
 *   session entries, so a crash, a killed tmux window, or a node that lost power mid-tool-call is still
 *   readable from the session file.
 *
 *   On the way in — the last recorded state, what the model was doing, when it stopped — as a custom
 *   message the model reads before it acts, with instructions to continue only if the work is genuinely
 *   unfinished.
 *
 * `session_start.reason` alone cannot tell a resumed session from a fresh one: `pi -c` arrives as
 * "startup" and only `/resume` arrives as "resume". The session's own entries are the reliable signal —
 * a fresh session has no actions in it and a continued one has a transcript. Both are checked.
 *
 * Commands:
 *   /auto-resume                     toggle on or off for this repository (off until you say on)
 *   /auto-resume on | off | status | why | fire
 *   /auto-resume max-age <dur|off>   leave a resume alone if the last activity is older than this
 *   /auto-resume skip-idle on|off    drop the turn when the record already says the session was idle
 *
 * Flags:
 *   --auto-resume-off                do not arm a resumed session in this Pi instance
 *
 * Environment:
 *   AUTO_RESUME_OFF=1                same as the flag
 *   AUTO_RESUME_MAX_AGE=24h          cap the age of a resume worth re-arming (0 = no cap)
 *   AUTO_RESUME_SKIP_IDLE=1          do not spend a turn on a session that was idle when it stopped
 *   AUTO_RESUME_STATE_FILE=<path>    move the settings file (relative to the repository root)
 *   AUTO_RESUME_DEBUG=<path>         append every decision, including the ones that inject nothing
 *
 * Scope: sessions with a UI. Print and JSON modes never inject — their prompt comes from the command
 * line. Settings live in .pi/auto-resume.json; the evidence lives in the session file itself.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import {
  CONFIG_DIR_NAME,
  type CustomEntry,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/** The quiet evidence entries this extension appends to the session. */
const ENTRY_TYPE = "auto-resume";
/** The custom message this extension injects on a resume. */
const PROMPT_TYPE = "auto-resume-prompt";
const STATUS_KEY = "auto-resume";
const STATE_VERSION = 1;
const SNIPPET_LIMIT = 200;
const ARGS_LIMIT = 90;

type MarkerOp = "start" | "settled" | "quit";

/** One line of session memory: what the session was doing at that moment. */
export interface MarkerData {
  v: number;
  op: MarkerOp;
  /** Epoch ms. The entry carries a timestamp too; this keeps the payload readable on its own. */
  at: number;
  /** quit: whether the agent was waiting for input when the process stopped. */
  idle?: boolean;
  /** quit: why the session stopped ("quit", "reload", "new", "resume", "fork"). */
  reason?: string;
  /** settled: the run was interrupted rather than completed. */
  aborted?: boolean;
  /** settled: how many tool calls the run made, and how the last one ended. */
  tools?: number;
  lastTool?: string;
  lastToolFailed?: boolean;
}

export interface Config {
  v: number;
  enabled: boolean;
  /** Leave a resume alone when its last activity is older than this. 0 means no cap. */
  maxAgeMs: number;
  /** Skip the injection when the record already says the session was idle. */
  skipIdle: boolean;
}

const DEFAULT_CONFIG: Config = { v: STATE_VERSION, enabled: false, maxAgeMs: 0, skipIdle: false };

/* ------------------------------------------------------------------ settings file */

function configPath(ctx: ExtensionContext): string {
  const override = process.env.AUTO_RESUME_STATE_FILE?.trim();
  if (override) return override.startsWith("/") ? override : join(ctx.cwd, override);
  return join(ctx.cwd, CONFIG_DIR_NAME, "auto-resume.json");
}

function writeConfig(ctx: ExtensionContext, cfg: Config): string {
  const path = configPath(ctx);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return path;
}

function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readConfig(ctx: ExtensionContext): Config {
  const cfg: Config = { ...DEFAULT_CONFIG };
  const path = configPath(ctx);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
      if (typeof parsed.enabled === "boolean") cfg.enabled = parsed.enabled;
      if (typeof parsed.maxAgeMs === "number" && Number.isFinite(parsed.maxAgeMs)) cfg.maxAgeMs = Math.max(0, parsed.maxAgeMs);
      if (typeof parsed.skipIdle === "boolean") cfg.skipIdle = parsed.skipIdle;
    } catch {
      // A settings file we cannot read leaves the feature off rather than guessing.
    }
  }
  const age = process.env.AUTO_RESUME_MAX_AGE?.trim();
  if (age) {
    const parsed = parseDuration(age);
    if (parsed) cfg.maxAgeMs = parsed.ms;
  }
  if (envFlag("AUTO_RESUME_SKIP_IDLE")) cfg.skipIdle = true;
  return cfg;
}

function debugLog(ctx: ExtensionContext | undefined, line: string): void {
  const path = process.env.AUTO_RESUME_DEBUG?.trim();
  if (!path) return;
  try {
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Diagnostics are allowed to fail silently.
  }
}

/**
 * What a headless run would have read. Print and JSON mode never inject — their prompt already came
 * from the command line — but this is the only place that can show how a real resumed session looks
 * from the inside, which is the assumption the whole extension rests on. Reading is not injecting.
 */
function logHeadlessRead(ctx: ExtensionContext, reason: string): void {
  const tail = describeTail(ctx.sessionManager.getBranch());
  const read = tail ? `${tail.from} at ${new Date(tail.at).toISOString()}, pending=${tail.pending} failed=${tail.failed}` : "nothing readable";
  debugLog(ctx, `skipped reason=${reason}: no session UI in ${ctx.mode ?? "headless"} mode. would have read: ${read}`);
}

/* ------------------------------------------------------------------ time and durations */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(input: string): { ms: number; text: string } | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const minutes = Number(trimmed);
    return minutes > 0 ? { ms: minutes * UNIT_MS.m!, text: `${minutes}m` } : undefined;
  }
  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(secs?|seconds?|s|mins?|minutes?|m|hrs?|hours?|h|days?|d|weeks?|w)/g)];
  let consumed = 0;
  let ms = 0;
  const parts: string[] = [];
  for (const match of matches) {
    const [whole, digits, unit] = match;
    const key = unit[0]!;
    ms += Number(digits) * UNIT_MS[key]!;
    parts.push(`${Number(digits)}${key}`);
    consumed += whole.length;
  }
  if (ms <= 0) return undefined;
  // Reject "2h of chaos": the whole argument has to be durations.
  if (trimmed.replace(/\s+/g, "").length > consumed + 1) return undefined;
  return { ms, text: parts.join(" ") };
}

export function humanAge(ms: number): string {
  const age = Math.max(0, ms);
  if (age < 60_000) return `${Math.max(1, Math.round(age / 1000))}s`;
  const minutes = Math.round(age / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return hrs ? `${days}d ${hrs}h` : `${days}d`;
}

function sessionZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function wallClock(ms: number, zone: string): string {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short" }).format(ms);
  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(ms);
  return `${weekday} ${stamp} ${zone}`;
}

/** Print mode (-p) and JSON mode have no UI, and their prompt already came from the command line. */
function hasSessionUI(ctx: ExtensionContext): boolean {
  if (typeof ctx.hasUI === "boolean") return ctx.hasUI;
  const mode = (ctx as { mode?: string }).mode;
  return mode !== "print" && mode !== "json";
}

/* ------------------------------------------------------------------ reading the session back */

const isMarker = (entry: SessionEntry): MarkerData | undefined => {
  if (entry.type !== "custom") return undefined;
  const custom = entry as CustomEntry;
  if (custom.customType !== ENTRY_TYPE) return undefined;
  const data = custom.data as MarkerData | undefined;
  if (!data || typeof data !== "object" || data.v !== STATE_VERSION || typeof data.op !== "string") return undefined;
  return data;
};

const entryTime = (entry: SessionEntry | undefined): number => {
  if (!entry) return 0;
  const parsed = Date.parse(String((entry as { timestamp?: string }).timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Entries that say something about work: model turns, tool results, prompts, extensions' own asides. */
const isAction = (entry: SessionEntry): boolean =>
  entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";

interface ToolNote {
  name: string;
  args: string;
}

export interface ActionTail {
  at: number;
  /** Which side of the conversation the last recorded action came from. */
  from: "model" | "tool" | "you" | "extension" | "summary" | "unknown";
  /** One line describing that action. */
  line: string;
  /** The last visible words, when there were any worth quoting. */
  words?: string;
  toolCalls: ToolNote[];
  /** Something was asked for and its follow-up was never recorded. */
  pending: boolean;
  failed: boolean;
  /** An Escape-interrupted run: the human stopped it on purpose. */
  interrupted: boolean;
  /** The last action was this extension's own resume prompt. */
  ownPrompt: boolean;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function argHint(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "query", "prompt", "text", "id", "action"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value, ARGS_LIMIT);
  }
  const json = JSON.stringify(record);
  return json === "{}" ? "" : clip(json, ARGS_LIMIT);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
      const text = (item as { text?: string }).text;
      if (text) chunks.push(text);
    }
  }
  return chunks.join(" ");
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((item) => item && typeof item === "object" && (item as { type?: string }).type === "image").length;
}

/** What the last recorded action in the transcript says about where the session left off. */
export function describeTail(entries: SessionEntry[]): ActionTail | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (!isAction(entry)) continue;
    const at = entryTime(entry);

    if (entry.type === "branch_summary") {
      return { at, from: "summary", line: "the context was compacted and no turn followed it", toolCalls: [], pending: false, failed: false, interrupted: false, ownPrompt: false };
    }

    if (entry.type === "custom_message") {
      const custom = entry as { customType?: string; content?: unknown };
      const own = custom.customType === PROMPT_TYPE;
      return {
        at,
        from: "extension",
        line: own
          ? "a resume prompt was already injected here and nothing happened after it"
          : `another extension (${custom.customType ?? "unknown"}) left a message here and no turn followed it`,
        words: clip(contentText(custom.content), SNIPPET_LIMIT) || undefined,
        toolCalls: [],
        pending: false,
        failed: false,
        interrupted: false,
        ownPrompt: own,
      };
    }

    const message = (entry as SessionMessageEntry).message;
    if (!message || typeof message !== "object") continue;
    const role = String((message as { role?: string }).role ?? "");

    if (role === "assistant") {
      const assistant = message as {
        content?: unknown[];
        stopReason?: string;
        errorMessage?: string;
        model?: string;
        usage?: { stopReason?: string };
      };
      const calls: ToolNote[] = (assistant.content ?? [])
        .filter((item) => item && typeof item === "object" && (item as { type?: string }).type === "toolCall")
        .map((item) => {
          const call = item as { name?: string; arguments?: unknown };
          return { name: String(call.name ?? "?"), args: argHint(call.arguments) };
        });
      const stop = assistant.stopReason ?? assistant.usage?.stopReason;
      const images = imageCount(assistant.content);
      const toolHint = calls.length
        ? `, asking for ${calls.map((call) => `\`${call.name}\`${call.args ? ` ${call.args}` : ""}`).join(", ")}`
        : "";
      const imageHint = images ? ` and ${images} image${images === 1 ? "" : "s"}` : "";
      let line = `the model's turn (${assistant.model ?? "unknown model"}) ended with stopReason ${stop ?? "unknown"}${toolHint}${imageHint}`;
      if (stop === "toolUse" && calls.length) line = `${line}, and no result for those tool calls was recorded`;
      if (stop === "length") line = `${line} mid-output: the turn was truncated by the token limit`;
      if (stop === "error") line = `the model's turn failed${assistant.errorMessage ? `: ${clip(assistant.errorMessage, 140)}` : ""}`;
      if (stop === "aborted") line = "the run was interrupted with Escape";
      return {
        at,
        from: "model",
        line,
        words: clip(contentText(assistant.content), SNIPPET_LIMIT) || undefined,
        toolCalls: calls,
        pending: stop === "toolUse" && calls.length > 0,
        failed: stop === "error",
        interrupted: stop === "aborted",
        ownPrompt: false,
      };
    }

    if (role === "toolResult") {
      const tool = message as { toolName?: string; isError?: boolean; content?: unknown };
      return {
        at,
        from: "tool",
        line: `the tool \`${tool.toolName ?? "?"}\` ${tool.isError ? "failed" : "returned"} and no model turn followed it`,
        words: tool.isError ? clip(contentText(tool.content), SNIPPET_LIMIT) || undefined : undefined,
        toolCalls: [],
        pending: true,
        failed: Boolean(tool.isError),
        interrupted: false,
        ownPrompt: false,
      };
    }

    if (role === "user" || role === "bashExecution") {
      return {
        at,
        from: "you",
        line: role === "user" ? "you sent a prompt and no turn answered it" : "a `!` bash command ran and no turn followed it",
        words: clip(contentText((message as { content?: unknown }).content), SNIPPET_LIMIT) || undefined,
        toolCalls: [],
        // An unanswered prompt is unfinished work: the follow-up turn is the missing piece.
        pending: true,
        failed: false,
        interrupted: false,
        ownPrompt: false,
      };
    }

    return { at, from: "unknown", line: `the last entry in the transcript was a \`${role || "unknown"}\` message`, toolCalls: [], pending: false, failed: false, interrupted: false, ownPrompt: false };
  }

  return undefined;
}

/* ------------------------------------------------------------------ what the record says */

export interface Facts {
  /** Inject nothing, and the reason. status and why show it so a silent no-op is explainable. */
  eligible: boolean;
  skipReason?: string;
  startReason: string;
  lastAt: number;
  ago: string;
  wall: string;
  action?: ActionTail;
  marker?: MarkerData;
  /** A sentence about the last recorded state, from this extension's own entries. */
  recorded?: string;
  state: string;
  source: "recorded" | "inferred" | "unknown";
  /** Whether the record says work was in flight. */
  working: boolean;
  interrupted: boolean;
  failed: boolean;
  stale: boolean;
  ageCap: string;
}

export function markerSentence(marker: MarkerData): string {
  if (marker.op === "start") return "a run started and never finished";
  if (marker.op === "settled") {
    const tools = `${marker.tools ?? 0} tool call${marker.tools === 1 ? "" : "s"}`;
    if (marker.aborted) return `a run was interrupted with Escape after ${tools}`;
    const last = marker.lastTool ? `, the last one (\`${marker.lastTool}\`) ${marker.lastToolFailed ? "failed" : "returned"}` : "";
    return `a run settled after ${tools}${last}`;
  }
  if (marker.op === "quit") {
    const why = marker.reason ? ` (${marker.reason})` : "";
    return marker.idle ? `the process stopped while the session was waiting for input${why}` : `the process stopped while a run was still going${why}`;
  }
  return "an unrecognised marker";
}

/**
 * The judgement a resume is made from. Recorded evidence beats inferred evidence, but only when the
 * recording is not older than the transcript behind it: a marker written three turns ago says nothing
 * about a prompt you typed after it.
 */
export function decideFacts(entries: SessionEntry[], startReason: string, cfg: Config, now: number): Facts {
  const zone = sessionZone();
  const markers = entries.map((entry) => isMarker(entry)).filter((data): data is MarkerData => data !== undefined);
  const lastMarker = markers[markers.length - 1];
  const action = describeTail(entries);
  const lastAt = Math.max(lastMarker?.at ?? 0, action?.at ?? 0, entryTime(entries[entries.length - 1]));
  const ago = humanAge(now - lastAt);
  const wall = lastAt ? wallClock(lastAt, zone) : "unknown time";
  const ageCap = cfg.maxAgeMs > 0 ? humanAge(cfg.maxAgeMs) : "off";
  const stale = cfg.maxAgeMs > 0 && now - lastAt > cfg.maxAgeMs;

  const base: Facts = {
    eligible: false,
    startReason,
    lastAt,
    ago,
    wall,
    action,
    marker: lastMarker,
    state: "unknown",
    source: "unknown",
    working: false,
    interrupted: false,
    failed: false,
    stale,
    ageCap,
  };

  // A fresh, forked or reloaded session has nothing that stopped mid-flight.
  if (startReason !== "startup" && startReason !== "resume") {
    return { ...base, skipReason: `this session started with reason \`${startReason}\`, which is not a stopped session coming back` };
  }
  if (action?.ownPrompt) {
    return { ...base, skipReason: "the last thing in this session was already a resume prompt, so a second one would be noise" };
  }
  if (!action && !lastMarker) {
    return { ...base, skipReason: "this session has no activity recorded in it yet" };
  }

  // A marker only says something if nothing happened after it. A reload writes a quit note, the user
  // keeps working, and the next crash has to be read from the transcript, not from that old note.
  const markerIsCurrent = lastMarker !== undefined && lastMarker.at >= (action?.at ?? 0);
  let state = "unknown";
  let source: Facts["source"] = "inferred";
  let working = false;
  let interrupted = false;
  let failed = false;
  let recorded: string | undefined;

  if (markerIsCurrent && lastMarker && lastMarker.op === "quit") {
    // The session wrote its own exit note: the honest answer about what it was doing when it stopped.
    recorded = markerSentence(lastMarker);
    state = lastMarker.idle ? "idle when it stopped" : "mid-task when it stopped";
    working = !lastMarker.idle;
    source = "recorded";
  } else if (markerIsCurrent && lastMarker) {
    recorded = markerSentence(lastMarker);
    source = "recorded";
    if (lastMarker.op === "start") {
      // Started, never settled: killed mid-run, or died in a tool call. The case a resume cannot see.
      state = "mid-task: a run started and never settled";
      working = true;
    } else {
      state = lastMarker.aborted ? "interrupted with Escape" : "settled, which normally means the turn finished";
      working = Boolean(lastMarker.lastToolFailed);
      interrupted = Boolean(lastMarker.aborted);
      failed = Boolean(lastMarker.lastToolFailed);
    }
  } else if (action) {
    // No usable marker: read the tail of the transcript instead.
    state = action.pending
      ? "mid-task: the last action never got its follow-up turn"
      : action.interrupted
        ? "interrupted with Escape"
        : action.failed
          ? "stopped on a failure"
          : action.from === "model"
            ? "finished its last turn"
            : `the last thing in it was ${action.from}`;
    working = action.pending || action.failed;
    interrupted = action.interrupted;
    failed = action.failed;
    source = "inferred";
  } else {
    return { ...base, skipReason: "the session has no readable activity to judge" };
  }

  return { ...base, eligible: true, recorded, state, source, working, interrupted, failed };
}

/* ------------------------------------------------------------------ the message the model reads */

function factLines(facts: Facts): string[] {
  return [
    `- Stopped ${facts.ago} ago (${facts.wall}).`,
    facts.recorded ? `- Last state this session recorded: ${facts.recorded}.` : "",
    facts.action ? `- Last entry in the transcript: ${facts.action.line}.` : "",
    facts.action?.words ? `- Last words on screen: \`${facts.action.words}\`` : "",
    `- Judgement: ${facts.state}, from ${facts.source === "recorded" ? "this session's own markers" : "the transcript tail"}.`,
  ].filter((line) => line !== "");
}

export function promptText(facts: Facts): string {
  return [
    "(auto-resume) This session stopped and was resumed. Its own record says:",
    ...factLines(facts),
    "",
    "Respond in this order:",
    "1. Unfinished work — mid-task, an action that never got its follow-up, a failure, or a prompt with no answer: continue it now from the latest verified state. Do not redo steps the transcript already shows succeeded.",
    "2. Finished, idle, or waiting on a question for the user: say one short line and do nothing else. No new work, no verification pass, no while-I-am-here improvements.",
    facts.interrupted
      ? "3. The last run was interrupted with Escape. That is the human stopping it on purpose: resume only if the transcript shows they asked to continue."
      : "3. An interrupted run (Escape) is the human stopping it on purpose. Do not resume one unless the transcript shows they asked to continue.",
    "4. If the record cannot tell you, ask one short question instead of guessing.",
  ].join("\n");
}

function usage(): string {
  return [
    "Usage:",
    "  /auto-resume                       toggle on or off for this repository",
    "  /auto-resume on | off | status | why | fire",
    "  /auto-resume max-age <duration|off> leave a resume alone if the last activity is older than this (2h, 45m, 1d)",
    "  /auto-resume skip-idle on|off       drop the turn when the record already says the session was idle",
  ].join("\n");
}

/** The one-line footer while the extension is on. */
function statusLine(facts: Facts | undefined): string {
  if (!facts) return "⏻ auto-resume on";
  if (!facts.eligible) return `⏻ auto-resume · nothing to continue (${facts.skipReason?.length && facts.skipReason.length < 40 ? facts.skipReason : "see /auto-resume why"})`;
  if (facts.stale) return `⏻ auto-resume · left alone, last activity ${facts.ago} ago (cap ${facts.ageCap})`;
  return facts.working ? `⏻ auto-resume · mid-task ${facts.ago} ago` : `⏻ auto-resume · ${facts.state} ${facts.ago} ago`;
}



/* ------------------------------------------------------------------ registration */

export default function (api: ExtensionAPI): void {
  let cfg: Config = { ...DEFAULT_CONFIG };
  let cfgFile = join(CONFIG_DIR_NAME, "auto-resume.json");
  let facts: Facts | undefined;
  /** The run in flight, so a settled marker can say how many tools it used and how the last ended. */
  let run: { tools: number; lastTool?: string; lastToolFailed: boolean } | undefined;

  const load = (ctx: ExtensionContext): Config => {
    cfg = readConfig(ctx);
    cfgFile = configPath(ctx);
    return cfg;
  };

  const showStatus = (ctx: ExtensionContext, line: string | undefined): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, line);
  };

  const off = (ctx: ExtensionContext): void => {
    facts = undefined;
    run = undefined;
    showStatus(ctx, undefined);
  };

  const record = (data: MarkerData): void => {
    try {
      api.appendEntry(ENTRY_TYPE, data);
    } catch {
      // A session that will not take an entry is not worth breaking over.
    }
  };

  const inject = (ctx: ExtensionContext, why: string): void => {
    if (!facts) return;
    const message = {
      customType: PROMPT_TYPE,
      content: promptText(facts),
      // Displayed, because a model deciding to "continue" without showing you why it thought the work
      // was unfinished is worse than a few extra dim lines in the transcript.
      display: true,
      details: { state: facts.state, source: facts.source, ago: facts.ago, wall: facts.wall, why },
    };
    try {
      void api.sendMessage(message, { triggerTurn: true });
    } catch (error) {
      const why2 = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`auto-resume could not hand the session back to the model: ${why2}`, "error");
      debugLog(ctx, `inject failed ${why2}`);
      return;
    }
    showStatus(ctx, statusLine(facts));
    debugLog(ctx, `injected why="${why}" reason=${facts.startReason} state="${facts.state}" source=${facts.source} ago=${facts.ago}`);
  };

  api.registerFlag("auto-resume-off", {
    description: "Do not re-arm a resumed session in this Pi instance",
    type: "boolean",
    default: false,
  });

  api.registerCommand("auto-resume", {
    description: "Hand a resumed session its own last known state",
    getArgumentCompletions: (argumentPrefix: string) => {
      const words = ["on", "off", "status", "why", "fire", "max-age", "skip-idle"];
      const head = (argumentPrefix ?? "").trim().split(/\s+/)[0] ?? "";
      const matches = head ? words.filter((word) => word.startsWith(head)) : words;
      return matches.length ? matches.map((word) => ({ value: word, label: word })) : null;
    },
    handler: async (raw: string, ctx: ExtensionCommandContext) => {
      load(ctx);
      const [verb, ...rest] = (raw ?? "").trim().split(/\s+/);

      const save = (note: string, level: "info" | "warning" = "info"): void => {
        const path = writeConfig(ctx, cfg);
        cfgFile = path;
        showStatus(ctx, cfg.enabled ? statusLine(facts) : undefined);
        ctx.ui.notify(`${note}\nsettings: ${path}`, level);
      };

      if (!verb) {
        cfg = { ...cfg, enabled: !cfg.enabled };
        save(
          `auto-resume ${cfg.enabled ? "on" : "off"} for ${ctx.cwd}\n${
            cfg.enabled
              ? "a session that stopped mid-task will be re-armed with its last recorded state"
              : "resumed sessions start quiet"
          }`,
          cfg.enabled ? "info" : "warning",
        );
        return;
      }

      switch (verb) {
        case "on":
        case "off": {
          cfg = { ...cfg, enabled: verb === "on" };
          if (!cfg.enabled) off(ctx);
          save(`auto-resume ${verb} for ${ctx.cwd}`, verb === "on" ? "info" : "warning");
          return;
        }
        case "max-age": {
          const arg = rest[0] ?? "";
          if (!arg || arg === "off" || arg === "none" || arg === "0") {
            cfg = { ...cfg, maxAgeMs: 0 };
            save("auto-resume will re-arm a resumed session however long it has been sitting");
            return;
          }
          const parsed = parseDuration(arg);
          if (!parsed) {
            ctx.ui.notify(`${usage()}\n\nmax-age wants 2h, 45m, 1d or off, not \`${arg}\``, "error");
            return;
          }
          cfg = { ...cfg, maxAgeMs: parsed.ms };
          save(`auto-resume will leave a resumed session alone if its last activity is older than ${parsed.text}`);
          return;
        }
        case "skip-idle": {
          const arg = (rest[0] ?? "").toLowerCase();
          cfg = { ...cfg, skipIdle: arg === "on" ? true : arg === "off" ? false : !cfg.skipIdle };
          save(
            cfg.skipIdle
              ? "auto-resume will drop the turn when the record says the session was already idle"
              : "auto-resume will still hand an idle session to the model to decide",
          );
          return;
        }
        case "status":
        case "why": {
          if (!ctx.hasUI) {
            ctx.ui.notify("auto-resume status needs a UI", "warning");
            return;
          }
          if (!facts) {
            ctx.ui.notify(`auto-resume ${cfg.enabled ? "on" : "off"} (${cfgFile})\nnothing has been read from this session yet`, "info");
            return;
          }
          const lines = [
            `auto-resume ${cfg.enabled ? "on" : "off"} (${cfgFile})`,
            `this session started with reason \`${facts.startReason}\``,
            facts.recorded ? `recorded: ${facts.recorded}` : "recorded: no markers in this session",
            facts.action ? `last entry: ${facts.action.line}` : "last entry: nothing readable",
            facts.action?.words ? `last words: ${facts.action.words}` : "",
            `judgement: ${facts.state} (${facts.source}) · stopped ${facts.ago} ago at ${facts.wall}`,
            `max age: ${facts.ageCap} · skip idle: ${cfg.skipIdle ? "on" : "off"}`,
            facts.eligible
              ? !facts.working && cfg.skipIdle
                ? "would not inject: skip-idle is on and the session looks idle"
                : facts.stale
                  ? `would not inject: older than ${facts.ageCap}`
                  : "would inject: the continue-or-nothing call is the model's"
              : `would not inject: ${facts.skipReason ?? "unknown reason"}`,
          ];
          ctx.ui.setWidget(STATUS_KEY, (_tui, theme) => new Text(lines.map((line) => (line ? theme.fg("dim", line) : "")).join("\n"), 3, 0));
          return;
        }
        case "fire": {
          if (!facts) {
            ctx.ui.notify("nothing has been read from this session yet, so there is no state to hand over", "warning");
            return;
          }
          if (!facts.eligible) ctx.ui.notify(`would have skipped this: ${facts.skipReason ?? "unknown reason"}\ninjected anyway because you asked`, "warning");
          inject(ctx, "you asked for it");
          return;
        }
        default:
          ctx.ui.notify(usage(), "error");
          return;
      }
    },
  });

  api.on("session_start", (event, ctx) => {
    load(ctx);
    run = undefined;
    facts = undefined;

    // Diagnostics first, in the one place that sees every start, so a silent no-op is still explainable.
    const forcedOff = envFlag("AUTO_RESUME_OFF") || api.getFlag("auto-resume-off") === true;

    if (!hasSessionUI(ctx)) {
      logHeadlessRead(ctx, event.reason);
      return;
    }
    if (!cfg.enabled) {
      debugLog(ctx, `skipped reason=${event.reason}: auto-resume is off (${cfgFile})`);
      off(ctx);
      return;
    }
    if (forcedOff) {
      debugLog(ctx, `skipped reason=${event.reason}: --auto-resume-off`);
      ctx.ui.notify("auto-resume is off for this invocation (--auto-resume-off)", "info");
      off(ctx);
      return;
    }

    facts = decideFacts(ctx.sessionManager.getBranch(), event.reason, cfg, Date.now());
    showStatus(ctx, statusLine(facts));
    if (!facts.eligible) {
      debugLog(ctx, `skipped reason=${event.reason}: ${facts.skipReason ?? "unknown"}`);
      return;
    }
    if (facts.stale) {
      debugLog(ctx, `skipped reason=${event.reason}: last activity ${facts.ago} ago, cap ${facts.ageCap}`);
      ctx.ui.notify(`auto-resume left this session alone: its last activity is ${facts.ago} old (cap ${facts.ageCap})`, "info");
      return;
    }
    if (!facts.working && cfg.skipIdle) {
      debugLog(ctx, `skipped reason=${event.reason}: ${facts.state}`);
      ctx.ui.notify(`auto-resume left this session alone: ${facts.state}`, "info");
      return;
    }

    inject(ctx, "the session was resumed");
  });

  /* The evidence, written while the session runs. */

  api.on("agent_start", (_event, ctx) => {
    if (!cfg.enabled || !hasSessionUI(ctx)) return;
    run = { tools: 0, lastToolFailed: false };
    record({ v: STATE_VERSION, op: "start", at: Date.now() });
  });

  api.on("tool_result", (event, _ctx) => {
    if (!run) return;
    run.tools += 1;
    run.lastTool = event.toolName;
    run.lastToolFailed = Boolean(event.isError);
  });

  api.on("agent_settled", (event, ctx) => {
    if (!cfg.enabled || !hasSessionUI(ctx) || !run) return;
    record({
      v: STATE_VERSION,
      op: "settled",
      at: Date.now(),
      aborted: event.aborted,
      tools: run.tools,
      lastTool: run.lastTool,
      lastToolFailed: run.lastToolFailed,
    });
    run = undefined;
    // Whatever this session was doing, it is no longer doing it: the next resume judges from the marker.
    if (facts) facts = { ...facts, working: false, eligible: facts.eligible };
    showStatus(ctx, statusLine(facts));
  });

  api.on("session_shutdown", (event, ctx) => {
    if (!cfg.enabled || !hasSessionUI(ctx)) return;
    // The one fact a later resume cannot reconstruct on its own: was the agent working or waiting?
    record({ v: STATE_VERSION, op: "quit", at: Date.now(), idle: ctx.isIdle(), reason: event.reason });
    run = undefined;
  });

  api.registerMessageRenderer<{ state?: string; source?: string; ago?: string; wall?: string; why?: string }>(
    PROMPT_TYPE,
    (message, options, theme) => {
      const details = message.details ?? {};
      const body = typeof message.content === "string" ? message.content : contentText(message.content);
      const head = theme.fg("accent", `⏻ auto-resume${details.ago ? ` · ${details.ago} ago` : ""}${details.state ? ` · ${details.state}` : ""}${details.source ? ` · ${details.source}` : ""}`);
      return new Text(`${head}\n${theme.fg("customMessageText", body)}`, 1, 1);
    },
  );
}
