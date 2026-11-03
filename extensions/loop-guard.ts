import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HISTORY_LIMIT = 32;
const MAX_CYCLE_LENGTH = 4;
const TEXT_HISTORY_LIMIT = 8;
const TEXT_SIMILARITY_THRESHOLD = 0.84;
const MIN_TEXT_WORDS = 16;
const MAX_RESULT_CHARS = 1200;

interface PendingCall {
  fingerprint: string;
  toolName: string;
  blocked: boolean;
}

interface ToolObservation {
  fingerprint: string;
  toolName: string;
  failed: boolean;
  result: string;
  failureSummary?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toolFingerprint(toolName: string, input: unknown, cwd: string): string {
  if (toolName === "bash" && isRecord(input) && typeof input.command === "string") {
    const command = input.command
      .replace(/\bsleep\s+\d+(?:\.\d+)?(?:ms|s|m|h)?\b/gi, "sleep <duration>")
      .replace(/\btimeout\s+\d+(?:\.\d+)?(?:ms|s|m|h)?\b/gi, "timeout <duration>")
      .replace(/\s+/g, " ")
      .trim();
    return sha256(`${toolName}\0${cwd}\0${command}`);
  }
  return sha256(`${toolName}\0${cwd}\0${stableJson(input)}`);
}

const FAILURE_MARKER = /curl:\s*\(\d+\)|empty reply from server|failed to connect|connection refused|address already in use|failed to start server|panic:|fatal:|command (?:timed out|aborted)|command exited with code [1-9]\d*/i;

function resultFingerprint(content: unknown, isError: boolean): { fingerprint: string; failed: boolean; failureSummary?: string } {
  const raw = Array.isArray(content)
    ? content.map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "[non-text output]").join("\n")
    : "";
  const lines = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(\bfrom\s+\S+\s+port\s+)\d+\b/gi, "$1<ephemeral-port>")
    .split(/[\r\n]+/)
    .filter((line) => !/^\s*(?:TPS\b|Took\b)/i.test(line))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const normalized = lines
    .join(" ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/gi, "<duration>")
    .slice(-MAX_RESULT_CHARS);
  const failureSummary = lines.find((line) => /curl:\s*\(\d+\)/i.test(line))
    ?? lines.find((line) => FAILURE_MARKER.test(line))
    ?? (isError ? normalized : undefined);
  const failed = isError || FAILURE_MARKER.test(normalized);
  return {
    fingerprint: sha256(`${failed ? "error" : "ok"}\0${normalized}`),
    failed,
    failureSummary: failureSummary?.slice(-240),
  };
}

function repeatedCycle(history: ToolObservation[], candidate: string): { length: number; failureSummary?: string } | undefined {
  for (let length = 1; length <= Math.min(MAX_CYCLE_LENGTH, Math.floor(history.length / 2)); length++) {
    const first = history.slice(-2 * length, -length);
    const second = history.slice(-length);
    if (first[0]?.fingerprint !== candidate) continue;

    const repeated = first.every((left, index) => {
      const right = second[index];
      return left.fingerprint === right?.fingerprint && left.result === right.result && left.failed === right.failed;
    });
    if (!repeated) continue;

    const failure = [...first, ...second].find((observation) => observation.failed);
    if (failure) return { length, failureSummary: failure.failureSummary };
  }
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function textSimilarity(left: string, right: string): number {
  if (left === right && left.length >= 32) return 1;
  const leftWords = left.match(/[\p{L}\p{N}_'-]+/gu) ?? [];
  const rightWords = right.match(/[\p{L}\p{N}_'-]+/gu) ?? [];
  if (Math.min(leftWords.length, rightWords.length) < MIN_TEXT_WORDS) return 0;

  const shingles = (words: string[]) => {
    const result = new Set<string>();
    for (let i = 0; i <= words.length - 3; i++) result.add(words.slice(i, i + 3).join(" "));
    return result;
  };
  const leftShingles = shingles(leftWords);
  const rightShingles = shingles(rightWords);
  let overlap = 0;
  for (const shingle of leftShingles) if (rightShingles.has(shingle)) overlap++;
  return overlap / (leftShingles.size + rightShingles.size - overlap);
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  const pending = new Map<string, PendingCall>();
  const observations: ToolObservation[] = [];
  const blockedCounts = new Map<string, number>();
  const textHistory: string[] = [];
  const nudgedTextLoops: string[] = [];
  const reportedTextLoops: string[] = [];

  const reset = () => {
    pending.clear();
    observations.length = 0;
    blockedCounts.clear();
    textHistory.length = 0;
    nudgedTextLoops.length = 0;
    reportedTextLoops.length = 0;
  };

  pi.on("input", reset);
  pi.on("session_start", reset);
  pi.on("session_tree", reset);

  pi.on("tool_call", (event, ctx) => {
    if (event.parentToolCallId) return;

    const input = event.input as unknown;
    const fingerprint = toolFingerprint(event.toolName, input, ctx.cwd);
    const pendingCall: PendingCall = { fingerprint, toolName: event.toolName, blocked: false };
    pending.set(event.toolCallId, pendingCall);

    const repeat = repeatedCycle(observations, fingerprint);
    if (!repeat) return;

    pendingCall.blocked = true;
    const blockCount = (blockedCounts.get(fingerprint) ?? 0) + 1;
    blockedCounts.set(fingerprint, blockCount);
    const evidence = repeat.failureSummary ? ` Repeated failure evidence: ${repeat.failureSummary}.` : "";
    const reason = `Loop guard blocked this ${event.toolName} call: the last ${repeat.length}-call sequence repeated twice with the same result${repeat.length === 1 ? "" : "s"}, including a failure.${evidence} Do not replay it unchanged or only increase wait/timeout values; choose a materially different diagnostic or ask the user for help.`;
    if (blockCount > 1 && ctx.hasUI) {
      ctx.ui.notify("Loop guard stopped a repeated tool-call loop; the agent needs a different approach.", "warning");
    }
    return { block: true, reason, terminate: blockCount > 1 };
  });

  pi.on("turn_end", (event, ctx) => {
    for (const result of event.toolResults) {
      const call = pending.get(result.toolCallId);
      if (!call || call.blocked) continue;
      const outcome = resultFingerprint(result.content, result.isError);
      observations.push({
        fingerprint: call.fingerprint,
        toolName: call.toolName,
        failed: outcome.failed,
        result: outcome.fingerprint,
        failureSummary: outcome.failureSummary,
      });
      if (!outcome.failed) blockedCounts.delete(call.fingerprint);
    }
    pending.clear();
    while (observations.length > HISTORY_LIMIT) observations.shift();

    if (event.toolResults.length > 0) {
      textHistory.length = 0;
      return;
    }

    const text = normalizeText(assistantText(event.message));
    const wordCount = text.match(/[\p{L}\p{N}_'-]+/gu)?.length ?? 0;
    if (!text || (wordCount < MIN_TEXT_WORDS && text.length < 32)) {
      textHistory.push(text);
      while (textHistory.length > TEXT_HISTORY_LIMIT) textHistory.shift();
      return;
    }

    const similar = textHistory.filter((previous) => textSimilarity(text, previous) >= TEXT_SIMILARITY_THRESHOLD).length;
    textHistory.push(text);
    while (textHistory.length > TEXT_HISTORY_LIMIT) textHistory.shift();
    if (similar < 2) return;

    const alreadyNudged = nudgedTextLoops.some((previous) => textSimilarity(text, previous) >= TEXT_SIMILARITY_THRESHOLD);
    if (alreadyNudged) {
      const alreadyReported = reportedTextLoops.some((previous) => textSimilarity(text, previous) >= TEXT_SIMILARITY_THRESHOLD);
      if (!alreadyReported) {
        reportedTextLoops.push(text);
        if (ctx.hasUI) ctx.ui.notify("Loop guard: the text-only repetition continued after its one automatic nudge.", "warning");
      }
      return;
    }

    nudgedTextLoops.push(text);
    const excerpt = text.length > 500 ? `${text.slice(0, 497)}...` : text;
    return {
      entries: [{
        type: "custom_message",
        customType: "loop-guard",
        display: true,
        content: `Loop guard: your recent text-only replies are near-duplicates and are not adding new evidence. Do not restate the same answer. Identify what is actually known, then either take a materially different next step or clearly ask the user for the missing information.\n\nRepeated reply: ${excerpt}`,
      }],
      continue: true,
    };
  });
}
