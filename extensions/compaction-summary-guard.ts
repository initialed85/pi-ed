/**
 * Compaction summary guard
 *
 * Fixes repeated "Auto-compaction failed: Summarization failed: generation hit the
 * token cap and the summary is incomplete".
 *
 * Cause (seen on local reasoning models, e.g. sushi/Qwen3.8-Flash-Next):
 * - Pi caps the summarization response at `min(0.8 * compaction.reserveTokens,
 *   model.maxTokens)`, i.e. 13107 tokens with the default reserveTokens.
 * - Pi summarizes at the *session* thinking level, and `high` maps to `xhigh` on
 *   these models, which is an unbounded reasoning budget. Reasoning consumed
 *   1k-9k of those 13107 tokens.
 * - Each compaction merges the previous summary forward, so summaries grew
 *   (~10k -> ~13k output tokens) until every attempt hit the cap. Auto-compaction
 *   then failed on every turn and context stayed pinned at the ceiling.
 *
 * This handler keeps Pi's own compaction implementation (`compact()` — same
 * structured format, previous-summary merge, split-turn handling, file lists,
 * cut point) and only changes the summarization request:
 * 1. a bounded response cap (reserveTokens is only read for that cap here; the
 *    cut point is already computed before this event fires);
 * 2. reasoning disabled for the summary call (faster, and the budget goes to the
 *    summary instead of thinking — worth ~1-2 min per compaction on local models);
 * 3. a length budget in the prompt plus validation of actual output tokens/text;
 * 4. up to two compressed retries for token-cap failures or oversized summaries;
 * 5. file lists are carried forward by hand, because Pi only merges them between
 *    its own (non-extension) compactions — see extractFileOperations().
 *
 * Side effects: compaction summaries are shorter and generated without thinking.
 * Tune SUMMARY_TARGET_TOKENS / SUMMARY_OUTPUT_TOKENS below, or delete this file to
 * revert to Pi's default behaviour. `/compact <focus>` still works: the focus text
 * is passed through unchanged.
 */

import { compact, type CompactionResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Ceiling for one summarization response (Pi clamps this to model.maxTokens too). */
const SUMMARY_OUTPUT_TOKENS = 8192;
/** Maximum accepted summary size; checked against provider usage and a conservative chars/4 estimate. */
const SUMMARY_TARGET_TOKENS = 4000;
const SUMMARY_MAX_CHARS = SUMMARY_TARGET_TOKENS * 4;
const RETRY_POLICY = { enabled: true, maxRetries: 2, baseDelayMs: 2000, maxAgentDelayMs: 15000 };

const LENGTH_BUDGET = `Length budget (hard requirement): keep the whole summary under ${SUMMARY_TARGET_TOKENS} tokens (~${SUMMARY_MAX_CHARS} characters), and never let it grow just because the conversation or a previous summary is long. If a <previous-summary> is present, rewrite and compress it together with the new messages instead of appending to it: keep only the newest value of any superseded fact, drop completed work whose result no longer matters, merge duplicate bullets, and cut prose that is not needed to continue the task. Prefer short bullets holding exact paths, commands, symbols, and error strings. Do not restate the conversation.`;

const COMPRESS_HARDER = `The previous summary exceeded the enforced ${SUMMARY_TARGET_TOKENS}-token budget. Rewrite it from scratch, targeting under 2000 tokens. Keep only the current goal/task, constraints that still apply, important decisions, current state/blockers, next action, and essential paths/commands. Remove completed work from prior tasks, stale or contradictory status, repeated bullets, and narrative.`;
const COMPRESS_HARDEST = `The last summary was still over budget. Rewrite it from scratch in at most 1000 tokens. Preserve only the active task, critical constraints, current state/blocker, immediate next step, and essential file paths/commands. Drop all old completed work and repeated history.`;

function summaryOverBudget(result: CompactionResult): string | undefined {
	const outputTokens = result.usage?.output;
	if (typeof outputTokens === "number" && outputTokens > SUMMARY_TARGET_TOKENS) {
		return `summary used ${outputTokens} output tokens (limit ${SUMMARY_TARGET_TOKENS})`;
	}
	const estimatedTokens = Math.ceil(result.summary.length / 4);
	if (result.summary.length > SUMMARY_MAX_CHARS) {
		return `summary is about ${estimatedTokens} tokens by length (limit ${SUMMARY_TARGET_TOKENS})`;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions, reason, signal } = event;
		const model = ctx.model;
		if (!model || signal.aborted) return;

		// Carry the newest previous compaction's file lists into this one (sets, so
		// duplicating what Pi already carried is harmless).
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type !== "compaction") continue;
			const details = entry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
			for (const [files, target] of [
				[details?.readFiles, preparation.fileOps.read],
				[details?.modifiedFiles, preparation.fileOps.edited],
			] as const) {
				if (Array.isArray(files)) {
					for (const file of files) if (typeof file === "string") (target as Set<string>).add(file);
				}
			}
			break;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Compaction summary guard: no auth for ${model.provider}/${model.id}, using default compaction`, "warning");
			return;
		}

		const headerEntries: Array<[string, string]> = [];
		for (const [key, value] of Object.entries(auth.headers ?? {})) {
			if (typeof value === "string") headerEntries.push([key, value]);
		}
		const headers = headerEntries.length > 0 ? Object.fromEntries(headerEntries) : undefined;

		// generateSummaryWithUsage derives maxTokens from this value; a copy keeps the
		// session's real reserveTokens (trigger threshold) untouched.
		const prepared = {
			...preparation,
			settings: { ...preparation.settings, reserveTokens: Math.ceil(SUMMARY_OUTPUT_TOKENS / 0.8) },
		};

		const summarize = (extra: string | undefined): Promise<CompactionResult> => {
			const instructions = [customInstructions, LENGTH_BUDGET, extra].filter(Boolean).join("\n\n");
			// "off" here only affects the summarization call; the session keeps its thinking level.
			return compact(prepared, model, auth.apiKey, headers, instructions, signal, "off", undefined, auth.env, RETRY_POLICY);
		};

		const compressionInstructions = [undefined, COMPRESS_HARDER, COMPRESS_HARDEST];
		let lastFailure = "summary was empty";
		for (let attempt = 0; attempt < compressionInstructions.length; attempt++) {
			try {
				const result = await summarize(compressionInstructions[attempt]);
				if (!result.summary.trim()) {
					lastFailure = "summary was empty";
					break;
				}

				const overBudget = summaryOverBudget(result);
				if (!overBudget) {
					if (attempt > 0) {
						ctx.ui.notify(`Compaction summary compressed to budget after ${attempt} retries in ${reason} compaction`, "info");
					}
					return { compaction: result };
				}
				lastFailure = overBudget;
			} catch (error) {
				lastFailure = error instanceof Error ? error.message : String(error);
				if (signal.aborted || !lastFailure.includes("token cap")) break;
			}

			if (signal.aborted) return;
		}

		if (!signal.aborted) {
			ctx.ui.notify(
				`Compaction summary guard: ${lastFailure} after compression retries; falling back to default compaction`,
				"warning",
			);
		}
		return;
	});
}
