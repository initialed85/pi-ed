/**
 * The contract between the two compaction extensions.
 *
 * `extensions/compaction-summary-guard.ts` controls what one summarisation call costs and how big the
 * summary it writes may be. `extensions/idle-compaction.ts` controls *when* a compaction happens: it
 * moves the work into the quiet windows a long session already has (measured: 92% of the wall time of
 * this repository's own session is in gaps longer than five minutes) instead of letting it land in the
 * middle of a run, where a human is waiting for the next answer.
 *
 * The scheduler needs exactly one thing from the guard: a single summarisation attempt, with no
 * compression retries. Pi's `CompactOptions` carries `customInstructions`, `onComplete` and `onError`,
 * and `session_before_compact` receives `customInstructions` verbatim, so the request travels inside
 * that string. A string is deliberate rather than lazy: it survives however the loader resolves the two
 * modules, where shared module state would not, and it is visible in a session file if anyone ever
 * wonders why a compaction did not retry.
 */

/** Written into `customInstructions` by the idle scheduler; read by the guard. On its own line, because that is
 * what the guard's line-anchored test looks for, and because it is what makes the request legible to whoever
 * reads the session file afterwards. */
export const SINGLE_ATTEMPT_MARKER = "pi-ed:compaction-single-attempt";

/** The marker, anchored to its own line: a person who happens to type the phrase into their own `/compact`
 * instructions is asking for a shorter summary, not opting out of the compression ladder. */
const MARKER_LINE = new RegExp(`^\\s*${SINGLE_ATTEMPT_MARKER}\\s*$`, "im");

/** True when this compaction request asked the guard not to spend a second summarisation call. */
export function isSingleAttemptRequest(customInstructions: string | undefined): boolean {
  return typeof customInstructions === "string" && MARKER_LINE.test(customInstructions);
}

/** One attempt, said in plain English instead of in a marker. */
export const ONE_ATTEMPT_PHRASE = /\b(one|single|no)\s+(summarisation|compression)\s+attempt\b|do not retry the summarisation/i;

/**
 * What an idle compaction is for, said to the model that writes the summary.
 *
 * The instruction is not decoration. A compaction that runs while nobody is watching has one job the
 * mid-run one does not: it has to be worth reading in an hour. So it names what must survive (the live
 * plan, exact identifiers, blockers, decisions and why) and what must not be rewritten (a summary that
 * has already been compressed once).
 *
 * `planBlock` is this session's plan read straight out of `.pi/plan/<session-id>.json`. Pinned here, it
 * survives the compaction verbatim instead of being reconstructed from a summary of a summary.
 */
export function idleCompactionInstructions(planBlock?: string): string {
  const parts = [
    SINGLE_ATTEMPT_MARKER,
    `This compaction is being written while the session is idle, not because the context overflowed mid-turn, and
nobody is waiting for it. Write the version a later turn will depend on, and spend one summarisation attempt on
it: do not retry the summarisation to make it tighter.

Preserve, in this order: the current goal and the stated direction; the open steps and anything in progress, with
their ids; the current blocker, if any; the decisions that still hold and the reason for each; exact paths,
commands, ids, shas, endpoints and error strings a later step would otherwise have to re-read.

Compress, do not restate: drop completed work whose result no longer matters, drop superseded status, and never
lengthen the summary just because the conversation is long. If the context already contains a summary, compress it
as material rather than summarising it again. Do not call a tool: the session is idle and a tool call here would
start the work this compaction is meant to make room for.`,
  ];
  if (planBlock?.trim()) {
    parts.push(`This session's plan is authoritative and must survive this summary unchanged:
<plan>
${planBlock.trim()}
</plan>`);
  }
  return parts.join("\n\n");
}
