/**
 * `/goal` and `/todo` — the aim of this session and its list of steps, in a file, and from there into the system prompt.
 *
 * A goal is the one piece of state that a long session reliably loses. It is stated at the top, it survives the
 * first twenty turns by being obvious, and then it is buried under everything the session did about it - and the
 * summary that replaces it is written by a model trying to preserve *events*, which is exactly the wrong shape for
 * an intent. The substrate for the answer is `lib/plan.ts`; this file is the wiring: one file per session id, the
 * human sets it, every turn's prompt carries it, and nothing about it depends on the transcript still being long
 * enough to contain the sentence where it was first said.
 *
 * **Why the goal rides as a prompt section rather than as injected messages or a compaction hook.** Pi builds the
 * system prompt from named sections, wraps each in a tag of the same name, and diffs them against what the model
 * already has, appending one system message that patches only the changed sections (`docs/extensions.md`,
 * `before_agent_start`). A section that changes only when the goal changes therefore costs one section the first
 * time and nothing on every turn after it - which is the property this feature needs, because the alternative
 * routes are a per-turn tax or a per-turn transcript write. It also means the goal reappears by itself after a
 * compaction or a context replay, so this extension deliberately does not touch `compaction-summary-guard`: that
 * guard has three separate `return { compaction: result }` paths and both its `overBudget` check and its
 * `trimToBudget` act on `result.summary.length`, so anything appended to the summary text either inflates the
 * guard's own accounting or gets trimmed by it. Coupling a ~650-token renewal block to a 4000-token summary budget
 * is a worse outcome than not coupling at all.
 *
 * **Why the model cannot set the goal, and can move the list.** It reads `<plan>`, it does not write the aim: the
 * goal is the human's, and overwriting it is the authority question this sequence has not answered. The list of
 * steps is the opposite case, so `/todo` ships with a `todos` tool - the work on a list is done by the agent, and a
 * list nobody can move reports `[ ]` about things that are finished. The one action there that retires
 * something a human wrote (`supersede`) requires a reason, which is what lets the human overrule it later.
 * Everything in the sequence shares this file for the same reason: one reader of the record, one writer, one paint.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  addTodo,
  clearGoal,
  completeTodo,
  countTodos,
  editTodo,
  emptyPlan,
  planPath,
  readPlan,
  renderPlanBlock,
  setGoal,
  startTodo,
  supersedeTodo,
  writePlan,
  TODO_MAX_CHARS,
  WHY_MAX_CHARS,
  type Mutation,
  type PlanRecord,
} from "../lib/plan.ts";

/** Status-bar and panel key. Names here are a shared namespace across extensions (`schedules`, `tags`, `auto-resume`). */
const STATUS_KEY = "plan";
const WIDGET_KEY = "plan";
/** The prompt section this extension owns: rendered as `<plan>…</plan>` and patched only when it changes. */
const SECTION_KEY = "plan";
/** Toggles the read-only panel. `shift+left` is unclaimed in `docs/keybindings.md` (`left`/`ctrl+b` move the cursor,
 * `alt+left`/`ctrl+left` move by word and fold the tree), so this binds nothing the editor already uses. */
const PANEL_SHORTCUT = "shift+left";
const MARK = "🎯";
/** Lines the panel shows. Above the editor, every line is screen the prompt does not have. Exported so the test
 * asserts against the real cap rather than a copy of it that can drift. */
export const PANEL_MAX_LINES = 8;
/** Lines `/todo` prints as a notification. The first is the counts, so a truncated notification still says something. */
const REPORT_MAX_ITEMS = 8;
const STATE_MARKS: Record<string, string> = { todo: " ", in_progress: ">", done: "x", superseded: "!" };
const KNOWN_ACTIONS = new Set(["list", "add", "start", "done", "supersede", "edit"]);

/** One step, one line, id first: the id is what every verb takes, so it goes where an eye lands. */
function todoLine(todo: { id: string; text: string; state: string; why?: string; note?: string }): string {
  const note = todo.why ? ` (${todo.why})` : "";
  const retired = todo.note ? ` - retired: ${todo.note}` : "";
  return `${todo.id} [${STATE_MARKS[todo.state] ?? " "}] ${todo.text}${note}${retired}`;
}

/** What `/goal` with no argument clears to. Matched against the whole argument, so a goal may still contain the word. */
const CLEAR_WORDS = /^(clear|none|unset|reset)$/i;

type Loaded = { sessionId: string; plan: PlanRecord; problem?: string };

const TODO_HELP =
  "/todo <text> adds a step · /todo done|start <id> moves it · /todo drop <id> <why> retires it · /todo note <id> <text> sets why · /todo edit <id> <text> rewrites it · /todo show|hide toggles the panel";

/** What a list looks like to a human reading it: counts first, then items with the id every verb takes. */
function planReport(plan: PlanRecord): string {
  const counts = countTodos(plan);
  const header = `${MARK} ${counts.open} open · ${counts.inProgress} in progress`;
  if (plan.todos.length === 0) return `${header} · no steps yet · /todo <text> adds one, ${PANEL_SHORTCUT} shows the panel`;
  const history = counts.done + counts.superseded > 0 ? ` · ${counts.done} done · ${counts.superseded} retired` : "";
  const lines = plan.todos.slice(0, REPORT_MAX_ITEMS).map(todoLine);
  if (plan.todos.length > REPORT_MAX_ITEMS) lines.push(`… ${plan.todos.length - REPORT_MAX_ITEMS} more · .pi/plan/${plan.session_id}.json`);
  return [`${header}${history}`, ...lines].join("\n");
}

export default function activate(pi: ExtensionAPI) {
  /** The record for the session that is currently loaded, or undefined until a session starts. */
  let loaded: Loaded | undefined;
  /** Whether the panel is showing. Per process, and off by default: a plan the human did not ask to see should not
   * spend screen, and the whole point of the file is that the state is there whether or not it is on screen. */
  let panelVisible = false;

  const now = () => new Date().toISOString();

  const sessionIdOf = (ctx: ExtensionContext | ExtensionCommandContext) => ctx.sessionManager.getSessionId();

  /**
   * Read this session's plan. Never throws and never invents: a missing file is simply a session without a plan,
   * while a damaged one is carried as a `problem` so the write paths can refuse instead of replacing it.
   */
  const load = (ctx: ExtensionContext | ExtensionCommandContext): Loaded => {
    const sessionId = sessionIdOf(ctx);
    const found = readPlan(ctx.cwd, sessionId);
    if (found.problem) return { sessionId, plan: emptyPlan(sessionId, now()), problem: found.problem };
    return { sessionId, plan: found.plan ?? emptyPlan(sessionId, now()) };
  };

  /** The loaded record, re-read if the session id changed underneath us (`/new`, `/clone`, a resume). */
  const current = (ctx: ExtensionContext | ExtensionCommandContext): Loaded => {
    if (!loaded || loaded.sessionId !== sessionIdOf(ctx)) loaded = load(ctx);
    return loaded;
  };

  const warn = (ctx: ExtensionContext | ExtensionCommandContext, text: string) => {
    if (ctx.hasUI) ctx.ui.notify(`⚠️ ${text}`, "warning");
  };

  /**
   * The status line, and the panel if it is toggled on. Deliberately short: the goal and the list are also in the
   * prompt where the model reads them in full, and the status line exists to answer "which session am I in, and
   * what is it for" without being looked at directly.
   */
  const paint = (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;
    const record = loaded;
    if (!record) return;
    if (record.problem) {
      ctx.ui.setStatus(STATUS_KEY, `⚠️ ${record.problem.slice(0, 60)}`);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const plan = record.plan;
    const counts = countTodos(plan);
    const aim = plan.goal ?? plan.direction;
    const open = counts.open + counts.inProgress;
    const tally = plan.todos.length > 0 ? `${open} step${open === 1 ? "" : "s"} open` : "";
    const line = [aim ? `${MARK} ${aim.length > 46 ? `${aim.slice(0, 45)}…` : aim}` : "", tally].filter(Boolean).join(" · ");
    ctx.ui.setStatus(STATUS_KEY, line || undefined);

    if (!panelVisible) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    // The panel is the report, cut shorter, with the aim on top. It is built from the same `todoLine` as the
    // notification so the two can never disagree about what a step says.
    // Two lines are spoken for (the aim and the counts), and one more is reserved for the truncation notice: a
    // panel that cut its "and N more" line off would leave a reader believing five steps was the whole list.
    const itemBudget = PANEL_MAX_LINES - 3;
    const shown = plan.todos.slice(0, itemBudget);
    const items = shown.map(todoLine);
    if (plan.todos.length > shown.length) items.push(`… ${plan.todos.length - shown.length} more · /todo for all, ${PANEL_SHORTCUT} to hide`);
    ctx.ui.setWidget(WIDGET_KEY, [
      aim ? `${MARK} ${aim}` : `${MARK} no goal`,
      plan.todos.length === 0 ? `${MARK} no steps yet · /todo <text> adds one` : `${counts.open} open · ${counts.inProgress} in progress`,
      ...items,
    ]);
  };

  /** Commit a mutation: write it first, only then make it the loaded record. A failed write leaves the old one intact. */
  const commit = (ctx: ExtensionContext | ExtensionCommandContext, next: Loaded): boolean => {
    if (next.problem) {
      warn(ctx, `not saved · ${next.problem}`);
      return false;
    }
    const wrote = writePlan(ctx.cwd, next.plan);
    if (!wrote.ok) {
      warn(ctx, `not saved · ${wrote.error}`);
      return false;
    }
    loaded = next;
    paint(ctx);
    return true;
  };

  /**
   * Apply one mutation and save it. Both doors go through here - the command and the tool - so there is exactly one
   * place that decides what an accepted edit looks like and exactly one that refuses a write. Callers build their
   * own message from the mutation they handed in, because the shape of "what happened" differs per verb.
   */
  const applyMutation = (
    ctx: ExtensionContext | ExtensionCommandContext,
    mutation: Mutation,
  ): { ok: boolean; text: string } => {
    if (mutation.problem) return { ok: false, text: mutation.problem };
    if (!mutation.changed) return { ok: true, text: "" };
    const record = current(ctx);
    if (!commit(ctx, { ...record, plan: mutation.plan })) {
      return { ok: false, text: `the change is not saved. ${record.problem ?? ""}`.trim() };
    }
    return { ok: true, text: "" };
  };

  pi.on("session_start", (_event, ctx) => {
    loaded = load(ctx);
    if (!ctx.hasUI) return;
    if (loaded.problem) {
      ctx.ui.notify(`⚠️ plan · ${loaded.problem}`, "warning");
    } else if (loaded.plan.goal) {
      // The point of the keying: `pi -c` continues this id, so a goal set days ago is still the goal. Saying so
      // out loud is what keeps a resumed session from quietly working toward something that has been superseded.
      const when = loaded.plan.goal_at ? ` · set ${loaded.plan.goal_at.slice(0, 10)}` : "";
      ctx.ui.notify(`${MARK} goal restored${when} · ${loaded.plan.goal}`, "info");
    }
    paint(ctx);
  });

  pi.on("session_info_changed", (_event, ctx) => {
    // A rename does not change the id, so the record stays; repainted anyway so the status line reflects whatever
    // is loaded rather than what was loaded when the last command ran.
    paint(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const record = current(ctx);
    const block = renderPlanBlock(record.plan);
    const sections = event.systemPromptOptions.sections;
    // An empty plan deletes the section rather than writing an empty tag: a `<plan></plan>` in every prompt is
    // noise the model has to parse for no information, and it would also count as a change against the diff.
    if (block) sections[SECTION_KEY] = block;
    else delete sections[SECTION_KEY];
  });

  pi.registerCommand("goal", {
    description: "Set, show, or clear this session's goal (stored in .pi/plan/<session-id>.json)",
    handler: async (args, ctx) => {
      const record = current(ctx);
      const text = String(args ?? "").trim();
      const path = planPath(ctx.cwd, record.sessionId) ?? `.pi/plan/<invalid session id>`;

      if (!text) {
        if (!ctx.hasUI) return;
        if (record.problem) {
          ctx.ui.notify(`⚠️ plan · ${record.problem}`, "warning");
          return;
        }
        ctx.ui.notify(
          record.plan.goal
            ? `${MARK} ${record.plan.goal}${record.plan.goal_at ? ` · set ${record.plan.goal_at}` : ""}`
            : `${MARK} no goal for this session · /goal <text> to set one (${path})`,
          "info",
        );
        return;
      }

      const at = now();
      if (CLEAR_WORDS.test(text)) {
        const cleared = clearGoal(record.plan, at);
        if (!cleared.changed) {
          if (ctx.hasUI) ctx.ui.notify(`${MARK} no goal to clear`, "info");
          return;
        }
        if (commit(ctx, { ...record, plan: cleared.plan })) {
          if (ctx.hasUI) ctx.ui.notify(`${MARK} goal cleared${record.plan.goal_prev ? ` (was: ${record.plan.goal_prev})` : ""}`, "info");
        }
        return;
      }

      const next = setGoal(record.plan, text, at);
      if (next.problem) {
        warn(ctx, `${MARK} ${next.problem}`);
        return;
      }
      if (!next.changed) {
        if (ctx.hasUI) ctx.ui.notify(`${MARK} already the goal`, "info");
        return;
      }
      if (commit(ctx, { ...record, plan: next.plan })) {
        if (ctx.hasUI) {
          const note = record.plan.goal ? ` · replaced: ${record.plan.goal}` : "";
          ctx.ui.notify(`${MARK} goal set · ${next.plan.goal}${note}`, "info");
        }
      }
    },
  });

  // ---------------------------------------------------------------- the list of work

  /**
   * `/todo` reads the list, and its verbs move it. A human typing a verb acts on the same record, through the same
   * save path, as the `todos` tool does for the model - which is why there is one `applyMutation` rather than two
   * implementations of "what happens when a step is finished".
   */
  pi.registerCommand("todo", {
    description: "This session's steps of work: /todo lists them, /todo <text> adds one",
    handler: async (args, ctx) => {
      const record = current(ctx);
      const at = now();
      const raw = String(args ?? "").trim();
      const show = (message: string, level: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
      };
      const reject = (mutation: Mutation, word: string) => {
        if (!mutation.problem) return false;
        // The substrate's sentence is the message. Appending the whole help line under it would push the answer off
        // the notification and tell a human things they did not ask about.
        show(`${word}: ${mutation.problem}`, "warning");
        return true;
      };

      if (!raw) {
        show(planReport(record.plan));
        return;
      }

      const [verb, ...restParts] = raw.split(/\s+/);
      const rest = restParts.join(" ").trim();
      const word = verb.toLowerCase();

      if (word === "show" || word === "hide") {
        panelVisible = word === "show";
        paint(ctx);
        show(`${MARK} plan ${panelVisible ? "shown" : "hidden"} · ${PANEL_SHORTCUT} toggles it`);
        return;
      }
      if (word === "help") {
        show(TODO_HELP);
        return;
      }

      // The verbs that act on a step take its id as their first word, so `/todo done t3` moves one item and
      // `/todo drop t3 superseded by the section route` carries the reason as free text.
      if (word === "start" || word === "done" || word === "drop" || word === "note" || word === "edit") {
        const id = (rest.split(/\s+/)[0] ?? "").trim();
        const tail = rest.slice(id.length).trim();
        if (!id) {
          show(`which step? ${TODO_HELP}`, "warning");
          return;
        }
        const mutation =
          word === "start" ? startTodo(record.plan, id, at)
          : word === "done" ? completeTodo(record.plan, id, at)
          : word === "drop" ? supersedeTodo(record.plan, id, tail || "dropped by /todo", at)
          : word === "note" ? editTodo(record.plan, id, { why: tail }, at)
          : editTodo(record.plan, id, tail ? { text: tail } : {}, at);
        if (reject(mutation, word)) return;
        if (!mutation.changed) {
          show(`${word} ${id}: nothing to change`);
          return;
        }
        if (!applyMutation(ctx, mutation).ok) return;
        const moved = mutation.plan.todos.find((t) => t.id === id);
        show(`${MARK} ${word} ${id}${moved ? ` · ${moved.text}` : ""}`);
        return;
      }

      // Anything else is the text of a new step, with `add` accepted as a leading verb for people who expect it.
      const text = word === "add" ? rest : raw;
      if (!text) {
        show(`a step needs text. ${TODO_HELP}`, "warning");
        return;
      }
      const mutation = addTodo(record.plan, { text }, at);
      // The substrate refuses a duplicate open item, and its sentence is the message a human wants; the help line
      // is for the cases where a verb was wrong.
      if (mutation.problem && mutation.problem.includes("already open")) {
        show(`${MARK} ${mutation.problem}`);
        return;
      }
      if (reject(mutation, "add")) return;
      if (!applyMutation(ctx, mutation).ok) return;
      const added = mutation.plan.todos.filter((t) => t.text === text).at(-1);
      show(`${MARK} added ${added?.id ?? ""} · ${text}`);
    },
  });

  /**
   * The model's door to the same record. Step 1 deliberately had no tool, because a goal a model can rewrite is no
   * longer the human's aim. A list of steps is the opposite case: the work on it is done by the agent, so a list
   * nobody can move reports `[ ]` about things that are finished, which is worse than no list. The aim stays
   * out of reach here, and `supersede` - the one action that retires something a human wrote - cannot happen
   * without a reason, which is what lets the human overrule it later.
   */
  pi.registerTool({
    name: "todos",
    label: "todos",
    description: `Read and move this session's plan of work - the same list /todo shows, and the same one your <plan> section carries. Keep it true as the work happens.`,
    promptSnippet: "Add or move a step in this session's todo list",
    promptGuidelines: [
      `Add a step with a one-line why before starting work that is not already on the list, and move it as you go: an item left in_progress tells the next reader the work is still open, and an item marked done that is not done is worse than no list.`,
      "supersede needs a reason. It is the one action here that retires something a human wrote, and the reason is what lets them overrule it.",
      "Never set or clear the goal from here - the aim is the human's, and /goal is the only way it changes.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("add"), Type.Literal("start"), Type.Literal("done"), Type.Literal("supersede"), Type.Literal("edit")],
        { description: "`list` reads it; `add` needs text; start/done/supersede/edit need id" },
      ),
      id: Type.Optional(Type.String({ description: "Step to act on, exactly as shown (`t3`)" })),
      text: Type.Optional(Type.String({ description: `New step text (add) or rewrite (edit), ${TODO_MAX_CHARS} chars max. Put the acceptance check in it where you have one.` })),
      why: Type.Optional(Type.String({ description: `One line on why the step exists (${WHY_MAX_CHARS} chars max). Give it for anything not obvious from the goal.` })),
      reason: Type.Optional(Type.String({ description: "Required for supersede: why the step is being retired" })),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const record = current(ctx);
      const at = now();
      const action = String(params.action ?? "list");
      const id = String(params.id ?? "").trim();
      const text = String(params.text ?? "").trim();
      const why = params.why === undefined ? undefined : String(params.why).trim();
      const reason = String(params.reason ?? "").trim();
      const fail = (error: string) => ({ content: [{ type: "text" as const, text: error }], details: { ok: false, error } });
      // Checked before anything else, so an action that is not on the list cannot reach a branch that happens to
      // ignore it. `set_goal` is the case this is here for: the tool has no door to the aim, in any shape.
      if (!KNOWN_ACTIONS.has(action)) {
        return fail(`unknown action "${action}". Use ${[...KNOWN_ACTIONS].join(", ")}. This tool cannot change the goal.`);
      }
      /**
       * The whole re-rendered list comes back on every successful write, not just "ok": an agent that cannot see
       * the list it just edited will edit it again, and the ids it needs are only in the list.
       */
      const say = (mutation: Mutation, headline: string) => {
        if (mutation.problem) return fail(`${headline}: ${mutation.problem}`);
        const outcome = applyMutation(ctx, mutation);
        if (!outcome.ok) return fail(`${headline}: ${outcome.text}`);
        return {
          content: [{ type: "text" as const, text: `${headline}${mutation.changed ? "" : " (already like that)"}\n${planReport(mutation.plan)}` }],
          details: { ok: true, changed: mutation.changed, todos: countTodos(mutation.plan) },
        };
      };

      if (action === "list") {
        return { content: [{ type: "text" as const, text: planReport(record.plan) }], details: { ok: true, todos: countTodos(record.plan) } };
      }
      if (action === "add") {
        if (!text) return fail("add needs text: what is the step?");
        return say(addTodo(record.plan, { text, why }, at), `add ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`);
      }
      if (!id) return fail(`${action} needs an id. Read the list first with action "list".`);
      if (action === "start") return say(startTodo(record.plan, id, at), `start ${id}`);
      if (action === "done") return say(completeTodo(record.plan, id, at), `done ${id}`);
      if (action === "supersede") return say(supersedeTodo(record.plan, id, reason, at), `supersede ${id}`);
      if (action === "edit") {
        const patch = { ...(text ? { text } : {}), ...(why !== undefined ? { why } : {}) };
        if (Object.keys(patch).length === 0) return fail("edit needs text and/or why");
        return say(editTodo(record.plan, id, patch, at), `edit ${id}`);
      }
      return fail(`unknown action "${action}". Use ${[...KNOWN_ACTIONS].join(", ")}.`);
    },
  });

  pi.registerShortcut(PANEL_SHORTCUT, {
    description: "Show or hide this session's plan panel",
    handler: (ctx) => {
      panelVisible = !panelVisible;
      paint(ctx);
      if (ctx.hasUI) ctx.ui.notify(`${MARK} plan ${panelVisible ? "shown" : "hidden"}`, "info");
    },
  });
}
