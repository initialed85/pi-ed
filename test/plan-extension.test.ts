import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext, type FakePi, type FakeContext, type FakeUi } from "./harness.ts";
import { planDir, PLAN_BLOCK_MAX_CHARS, readPlan } from "../lib/plan.ts";

/**
 * `/goal`, wired to a real filesystem in a temp cwd and driven through the lifecycle it will actually see.
 *
 * The interesting assertions are the two that look boring. The first is that the goal arrives as a **prompt
 * section**, not as an injected message: Pi wraps named sections in a tag and patches only the ones that changed
 * (`docs/extensions.md`, `before_agent_start`), so a goal that does not change costs nothing on the next two
 * hundred turns. The alternative vehicles all tax every turn - and the one that looks cheapest, appending the block
 * to the compaction summary, is refused by `compaction-summary-guard`, whose `overBudget` check and `trimToBudget`
 * both act on `result.summary.length` across three separate return paths. That is why no test here mentions
 * compaction: the design goal is that this extension has nothing to know about it.
 *
 * The second is what a damaged plan file does: nothing, except say so. A corrupt or foreign-schema file is the one
 * case where an agent could reasonably decide to "fix" state by overwriting it, and the human's goal would be gone
 * with no trace - so the wiring carries the problem through to the write path and refuses, and a test reads the
 * damaged bytes back off disk afterwards.
 *
 * The rest is the contract of one command: set replaces and keeps what it replaced, bare `/goal` reports,
 * `clear` clears only when it is the whole argument, print mode stays silent but still loads the goal into the
 * prompt, and a session id that is not a safe filename never reaches the filesystem.
 */

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/plan.ts");
const STATUS_KEY = "plan";
const SECTION_KEY = "plan";
const ID = "01a1c4d0-2f3a-7b4c-9d5e-1f2a3b4c5d6e";
const OTHER = "01a1c4d0-0000-7b4c-9d5e-1f2a3b4c5d6e";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

type Harness = { pi: FakePi; cwd: string; context: FakeContext; ui: FakeUi };

async function setup(options: { sessionId?: string; cwd?: string; hasUI?: boolean; mode?: "tui" | "rpc" | "print" | "json" } = {}): Promise<Harness> {
  const cwd = options.cwd ?? mkdtempSync(path.join(tmpdir(), "pi-ed-plan-cmd-"));
  if (options.cwd === undefined) dirs.push(cwd);
  const pi = createFakePi();
  const record = createContext({ cwd, sessionId: options.sessionId ?? ID, hasUI: options.hasUI ?? true, ...(options.mode ? { mode: options.mode } : {}) });
  const mod = await import(MODULE);
  (mod as { default: (api: unknown) => void }).default(pi as any);
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, record.context);
  return { pi, cwd, context: record.context, ui: record.ui };
}

/** Fire the turn-start event the way Pi does, with the mutable prompt sections an empty session would carry. */
async function startTurn(harness: Harness, sections: Record<string, string> = { preamble: "you are a coding agent" }) {
  const event = { type: "before_agent_start", messageType: "user", prompt: "carry on", systemPrompt: "you are a coding agent", systemPromptOptions: { sections } };
  await harness.pi.emit("before_agent_start", event, harness.context);
  return event.systemPromptOptions.sections as Record<string, string>;
}

async function runGoal(harness: Harness, args: string) {
  await harness.pi.commands.get("goal")!.handler!(args, harness.context);
}

const planFile = (cwd: string, sessionId = ID) => path.join(planDir(cwd), `${sessionId}.json`);

describe("the surface", () => {
  it("registers one command, no tools, and only the events it needs", async () => {
    const harness = await setup();
    expect([...harness.pi.commands.keys()]).toEqual(["goal"]);
    // The model reads the goal; it does not write it. A tool would be the difference between a human's aim and
    // the model's aim, and that question is not answered yet.
    expect(harness.pi.tools.size).toBe(0);
    expect(harness.pi.flags.size).toBe(0);
    expect(harness.pi.lifecycleEvents).toEqual(["session_start", "session_info_changed", "before_agent_start"]);
    expect(harness.pi.appendedEntries).toHaveLength(0);
    expect(harness.pi.sentUserMessages).toHaveLength(0);
  });

  it("starts with nothing on disk and nothing in the prompt", async () => {
    const harness = await setup();
    const sections = await startTurn(harness);
    expect(sections[SECTION_KEY]).toBeUndefined();
    expect(readdirSync(harness.cwd)).toEqual([]);
    expect(harness.ui.statuses.get(STATUS_KEY)).toBeUndefined();
  });
});

describe("/goal", () => {
  it("sets the goal, writes it under the session id, and paints the status line", async () => {
    const harness = await setup();
    await runGoal(harness, "ship the plan substrate in three validated steps");

    const stored = readPlan(harness.cwd, ID).plan!;
    expect(stored.goal).toBe("ship the plan substrate in three validated steps");
    expect(stored.goal_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stored.session_id).toBe(ID);
    expect(JSON.parse(readFileSync(planFile(harness.cwd), "utf8"))).toEqual(stored);
    expect(harness.ui.statuses.get(STATUS_KEY)).toContain("ship the plan substrate");
    expect(harness.ui.notifications.at(-1)?.message).toContain("goal set");
  });

  it("replaces the goal and keeps what it replaced", async () => {
    const harness = await setup();
    await runGoal(harness, "the first aim");
    await runGoal(harness, "the second aim");
    const stored = readPlan(harness.cwd, ID).plan!;
    expect(stored.goal).toBe("the second aim");
    expect(stored.goal_prev).toBe("the first aim");
    expect(harness.ui.notifications.at(-1)?.message).toContain("replaced: the first aim");
  });

  it("says so when the goal is already the goal", async () => {
    const harness = await setup();
    await runGoal(harness, "same thing");
    harness.ui.notifications.length = 0;
    await runGoal(harness, "same thing");
    expect(harness.ui.notifications.at(-1)?.message).toContain("already the goal");
  });

  it("reports the goal with a bare /goal, and points at the file when there is none", async () => {
    const harness = await setup();
    await runGoal(harness, "");
    const empty = harness.ui.notifications.at(-1)!.message!;
    expect(empty).toContain("no goal for this session");
    expect(empty).toContain(`${ID}.json`);

    await runGoal(harness, "do the thing");
    harness.ui.notifications.length = 0;
    await runGoal(harness, "   ");
    const shown = harness.ui.notifications.at(-1)!.message!;
    expect(shown).toContain("do the thing");
    expect(shown).toMatch(/set \d{4}-\d{2}-\d{2}T/); // the stored timestamp, not a truncated phrase
  });

  it("clears only when clear is the whole argument", async () => {
    const harness = await setup();
    await runGoal(harness, "make it clear which session is which");
    expect(readPlan(harness.cwd, ID).plan!.goal).toBe("make it clear which session is which");

    await runGoal(harness, "clear");
    const stored = readPlan(harness.cwd, ID).plan!;
    expect(stored.goal).toBeUndefined();
    expect(stored.goal_prev).toBe("make it clear which session is which");
    expect(harness.ui.statuses.get(STATUS_KEY)).toBeUndefined();
    harness.ui.notifications.length = 0;
    await runGoal(harness, "none");
    expect(harness.ui.notifications.at(-1)?.message).toContain("no goal to clear");
  });

  it("keeps two sessions in one checkout apart", async () => {
    const first = await setup();
    await runGoal(first, "the first session's aim");
    const second = await setup({ cwd: first.cwd, sessionId: OTHER });
    expect(second.ui.notifications).toHaveLength(0); // no "restored" for a session with nothing stored
    await runGoal(second, "the second session's aim");
    expect(readPlan(first.cwd, ID).plan!.goal).toBe("the first session's aim");
    expect(readPlan(first.cwd, OTHER).plan!.goal).toBe("the second session's aim");
  });

  it("refuses a session id that is not a safe filename, and writes nothing anywhere", async () => {
    const harness = await setup({ sessionId: "../escape" });
    expect(harness.ui.notifications.at(-1)?.message).toContain("refused session id");
    await runGoal(harness, "a goal that cannot be stored");
    expect(harness.ui.notifications.at(-1)?.message).toContain("goal not saved");
    expect(readdirSync(harness.cwd)).toEqual([]);
  });
});

describe("inheritance", () => {
  it("restores the goal of a continued session, and says when it was set", async () => {
    const first = await setup();
    await runGoal(first, "finish the migration");

    // `pi -c` reuses the id and reuses nothing else: a new extension instance, a new session_start.
    const second = await setup({ cwd: first.cwd, sessionId: ID });
    const note = second.ui.notifications.at(-1)!.message!;
    expect(note).toContain("goal restored");
    expect(note).toContain("finish the migration");
    expect(note).toContain("set ");
    expect(second.ui.statuses.get(STATUS_KEY)).toContain("finish the migration");
  });

  it("starts a fresh session blank", async () => {
    const first = await setup();
    await runGoal(first, "finish the migration");
    const fresh = await setup({ cwd: first.cwd, sessionId: OTHER });
    expect(fresh.ui.notifications).toHaveLength(0);
    const sections = await startTurn(fresh);
    expect(sections[SECTION_KEY]).toBeUndefined();
    expect(readPlan(fresh.cwd, OTHER).plan).toBeUndefined();
  });
});

describe("the prompt section", () => {
  it("carries the goal into the turn as a named section", async () => {
    const harness = await setup();
    await runGoal(harness, "ship /goal, then /todo");
    const sections = await startTurn(harness);
    expect(sections[SECTION_KEY]).toContain("GOAL      ship /goal, then /todo");
    expect(sections[SECTION_KEY]!.length).toBeLessThanOrEqual(PLAN_BLOCK_MAX_CHARS);
    // Untouched: the section route means this extension does not edit anything else's prompt.
    expect(sections.preamble).toBe("you are a coding agent");
  });

  it("stays byte-identical turn to turn, so the diff sends it once", async () => {
    // This is the whole reason the goal is a section rather than a per-turn message: an identical string means no
    // patch, so a two-hundred-turn session pays for the goal once. Any nondeterminism in the rendering - a
    // timestamp, a clock, a Map iteration that moved - would turn into one system message per turn.
    const harness = await setup();
    await runGoal(harness, "hold the rendering deterministic");
    const first = await startTurn(harness);
    const second = await startTurn(harness);
    expect(second[SECTION_KEY]).toBe(first[SECTION_KEY]);
  });

  it("removes the section when the goal goes away", async () => {
    const harness = await setup();
    await runGoal(harness, "temporary aim");
    await runGoal(harness, "clear");
    // A leftover `<plan>` tag would keep a retired goal in front of the model forever, and an empty tag would cost
    // a parse for no information.
    const sections = await startTurn(harness, { preamble: "p", [SECTION_KEY]: "stale text from before the clear" });
    expect(sections[SECTION_KEY]).toBeUndefined();
  });

  it("loads the goal in print mode, without saying anything", async () => {
    const seeded = await setup();
    await runGoal(seeded, "quiet aim");
    const harness = await setup({ cwd: seeded.cwd, hasUI: false, mode: "print" });
    expect(harness.ui.notifications).toHaveLength(0);
    expect(harness.ui.statuses.size).toBe(0);
    const sections = await startTurn(harness);
    expect(sections[SECTION_KEY]).toContain("GOAL      quiet aim");
  });
});

describe("a plan that cannot be read", () => {
  it("reports a corrupt file, refuses to overwrite it, and leaves the bytes for a human", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-plan-corrupt-"));
    dirs.push(cwd);
    mkdirSync(planDir(cwd), { recursive: true });
    writeFileSync(planFile(cwd), '{ "v": 1, "session_id": "01a1c4d0', "utf8");

    const harness = await setup({ cwd });
    expect(harness.ui.notifications.at(-1)?.message).toContain("not valid JSON");
    expect(harness.ui.statuses.get(STATUS_KEY)).toContain("⚠️");

    await runGoal(harness, "a goal that must not be written");
    expect(harness.ui.notifications.at(-1)?.message).toContain("goal not saved");
    expect(readFileSync(planFile(cwd), "utf8")).toBe('{ "v": 1, "session_id": "01a1c4d0');
  });

  it("refuses a schema it cannot reinterpret, and keeps refusing", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-plan-future-"));
    dirs.push(cwd);
    mkdirSync(planDir(cwd), { recursive: true });
    writeFileSync(planFile(cwd), JSON.stringify({ v: 9, session_id: ID, goal: "from a newer pi-ed", todos: [] }), "utf8");

    const harness = await setup({ cwd });
    expect(harness.ui.notifications.at(-1)?.message).toContain("schema v9");
    await runGoal(harness, "overwrite the future");
    expect(harness.ui.notifications.at(-1)?.message).toContain("goal not saved");
    expect(JSON.parse(readFileSync(planFile(cwd), "utf8")).v).toBe(9);
  });
});
