import { describe, expect, it } from "vitest";

import { idleCompactionInstructions, isSingleAttemptRequest, SINGLE_ATTEMPT_MARKER } from "../lib/compaction.ts";
import { isOneAttemptRequest } from "../extensions/compaction-summary-guard.ts";

/**
 * The seam between the idle scheduler and the summary guard.
 *
 * `compaction-summary-guard` runs a ladder: summarise, and if the summary is over budget rewrite it harder, then
 * hardest. That is right for a compaction forced mid-run, where the alternative is a failed turn. It is wrong for
 * one nobody is waiting for: 52-77 s for a single clean summarisation call against this fleet's local backends,
 * against a measured 70 s median and 226 s p90 for a compaction overall - which is the shape of a ladder on a
 * contended shared GPU. And 48 of 102 compactions across 11 sessions went over budget, spending 158 extra
 * summarisation calls between them.
 *
 * So the idle path asks for one attempt by writing a marker as the first line of its `customInstructions`, and the
 * guard reads it. Both sides take the marker from `lib/compaction.ts`, which is the point of this file: the request
 * is a string, and a string that two files spell differently is a bug waiting to be invisible.
 */

const INSTRUCTIONS = idleCompactionInstructions();
const TEXT = INSTRUCTIONS;

describe("the idle compaction contract", () => {
  it("asks for one attempt in the first line, where both a model and a regex will see it", () => {
    expect(TEXT.split("\n")[0]).toBe(SINGLE_ATTEMPT_MARKER);
  });

  it("is a request the guard accepts", () => {
    // The marker path, and the guard's own entry point. If either moves, the idle path silently goes back to three
    // summarisation calls, and nothing in a session's output would show it.
    expect(isSingleAttemptRequest(TEXT)).toBe(true);
    expect(isOneAttemptRequest(TEXT)).toBe(true);
  });

  it("does not treat a phrase in someone else's prose as the handshake", () => {
    expect(isSingleAttemptRequest("make it shorter and mention pi-ed:compaction-single-attempt inline")).toBe(false);
    expect(isSingleAttemptRequest(undefined)).toBe(false);
    expect(isSingleAttemptRequest("")).toBe(false);
  });

  it("still counts as one attempt when a person says it in plain English", () => {
    expect(isSingleAttemptRequest("one summarisation attempt, no more")).toBe(false);
    expect(isOneAttemptRequest("please make it short with a single summarisation attempt")).toBe(true);
    expect(isOneAttemptRequest("do not retry the summarisation")).toBe(true);
    expect(isOneAttemptRequest("summarise everything again in detail")).toBe(false);
  });

  it("says what an idle summary is for, in terms the summariser can act on", () => {
    expect(TEXT).toContain("while the session is idle");
    expect(TEXT).toContain("nobody is waiting for it");
    expect(TEXT).toContain("one summarisation attempt");
    expect(TEXT).toContain("Do not call a tool");
  });

  it("names what must survive, in the order this session actually loses things", () => {
    expect(TEXT).toContain("the current goal and the stated direction");
    expect(TEXT).toContain("the open steps and anything in progress");
    expect(TEXT).toContain("the current blocker");
    expect(TEXT).toContain("exact paths");
    expect(TEXT).toContain("compress it\nas material");
  });

  it("carries the live plan through verbatim rather than letting the model re-describe it", () => {
    const plan = [
      "# Plan",
      "Session 01a1c4d0. Use `todos(action=list)` to read the live list; it is authoritative over this block.",
      "GOAL      Ship the idle compaction path",
      "TODO      2 open · 1 in progress · 4 done · 0 superseded",
      "  ~ t5 Design the quiet window — the burst ends under 60s, so two minutes means it is over",
    ].join("\n");
    const text = idleCompactionInstructions(plan);
    expect(text).toContain("<plan>");
    expect(text).toContain("Ship the idle compaction path");
    expect(text).toContain("~ t5 Design the quiet window");
    // The marker must survive pinning, because the plan block is what makes the request worth honouring.
    expect(text.split("\n")[0]).toBe(SINGLE_ATTEMPT_MARKER);
    expect(isOneAttemptRequest(text)).toBe(true);
  });

  it("is short enough that the guard's own budget check is never the thing arguing with it", () => {
    // The guard trims a summary at 16000 characters. A scheduler whose brief is longer than the thing it is
    // briefing would be arguing with that check on every compaction.
    const withPlan = idleCompactionInstructions(`# Plan\n${"GOAL      x\n".repeat(400)}`);
    expect(TEXT.length).toBeLessThan(2000);
    expect(withPlan.length).toBeLessThan(6000);
  });

  it("asks the same way when there is no plan to pin", () => {
    expect(idleCompactionInstructions()).toBe(TEXT);
    expect(idleCompactionInstructions("   ")).toBe(TEXT);
    expect(idleCompactionInstructions("")).toBe(TEXT);
    expect(isOneAttemptRequest(idleCompactionInstructions())).toBe(true);
  });
});
