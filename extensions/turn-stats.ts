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
 *   - `when` is the calendar date and the clock, in the reader's timezone, on every row. The date is
 *     eleven columns on a row that is 63 wide undated and 74 dated, and a narrow terminal keeps the head
 *     of the row rather than its tail - so at 50 columns the undated row had already lost `41.7 tok/s`
 *     onward and at 45 it had already lost the model name. The date does not newly sacrifice anything a
 *     phone reader was keeping; it buys the only field that a long-lived session cannot infer from the
 *     row itself.
 *   - `duration` is wall clock around the provider call, from the request Pi made to the message
 *     finishing. A turn that ran three tool calls gets three lines, one per answer, which is the
 *     granularity a reader actually scans for.
 *   - `ttft` comes from `X-Rooter-Ttft-Ms` when rooter could measure it honestly. Rooter publishes
 *     that header on a held body only, because a stream's first byte and its headers are the same
 *     instant and nobody can report a latency they did not observe. On a stream this extension
 *     measures it locally - first chunk carrying a real word minus request start - which is the
 *     arrival the client actually experienced. It is marked `~` so a server measurement and a local
 *     one are not read as the same kind of number.
 *   - `tok/s` prefers the runner's own decode rate, whether it arrived as `X-Rooter-Decode-Tok-S` on a
 *     held body or as `timings.predicted_per_second` in the last chunk of a stream. The fallback
 *     divides tokens by the window they arrived in - last parsed stream event minus first - because
 *     that is the only window that is actually decoding. A held body exposes no arrival window at all,
 *     so a call with no runner rate and no stream shows no rate rather than tokens over however long
 *     the proxy spent queueing, which is a different quantity wearing the same unit.
 *   - `pre` is the time the runner spent on the prompt, and it appears only when the prompt is what
 *     made the turn slow: at least a second, and at least 15% of the turn. It is a duration and not a
 *     rate, deliberately. A warm 44-token read runs at 78 tok/s in 0.56s while a cold 93,857-token
 *     read runs at 1,513 tok/s in 62s - the *rate* is better on the call that took a minute longer -
 *     so a prefill rate on a line meant for scanning would train a reader to watch the wrong column.
 *     The rate is under `ctrl+o`.
 *
 * On a stream, everything after the routing headers arrives in the body, not the headers. Rooter sends
 * `X-Rooter-Backend`, `-Model`, `-Route`, `-Request-Id`, `-Streamed` and `-Wait-Ms` and nothing else,
 * because the headers and the first byte are the same instant and the tokens do not exist yet; the
 * runner's `usage` and `timings` land in the final SSE chunk, which is the same tail rooter reads for
 * its own event ring, and Pi hands the parsed object to an extension. So the prompt size, the cached
 * prefix, the prefill window and both rates come out of the stream.
 *
 * `read N` - the tokens a call actually had to evaluate - is computed as `prompt_tokens - cached_tokens`
 * from the usage block rather than taken from `timings.prompt_n`, and that is not a stylistic choice.
 * `prompt_n` means the work done on strata and the whole prompt, cached prefix included, on sushi;
 * trusting it produced 166,000 tok/s prefills in the telemetry store. `prompt_tokens` and
 * `cached_tokens` are spelled the same way by both runners, so the subtraction is the one route that
 * works without knowing which llama.cpp build is on the other end.
 *   - `model` is the model that answered, which is not always the one requested: `auto` and a backend
 *     alias are routing decisions, and rooter reports `auto` in the header because it genuinely does
 *     not yet know which model the box will pick. On a stream the runner names the model in its own
 *     chunks, so that wins.
 *   - `ctrl+o` (expand) writes a second line under the first rather than appending to it: the prompt
 *     length and how much of it was cached, the work done, the cache rate, the prefill window and its
 *     rate, the generation window and its rate, the output token count with how much of it was
 *     thinking, and the proxy's own queue wait. A second line because the scan line is right-aligned and a
 *     narrow terminal truncates its tail - the model and the box go first - and those are the numbers that
 *     would otherwise be truncated away.
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
  /**
   * How long the runner spent on the prompt. On the collapsed line this is the number that explains a
   * slow turn, and the prefill *rate* is not: a warm 44-token read runs at 78 tok/s in 0.56s, while a
   * cold 93,857-token read runs at 1,513 tok/s in 62s. The rate is better on the call that took a
   * minute longer, so a prefill rate on the scan line would train a reader to watch the wrong column.
   */
  prefillMs?: number;
  decodeMs?: number;
  promptTokens?: number;
  cachedTokens?: number;
  /**
   * Tokens the runner actually evaluated, taken from the usage block rather than from `prompt_n`.
   * Both runners spell `prompt_tokens` and `cached_tokens` identically, so this is the one place a
   * client can work out the size of the job without knowing which llama.cpp build it is talking to.
   */
  computedTokens?: number;
  reasoningTokens?: number;
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
  /** Prompt length and cached prefix, from the runner's usage block. Known on both runners. */
  promptTokens?: number;
  cachedTokens?: number;
  /** The runner's own prefill and decode windows, from `timings`. */
  prefillMs?: number;
  decodeMs?: number;
  /** Tokens the runner spent thinking rather than answering, when it bothers to say. */
  reasoningTokens?: number;
  /** True when the response arrived as a stream, which is what decides who measures TTFT. */
  streamed: boolean;
  /** Why the provider stopped, read from the assistant message. */
  stopReason?: string;
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
    let prefillMs: number | undefined;
    let decodeMs: number | undefined;
    let promptTokens = 0;
    let hasPromptTokens = false;
    let cachedTokens = 0;
    let hasCachedTokens = false;
    let computedTokens = 0;
    let hasComputedTokens = false;
    let reasoningTokens = 0;
    let hasReasoningTokens = false;
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
      // Rooter's rate is the fallback for a held body, where the header exists and the counts arrive
      // as a single derived figure instead of two numbers this code can see.
      if (call.cacheHitRate !== undefined) cacheHitPercent = call.cacheHitRate * 100;
      if (call.prefillMs !== undefined) prefillMs = (prefillMs ?? 0) + call.prefillMs;
      if (call.decodeMs !== undefined) decodeMs = (decodeMs ?? 0) + call.decodeMs;
      if (call.promptTokens !== undefined) {
        promptTokens += call.promptTokens;
        hasPromptTokens = true;
      }
      if (call.cachedTokens !== undefined) {
        cachedTokens += call.cachedTokens;
        hasCachedTokens = true;
      }
      if (call.reasoningTokens !== undefined) {
        reasoningTokens += call.reasoningTokens;
        hasReasoningTokens = true;
      }
      // The size of the job, derived where the two runners agree instead of where they do not.
      if (call.promptTokens !== undefined) {
        computedTokens += Math.max(0, call.promptTokens - (call.cachedTokens ?? 0));
        hasComputedTokens = true;
      }
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
      cacheHitPercent:
        cacheHitPercent ??
        (hasPromptTokens && promptTokens > 0 && hasCachedTokens ? (cachedTokens / promptTokens) * 100 : undefined),
      prefillRate,
      prefillMs,
      decodeMs,
      promptTokens: hasPromptTokens ? promptTokens : undefined,
      cachedTokens: hasCachedTokens ? cachedTokens : undefined,
      computedTokens: hasComputedTokens ? computedTokens : undefined,
      reasoningTokens: hasReasoningTokens ? reasoningTokens : undefined,
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
    if (usage) {
      const completion = numField(usage.completion_tokens);
      if (completion !== undefined) call.completionTokens = completion;
      const prompt = numField(usage.prompt_tokens);
      if (prompt !== undefined) call.promptTokens = prompt;
      const cached = numField(usage.prompt_tokens_details?.cached_tokens);
      if (cached !== undefined) call.cachedTokens = cached;
      const reasoning = numField(usage.completion_tokens_details?.reasoning_tokens);
      if (reasoning !== undefined) call.reasoningTokens = reasoning;
    }
    // The runner's timings ride in the same chunk. Rooter reads that tail for its own event ring and
    // deliberately does not edit a stream, so this is the same data, arriving the same way, and it
    // arrives here as well whether or not the call went through rooter at all.
    const timings = data?.timings;
    if (timings) {
      const prefillMs = numField(timings.prompt_ms);
      if (prefillMs !== undefined) call.prefillMs = prefillMs;
      const prefillRate = numField(timings.prompt_per_second);
      if (prefillRate !== undefined) call.prefillTokensPerSecond = prefillRate;
      const decodeMs = numField(timings.predicted_ms);
      if (decodeMs !== undefined) call.decodeMs = decodeMs;
      const decodeRate = numField(timings.predicted_per_second);
      if (decodeRate !== undefined) call.decodeTokensPerSecond = decodeRate;
      if (call.cachedTokens === undefined) {
        const cached = numField(timings.cached_n) ?? numField(timings.cache_n);
        if (cached !== undefined) call.cachedTokens = cached;
      }
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
    call.stopReason = message.stopReason;
  });

  pi.on("turn_end", (event, ctx) => {
    lastCtx = ctx;
    // turn_end, not message_end. message_end is a handler that can still replace the message, so it
    // runs before the message reaches the session log; a row appended from it lands *above* the answer
    // it describes. turn_end runs after the assistant and tool-result messages are persisted, and it
    // fires once per turn, which is once per answer - so the row lands under the thing it measures.
    const stopReason = (event as { message?: { stopReason?: string } }).message?.stopReason;
    emit(calls, stopReason === "aborted");
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
    const { primary, detail } = format(this.data, this.expanded);
    const lines = [primary, ...(detail ? [detail] : [])].map((text) => {
      const w = visibleWidth(text);
      // What actually happens at a narrow terminal, measured rather than assumed: the padding only exists
      // while the row fits, and once it does not, `truncateToWidth` keeps the HEAD and eats the TAIL. So a
      // row that is too wide loses its right-hand end - the model and the box - not its left padding, and
      // the order `format` puts the fields in is what decides the casualties.
      const aligned = w <= width ? " ".repeat(Math.max(0, width - w)) + text : truncateToWidth(text, width, "…");
      return this.theme?.fg?.("dim", aligned) ?? aligned;
    });
    this.cachedLines = lines;
    this.cachedWidth = width;
    return this.cachedLines;
  }
}

/**
 * The line itself, in the order a reader actually scans it: when, how long, how fast, what answered.
 *
 * Expansion adds a second line rather than appending to the first. The scan line is right-aligned, and a
 * terminal narrower than the row loses its right-hand end - truncation keeps the head - so the fields a
 * reader on a phone keeps are the left ones: the time, then the duration. The detail line carries the
 * numbers that would otherwise be the first casualties.
 */
function format(data: TurnStatsData, expanded: boolean): { primary: string; detail?: string } {
  const parts: string[] = [];
  parts.push(clock(data.finishedAt));
  if (data.aborted) parts.push("aborted");
  if (data.durationMs > 0) parts.push(duration(data.durationMs));
  if (data.hasTtft && data.ttftMs !== undefined) {
    parts.push(`ttft ${data.ttftMeasured ? "~" : ""}${duration(data.ttftMs)}`);
  }
  // A prompt that took a noticeable slice of the turn is worth naming on the scan line, because it is
  // the difference between "the model is slow" and "this call had to read 93,857 tokens cold". A
  // warm call spends most of its time decoding and needs nothing here.
  if (prefillIsSignificant(data)) parts.push(`pre ${duration(data.prefillMs!)}`);
  if (data.hasDecode && data.decodeRate !== undefined) {
    parts.push(`${data.decodeMeasured ? "~" : ""}${rate(data.decodeRate)} tok/s`);
  }
  const answered = data.models.join(", ");
  const boxes = data.backends.join(", ");
  if (answered) parts.push(shortenModel(answered));
  if (boxes) parts.push(`→ ${boxes}`);

  return { primary: parts.join("  "), detail: expanded ? detailLine(data) : undefined };
}

/**
 * Whether the prompt itself, rather than the queue or the decode, is what made this turn slow.
 *
 * Both halves matter: a 3s prefill inside a 40s turn is a detail, and a 1s prefill in a 1.2s turn is
 * the whole story. Neither is answered by the duration alone.
 */
function prefillIsSignificant(data: TurnStatsData): boolean {
  if (data.prefillMs === undefined || data.prefillMs < 1000) return false;
  return data.prefillMs >= data.durationMs * 0.15;
}

/** The second line, only under ctrl+o: the shape of the prompt and where the wall clock actually went. */
function detailLine(data: TurnStatsData): string | undefined {
  const parts: string[] = [];
  if (data.promptTokens !== undefined) {
    const cached = data.cachedTokens !== undefined ? ` (${data.cachedTokens} cached)` : "";
    parts.push(`prompt ${data.promptTokens}${cached}`);
    if (data.computedTokens !== undefined) parts.push(`read ${data.computedTokens}`);
  }
  if (data.cacheHitPercent !== undefined) parts.push(`cache ${Math.round(data.cacheHitPercent)}%`);
  // Either half on its own is still worth saying. A held body knows the rate and not the window; a
  // runner that reports timings but no usage knows the window and not the rate.
  if (data.prefillMs !== undefined || data.prefillRate !== undefined) {
    const head = data.prefillMs !== undefined ? duration(data.prefillMs) : undefined;
    const ratePart = data.prefillRate !== undefined ? `${head ? " @ " : ""}${rate(data.prefillRate)} tok/s` : "";
    parts.push(`pre ${head ?? ""}${ratePart}`.trimEnd());
  }
  // The decode rate is already on the scan line. Here it is the *window* that earns its place,
  // because "gen 27s" is what tells a reader where the rest of the turn went.
  if (data.decodeMs !== undefined) {
    const ratePart = data.decodeRate !== undefined ? ` @ ${rate(data.decodeRate)} tok/s` : "";
    parts.push(`gen ${duration(data.decodeMs)}${ratePart}`);
  }
  if (data.tokens !== undefined) {
    const thinking =
      data.reasoningTokens !== undefined && data.reasoningTokens > 0 ? ` (${data.reasoningTokens} thinking)` : "";
    parts.push(`out ${data.tokens}${thinking}`);
  }
  if (data.waitMs !== undefined) parts.push(`queued ${duration(data.waitMs)}`);
  return parts.length ? parts.join("  ") : undefined;
}

/**
 * When the turn finished, in the reader's own timezone, with the calendar date in front of the clock.
 *
 * The date used to be left off on the theory that a clock to the second is the whole of "when". That is
 * true of a turn and false of a scrollback: Ed's sessions run for days, and a row reading `12:07:15` in
 * a long transcript is a row that could be any day in it. Measured on the row in his own screenshot -
 * `11:54:20  177.8s  ttft ~171.1s  pre 170.7s  41.7 tok/s  -> sushi` - the line is 63 columns undated and
 * 74 dated, and `truncateToWidth` keeps the head, so at 50 columns the *undated* row already loses from
 * `41.7 tok/s` onward and at 45 it already loses the model name. The date does not newly sacrifice the
 * model column on a phone; that column was already gone. It is on every row unconditionally, rather than
 * only when the day changes, because a day-change-only rule makes the first row of a session the one row
 * that cannot be dated from itself.
 */
function clock(value: number): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  /**
   * The token block a runner puts in its final chunk. Read from the body rather than a header
   * because on a stream there is no header left to set: the headers and the first byte are the same
   * instant, and the tokens do not exist yet.
   *
   * `prompt_tokens` and `prompt_tokens_details.cached_tokens` are the two that matter most, and
   * they are worth naming because of what they avoid. llama.cpp's `timings.prompt_n` means the work
   * done on strata and the whole prompt, cached prefix included, on sushi - which has already put
   * 166,000 tok/s prefills into the telemetry store. The usage block is spelled the same way by
   * both runners, so `prompt_tokens - cached_tokens` is the work done on either of them without
   * having to know which one this is.
   */
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  /** The runner's own timings, in the same final chunk. Present on strata and on sushi. */
  timings?: {
    prompt_n?: unknown;
    cached_n?: unknown;
    cache_n?: unknown;
    prompt_ms?: unknown;
    prompt_per_second?: unknown;
    predicted_n?: unknown;
    predicted_ms?: unknown;
    predicted_per_second?: unknown;
  };
}

/** Loose readers for a provider body: these fields are the runner's, not ours, and any of them can be absent. */
function numField(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function isRoutingPlaceholder(model: string): boolean {
  return model === "auto" || model === "default";
}
