/**
 * Turn stats
 *
 * One dim line at the bottom of the screen: when the last turn finished, how long the provider
 * actually took, how fast it decoded, and which model answered.
 *
 * This replaces two things that each measured a guess. A client-side throughput estimate has to
 * count tokens and time them locally, which means it is measuring its own rendering loop as much
 * as the model, and it has no way to know whether the box served most of the prompt from a KV
 * cache. A timestamp stamped on every message answers "when" with more lines than the question
 * needed. Rooter already publishes both numbers from the server, so this reads them out of response
 * headers and adds only what a client can legitimately measure for itself.
 *
 * Why a footer rather than a status. `ctx.ui.setStatus()` is the friendlier API — it hands a string
 * to the built-in footer and Pi lays it out — but Pi joins extension statuses left-aligned on a
 * line of their own, and its own `sanitizeStatusText` trims the result, so leading spaces meant for
 * right alignment are gone before anything reaches the terminal. Right alignment means owning the
 * footer.
 *
 * Owning the footer is why this folds in `footerData.getExtensionStatuses()` rather than replacing
 * the footer outright. `tags.ts` publishes session hashtags through `setStatus`, and a footer that
 * drew only its own content would silently make them invisible. Every status still renders; this
 * extension is only the one that positions them.
 *
 * What the numbers mean, and where each one comes from:
 *
 *   - `duration` is wall clock around the provider calls Pi made, summed over the turn. A turn with
 *     three tool calls made three provider calls, and summing them is what "how long did that take"
 *     is asking for.
 *   - `ttft` comes from `X-Rooter-Ttft-Ms` when rooter could measure it honestly. Rooter publishes
 *     that header on a held body only, because a stream's first byte and its headers are the same
 *     instant and nobody can report a latency they did not observe. On a stream this extension
 *     measures it locally — first parsed stream event minus request start — which is the arrival the
 *     client actually experienced. It is marked `~` so a server measurement and a local one are not
 *     read as the same kind of number.
 *   - `tok/s` prefers `X-Rooter-Decode-Tok-S`, the runner's own decode rate. The fallback divides
 *     tokens by the window they arrived in - last parsed stream event minus first - because that is
 *     the only window that is actually decoding. A held body exposes no arrival window at all, so a
 *     call with no runner rate and no stream shows no rate rather than tokens over however long the
 *     proxy spent queueing, which is a different quantity wearing the same unit.
 *   - A turn that made several provider calls shows the sum of their waits and total tokens over
 *     total time. Averaging the per-call rates would read as a speed no single call achieved.
 *   - `model` is the model that answered, which is not always the one requested: `auto` and a backend
 *     alias are routing decisions, and rooter reports `auto` in the header because it genuinely does
 *     not yet know which model the box will pick. On a stream the runner names the model in its own
 *     chunks, so that wins.
 *
 * No flag and no configuration, and nothing at all outside TUI modes: `pi -p` and `--json` have no
 * footer, and drawing one there would put a decoration into output that is meant to be piped.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";

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

/** The models a footer can be shown against are the ones a human is watching, so keep them short. */
/**
 * Real model ids on this network run to about forty characters and the quantisation suffix is the
 * part that tells two of the same family apart, so the budget has to hold one of them whole.
 */
const MAX_MODEL_WIDTH = 40;

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
   * Per-turn accumulation. Pi can make several provider calls in one turn and a footer that showed
   * only the last of them would read as though the turn were as fast as its final call.
   */
  let calls: CallStats[] = [];
  /** The instant the last turn finished, so the clock in the footer is the answer's time. */
  let finishedAt: number | undefined;
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
      // can hand one over. Timing it from now at least keeps the footer internally consistent.
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

  function backendOfCall(call: CallStats): string | undefined {
    return call.backend;
  }

  function ttftOfCall(call: CallStats): { ms: number; measured: boolean } | undefined {
    if (call.serverTtftMs !== undefined) return { ms: call.serverTtftMs, measured: false };
    // Only a stream needs a local measurement, and only a stream can supply one.
    const anchor = call.firstContentEventAt ?? call.firstStreamEventAt;
    if (anchor !== undefined) {
      return { ms: anchor - call.startedAt, measured: true };
    }
    return undefined;
  }

  function tokensOfCall(call: CallStats): number | undefined {
    return call.completionTokens;
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

  interface TurnSummary {
    durationMs: number;
    tokens: number;
    hasTokens: boolean;
    ttftMs?: number;
    ttftMeasured: boolean;
    hasTtft: boolean;
    decodeRate?: number;
    decodeMeasured: boolean;
    hasDecode: boolean;
    prefillRate?: number;
    cacheHitPercent?: number;
    waitMs: number;
    models: string[];
    backends: string[];
    streamed: boolean;
  }

  function summarize(): TurnSummary | undefined {
    if (!calls.length) return undefined;
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
    const models: string[] = [];
    const backends: string[] = [];
    let streamed = false;

    for (const call of calls) {
      if (call.endedAt) durationMs += call.endedAt - call.startedAt;
      if (call.waitMs) waitMs += call.waitMs;
      if (call.streamed) streamed = true;
      const count = tokensOfCall(call);
      if (count !== undefined) {
        tokens += count;
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
      const backend = backendOfCall(call);
      if (backend && !backends.includes(backend)) backends.push(backend);
    }

    // Summing rates is wrong the moment a turn has more than one call, so a multi-call turn shows
    // the aggregate that is actually defensible: total tokens over total decode time.
    if (calls.length > 1 && hasTokens && durationMs > 0) {
      decodeRate = tokens / (durationMs / 1000);
      decodeMeasured = true;
    }

    return {
      durationMs,
      tokens,
      hasTokens,
      ttftMs,
      ttftMeasured,
      hasTtft: ttftMs !== undefined,
      decodeRate,
      decodeMeasured,
      hasDecode: decodeRate !== undefined,
      prefillRate,
      cacheHitPercent,
      waitMs,
      models,
      backends,
      streamed,
    };
  }

  function clock(value: number): string {
    const d = new Date(value);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** Durations below a second read better in milliseconds than as 0.4s next to 12s. */
  function duration(ms: number): string {
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

  function buildRight(footerData: ReadonlyFooterDataProvider): string[] {
    const parts: string[] = [];

    // Other extensions' statuses first: they are context, and this line is decoration for them.
    for (const [, text] of footerData.getExtensionStatuses()) {
      const trimmed = text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
      if (trimmed) parts.push(trimmed);
    }

    const summary = summarize();
    if (finishedAt !== undefined) parts.push(clock(finishedAt));
    if (summary) {
      // Five things, in the order a reader actually scans them: when, how long, how long the first
      // token took, how fast it decoded, what answered. Cache hit rate, prefill rate and the token
      // count are all on /rooter/metrics and in Grafana; putting them here would trade the model name
      // for numbers nobody glances at while a turn is running.
      if (summary.durationMs > 0) parts.push(duration(summary.durationMs));
      if (summary.hasTtft && summary.ttftMs !== undefined) {
        parts.push(`ttft ${summary.ttftMeasured ? "~" : ""}${duration(summary.ttftMs)}`);
      }
      if (summary.hasDecode && summary.decodeRate !== undefined) {
        parts.push(`${summary.decodeMeasured ? "~" : ""}${rate(summary.decodeRate)} tok/s`);
      }
      // Pi already renders the selected model and any routed model on this line. Rooter adds the box
      // that answered, which is the half Pi cannot know.
      const answered = summary.models.join(", ");
      const boxes = summary.backends.join(", ");
      if (answered) parts.push(shortenModel(answered));
      if (boxes) parts.push(`→ ${boxes}`);
    }

    return parts;
  }

  class TurnStatsFooter implements Component {
    private cachedWidth = -1;
    private cachedLines: string[] = [];

    constructor(
      private readonly theme: any,
      private readonly footerData: ReadonlyFooterDataProvider,
    ) {}

    invalidate(): void {
      this.cachedWidth = -1;
      this.cachedLines = [];
    }

    render(width: number): string[] {
      if (this.cachedWidth === width && this.cachedLines.length) return this.cachedLines;

      const left: string[] = [];
      if (lastCtx) {
        const home = process.env.HOME;
        const cwd = home && lastCtx.cwd.startsWith(home) ? `~${lastCtx.cwd.slice(home.length)}` : lastCtx.cwd;
        left.push(cwd);
        const branch = this.footerData.getGitBranch();
        if (branch) left.push(branch);
      }

      const right = lastCtx ? buildRight(this.footerData) : [];
      const leftText = left.filter(Boolean).join(" ");
      const rightText = right.filter(Boolean).join("  ");

      const leftWidth = visibleWidth(leftText);
      const rightWidth = visibleWidth(rightText);
      const minimumGap = 2;

      let line: string;
      if (leftWidth + minimumGap + rightWidth <= width) {
        line = leftText + " ".repeat(width - leftWidth - rightWidth) + rightText;
      } else if (rightWidth <= width) {
        // The stats are the point of this line; the path is the part to lose.
        line = " ".repeat(Math.max(0, width - rightWidth)) + rightText;
      } else {
        line = truncateToWidth(rightText, width, "…");
      }

      this.cachedLines = [this.theme.fg("dim", line)];
      this.cachedWidth = width;
      return this.cachedLines;
    }
  }

  let installed: { footer: TurnStatsFooter; unsubscribe: () => void } | undefined;

  const footerFactory = (tui: any, theme: any, footerData: ReadonlyFooterDataProvider) => {
    const footer = new TurnStatsFooter(theme, footerData);
    // Pi's built-in footer notices a branch change on its own. An extension footer has to subscribe
    // for the same thing or a checkout leaves a stale branch on screen until something else decides
    // to repaint.
    const unsubscribe = footerData.onBranchChange(() => footer.invalidate());
    installed = { footer, unsubscribe };
    // The component is returned as itself on purpose. Spreading an instance into an object literal
    // copies its fields and drops render() and invalidate(), which live on the prototype, and Pi
    // would be handed an object it cannot draw.
    return Object.assign(footer, {
      dispose: () => {
        unsubscribe();
        footer.invalidate();
        installed = undefined;
      },
    });
  };

  function install(ctx: ExtensionContext): void {
    lastCtx = ctx;
    if (!ctx.hasUI) return;
    // Re-applied rather than applied once. `/resume`, `/clear` and a new session hand a different UI
    // to the next event, and a footer installed only on the first one is invisible from then on.
    ctx.ui.setFooter(footerFactory);
    installed?.footer.invalidate();
  }

  pi.on("session_start", (_event, ctx) => {
    calls = [];
    finishedAt = undefined;
    install(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    // A different branch means a different conversation, and the footer is describing this one.
    calls = [];
    finishedAt = undefined;
    install(ctx);
  });

  pi.on("turn_start", () => {
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
    call.streamed = headers[HDR_ROUTE] !== undefined && num(headers, "x-rooter-streamed") === 1;
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
  });

  pi.on("turn_end", (_event, ctx) => {
    lastCtx = ctx;
    finishedAt = Date.now();
    // Pi re-renders the footer on its own schedule, but a turn finishing is exactly the moment this
    // line becomes worth redrawing, so say so instead of hoping a layout pass notices.
    installed?.footer.invalidate();
  });
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
