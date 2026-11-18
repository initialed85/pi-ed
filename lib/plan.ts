/**
 * The plan record: goal, direction, todos. Shared substrate for the `/goal`, `/todo` and `/direction` commands.
 *
 * This lives outside `extensions/` for the same reason `lib/redact.ts` does: Pi discovers every `.ts` file in
 * `extensions/` and a helper is not an extension. Everything here is pure over a passed-in clock and a passed-in
 * root directory, so the substrate can be tested without a session, a TUI, or a model.
 *
 * Three decisions this file encodes, because they were made in planning and code without them drifts:
 *
 *   1. **One file per session id**, at `<repo>/.pi/plan/<session-id>.json`. Session id is the key precisely because
 *      it gives the inheritance rule we want for free: `pi -c` continues the same id (this repository's own long
 *      session is one 11.9k-line file spanning two compactions and six days), a fresh `pi` gets a new id and starts
 *      blank, and `/clear` starts a fresh session too. No name matching, no inherited stale goals.
 *
 *   2. **The directory is self-ignoring.** `ensurePlanDir` writes `.pi/plan/.gitignore` containing `*` and
 *      `!.gitignore`, the same shape `extensions/schedule.ts` uses for `.pi/schedule/`. A plan is runtime state
 *      about one agent's session, and this repository is public. There is precedent for why that has to be automatic
 *      rather than remembered: `cdfbaa5` committed a session screenshot into the repo because `git add -A` found it.
 *
 *   3. **The repository directory is shared, the sessions are not.** Every agent pod in this fleet mounts
 *      `/workspace` with `subPath: workspace` — the same tree in all of them — so two agents working in one checkout
 *      are concurrent writers by default, not by accident. That is why writes are atomic (temp file in the same
 *      directory, then `rename`), why a corrupt file is reported instead of overwritten, and why a session id is
 *      validated before it ever reaches `path.join`.
 *
 * What is deliberately *not* here: no Pi imports beyond `CONFIG_DIR_NAME`, no `Date.now()`, no UI, no tool
 * definitions, and no autopilot interaction. Wiring this to commands, the transcript entries, the compaction
 * renewal block, and the overlay panel is the job of the extensions that consume it.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const PLAN_SCHEMA_VERSION = 1;
/** The subdirectory of the project config dir that holds plan state. */
export const PLAN_DIR_NAME = "plan";

/** Goal and direction are held short: they are re-injected into context, not archived. */
export const GOAL_MAX_CHARS = 200;
export const DIRECTION_MAX_CHARS = 200;
/** A todo's one-line "why". Kept shorter than the item itself: it is context, not documentation. */
export const WHY_MAX_CHARS = 90;
/**
 * One step, one line. The same number the `todos` tool quotes in its own parameter description, so what the model is
 * told the limit is and what the writer enforces cannot drift apart.
 */
export const TODO_MAX_CHARS = 200;
/**
 * Ceiling on the rendered block. ~4 chars/token at this fleet's models, so 2600 chars is the ~650 tokens the
 * planning conversation priced a twelve-item plan at; the point of the cap is that a very long todo list cannot
 * silently turn the renewal block into a summary-sized one.
 */
export const PLAN_BLOCK_MAX_CHARS = 2600;

export type TodoState = "todo" | "in_progress" | "done" | "superseded";

export type Todo = {
  /** Stable per-plan id (`t1`, `t2`, …): readable in a panel and in a transcript entry, and it survives editing. */
  id: string;
  text: string;
  /** Why the item exists. One line. Without it a later reader cannot tell superseded from forgotten. */
  why?: string;
  state: TodoState;
  /** For `superseded`: why the item was retired. Required, and the reason the model's authority is auditable. */
  note?: string;
  /** ISO timestamps, supplied by the caller so the substrate never depends on a wall clock. */
  at: string;
  done_at?: string;
};

export type PlanRecord = {
  v: typeof PLAN_SCHEMA_VERSION;
  session_id: string;
  goal?: string;
  goal_at?: string;
  /** The text `setGoal` replaced. One deep on purpose: enough to show what changed, not a changelog. */
  goal_prev?: string;
  direction?: string;
  direction_at?: string;
  direction_prev?: string;
  todos: Todo[];
  updated_at: string;
  /**
   * Set when the session that owned this plan ended, and cleared if it comes back. It exists for the reader who is
   * not that session: the plans of a checkout sit in one directory as plain JSON, so a model that lists `.pi/plan/`
   * finds every session that ever ran here, and without this stamp a finished session's list looks exactly like live
   * instructions. (Measured: a fresh session `find`ed the directory, read another session's paperclip todos, and
   * started acting on them.)
   */
  ended_at?: string;
};

/** The result of a mutation: always a usable plan, plus a problem when the request was refused. */
export type Mutation = { plan: PlanRecord; changed: boolean; problem?: string };

export type ReadResult = { plan?: PlanRecord; problem?: string };

/** A new, empty plan for a session. */
export function emptyPlan(sessionId: string, at: string): PlanRecord {
  return { v: PLAN_SCHEMA_VERSION, session_id: sessionId, todos: [], updated_at: at };
}

/**
 * A session id is used to build a filename, so it is validated before it is joined, not after.
 *
 * Pi's ids are lowercase UUIDv7 and that is the shape accepted, plus a deliberately narrow allowance for a
 * caller-supplied label matching `[a-z0-9][a-z0-9._-]{0,63}`. Anything with a separator, a dot-prefix, or a
 * character outside those sets is refused: `path.join(root, dir, id + ".json")` is not a boundary, and the
 * `..` in `../../etc/passwd` is exactly the kind of string that arrives from a value another process wrote.
 */
export function safeSessionId(candidate: string | undefined | null): string | undefined {
  const id = String(candidate ?? "").trim();
  if (!id) return undefined;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return undefined;
  if (id.startsWith(".")) return undefined;
  const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const labelShape = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  if (!uuidShape.test(id) && !labelShape.test(id)) return undefined;
  return id;
}

/** Where plan state lives for a repository root. */
export function planDir(root: string): string {
  return join(root, CONFIG_DIR_NAME, PLAN_DIR_NAME);
}

export function planPath(root: string, sessionId: string): string | undefined {
  const id = safeSessionId(sessionId);
  return id ? join(planDir(root), `${id}.json`) : undefined;
}

/**
 * Create `.pi/plan/` and make sure it cannot dirty the repository.
 *
 * The ignore file is written on demand rather than committed, so a checkout that has never run a plan command is
 * not carrying an empty directory - and so that a `git clean -fdx` cannot remove the guard and leave the next
 * session's plans committable. Content mirrors `.pi/schedule/.gitignore`: ignore everything, un-ignore the guard.
 */
export function ensurePlanDir(root: string): string {
  const dir = planDir(root);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) {
    writeFileSync(
      ignore,
      "# Written by pi-ed's plan substrate: everything in here is runtime state about one agent's\n"
        + "# session (goal, direction, todos), keyed by session id. None of it belongs in the repository.\n*\n!.gitignore\n",
    );
  }
  return dir;
}

/** Read a session's plan. Missing is `{}`-equivalent (no plan); unreadable or corrupt is a reported problem. */
export function readPlan(root: string, sessionId: string): ReadResult {
  const path = planPath(root, sessionId);
  if (!path) return { problem: `refused session id: ${JSON.stringify(String(sessionId ?? "").slice(0, 40))}` };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return {};
    return { problem: `cannot read ${basename(path)}: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A torn file is reported, never replaced silently: an overwrite here would erase someone's open goal, and the
    // only writer that can fix it is a person who no longer has the contents.
    return { problem: `${basename(path)} is not valid JSON (${(error as Error).message}); refusing to overwrite it` };
  }
  const normalized = normalizePlan(parsed, sessionId);
  if ("problem" in normalized) return normalized;
  return { plan: normalized.plan };
}

/**
 * Write a session's plan atomically.
 *
 * Temp file in the same directory, then `rename`: a reader either sees the whole previous file or the whole new
 * one, never the half that a killed process left behind. Same-directory is not an optimisation - `rename` across
 * filesystems is an `EXDEV`, and `/workspace` is an NFS mount here while a temp in `/tmp` would not be.
 */
export function writePlan(root: string, plan: PlanRecord): { ok: true; path: string } | { ok: false; error: string } {
  const path = planPath(root, plan.session_id);
  if (!path) return { ok: false, error: `refused session id: ${JSON.stringify(String(plan.session_id).slice(0, 40))}` };
  ensurePlanDir(root);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is disposable; the error we are about to report is not.
    }
    return { ok: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Mutations. Pure, clock-supplied, and each refuses rather than inventing.
// ---------------------------------------------------------------------------

const clip = (text: string, max: number): string => {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

function touch(plan: PlanRecord, at: string): PlanRecord {
  return { ...plan, updated_at: at };
}

/** Set (overwriting) the goal. The replaced text is kept one deep so the change is visible. */
export function setGoal(plan: PlanRecord, text: string, at: string): Mutation {
  const goal = clip(text, GOAL_MAX_CHARS);
  if (!goal) return { plan, changed: false, problem: "an empty goal would clear the goal; use clearGoal" };
  if (goal === plan.goal) return { plan, changed: false };
  return { plan: touch({ ...plan, goal_prev: plan.goal, goal, goal_at: at }, at), changed: true };
}

export function clearGoal(plan: PlanRecord, at: string): Mutation {
  if (!plan.goal) return { plan, changed: false };
  return { plan: touch({ ...plan, goal_prev: plan.goal, goal: undefined, goal_at: undefined }, at), changed: true };
}

/** Set (overwriting) the direction. Deliberately the same shape as a goal: `/direction` is a second door, not a second format. */
export function setDirection(plan: PlanRecord, text: string, at: string): Mutation {
  const direction = clip(text, DIRECTION_MAX_CHARS);
  if (!direction) return { plan, changed: false, problem: "an empty direction would clear it; use clearDirection" };
  if (direction === plan.direction) return { plan, changed: false };
  return { plan: touch({ ...plan, direction_prev: plan.direction, direction, direction_at: at }, at), changed: true };
}

export function clearDirection(plan: PlanRecord, at: string): Mutation {
  if (!plan.direction) return { plan, changed: false };
  return { plan: touch({ ...plan, direction_prev: plan.direction, direction: undefined, direction_at: undefined }, at), changed: true };
}

/** The next `t<n>`, ignoring ids that were retired, so an id is never reused. */
function nextTodoId(todos: Todo[]): string {
  let highest = 0;
  for (const todo of todos) {
    const n = /^t(\d+)$/.exec(todo.id)?.[1];
    if (n) highest = Math.max(highest, Number(n));
  }
  return `t${highest + 1}`;
}

export function addTodo(plan: PlanRecord, input: { text: string; why?: string }, at: string): Mutation {
  const text = clip(input.text, TODO_MAX_CHARS);
  if (!text) return { plan, changed: false, problem: "a todo needs text" };
  // Same text already open: refuse rather than duplicate. An agent that re-adds what it just added is describing
  // the same thing twice, and two open copies of one item make the count a lie.
  if (plan.todos.some((t) => t.text.toLowerCase() === text.toLowerCase() && (t.state === "todo" || t.state === "in_progress"))) {
    return { plan, changed: false, problem: `${text} is already open` };
  }
  const todo: Todo = { id: nextTodoId(plan.todos), text, state: "todo", at };
  const why = input.why ? clip(input.why, WHY_MAX_CHARS) : undefined;
  if (why) todo.why = why;
  return { plan: touch({ ...plan, todos: [...plan.todos, todo] }, at), changed: true };
}

function mutateTodo(plan: PlanRecord, id: string, at: string, apply: (todo: Todo) => Todo | undefined, noChange?: (todo: Todo) => string): Mutation {
  const found = plan.todos.find((t) => t.id === id);
  if (!found) return { plan, changed: false, problem: `no todo ${id}` };
  const next = apply(found);
  if (!next) return { plan, changed: false, problem: noChange ? noChange(found) : `${id} is already ${found.state}` };
  return { plan: touch({ ...plan, todos: plan.todos.map((t) => (t.id === id ? next : t)) }, at), changed: true };
}

export function startTodo(plan: PlanRecord, id: string, at: string): Mutation {
  return mutateTodo(plan, id, at, (todo) =>
    todo.state === "todo" ? { ...todo, state: "in_progress", at } : undefined);
}

export function completeTodo(plan: PlanRecord, id: string, at: string): Mutation {
  return mutateTodo(plan, id, at, (todo) =>
    todo.state === "done" ? undefined : { ...todo, state: "done", done_at: at, at });
}

/**
 * Retire an item, with a reason.
 *
 * The reason is required because this is the operation where the model is exercising judgement over a list a human
 * wrote ("that todo was stupid given what we turned out to be doing"). Authority without a recorded reason is
 * indistinguishable from forgetting, and the human reviewing the session later cannot overrule a decision they
 * cannot see.
 */
export function supersedeTodo(plan: PlanRecord, id: string, reason: string, at: string): Mutation {
  const note = clip(reason, WHY_MAX_CHARS);
  if (!note) return { plan, changed: false, problem: "superseding needs a one-line reason" };
  return mutateTodo(plan, id, at, (todo) =>
    todo.state === "superseded" && todo.note === note ? undefined : { ...todo, state: "superseded", note, done_at: at, at });
}

/** Correct an item's text or why, keeping its id and state. */
export function editTodo(plan: PlanRecord, id: string, input: { text?: string; why?: string }, at: string): Mutation {
  return mutateTodo(plan, id, at, (todo) => {
    const text = input.text ? clip(input.text, TODO_MAX_CHARS) : todo.text;
    const why = input.why !== undefined ? clip(input.why, WHY_MAX_CHARS) : todo.why;
    if (text === todo.text && why === todo.why) return undefined;
    return { ...todo, text, why, at };
  }, (todo) => `${todo.id} already reads ${todo.text}`);
}

export type PlanCounts = { open: number; inProgress: number; done: number; superseded: number };

export function countTodos(plan: PlanRecord): PlanCounts {
  const counts: PlanCounts = { open: 0, inProgress: 0, done: 0, superseded: 0 };
  for (const todo of plan.todos) {
    if (todo.state === "todo") counts.open += 1;
    else if (todo.state === "in_progress") counts.inProgress += 1;
    else if (todo.state === "done") counts.done += 1;
    else counts.superseded += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MARK: Record<TodoState, string> = { todo: "[ ]", in_progress: "[~]", done: "[x]", superseded: "[!]" };

/**
 * Stamp the plan as belonging to an ended session. Only ever called on a plan with content: an empty plan is not
 * worth a file, let alone a stamp, and writing one on quit would create state that did not exist before the quit.
 */
export function endPlan(plan: PlanRecord, at: string): { plan: PlanRecord; changed: boolean } {
  if (plan.ended_at || planIsEmpty(plan)) return { plan, changed: false };
  return { plan: touch({ ...plan, ended_at: at }, at), changed: true };
}

/** Drop the stamp, because this session is alive again (`pi -c`, a resume, a fork). */
export function reopenPlan(plan: PlanRecord): { plan: PlanRecord; changed: boolean } {
  if (!plan.ended_at) return { plan, changed: false };
  const next = { ...plan };
  delete next.ended_at;
  return { plan: next, changed: true };
}

/**
 * The plan as a compact block, for re-describing state where context is rebuilt (a compaction renewal, a resumed
 * session, the overlay panel's text fallback).
 *
 * Sized on purpose: goal and direction are clipped to their own caps, open and in-progress items carry their why,
 * and completed and superseded items are shown only a few deep because they are history, not the plan. What is cut
 * says it was cut and where the rest lives, so a reader is never left believing a short list is a complete one.
 */
/**
 * What each label *is*, in the block itself, because the bare labels lost an ordering contest to a checklist.
 *
 * The wording is measured, not chosen, and the measurement is what matters as much as the result: three candidate
 * sentences were run against the same conflicting plan (`DIRECTION acquire paperclips` with `[ ] t1 write the
 * changelog`) and the same aligned one, with the pointer swapped, using `hack/plan-wording-probe.sh`.
 *
 * - no pointer: one run took the step and never mentioned the route, another noticed on its own - so it is a coin
 *   toss whether the human's stated route is weighed at all;
 * - "aim and route are the human's; steps are yours to move": took the step with "no conflict" twice, and on the
 *   aligned plan *invented* a conflict (`TODO conflicts with DIRECTION`). Framing the route as belonging to somebody
 *   else made the model read it as something to defer to rather than something to weigh;
 * - the wording below: surfaced the real conflict in both runs (`Acquire paperclips; DIRECTION conflicts with TODO`,
 *   `Question t1; DIRECTION conflicts with TODO t1`) and correctly reported no conflict on the aligned plan.
 *
 * That last contrast is the whole behaviour wanted: notice a disagreement between the route and a step, and do not
 * stall when there is none. Two earlier readings of this script were thrown out because they were fiction - see the
 * session-id note in `hack/plan-wording-probe.sh`, which is now the reason every probe takes a fresh id.
 *
 * The session clause is for the other measured failure: a model that lists `.pi/plan/` finds every session's plan in
 * the checkout, and will read a stranger's open steps as instructions unless the text tells it whose plan it is.
 */
function pointer(plan: PlanRecord): string {
  const bits = [
    "TODO steps are the work; DIRECTION is the human's route and decides which step comes next",
    "a step that no longer fits the route should be questioned rather than done",
    `this is session ${plan.session_id}'s plan; the other files in ${CONFIG_DIR_NAME}/${PLAN_DIR_NAME}/ belong to other sessions`,
  ];
  if (plan.ended_at) bits.push(`this plan's session ended ${plan.ended_at}`);
  return bits.join(" \u00b7 ");
}

export function renderPlanBlock(plan: PlanRecord, options: { recentDone?: number } = {}): string {
  const recentDone = options.recentDone ?? 3;
  const lines: string[] = [];
  const counts = countTodos(plan);

  if (plan.goal) lines.push(`GOAL      ${clip(plan.goal, GOAL_MAX_CHARS)}`);
  if (plan.direction) lines.push(`DIRECTION ${clip(plan.direction, DIRECTION_MAX_CHARS)}`);

  if (plan.todos.length) {
    lines.push(`TODO      ${counts.open} open · ${counts.inProgress} in progress · ${counts.done} done · ${counts.superseded} superseded`);
    const active = plan.todos.filter((t) => t.state === "in_progress" || t.state === "todo");
    for (const todo of active) {
      lines.push(`  ${MARK[todo.state]} ${todo.id} ${todo.text}${todo.why ? ` — ${todo.why}` : ""}`);
    }
    for (const todo of plan.todos.filter((t) => t.state === "superseded").slice(-recentDone)) {
      lines.push(`  ${MARK.superseded} ${todo.id} ${todo.text}${todo.note ? ` — superseded: ${todo.note}` : ""}`);
    }
    for (const todo of plan.todos.filter((t) => t.state === "done").slice(-recentDone)) {
      lines.push(`  ${MARK.done} ${todo.id} ${todo.text}`);
    }
  }

  if (!lines.length) return "";

  // Trim to budget by dropping the rendered items from the end (history first, since active items were pushed
  // first), never the GOAL/DIRECTION lines. The reserve is the pointer line's own room: without it a trim that
  // lands exactly on the budget goes over the moment it says "there is more" - which is the failure this cap
  // exists to prevent, so it is measured rather than eyeballed.
  const header = `# Plan\n${pointer(plan)}`;
  const POINTER_RESERVE = 96;
  const budget = PLAN_BLOCK_MAX_CHARS - POINTER_RESERVE;
  let body = lines;
  const overBudget = () => `${header}\n${body.join("\n")}`.length > budget;
  while (overBudget() && body.length > 3) body = body.slice(0, -1);
  const dropped = lines.length - body.length;
  if (dropped > 0) body.push(`  (+${dropped} more in ${CONFIG_DIR_NAME}/${PLAN_DIR_NAME}/${plan.session_id}.json)`);
  return `${header}\n${body.join("\n")}`;
}

/** Rough token cost of a block, on the same chars/4 estimate the compaction guard uses. */
export function estimatedTokens(text: string): number {
  return Math.ceil(String(text ?? "").length / 4);
}

/** True when there is nothing to say: no goal, no direction, no items. */
export function planIsEmpty(plan: PlanRecord): boolean {
  return !plan.goal && !plan.direction && plan.todos.length === 0;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Accept what is on disk, reject what is not a plan.
 *
 * Fields are whitelisted rather than spread, so a file written by an older or newer shape cannot smuggle keys into
 * a render or a write-back, and an unknown `v` is a problem rather than a silent reinterpretation.
 */
function normalizePlan(input: unknown, sessionId: string): { plan: PlanRecord } | { problem: string } {
  const raw = (input ?? {}) as Partial<PlanRecord> & Record<string, unknown>;
  if (Number(raw.v) !== PLAN_SCHEMA_VERSION) {
    return { problem: `${sessionId} plan has schema v${String(raw.v)}; this build writes v${PLAN_SCHEMA_VERSION} and will not reinterpret it` };
  }
  const todos: Todo[] = [];
  for (const item of Array.isArray(raw.todos) ? raw.todos : []) {
    const todo = item as Partial<Todo>;
    const text = typeof todo?.text === "string" ? clip(todo.text, TODO_MAX_CHARS) : "";
    const at = typeof todo?.at === "string" ? todo.at : "";
    if (!text || !at) continue;
    const state: TodoState = todo.state === "in_progress" || todo.state === "done" || todo.state === "superseded" ? todo.state : "todo";
    const id = typeof todo.id === "string" && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(todo.id) ? todo.id : `t${todos.length + 1}`;
    const next: Todo = { id, text, state, at };
    if (typeof todo.why === "string" && todo.why.trim()) next.why = clip(todo.why, WHY_MAX_CHARS);
    if (typeof todo.note === "string" && todo.note.trim()) next.note = clip(todo.note, WHY_MAX_CHARS);
    if (typeof todo.done_at === "string") next.done_at = todo.done_at;
    todos.push(next);
  }
  const plan: PlanRecord = { v: PLAN_SCHEMA_VERSION, session_id: sessionId, todos, updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "" };
  if (typeof raw.goal === "string" && raw.goal.trim()) plan.goal = clip(raw.goal, GOAL_MAX_CHARS);
  if (typeof raw.goal_at === "string") plan.goal_at = raw.goal_at;
  if (typeof raw.goal_prev === "string") plan.goal_prev = clip(raw.goal_prev, GOAL_MAX_CHARS);
  if (typeof raw.direction === "string" && raw.direction.trim()) plan.direction = clip(raw.direction, DIRECTION_MAX_CHARS);
  if (typeof raw.direction_at === "string") plan.direction_at = raw.direction_at;
  if (typeof raw.direction_prev === "string") plan.direction_prev = clip(raw.direction_prev, DIRECTION_MAX_CHARS);
  // Carried through rather than dropped: a stamp a reader cannot see is a stamp that does nothing.
  if (typeof raw.ended_at === "string" && raw.ended_at) plan.ended_at = raw.ended_at;
  return { plan };
}

/** The directory a plan file sits in, for callers that want to report where state lives. */
export function planDirOf(path: string): string {
  return dirname(path);
}
