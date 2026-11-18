import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext, callTool, renderedWidget, type FakePi, type FakeContext, type FakeUi } from "./harness.ts";
import { PANEL_MAX_STEPS } from "../extensions/plan.ts";
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

async function runTodo(harness: Harness, args: string) {
  await harness.pi.commands.get("todo")!.handler!(args, harness.context);
}

/** Press the panel key the way the TUI would: the recorded handler, called with a context. */
async function pressPanelKey(harness: Harness) {
  await harness.pi.shortcuts.get("shift+down")!.handler(harness.context);
}

async function callTodos(harness: Harness, params: Record<string, unknown>) {
  return callTool(harness.pi, "todos", params, harness.context);
}

const toolText = (result: { content: Array<{ text?: string }> }) => result.content.map((c) => c.text ?? "").join("\n");

const planFile = (cwd: string, sessionId = ID) => path.join(planDir(cwd), `${sessionId}.json`);

describe("the surface", () => {
  it("registers two commands, one tool, one key, and only the events it needs", async () => {
    const harness = await setup();
    expect([...harness.pi.commands.keys()].sort()).toEqual(["goal", "todo"]);
    // The aim has no model-facing door; the list does, because the work on a list is done by the agent. The tool is
    // named for the list and not for the plan, so its name cannot imply it writes the goal too.
    expect([...harness.pi.tools.keys()]).toEqual(["todos"]);
    expect([...harness.pi.shortcuts.keys()]).toEqual(["shift+down"]);
    expect(harness.pi.flags.size).toBe(0);
    expect(harness.pi.lifecycleEvents).toEqual(["session_start", "session_info_changed", "before_agent_start"]);
    expect(harness.pi.appendedEntries).toHaveLength(0);
    expect(harness.pi.sentUserMessages).toHaveLength(0);
  });

  it("gives the model a tool that cannot touch the aim", async () => {
    const harness = await setup();
    const tool = harness.pi.tools.get("todos")!;
    const schema = JSON.stringify(tool.parameters);
    // The authority split, pinned where a future edit would break it: no action writes goal or direction, and the
    // guidelines say so out loud rather than relying on the enum alone.
    expect(schema).not.toMatch(/"goal"/);
    expect(schema).not.toMatch(/"direction"/);
    expect(String((tool.promptGuidelines ?? []).join(" "))).toContain("Never set or clear the goal");

    const result = await callTodos(harness, { action: "set_goal", text: "steal the aim" });
    expect(result.details.ok).toBe(false);
    expect(toolText(result)).toContain("unknown action");
    expect(harness.pi.appendedEntries).toHaveLength(0);
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
    expect(harness.ui.notifications.at(-1)?.message).toContain("not saved");
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
    expect(harness.ui.notifications.at(-1)?.message).toContain("not saved");
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
    expect(harness.ui.notifications.at(-1)?.message).toContain("not saved");
    expect(JSON.parse(readFileSync(planFile(cwd), "utf8")).v).toBe(9);
  });
});

/** The record on disk, parsed. `readPlan` is the substrate's own reader; this is the test's, so a corrupt file is
 *  visible as bytes and not silently turned into a problem string. */
function planOnDisk(cwd: string, sessionId = ID) {
  return JSON.parse(readFileSync(planFile(cwd, sessionId), "utf8"));
}

const widgetLines = (harness: Harness) => renderedWidget(harness.ui, STATUS_KEY);

describe("/todo — the list, by hand", () => {
  it("adds a step and says which id it got", async () => {
    const harness = await setup();
    await runTodo(harness, "ship the panel");
    expect(harness.ui.notifications.at(-1)?.message).toContain("added t1");
    expect(planOnDisk(harness.cwd).todos).toEqual([
      expect.objectContaining({ id: "t1", text: "ship the panel", state: "todo" }),
    ]);
  });

  it("reads the list with counts on the first line", async () => {
    const harness = await setup();
    await runTodo(harness, "one");
    await runTodo(harness, "two — because the goal says so");
    await runTodo(harness, "");
    const report = (harness.ui.notifications.at(-1)?.message ?? "").split("\n");
    expect(report[0]).toBe("🎯 2 open · 0 in progress");
    expect(report.join("\n")).toContain("t1 [ ] one");
    expect(report.join("\n")).toContain("t2 [ ] two");
  });

  it("moves an item, and says so when it is already there", async () => {
    const harness = await setup();
    await runTodo(harness, "fix CI");
    await runTodo(harness, "done t1");
    expect(planOnDisk(harness.cwd).todos[0]).toEqual(expect.objectContaining({ state: "done", done_at: expect.any(String) }));
    await runTodo(harness, "done t1");
    expect(harness.ui.notifications.at(-1)?.message).toContain("t1 is already done");
  });

  it("refuses to start something already in progress, with the substrate's sentence", async () => {
    const harness = await setup();
    await runTodo(harness, "write the tests");
    await runTodo(harness, "start t1");
    await runTodo(harness, "start t1");
    expect(harness.ui.notifications.at(-1)?.level).toBe("warning");
    expect(harness.ui.notifications.at(-1)?.message).toContain("t1 is already in_progress");
  });

  it("keeps the reason a step was dropped, and records who dropped it when no reason is given", async () => {
    const harness = await setup();
    await runTodo(harness, "append the block to the summary");
    await runTodo(harness, "add the tool the human did not ask for");
    await runTodo(harness, "drop t1 superseded by the section route");
    await runTodo(harness, "drop t2");
    const todos = planOnDisk(harness.cwd).todos;
    expect(todos[0]).toEqual(expect.objectContaining({ state: "superseded", note: "superseded by the section route" }));
    expect(todos[1]).toEqual(expect.objectContaining({ state: "superseded", note: "dropped by /todo" }));
  });

  it("edits an item without changing its id", async () => {
    const harness = await setup();
    await runTodo(harness, "old text");
    await runTodo(harness, "note t1 CI runs in UTC");
    await runTodo(harness, "edit t1 new text");
    expect(planOnDisk(harness.cwd).todos[0]).toEqual(
      expect.objectContaining({ id: "t1", text: "new text", why: "CI runs in UTC", state: "todo" }),
    );
  });

  it("treats an unknown id as a message, not a crash", async () => {
    const harness = await setup();
    await runTodo(harness, "done t9");
    expect(harness.ui.notifications.at(-1)?.level).toBe("warning");
    expect(harness.ui.notifications.at(-1)?.message).toContain("no todo t9");
    // A refused verb writes nothing at all: not an empty plan file, not a touched `updated_at`. A session that has
    // never successfully planned has no file, which is what makes `pi -c` say "no goal" rather than read a stub.
    expect(existsSync(planFile(harness.cwd))).toBe(false);
  });

  it("adds one item, not two, when the same text is already open", async () => {
    const harness = await setup();
    await runTodo(harness, "land step 2");
    await runTodo(harness, "land step 2");
    expect(harness.ui.notifications.at(-1)?.message).toContain("already open");
    expect(planOnDisk(harness.cwd).todos).toHaveLength(1);
  });

  it("carries the list into the turn, so the model sees what the human typed", async () => {
    const harness = await setup();
    await runGoal(harness, "make memory boring");
    await runTodo(harness, "restart the pods — the fleet is still on the old build");
    const sections = await startTurn(harness);
    expect(sections[SECTION_KEY]).toContain("GOAL      make memory boring");
    expect(sections[SECTION_KEY]).toContain("t1 restart the pods");
    expect(sections[SECTION_KEY]).toContain("1 open");
  });
});

describe("todos — the list, by the model", () => {
  it("returns the whole list on a write, ids included", async () => {
    const harness = await setup();
    const result = await callTodos(harness, { action: "add", text: "read the list back", why: "the ids are only in the list" });
    expect(result.details).toEqual(expect.objectContaining({ ok: true, changed: true }));
    expect(toolText(result)).toContain("t1 [ ] read the list back");
    expect(toolText(result)).toContain("(the ids are only in the list)");
    expect(toolText(result)).toContain("🎯 1 open · 0 in progress");
  });

  it("moves an item through its states and reports the counts", async () => {
    const harness = await setup();
    await callTodos(harness, { action: "add", text: "step one" });
    await callTodos(harness, { action: "add", text: "step two" });
    expect((await callTodos(harness, { action: "start", id: "t1" })).details.todos).toEqual(
      expect.objectContaining({ open: 1, inProgress: 1, done: 0 }),
    );
    const done = await callTodos(harness, { action: "done", id: "t1" });
    expect(done.details.todos).toEqual(expect.objectContaining({ open: 1, inProgress: 0, done: 1 }));
    expect(planOnDisk(harness.cwd).todos[0].state).toBe("done");
  });

  it("cannot retire a step a human wrote without saying why", async () => {
    const harness = await setup();
    await callTodos(harness, { action: "add", text: "written by a human" });
    const refused = await callTodos(harness, { action: "supersede", id: "t1" });
    expect(refused.details.ok).toBe(false);
    expect(toolText(refused)).toContain("superseding needs a one-line reason");
    expect(planOnDisk(harness.cwd).todos[0].state).toBe("todo");

    const allowed = await callTodos(harness, { action: "supersede", id: "t1", reason: "the section route made it moot" });
    expect(allowed.details.ok).toBe(true);
    expect(planOnDisk(harness.cwd).todos[0]).toEqual(
      expect.objectContaining({ state: "superseded", note: "the section route made it moot" }),
    );
  });

  it("says what an action needs instead of guessing", async () => {
    const harness = await setup();
    expect(toolText(await callTodos(harness, { action: "add" }))).toContain("add needs text");
    expect(toolText(await callTodos(harness, { action: "done" }))).toContain("needs an id");
    expect(toolText(await callTodos(harness, { action: "edit", id: "t1" }))).toContain("edit needs text and/or why");
    expect(toolText(await callTodos(harness, { action: "start", id: "t7" }))).toContain("no todo t7");
  });

  it("reads an empty list without writing anything", async () => {
    const harness = await setup();
    const result = await callTodos(harness, { action: "list" });
    expect(toolText(result)).toContain("no steps yet");
    expect(result.details.ok).toBe(true);
    expect(widgetLines(harness)).toBeUndefined();
  });

  it("refuses every write when the record is damaged, and leaves the bytes", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-plan-tool-corrupt-"));
    dirs.push(cwd);
    mkdirSync(planDir(cwd), { recursive: true });
    writeFileSync(planFile(cwd), "{ not json", "utf8");

    const harness = await setup({ cwd });
    const result = await callTodos(harness, { action: "add", text: "this must not be written" });
    expect(result.details.ok).toBe(false);
    expect(toolText(result)).toContain("not valid JSON");
    expect(readFileSync(planFile(cwd), "utf8")).toBe("{ not json");
  });

  it("keeps two sessions' lists apart in one checkout", async () => {
    const harness = await setup();
    await callTodos(harness, { action: "add", text: "for session A" });

    // A second session in the same cwd: `current()` re-reads because the id changed, so it sees its own empty plan.
    const other = createContext({ cwd: harness.cwd, sessionId: OTHER, hasUI: true });
    await harness.pi.emit("session_start", { type: "session_start", reason: "resume" }, other.context);
    const listed = await callTool(harness.pi, "todos", { action: "list" }, other.context);
    expect(toolText(listed)).toContain("no steps yet");
    expect(toolText(await callTool(harness.pi, "todos", { action: "done", id: "t1" }, other.context))).toContain("no todo t1");
    expect(planOnDisk(harness.cwd).todos).toHaveLength(1);
    // Reading another session's list must not create a file for this one: a session without a plan has no plan file,
    // and a `list` is not a write.
    expect(existsSync(planFile(harness.cwd, OTHER))).toBe(false);
  });
});

describe("the panel", () => {
  it("lists nothing until there is something to list, but opens when asked", async () => {
    const harness = await setup();
    expect(widgetLines(harness)).toBeUndefined();
    expect(harness.ui.overlays).toHaveLength(0);

    // The keypress is the request. A panel that refuses to appear because the session has not said anything yet
    // looks identical to a binding that does not work, and reads as a broken shortcut - so an empty session draws
    // its empty state, which is the one thing worth saying here: what to type. Opening it also puts up the compact
    // line, because the overlay rises from that line and would otherwise land on the editor.
    await pressPanelKey(harness);
    expect(harness.ui.overlays).toHaveLength(1);
    const lines = harness.ui.overlays[0].component.render(120).join("\n");
    expect(lines).toContain("/goal");
    expect(lines).toContain("no steps yet");
    expect(widgetLines(harness)).toHaveLength(1);

    await pressPanelKey(harness);
    expect(harness.ui.overlays[0].closed).toBe(true);
    expect(harness.ui.widgets.size).toBe(0);
  });

  it("is one compact line, and shift+down raises the detail over it", async () => {
    const harness = await setup();
    await runGoal(harness, "ship the plan");
    await runTodo(harness, "restart the pods");

    const compact = widgetLines(harness)!;
    expect(compact).toHaveLength(1);
    expect(compact[0]).toContain("Plan:");
    expect(compact[0]).toContain("ship the plan");
    expect(compact[0]).toContain("1 open");
    // The compact line is a counted summary, not the list: the step's text belongs to the expanded panel.
    expect(compact[0]).not.toContain("restart the pods");

    await pressPanelKey(harness);
    expect(harness.ui.overlays).toHaveLength(1);
    const overlay = harness.ui.overlays[0];
    expect(overlay.options.overlay).toBe(true);
    // Non-capturing, because this is a panel you keep open while you type, not a dialog.
    expect(overlay.options.overlayOptions.nonCapturing).toBe(true);
    const lines = overlay.component.render(120);
    expect(lines[0]).toContain("borderAccent");
    expect(lines.join("\n")).toContain("◆ goal");
    expect(lines.join("\n")).toContain("ship the plan");
    expect(lines.join("\n")).toContain("restart the pods");
    expect(lines.join("\n")).toContain("t1");

    await pressPanelKey(harness);
    expect(overlay.closed).toBe(true);
    expect(widgetLines(harness)).toHaveLength(1);
  });

  it("rises from the compact line and does not cover the editor", async () => {
    const harness = await setup();
    await runGoal(harness, "ship the plan");
    await runTodo(harness, "restart the pods");
    // A screen in scrollback mode: more rendered lines than the viewport, with the compact line near the bottom.
    const rows = 24;
    const markerAt = 30;
    const screen = Array.from({ length: 40 }, (_, i) => (i === markerAt ? "  ▌ Plan: ◆ ship the plan" : "~"));
    harness.ui.tui.terminal = { columns: 120, rows };
    harness.ui.tui.render = () => screen;

    await pressPanelKey(harness);
    const overlay = harness.ui.overlays[0];
    const height = overlay.component.render(120).length;
    const widgetRow = markerAt - (screen.length - rows);
    // The panel's last row is the compact line's row: everything it draws sits above it, so it cannot reach the
    // editor or the autocomplete that grows below it.
    const place = overlay.options.overlayOptions;
    expect(place.row + place.maxHeight).toBe(widgetRow + 1);
    expect(place.maxHeight).toBeLessThanOrEqual(height);
    expect(place.width).toBe("100%");
    expect(place.anchor).toBe("top-left");
    expect(place.col).toBe(0);
  });

  it("trims the compositor's terminal-height padding while it is mounted", async () => {
    const harness = await setup();
    await runGoal(harness, "ship the plan");
    await pressPanelKey(harness);
    const tui = harness.ui.tui;
    // A short base render: without the trim, Pi's padding becomes scrollback rows that show as blank lines.
    expect(tui.compositeOverlays(["a", "b", "c"], 100, 24)).toEqual(["a", "b", "c"]);

    // A shrink redraw is only possible with the overlay off the stack for that frame, and it goes straight back.
    tui.maxLinesRendered = 30;
    expect(tui.compositeOverlays(["a"], 100, 24)).toEqual(["a"]);
    expect(tui.overlayStack).toHaveLength(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(tui.overlayStack).toHaveLength(1);

    // Closing the panel restores the compositor, so the next session's renders are Pi's again.
    harness.ui.overlays[0].close();
    await Promise.resolve();
    expect(tui.compositeOverlays(["a"], 100, 24)).toHaveLength(24);
  });

  it("shows the new state without remounting", async () => {
    const harness = await setup();
    await runGoal(harness, "ship the plan");
    await runTodo(harness, "restart the pods");
    await pressPanelKey(harness);
    await callTodos(harness, { action: "add", text: "write the docs", why: "the contract is the docs" });

    // One overlay still, not a close-and-reopen: the panel reads the live record when the terminal asks it to draw.
    expect(harness.ui.overlays).toHaveLength(1);
    const lines = harness.ui.overlays[0].component.render(120).join("\n");
    expect(lines).toContain("restart the pods");
    expect(lines).toContain("write the docs");
    expect(lines).toContain("the contract is the docs");
    expect(lines).toContain("2 open");
  });

  it("caps what it draws and says what it cut", async () => {
    const harness = await setup();
    for (let i = 1; i <= 12; i += 1) await runTodo(harness, `step ${i}`);
    await pressPanelKey(harness);
    const lines = harness.ui.overlays[0].component.render(200);
    expect(lines.join("\n")).toContain(`step ${PANEL_MAX_STEPS}`);
    expect(lines.join("\n")).not.toContain(`step ${PANEL_MAX_STEPS + 1}`);
    expect(lines.join("\n")).toContain("4 more");
    // Capping the panel is not capping the record: all twelve are still on disk, and still in the prompt.
    expect(planOnDisk(harness.cwd).todos).toHaveLength(12);
    expect((await startTurn(harness))[SECTION_KEY]).toContain("12 open");
  });

  it("says so when the overlay cannot be mounted", async () => {
    // A keypress that does nothing is indistinguishable from a binding the terminal never delivered, which is a
    // support nightmare for a feature whose whole interface is a key. So the failure is named.
    const harness = await setup();
    await runGoal(harness, "ship the plan");
    harness.ui.customError = new Error("overlay stack is full");
    await pressPanelKey(harness);
    const warning = harness.ui.notifications.find((n) => n.level === "warning");
    expect(warning?.message).toContain("plan panel");
    expect(warning?.message).toContain("overlay stack is full");
  });

  it("draws the detail into the widget where there is no scrollback", async () => {
    // Fullscreen (alt-screen) mode has no lines that have already scrolled away, so an overlay rising from the
    // compact row would cover the viewport for no reason: the widget itself carries the detail there.
    const harness = await setup();
    await runGoal(harness, "ship the plan");
    await runTodo(harness, "restart the pods");
    harness.ui.tui.mode = "fullscreen";
    await harness.pi.commands.get("todo")!.handler!("hide", harness.context);
    await runTodo(harness, "show");
    expect(harness.ui.overlays).toHaveLength(0);
    const lines = widgetLines(harness)!;
    expect(lines.join("\n")).toContain("restart the pods");
    expect(lines.join("\n")).toContain("◆ goal");
    expect(lines.length).toBeGreaterThan(1);
  });

  it("says nothing when it is opened or closed", async () => {
    const harness = await setup();
    await runGoal(harness, "ship the plan");
    const before = harness.ui.notifications.length;
    await pressPanelKey(harness);
    await pressPanelKey(harness);
    expect(harness.ui.notifications).toHaveLength(before);
    // `/todo show|hide` is the same door, and equally quiet where a panel can actually appear.
    await runTodo(harness, "show");
    await runTodo(harness, "hide");
    expect(harness.ui.notifications).toHaveLength(before);
  });

  it("falls back to plain lines where there is no overlay", async () => {
    const harness = await setup({ hasUI: true, mode: "rpc" });
    await runGoal(harness, "ship the plan");
    await runTodo(harness, "restart the pods");
    expect(widgetLines(harness)).toEqual(["◆ ship the plan", "1 open"]);
    await runTodo(harness, "show");
    const lines = widgetLines(harness)!;
    expect(harness.ui.overlays).toHaveLength(0);
    expect(lines[0]).toContain("Plan");
    expect(lines.join("\n")).toContain("restart the pods");
    expect(lines.join("\n")).toContain("1 open · 0 in progress · 0 done · 0 retired");
  });

  it("paints nothing without a UI, and still writes", async () => {
    const harness = await setup({ hasUI: false, mode: "print" });
    await runTodo(harness, "quietly added");
    expect(harness.ui.notifications).toHaveLength(0);
    expect(harness.ui.statuses.size).toBe(0);
    expect(harness.ui.widgets.size).toBe(0);
    expect(planOnDisk(harness.cwd).todos).toEqual([expect.objectContaining({ text: "quietly added" })]);
  });

  it("shows the aim in the status line alongside what is still open", async () => {
    const harness = await setup();
    await runGoal(harness, "operationalize the fleet's memory");
    await runTodo(harness, "restart the pods");
    await runTodo(harness, "write the docs");
    expect(harness.ui.statuses.get(STATUS_KEY)).toBe("🎯 operationalize the fleet's memory · 2 steps open");
    await runTodo(harness, "done t1");
    expect(harness.ui.statuses.get(STATUS_KEY)).toBe("🎯 operationalize the fleet's memory · 1 step open");
  });
});
