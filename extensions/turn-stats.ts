/**
 * Turn stats
 *
 * One dim, right-aligned line under each assistant message: when it finished, how long the provider
 * actually took, how long until the first word, how fast it decoded, and which model answered.
 *
 * This replaces two things that each measured a guess. A client-side throughput estimate has to count
 * tokens and time them locally, which means it is measuring its own rendering loop as much as the
 * model, and it has no way to know whether the box served most of the prompt from a KV cache. A
 * timestamp stamped on every message answers "when" with more lines than the question needed. Rooter
 * already publishes both numbers from the server, so this reads them out of response headers and adds
 * only what a client can legitimately measure for itself.
 *
 * The line is a session entry, not a message and not a footer. `pi.appendEntry()` writes it to the
 * transcript and keeps it out of the model's context; `pi.sendMessage()` with a custom message would
 * have rendered identically and then handed the whole thing to the model as a user turn, which is
 * both a lie and a waste of tokens. `registerEntryRenderer` draws it, so it survives a restart and
 * shows up in scrollback, which is the entire point: the answer to "how fast was that?" is supposed
 * to be next to the thing it was being fast about.
 *
 * What the numbers mean, and where each one comes from:
 *
 *   - `duration` is wall clock around the provider call, from the request Pi made to the message
 *     finishing. A turn that ran three tool calls gets three lines, one per answer, which is the
 *     granularity a reader actually scans for.
 *   - `ttft` comes from `X-Rooter-Ttft-Ms` when rooter could measure it honestly. Rooter publishes
 *     that header on a held body only, because a stream's first byte and its headers are the same
 *     instant and nobody can report a latency they did not observe. On a stream this extension
 *     measures it locally - first chunk carrying a real word minus request start - which is the
 *     arrival the client actually experienced. It is marked `~` so a server measurement and a local
 *     one are not read as the same kind of number.
 *   - `tok/s` prefers `X-Rooter-Decode-Tok-S`, the runner's own decode rate. The fallback divides
 *     tokens by the window they arrived in - last parsed stream event minus first - because that is
 *     the only window that is actually decoding. A held body exposes no arrival window at all, so a
 *     call with no runner rate and no stream shows no rate rather than tokens over however long the
 *     proxy spent queueing, which is a different quantity wearing the same unit.
 *   - `model` is the model that answered, which is not always the one requested: `auto` and a backend
 *     alias are routing decisions, and rooter reports `auto` in the header because it genuinely does
 *     not yet know which model the box will pick. On a stream the runner names the model in its own
 *     chunks, so that wins.
 *   - `ctrl+o` (expand) adds the numbers that are worth having occasionally but not every line:
 *     token count, cache hit rate, prefill rate, and the proxy's own queue wait.
 *
 * No flag and no configuration, and nothing at all outside TUI modes: `pi -p` and `--json` have no
 * transcript to decorate, and appending an entry there costs a write to a session nobody is reading.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Rooter's own header names. Kept literal and local: this is a wire contract, not a shared module. */
const HDR_BACKEND = "x-rooter-backend";
const HDR_MODEL = "x-rooter-model";
const HDR_ROUTE = "x-rooter-route";
const HDR_TTFT_MS = "x-rooter-ttft-ms";
const HDR_WAIT_MS = "x-rooter-wait-ms";
const HDR_COMPLETION_TOKENS = "x-rooter-completion-tokens";
const HDR_DECODE_TOKENS_PER_SECOND = "x-rooter-decode-tok-s";
const HDR_PREFILL_TOKENS_PER_SECOND = "x-rooter-prefill-tok-s";
const HDR_CACHE_HIT_RATE = "x-rooter-cache-hit-rate";
const HDR_STREAMED = "x-rooter-streamed";

/** The custom entry type this extension owns. */
const ENTRY_TYPE = "turn-stats";

/**
 * Real model ids on this network run to about forty characters and the quantisation suffix is the
 * part that tells two of the same family apart, so the budget has to hold one of them whole.
 */
const MAX_MODEL_WIDTH = 40;

/** The numbers that outlive this session. Stored raw; the formatter is allowed to change. */
interface TurnStatsData {
  finishedAt: number;
  durationMs: number;
  ttftMs?: number;
  /** True when the client measured ttft rather than rooter reporting it. */
  ttftMeasured: boolean;
  hasTtft: boolean;
  decodeRate?: number;
  decodeMeasured: boolean;
  hasDecode: boolean;
  tokens?: number;
  models: string[];
  backends: string[];
  streamed: boolean;
  /** Rooter's own queue wait, shown only when expanded. */
  waitMs?: number;
  cacheHitPercent?: number;
  prefillRate?: number;
  /** Set when the answer never arrived, so the line says so instead of showing nothing. */
  aborted?: boolean;
}

interface CallStats {
  /** Set by `before_provider_request`; a call that never started has no row at all. */
  startedAt: number;
  endedAt?: number;
  /** Parsed stream events are the only honest signal a streaming client has of first token. */
  firstStreamEventAt?: number;
  /**
   * The last parsed stream event. A measured rate is divided by the window the tokens actually
   * arrived in, and that window starts at the first token rather than at the request - otherwise the
   * queue and the prefill get folded into a number whose whole point is how fast it decoded.
   */
  lastStreamEventAt?: number;
  /**
   * The first event that carried a character the user could see. This is the one that matters and it
   * is not the first event: llama.cpp opens every stream with an empty delta, so "first chunk" means
   * "the runner accepted the request" and can be six seconds earlier than the first word. Measuring
   * to it produces a time-to-first-token of 99ms for a response nobody has read yet.
   */
  firstContentEventAt?: number;
  backend?: string;
  /** What rooter's header said, which for `auto` is `auto` rather than a lie. */
  routedModel?: string;
  /** What the runner itself named in its chunks, or the model Pi resolved for a held body. */
  answeredModel?: string;
  route?: string;
  serverTtftMs?: number;
  waitMs?: number;
  completionTokens?: number;
  decodeTokensPerSecond?: number;
  prefillTokensPerSecond?: number;
  cacheHitRate?: number;
  /** True when the response arrived as a stream, which is what decides who measures TTFT. */
  streamed: boolean;
}

export default function turnStats(pi: ExtensionAPI): void {
  /**
   * Calls not yet attributed to a message. Pi can retry, so more than one can exist before an answer
   * lands; an aborted turn leaves one behind that never saw a `message_end`.
   */
  let calls: CallStats[] = [];
  let lastCtx: ExtensionContext | undefined;

  function num(headers: Record<string, string>, name: string): number | undefined {
    const raw = headers[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  function str(headers: Record<string, string>, name: string): string | undefined {
    const raw = headers[name];
    return raw === undefined || raw === "" ? undefined : raw;
  }

  function currentCall(): CallStats {
    let call = calls[calls.length - 1];
    if (!call) {
      // A response with no preceding request is a real state: an extension or a resumed session
      // can hand one over. Timing it from now at least keeps the numbers internally consistent.
      call = { startedAt: Date.now(), streamed: false };
      calls.push(call);
    }
    return call;
  }

  function answeredModelByCall(call: CallStats): string | undefined {
    // Rooter says `auto` because it does not know yet. The runner's own name is the answer, and a
    // held body's model field is the next best thing.
    if (call.answeredModel) return call.answeredModel;
    if (call.routedModel && call.routedModel !== "auto" && call.routedModel !== "default") {
      return call.routedModel;
    }
    return undefined;
  }

  function ttftOfCall(call: CallStats): { ms: number; measured: boolean } | undefined {
    if (call.serverTtftMs !== undefined) return { ms: call.serverTtftMs, measured: false };
    // Only a stream needs a local measurement, and only a stream can supply one.
    const anchor = call.firstContentEventAt ?? call.firstStreamEventAt;
    if (anchor !== undefined) return { ms: anchor - call.startedAt, measured: true };
    return undefined;
  }

  function decodeRateOfCall(call: CallStats): { rate: number; measured: boolean } | undefined {
    if (call.decodeTokensPerSecond !== undefined) return { rate: call.decodeTokensPerSecond, measured: false };
    const tokens = call.completionTokens;
    if (tokens === undefined) return undefined;
    // A held body has no arrival window to measure, and dividing its tokens by the time the proxy
    // spent waiting would read as a decode rate when it is really a queueing rate. Nothing is the
    // honest answer for a call that never exposed when its tokens arrived.
    if (call.firstStreamEventAt === undefined || call.lastStreamEventAt === undefined) return undefined;
    const anchor = call.firstContentEventAt ?? call.firstStreamEventAt;
    const seconds = (call.lastStreamEventAt - anchor) / 1000;
    // One token, or a burst Pi parsed in the same millisecond, has no measurable window.
    if (seconds <= 0 || tokens < 2) return undefined;
    return { rate: tokens / seconds, measured: true };
  }

  /**
   * Fold the calls since the last answer into one row. A turn that made several provider calls shows
   * the sum of their waits and total tokens over total time, because averaging per-call rates would
   * read as a speed no single call achieved.
   */
  function summarize(list: CallStats[], aborted: boolean): TurnStatsData | undefined {
    if (!list.length) return undefined;
    let durationMs = 0;
    let waitMs = 0;
    let tokens = 0;
    let hasTokens = false;
    let ttftMs: number | undefined;
    let ttftMeasured = false;
    let decodeRate: number | undefined;
    let decodeMeasured = false;
    let prefillRate: number | undefined;
    let cacheHitPercent: number | undefined;
    let streamed = false;
    const models: string[] = [];
    const backends: string[] = [];

    for (const call of list) {
      if (call.endedAt) durationMs += call.endedAt - call.startedAt;
      if (call.waitMs) waitMs += call.waitMs;
      if (call.streamed) streamed = true;
      if (call.completionTokens !== undefined) {
        tokens += call.completionTokens;
        hasTokens = true;
      }
      const ttft = ttftOfCall(call);
      if (ttft) {
        ttftMs = (ttftMs ?? 0) + ttft.ms;
        ttftMeasured ||= ttft.measured;
      }
      const rate = decodeRateOfCall(call);
      if (rate) {
        decodeRate = (decodeRate ?? 0) + rate.rate;
        decodeMeasured ||= rate.measured;
      }
      if (call.prefillTokensPerSecond !== undefined) prefillRate = call.prefillTokensPerSecond;
      if (call.cacheHitRate !== undefined) cacheHitPercent = call.cacheHitRate * 100;
      const model = answeredModelByCall(call);
      if (model && !models.includes(model)) models.push(model);
      if (call.backend && !backends.includes(call.backend)) backends.push(call.backend);
    }

    // Summing rates is wrong the moment a row covers more than one call, so show the aggregate that
    // is actually defensible: total tokens over total time.
    if (list.length > 1 && hasTokens && durationMs > 0) {
      decodeRate = tokens / (durationMs / 1000);
      decodeMeasured = true;
    }

    const last = list[list.length - 1];
    return {
      finishedAt: last.endedAt ?? Date.now(),
      durationMs,
      ttftMs,
      ttftMeasured,
      hasTtft: ttftMs !== undefined,
      decodeRate,
      decodeMeasured,
      hasDecode: decodeRate !== undefined,
      tokens: hasTokens ? tokens : undefined,
      models,
      backends,
      streamed,
      waitMs: waitMs || undefined,
      cacheHitPercent,
      prefillRate,
      aborted: aborted || undefined,
    };
  }

  /**
   * Write one row into the transcript. Guarded, because a failed append is not worth losing an
   * answer over, and Pi can be asked to draw this in a mode where entries are not accepted.
   */
  function emit(list: CallStats[], aborted: boolean): void {
    const data = summarize(list, aborted);
    calls = [];
    if (!data || !lastCtx?.hasUI) return;
    try {
      pi.appendEntry<TurnStatsData>(ENTRY_TYPE, data);
    } catch {
      // A session that will not take the entry is a session with no transcript to decorate.
    }
  }

  pi.registerEntryRenderer<TurnStatsData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data as TurnStatsData | undefined;
    if (!data) return undefined;
    return new StatsLine(data, expanded, theme);
  });

  pi.on("session_start", (_event, ctx) => {
    calls = [];
    lastCtx = ctx;
  });

  pi.on("session_tree", (_event, ctx) => {
    // A different branch means a different conversation, and the rows already drawn belong to it.
    calls = [];
    lastCtx = ctx;
  });

  pi.on("turn_start", () => {
    // Anything left over from a previous turn was never answered. Draw it before forgetting it.
    if (calls.length) emit(calls, true);
    calls = [];
  });

  pi.on("before_provider_request", (_event, ctx) => {
    lastCtx = ctx;
    calls.push({ startedAt: Date.now(), streamed: false });
  });

  pi.on("after_provider_response", (event, ctx) => {
    lastCtx = ctx;
    const headers = event.headers ?? {};
    const call = currentCall();
    call.backend = str(headers, HDR_BACKEND);
    call.routedModel = str(headers, HDR_MODEL);
    call.route = str(headers, HDR_ROUTE);
    call.serverTtftMs = num(headers, HDR_TTFT_MS);
    call.waitMs = num(headers, HDR_WAIT_MS);
    call.completionTokens = num(headers, HDR_COMPLETION_TOKENS);
    call.decodeTokensPerSecond = num(headers, HDR_DECODE_TOKENS_PER_SECOND);
    call.prefillTokensPerSecond = num(headers, HDR_PREFILL_TOKENS_PER_SECOND);
    call.cacheHitRate = num(headers, HDR_CACHE_HIT_RATE);
    // Rooter marks streams explicitly; a model behind rooter that is not rooter at all still has to
    // be recognised, so the parsed stream events are the other half of this.
    call.streamed = headers[HDR_ROUTE] !== undefined && num(headers, HDR_STREAMED) === 1;
  });

  pi.on("provider_stream_event", (event) => {
    const call = currentCall();
    call.streamed = true;
    const data = event.data as StreamChunk | null;
    if (call.firstStreamEventAt === undefined) call.firstStreamEventAt = Date.now();
    if (call.firstContentEventAt === undefined && carriesContent(data)) call.firstContentEventAt = Date.now();
    call.lastStreamEventAt = Date.now();
    if (data && typeof data.model === "string" && data.model && !isRoutingPlaceholder(data.model)) {
      call.answeredModel = data.model;
    }
    // Strata and sushi both put usage in the final chunk, so a streaming turn gets real token counts
    // rather than one counted off rendered text.
    const usage = data?.usage;
    if (usage && typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens)) {
      call.completionTokens = usage.completion_tokens;
    }
  });

  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    const message = event.message as
      | {
          role?: string;
          model?: string;
          responseModel?: string;
          stopReason?: string;
          usage?: { output?: number };
        }
      | undefined;
    if (!message || message.role !== "assistant") return;
    const call = currentCall();
    if (!call.endedAt) call.endedAt = Date.now();
    if (!call.answeredModel) {
      const named = message.responseModel ?? message.model;
      if (named && !isRoutingPlaceholder(named)) call.answeredModel = named;
    }
    if (call.completionTokens === undefined && typeof message.usage?.output === "number") {
      call.completionTokens = message.usage.output;
    }
    // One row per answer, which is the granularity Ed reads at: the number sits under the thing it
    // describes, so scrollback keeps the pairing.
    emit(calls, message.stopReason === "aborted");
  });

  pi.on("agent_end", (_event, ctx) => {
    lastCtx = ctx;
    // A turn that ended without an assistant message - an error, or an abort before the first token
    // - still deserves to say it happened and how long it took.
    if (calls.length) emit(calls, true);
  });
}

/**
 * One dim line, pushed to the right edge of the transcript.
 *
 * The renderer is a component rather than a string because the width is only known at draw time and
 * right alignment is arithmetic on it. Pi renders every entry as returned lines; there is no
 * alignment primitive to ask for.
 */
class StatsLine implements Component {
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  constructor(
    private readonly data: TurnStatsData,
    private readonly expanded: boolean,
    private readonly theme: any,
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines.length) return this.cachedLines;
    const text = format(this.data, this.expanded);
    const w = visibleWidth(text);
    let line: string;
    if (w <= width) line = " ".repeat(Math.max(0, width - w)) + text;
    else {
      // Prefer losing the left padding to losing the model name, then truncate hard.
      line = truncateToWidth(text, width, "…");
    }
    this.cachedLines = [this.theme?.fg?.("dim", line) ?? line];
    this.cachedWidth = width;
    return this.cachedLines;
  }
}

/** The line itself, in the order a reader actually scans it: when, how long, how fast, what answered. */
function format(data: TurnStatsData, expanded: boolean): string {
  const parts: string[] = [];
  parts.push(clock(data.finishedAt));
  if (data.aborted) parts.push("aborted");
  if (data.durationMs > 0) parts.push(duration(data.durationMs));
  if (data.hasTtft && data.ttftMs !== undefined) {
    parts.push(`ttft ${data.ttftMeasured ? "~" : ""}${duration(data.ttftMs)}`);
  }
  if (data.hasDecode && data.decodeRate !== undefined) {
    parts.push(`${data.decodeMeasured ? "~" : ""}${rate(data.decodeRate)} tok/s`);
  }
  if (expanded) {
    if (data.tokens !== undefined) parts.push(`${data.tokens} tok`);
    if (data.cacheHitPercent !== undefined) parts.push(`cache ${Math.round(data.cacheHitPercent)}%`);
    if (data.prefillRate !== undefined) parts.push(`pre ${rate(data.prefillRate)} tok/s`);
    if (data.waitMs !== undefined) parts.push(`queued ${duration(data.waitMs)}`);
  }
  const answered = data.models.join(", ");
  const boxes = data.backends.join(", ");
  if (answered) parts.push(shortenModel(answered));
  if (boxes) parts.push(`→ ${boxes}`);
  return parts.join("  ");
}

function clock(value: number): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Durations below a second read better in milliseconds than as 0.4s next to 12s. */
function duration(ms: number): string {
  // A sub-millisecond value is not zero, and "0ms" next to a real queue wait reads as "no wait".
  if (ms < 1) return ms > 0 ? "<1ms" : "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function rate(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
}

function shortenModel(model: string): string {
  if (model.length <= MAX_MODEL_WIDTH) return model;
  // Model ids here are namespaced slugs. Truncating the tail hides the quantisation, which is the
  // part that tells two entries of the same family apart, so the middle goes instead.
  const head = model.slice(0, MAX_MODEL_WIDTH - 8);
  const tail = model.slice(-6);
  return `${head}…${tail}`;
}

/**
 * Whether a parsed provider chunk carries text a user would see.
 *
 * Written against the openai-completions chunk shape rooter terminates, and against Pi's own delta
 * names as well, because an extension reading a stream is reading whatever the API in front of it
 * happened to emit and a wrong answer here silently moves the time-to-first-token back to the empty
 * opening chunk.
 */
function carriesContent(data: StreamChunk | null): boolean {
  if (!data) return false;
  if (typeof data.content === "string" && data.content.length > 0) return true;
  if (typeof data.text === "string" && data.text.length > 0) return true;
  if (typeof data.textDelta === "string" && data.textDelta.length > 0) return true;
  for (const choice of data.choices ?? []) {
    const delta = choice?.delta;
    if (typeof delta?.content === "string" && delta.content.length > 0) return true;
    // A thinking model says this first. Live proof that it belongs here: a sushi
    // response streamed twenty deltas as reasoning_content and its only content
    // field was the empty opening one, so a check limited to content measures the
    // end of the thinking as the first word.
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
    if (typeof choice?.text === "string" && choice.text.length > 0) return true;
  }
  return false;
}

interface StreamChunk {
  model?: unknown;
  content?: unknown;
  text?: unknown;
  textDelta?: unknown;
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown }; text?: unknown } | null>;
  usage?: { completion_tokens?: unknown };
}

function isRoutingPlaceholder(model: string): boolean {
  return model === "auto" || model === "default";
}
