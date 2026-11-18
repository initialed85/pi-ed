import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addTodo,
  clearGoal,
  completeTodo,
  countTodos,
  editTodo,
  emptyPlan,
  ensurePlanDir,
  estimatedTokens,
  GOAL_MAX_CHARS,
  planDir,
  planIsEmpty,
  planPath,
  PLAN_BLOCK_MAX_CHARS,
  readPlan,
  renderPlanBlock,
  safeSessionId,
  setDirection,
  setGoal,
  startTodo,
  supersedeTodo,
  writePlan,
  type PlanRecord,
} from "../lib/plan.ts";

/**
 * The plan substrate, tested without a session, a TUI, or a model.
 *
 * Three of these tests exist because of things measured elsewhere in this fleet rather than because the code looked
 * hard, and they are the ones worth reading first:
 *
 *   - **no two sessions share a file.** Every agent pod in home-dev mounts `/workspace` with `subPath: workspace`,
 *     the same tree in all 21 of them, so concurrent writers in one checkout are the normal case. Keyed by session
 *     id, and the id reaches `path.join`, so the id is validated *before* the join - `planPath` returning
 *     `undefined` for `../../etc/passwd` is the boundary, not a nicety.
 *   - **the directory ignores itself.** `.pi/plan/.gitignore` is written on demand, because this repository is
 *     public and `git add -A` has already committed a session artifact once (`cdfbaa5`, a screenshot). A guard that
 *     depends on someone remembering it is not a guard.
 *   - **the rendered block stays small.** The planning conversation priced a twelve-item plan with a one-line why
 *     each at roughly 650 tokens; the block is what gets re-described after compaction, so the cap and the
 *     "+N more" pointer are pinned here rather than trusted to a comment.
 *
 * Everything else is the contract the commands and tools will be built on: transitions that refuse instead of
 * inventing, a supersede that cannot happen without a reason, a corrupt file that is reported rather than
 * overwritten, and mutations that do not touch their input.
 */

const AT = "2026-11-12T00:00:00.000Z";
const LATER = "2026-11-12T00:05:00.000Z";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-ed-plan-"));
});

const newPlan = (sessionId = "01a1a9b1-795c-7190-862e-cde05ddd7bc0"): PlanRecord => emptyPlan(sessionId, AT);

describe("session id handling", () => {
  it("accepts pi's own uuid shape and a narrow label shape", () => {
    expect(safeSessionId("01a1a9b1-795c-7190-862e-cde05ddd7bc0")).toBe("01a1a9b1-795c-7190-862e-cde05ddd7bc0");
    expect(safeSessionId("step-0")).toBe("step-0");
  });

  it("refuses anything that could escape the plan directory", () => {
    // The whole point: the id is joined into a path, so these are not malformed input, they are writes elsewhere.
    for (const hostile of ["../../etc/passwd", "..", ".hidden", "a/b", "a\\b", "with space", "UPPER/CASE", "", "   ", "t".repeat(200)]) {
      expect(safeSessionId(hostile), `safeSessionId(${JSON.stringify(hostile)})`).toBeUndefined();
      expect(planPath(root, hostile)).toBeUndefined();
    }
  });

  it("refuses a hostile id at the io boundary rather than writing it", () => {
    const read = readPlan(root, "../escape");
    expect(read.problem).toMatch(/refused session id/);
    const written = writePlan(root, { ...newPlan(), session_id: "../escape" });
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.error).toMatch(/refused session id/);
    // Nothing was created outside the plan directory.
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("one file per session", () => {
  it("keeps two sessions in the same checkout from seeing each other", () => {
    const a = setGoal(newPlan("01a1a9b1-795c-7190-862e-cde05ddd7bc0"), "ship the substrate", AT).plan;
    const b = setGoal(newPlan("01a1b65e-1111-7222-8333-cde05ddd7bc0"), "something else entirely", AT).plan;
    expect(writePlan(root, a).ok).toBe(true);
    expect(writePlan(root, b).ok).toBe(true);

    expect(readPlan(root, a.session_id).plan?.goal).toBe("ship the substrate");
    expect(readPlan(root, b.session_id).plan?.goal).toBe("something else entirely");
    expect(readdirSync(planDir(root)).filter((f) => f.endsWith(".json"))).toHaveLength(2);
  });

  it("round-trips through JSON exactly, and leaves no temp file behind", () => {
    let plan = addTodo(newPlan(), { text: "write the io helpers", why: "everything else sits on them" }, AT).plan;
    plan = addTodo(plan, { text: "test it", why: "no test, no trust" }, AT).plan;
    plan = startTodo(plan, "t1", AT).plan;
    plan = supersedeTodo(plan, "t2", "covered by the fixture suite", LATER).plan;

    const written = writePlan(root, plan);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const back = readPlan(root, plan.session_id).plan;
    expect(back).toEqual(plan);
    expect(readdirSync(planDir(root)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("reports a corrupt file instead of silently replacing it", () => {
    const path = planPath(root, newPlan().session_id)!;
    ensurePlanDir(root);
    writeFileSync(path, '{ "v": 1, "session_id": "oops"');
    const read = readPlan(root, newPlan().session_id);
    expect(read.plan).toBeUndefined();
    expect(read.problem).toMatch(/not valid JSON.*refusing to overwrite/s);
    // The damaged bytes are still there for a human to read.
    expect(readFileSync(path, "utf8")).toContain("oops");
  });

  it("refuses a schema it cannot reinterpret, rather than rewriting it", () => {
    const path = planPath(root, newPlan().session_id)!;
    ensurePlanDir(root);
    writeFileSync(path, JSON.stringify({ v: 7, session_id: newPlan().session_id, todos: [] }));
    const read = readPlan(root, newPlan().session_id);
    expect(read.plan).toBeUndefined();
    expect(read.problem).toMatch(/schema v7/);
  });

  it("does not smuggle unknown keys through normalisation", () => {
    const path = planPath(root, newPlan().session_id)!;
    ensurePlanDir(root);
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        session_id: newPlan().session_id,
        todos: [{ id: "t1", text: "fine", state: "todo", at: AT, evil: "payload" }],
        goal: "kept",
        extra_top_level: "dropped",
      }),
    );
    const plan = readPlan(root, newPlan().session_id).plan!;
    expect(Object.keys(plan)).not.toContain("extra_top_level");
    expect(Object.keys(plan.todos[0])).not.toContain("evil");
    expect(plan.goal).toBe("kept");
  });

  it("drops a todo with no text or no timestamp rather than rendering an empty line", () => {
    const path = planPath(root, newPlan().session_id)!;
    ensurePlanDir(root);
    writeFileSync(path, JSON.stringify({
      v: 1,
      session_id: newPlan().session_id,
      todos: [{ id: "t1", text: "  ", state: "todo", at: AT }, { id: "t2", text: "real", state: "todo" }, { id: "t3", text: "kept", state: "todo", at: AT }],
    }));
    const plan = readPlan(root, newPlan().session_id).plan!;
    expect(plan.todos.map((t) => t.text)).toEqual(["kept"]);
  });
});

describe("ensurePlanDir", () => {
  it("writes the ignore guard, and does not clobber an existing one", () => {
    const dir = ensurePlanDir(root);
    const ignore = join(dir, ".gitignore");
    expect(existsSync(ignore)).toBe(true);
    const content = readFileSync(ignore, "utf8");
    expect(content).toContain("\n*\n");
    expect(content).toContain("!.gitignore");

    writeFileSync(ignore, "# mine\n");
    ensurePlanDir(root);
    expect(readFileSync(ignore, "utf8")).toBe("# mine\n");
  });
});

describe("goal and direction", () => {
  it("records a goal, keeps the text it replaced one deep, and refuses an empty set", () => {
    let { plan, changed } = setGoal(newPlan(), "  ship   the /goal command  ", AT);
    expect(changed).toBe(true);
    expect(plan.goal).toBe("ship the /goal command"); // collapsed whitespace, not archived prose
    expect(plan.goal_at).toBe(AT);

    const second = setGoal(plan, "now do /todo", LATER);
    expect(second.plan.goal_prev).toBe("ship the /goal command");
    expect(second.plan.goal).toBe("now do /todo");

    expect(setGoal(plan, "   ", LATER).problem).toMatch(/clearGoal/);
    expect(setGoal(plan, plan.goal!, LATER).changed).toBe(false);
    expect(clearGoal(newPlan(), AT).changed).toBe(false);
  });

  it("clips a goal to the documented ceiling", () => {
    const { plan } = setGoal(newPlan(), "x".repeat(GOAL_MAX_CHARS * 3), AT);
    expect(plan.goal!.length).toBeLessThanOrEqual(GOAL_MAX_CHARS);
    expect(plan.goal!.endsWith("…")).toBe(true);
  });

  it("treats direction as a second door onto the same shape", () => {
    const { plan } = setDirection(newPlan(), "toward fewer surprise regressions", AT);
    expect(plan.direction).toBe("toward fewer surprise regressions");
    expect(plan.direction_at).toBe(AT);
    const replaced = setDirection(plan, "toward legible sessions", LATER).plan;
    expect(replaced.direction_prev).toBe("toward fewer surprise regressions");
  });
});

describe("todos", () => {
  it("assigns never-reused ids in order", () => {
    let plan = addTodo(newPlan(), { text: "one" }, AT).plan;
    plan = addTodo(plan, { text: "two" }, AT).plan;
    plan = supersedeTodo(plan, "t1", "not needed", AT).plan;
    plan = addTodo(plan, { text: "three" }, AT).plan;
    expect(plan.todos.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(plan.todos.find((t) => t.id === "t3")?.text).toBe("three");
  });

  it("refuses to open the same item twice while it is still open", () => {
    const plan = addTodo(newPlan(), { text: "write the io helpers" }, AT).plan;
    const again = addTodo(plan, { text: "Write the io helpers" }, AT);
    expect(again.changed).toBe(false);
    expect(again.problem).toMatch(/already open/);
    // Once it is done, re-adding is legitimate: it is a different piece of work with the same name.
    const done = completeTodo(plan, "t1", LATER).plan;
    expect(addTodo(done, { text: "write the io helpers", why: "v2" }, LATER).changed).toBe(true);
  });

  it("moves through the states, and says so when a move is a no-op", () => {
    let plan = addTodo(newPlan(), { text: "step 0", why: "paths and schema" }, AT).plan;
    expect(plan.todos[0].state).toBe("todo");
    expect(startTodo(plan, "t1", AT).plan.todos[0].state).toBe("in_progress");
    const finished = completeTodo(startTodo(plan, "t1", AT).plan, "t1", LATER).plan;
    expect(finished.todos[0].state).toBe("done");
    expect(finished.todos[0].done_at).toBe(LATER);
    expect(completeTodo(finished, "t1", LATER).changed).toBe(false);
    expect(startTodo(finished, "t9", AT).problem).toMatch(/no todo t9/);
  });

  it("cannot supersede without a reason", () => {
    const plan = addTodo(newPlan(), { text: "name-matching inheritance" }, AT).plan;
    expect(supersedeTodo(plan, "t1", "   ", AT).problem).toMatch(/superseding needs a one-line reason/);
    const retired = supersedeTodo(plan, "t1", "session id keying already does this", AT).plan;
    expect(retired.todos[0].state).toBe("superseded");
    expect(retired.todos[0].note).toBe("session id keying already does this");
    expect(supersedeTodo(retired, "t1", "session id keying already does this", AT).changed).toBe(false);
  });

  it("edits text and why without touching the id or the state", () => {
    let plan = addTodo(newPlan(), { text: "subtrate", why: "typo" }, AT).plan;
    plan = startTodo(plan, "t1", AT).plan;
    const edited = editTodo(plan, "t1", { text: "substrate" }, LATER).plan;
    expect(edited.todos[0]).toMatchObject({ id: "t1", text: "substrate", state: "in_progress", why: "typo" });
    expect(editTodo(edited, "t1", { text: "substrate" }, LATER).problem).toMatch(/already reads substrate/);
  });

  it("counts each state exactly once", () => {
    let plan = addTodo(newPlan(), { text: "a" }, AT).plan;
    plan = addTodo(plan, { text: "b" }, AT).plan;
    plan = addTodo(plan, { text: "c" }, AT).plan;
    plan = addTodo(plan, { text: "d" }, AT).plan;
    plan = startTodo(plan, "t2", AT).plan;
    plan = completeTodo(plan, "t3", AT).plan;
    plan = supersedeTodo(plan, "t4", "not needed", AT).plan;
    expect(countTodos(plan)).toEqual({ open: 1, inProgress: 1, done: 1, superseded: 1 });
    expect(countTodos(newPlan())).toEqual({ open: 0, inProgress: 0, done: 0, superseded: 0 });
  });

  it("does not mutate the plan it was handed", () => {
    // The tools will hold a current plan and apply several mutations to it; an in-place write would mean two
    // callers editing one object see each other's edits without either asking.
    const original = addTodo(newPlan(), { text: "a" }, AT).plan;
    const snapshot = JSON.parse(JSON.stringify(original));
    setGoal(original, "changed", LATER);
    setDirection(original, "changed", LATER);
    startTodo(original, "t1", LATER);
    completeTodo(original, "t1", LATER);
    supersedeTodo(original, "t1", "why not", LATER);
    addTodo(original, { text: "b" }, LATER);
    editTodo(original, "t1", { text: "renamed" }, LATER);
    clearGoal(original, LATER);
    expect(original).toEqual(snapshot);
  });
});

describe("renderPlanBlock", () => {
  const rich = (): PlanRecord => {
    let plan = setGoal(newPlan(), "ship /goal, /todo and /direction as three separate, validated steps", AT).plan;
    plan = setDirection(plan, "toward tooling that keeps its own state legible", AT).plan;
    plan = addTodo(plan, { text: "write the substrate", why: "everything else sits on it" }, AT).plan;
    plan = startTodo(plan, "t1", AT).plan;
    plan = addTodo(plan, { text: "add /goal", why: "cheapest win, and it persists an existing note" }, AT).plan;
    plan = addTodo(plan, { text: "add /todo", why: "the biggest slice, needs the panel" }, AT).plan;
    plan = addTodo(plan, { text: "name-match inheritance", why: "looked useful at the time" }, AT).plan;
    plan = supersedeTodo(plan, "t4", "session id keying already does this", AT).plan;
    plan = addTodo(plan, { text: "pick a shortcut", why: "shift+left measured unclaimed" }, AT).plan;
    return completeTodo(plan, "t5", AT).plan;
  };

  it("shows the goal, the direction, active items with their why, and the counts", () => {
    const block = renderPlanBlock(rich());
    expect(block.startsWith("# Plan")).toBe(true);
    expect(block).toContain("GOAL      ship /goal");
    expect(block).toContain("DIRECTION toward tooling");
    expect(block).toContain("2 open · 1 in progress · 1 done · 1 superseded");
    expect(block).toContain("[~] t1 write the substrate — everything else sits on it");
    expect(block).toContain("[!] t4 name-match inheritance — superseded: session id keying already does this");
    expect(block).toContain("[x] t5 pick a shortcut");
    // Open items come before retired ones: the plan is what you read first.
    expect(block.indexOf("t1")).toBeLessThan(block.indexOf("t4"));
  });

  it("renders nothing when there is nothing to say", () => {
    expect(renderPlanBlock(newPlan())).toBe("");
    expect(planIsEmpty(newPlan())).toBe(true);
    expect(planIsEmpty(rich())).toBe(false);
  });

  it("stays inside the budget it was priced at, and points at the rest", () => {
    let plan = setGoal(newPlan(), "a goal long enough to be annoying ".repeat(8), AT).plan;
    for (let i = 0; i < 60; i++) plan = addTodo(plan, { text: `item ${i} with a fairly long description of the thing`, why: "and a why that is also not short".repeat(3) }, AT).plan;
    const block = renderPlanBlock(plan);
    expect(block.length).toBeLessThanOrEqual(PLAN_BLOCK_MAX_CHARS);
    expect(estimatedTokens(block)).toBeLessThanOrEqual(700);
    expect(block).toMatch(/\(\+\d+ more in \.pi\/plan\/.*\.json\)/);
    // The lines that matter survive the trim.
    expect(block).toContain("GOAL");
    expect(block).toContain("t1 item 0");
  });

  it("prices the realistic twelve-item case at about the number we told the human", () => {
    let plan = setGoal(newPlan(), "ship the plan substrate", AT).plan;
    plan = setDirection(plan, "toward legible sessions", AT).plan;
    for (let i = 0; i < 12; i++) plan = addTodo(plan, { text: `step ${i}: make the plan commands legible in a long session`, why: "because compaction drops things otherwise" }, AT).plan;
    const tokens = estimatedTokens(renderPlanBlock(plan));
    expect(tokens).toBeGreaterThan(200);
    expect(tokens).toBeLessThan(700);
  });
});
