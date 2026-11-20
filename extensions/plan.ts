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
 *
 * **Where the panel comes from.** Its style and its mechanism are lifted from the pulse panel in
 * `initialed85/pi-team-room`, with that project's runtime workarounds included, because those workarounds are about
 * Pi rather than about the team room: in scrollback mode a short render is padded to the full terminal height before
 * overlays composite, which leaves blank rows behind, and an above-editor widget cannot uncover lines that have
 * already scrolled off the top. See the panel section for what is copied and what is deliberately not.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  addTodo,
  clearDirection,
  clearGoal,
  completeTodo,
  countTodos,
  editTodo,
  emptyPlan,
  endPlan,
  planPath,
  readPlan,
  reopenPlan,
  renderPlanBlock,
  setDirection,
  setGoal,
  startTodo,
  supersedeTodo,
  writePlan,
  TODO_MAX_CHARS,
  WHY_MAX_CHARS,
  type Mutation,
  type PlanRecord,
  type Todo,
  type TodoState,
} from "../lib/plan.ts";

/** Status-bar and panel key. Names here are a shared namespace across extensions (`schedules`, `tags`, `auto-resume`). */
const STATUS_KEY = "plan";
const WIDGET_KEY = "plan";
/** The prompt section this extension owns: rendered as `<plan>…</plan>` and patched only when it changes. */
const SECTION_KEY = "plan";
/** Toggles the panel. `shift+down` rather than the team room's `shift+up`, so the two panels on one screen open
 * with different keys: `docs/keybindings.md` claims only `ctrl+shift+down`/`ctrl+down` for alt-screen prompt
 * navigation, and `shift+down` itself is unbound. */
const PANEL_SHORTCUT = "shift+down";
const MARK = "🎯";
/** The panel and the messages use this for the route; the aim keeps `MARK`, so a line says which of the two it is. */
const DIRECTION_MARK = "↳";
/** Written on the compact line, and searched for on the rendered screen, so the expanded panel can find the row it
 * belongs to. Both halves read this constant, so the two cannot drift apart. */
const PANEL_MARK = "Plan:";
/** Steps the expanded panel draws. More than this and the panel is a transcript again; the report and the prompt
 * block both still show everything. Exported so the test asserts against the real cap, not a copy of it. */
export const PANEL_MAX_STEPS = 32;
/** `/todo` and the expanded panel show a bounded but generous list; the file remains the source of truth beyond this. */
const REPORT_MAX_ITEMS = 32;
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

// ── the panel ───────────────────────────────────────────────────────────────────────────────────────
//
// Lifted from `initialed85/pi-team-room`'s pulse panel, in both senses: the same look (a `Box` on the theme's
// message background, a `▌` rail down the left edge, role colours and `◆`/`↳`/`●`/`○`/`✓`/`✗` marks instead of
// prose), and the same mechanism (one compact line as the widget, and the detail as a non-capturing overlay that
// rises from that line in scrollback mode). The team room already paid for the runtime's sharp edges, so this file
// pays them the same way: `patchCompositor` trims Pi's terminal-height padding back to the rows the overlay
// actually needs, `detachOwnedForShrink` lets Pi's clear-on-shrink redraw happen for one frame, and the overlay
// options are getter-backed because Pi resolves an `overlayOptions` callback once at mount while the compositor
// reads the stored object on every render.
//
// Three differences, all deliberate:
//
// - The key is `shift+down`, because `shift+up` is already the team room's panel and both are on screen together.
// - The compact line appears only when there is something on it. A team is always somewhere, so a presence line is
//   always true; "no goal" is not, and an empty line about nothing would spend screen on every session.
// - Opening and closing it says nothing. In the team room the panel *is* the feedback; a notification under it
//   repeats what the eye has just seen.

/** The subset of Pi's theme the panel needs - which is also what a test can hand it. */
type PanelTheme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};

type OverlayEntry = { component?: unknown };
type RenderingTui = TUI & {
  compositeOverlays?: (lines: string[], width: number, height: number) => string[];
  overlayStack?: OverlayEntry[];
  previousLines?: string[];
  maxLinesRendered?: number;
};

/**
 * The panel's mutable half. It hangs off one `activate()` rather than the module, because the compositor patch and
 * the mounted-overlay set are facts about *this* terminal: a process that starts a second session - which is what a
 * test does on every `import` of a fresh harness - must not inherit an overlay that is no longer on any screen, or a
 * patch installed on a terminal it no longer has.
 */
type PanelState = {
  /** What the panel draws. Read at render time, so a mutation under an open panel shows without remounting. */
  data?: PlanRecord;
  widgetTui?: TUI;
  overlayTui?: TUI;
  overlayDone?: () => void;
  overlayComponent?: { render(width: number): string[] };
  owned: Set<unknown>;
  restoreCompositorPatch?: () => void;
};

const newPanelState = (): PanelState => ({ owned: new Set() });

const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;

function countText(plan: PlanRecord): string {
  const c = countTodos(plan);
  return `${c.open} open · ${c.inProgress} in progress · ${c.done} done · ${c.superseded} retired`;
}

/** Compact counts drop the zeroes: "1 open · 0 in progress · 0 done · 0 retired" is a lot of nothing. */
function shortCountText(plan: PlanRecord): string {
  const c = countTodos(plan);
  const parts: string[] = [];
  if (c.open) parts.push(`${c.open} open`);
  if (c.inProgress) parts.push(`${c.inProgress} in progress`);
  if (c.done) parts.push(`${c.done} done`);
  if (c.superseded) parts.push(`${c.superseded} retired`);
  return parts.join(" · ") || "nothing open";
}

/** A step's mark, in the colour that means the same thing everywhere else in this terminal. */
function stepMark(theme: PanelTheme, state: TodoState): string {
  if (state === "in_progress") return theme.fg("warning", "●");
  if (state === "done") return theme.fg("success", "✓");
  if (state === "superseded") return theme.fg("error", "✗");
  return theme.fg("dim", "○");
}

function buildPlanBox(plan: PlanRecord, theme: PanelTheme, expanded: boolean, includeTrailingSpacer = false): Box {
  const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  const addLine = (line: string): void => box.addChild(new Text(line, 0, 0));
  const rail = theme.fg("accent", "▌ ");
  if (expanded) {
    // Pi's highlighted divider, drawn rather than imported: this file also loads in hosts without the
    // interactive runtime.
    box.addChild({
      render: (width: number) => [theme.fg("borderAccent", "─".repeat(Math.max(1, width)))],
      invalidate: () => undefined,
    });
  }

  if (!expanded) {
    // The aim's own glyph: on a steered-but-not-aimed session a diamond would claim the direction was the goal,
    // which is exactly the confusion the two fields exist to avoid.
    const aim = plan.goal ?? plan.direction;
    const aimGlyph = plan.goal ? "◆" : "↳";
    const bits = [
      aim ? theme.fg("accent", `${aimGlyph} ${truncate(aim, 44)}`) : theme.fg("dim", "◆ no goal"),
      plan.todos.length === 0 ? theme.fg("dim", "no steps") : theme.fg("dim", shortCountText(plan)),
    ];
    if (plan.direction && plan.goal) bits.splice(1, 0, theme.fg("warning", `↳ ${truncate(plan.direction, 32)}`));
    addLine(`${rail}${theme.bold(theme.fg("accent", PANEL_MARK))} ${bits.join(theme.fg("borderMuted", " | "))}`);
    return box;
  }

  addLine(`${rail}${theme.bold(theme.fg("accent", "Plan"))} ${theme.fg("dim", "— this session")} ${theme.fg("muted", `(${PANEL_SHORTCUT} to close)`)}`);
  addLine(`${rail}${theme.fg("accent", "◆ goal")} ${plan.goal ? theme.fg("text", truncate(plan.goal, 140)) : theme.fg("dim", "/goal <text> sets it")}`);
  if (plan.direction) {
    addLine(`${rail}${theme.fg("warning", "↳ direction")} ${theme.fg("text", truncate(plan.direction, 140))}`);
  }
  if (plan.todos.length === 0) {
    addLine(`${rail}${theme.fg("dim", "no steps yet · /todo <text> adds one")}`);
  }
  for (const todo of plan.todos.slice(0, PANEL_MAX_STEPS)) {
    const detail = todo.state === "superseded" ? todo.note : todo.why;
    const faded = todo.state === "done" || todo.state === "superseded";
    addLine([
      rail,
      stepMark(theme, todo.state),
      theme.fg("muted", todo.id),
      theme.fg(faded ? "dim" : "text", truncate(todo.text, 100)),
      detail ? theme.fg("dim", `— ${truncate(detail, 70)}`) : "",
    ].filter(Boolean).join(" "));
  }
  const hidden = plan.todos.length - Math.min(plan.todos.length, PANEL_MAX_STEPS);
  // The notice gets its own row even when everything else fit: a panel that silently stops at eight steps leaves a
  // reader believing eight was the whole list.
  if (hidden > 0) addLine(`${rail}${theme.fg("muted", `… ${hidden} more · /todo lists them all`)}`);
  addLine(`${rail}${theme.fg("dim", countText(plan))}`);
  if (includeTrailingSpacer) addLine("");
  return box;
}

/** The same content as plain lines, for RPC and print mode, where there is no overlay and no theme. */
function planLines(plan: PlanRecord, expanded: boolean): string[] {
  const aim = plan.goal ?? plan.direction;
  const lines: string[] = [];
  if (expanded) lines.push(`─── Plan ───`);
  lines.push(`${plan.goal ? "◆" : "↳"} ${aim ?? "no goal · /goal <text> sets it"}`);
  if (plan.direction && plan.goal) lines.push(`↳ ${plan.direction}`);
  if (expanded) {
    if (plan.todos.length === 0) lines.push("no steps yet · /todo <text> adds one");
    for (const todo of plan.todos) {
      const detail = todo.state === "superseded" ? todo.note : todo.why;
      lines.push(`${todo.state[0]?.toUpperCase()} ${todo.id} ${todo.text}${detail ? ` — ${detail}` : ""}`);
    }
    lines.push(countText(plan));
  } else if (plan.todos.length > 0) {
    lines.push(shortCountText(plan));
  }
  return lines.map((line) => line.slice(0, 200));
}

/**
 * Where the expanded panel goes in scrollback mode: the rows directly above the compact line, found by searching the
 * rendered screen for `PANEL_MARK`. Clamped so a tall panel cannot run past that row into the editor, or down into
 * the autocomplete that grows below it.
 */
function panelOverlayPosition(tui: TUI, height: number, renderedLines?: string[]): { row: number; maxHeight: number } {
  const lines = renderedLines || tui.render(tui.terminal.columns);
  // The last line carrying the compact widget - a forward scan rather than `findLastIndex`, because this repo
  // typechecks against an older `lib` and a screenful of lines is small either way.
  let widgetLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(PANEL_MARK)) widgetLine = i;
  }
  const viewportTop = Math.max(0, lines.length - tui.terminal.rows);
  const widgetRow = widgetLine >= 0 ? widgetLine - viewportTop : undefined;
  const targetLine = widgetLine >= 0 ? widgetLine - height + 1 : tui.terminal.rows - height;
  const row = Math.max(0, Math.min(tui.terminal.rows - 1, targetLine - viewportTop));
  const availableAboveWidget = widgetRow === undefined ? tui.terminal.rows - row : widgetRow - row + 1;
  return {
    row,
    maxHeight: Math.max(1, Math.min(tui.terminal.rows - row, availableAboveWidget)),
  };
}

/**
 * While one of our overlays is mounted, cut `TuiBase`'s terminal-height padding back to the base render plus the
 * rows the overlay needs. Keeping the padding makes the next ordinary render look shorter and reflows the
 * scrollback into blank rows.
 */
function patchCompositor(state: PanelState, tui: TUI): void {
  if (state.restoreCompositorPatch) return;
  const renderingTui = tui as RenderingTui;
  // `widgetTui` is normally Pi's stable TUI proxy. Read the method off the prototype chain instead of retaining the
  // proxy's per-access wrapper, so repeated open/close cycles cannot build a chain of wrappers around their copies.
  let owner = Object.getPrototypeOf(renderingTui) as object | null;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "compositeOverlays")) {
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  const inherited = owner && (owner as Partial<RenderingTui>).compositeOverlays;
  const original = inherited || renderingTui.compositeOverlays;
  if (!original) return;
  const owned = state.owned;
  const patched = function (this: RenderingTui, lines: string[], width: number, height: number): string[] {
    const composed = original.call(this, lines, width, height);
    const stack = this.overlayStack;
    const mounted = !stack || stack.some((entry) => owned.has(entry.component));
    const trimmed = mounted && composed.length > lines.length ? composed.slice(0, lines.length) : composed;
    if (mounted) detachOwnedForShrink(state, this, stack, lines);
    return trimmed;
  };
  renderingTui.compositeOverlays = patched;
  state.restoreCompositorPatch = () => {
    renderingTui.compositeOverlays = original;
    state.restoreCompositorPatch = undefined;
  };
}

/**
 * Pi skips its clear-on-shrink redraw while an overlay is mounted, because a modal overlay needs the padding. Ours
 * is non-capturing and already composited into the base render and trimmed above, so taking it off the stack for one
 * frame lets the normal shrink redraw happen; the current frame still contains the panel.
 */
function detachOwnedForShrink(state: PanelState, tui: RenderingTui, stack: OverlayEntry[] | undefined, lines: string[]): void {
  if (!stack || stack.length === 0) return;
  const previousLength = Math.max(
    Array.isArray(tui.previousLines) ? tui.previousLines.length : 0,
    typeof tui.maxLinesRendered === "number" ? tui.maxLinesRendered : 0,
  );
  if (lines.length >= previousLength) return;
  const owned = stack.filter((entry) => state.owned.has(entry.component));
  if (owned.length === 0 || owned.length !== stack.length) return;
  stack.splice(0, stack.length);
  queueMicrotask(() => {
    const currentStack = tui.overlayStack;
    if (!currentStack) return;
    for (const entry of owned) {
      if (state.owned.has(entry.component) && !currentStack.includes(entry)) currentStack.push(entry);
    }
  });
}

function closePanelOverlay(state: PanelState): void {
  const done = state.overlayDone;
  state.overlayDone = undefined;
  state.overlayTui = undefined;
  if (state.overlayComponent) state.owned.delete(state.overlayComponent);
  state.overlayComponent = undefined;
  if (state.owned.size === 0) state.restoreCompositorPatch?.();
  done?.();
}

function openPanelOverlay(state: PanelState, ctx: ExtensionContext | ExtensionCommandContext): void {
  if (ctx.mode !== "tui" || state.overlayDone) return;
  if (state.widgetTui) patchCompositor(state, state.widgetTui);
  let theme: PanelTheme = ctx.ui.theme as unknown as PanelTheme;
  const component = {
    // Drawn from `state.data` rather than a captured plan, so a mutation while the panel is open shows up on the
    // next frame without remounting the overlay.
    render: (width: number): string[] => (state.data ? buildPlanBox(state.data, theme, true, true).render(width) : []),
    invalidate: (): void => {
      theme = ctx.ui.theme as unknown as PanelTheme;
    },
  };
  state.owned.add(component);
  state.overlayComponent = component;
  const overlay = ctx.ui.custom<void>((tui, initialTheme, _keybindings, done) => {
    state.overlayTui = tui;
    theme = initialTheme as unknown as PanelTheme;
    state.overlayDone = () => done(undefined);
    return component;
  }, {
    overlay: true,
    // Getter-backed, because Pi resolves an `overlayOptions` callback once at mount while the compositor reads the
    // stored object on every render. The panel follows editor and autocomplete growth without holding
    // terminal-height padding in the scrollback.
    overlayOptions: {
      anchor: "top-left",
      get row(): number {
        const tui = state.overlayTui || state.widgetTui;
        const height = state.overlayComponent?.render(tui?.terminal.columns ?? 80).length ?? 1;
        return tui ? panelOverlayPosition(tui, height).row : 0;
      },
      col: 0,
      width: "100%",
      get maxHeight(): number {
        const tui = state.overlayTui || state.widgetTui;
        const height = state.overlayComponent?.render(tui?.terminal.columns ?? 80).length ?? 1;
        return tui ? panelOverlayPosition(tui, height).maxHeight : 1;
      },
      nonCapturing: true,
    },
  });
  // A rejected `custom()` is the one failure this path can have that is not visible on screen, and "nothing
  // happened when I pressed the key" is otherwise indistinguishable from a binding the terminal never delivered.
  // So the reason is said out loud, once, and the cleanup below still runs.
  void overlay.catch((error: unknown) => {
    ctx.ui.notify(`\u26a0\ufe0f plan panel \u00b7 ${String(error instanceof Error ? error.message : error).slice(0, 120)}`, "warning");
  }).finally(() => {
    state.owned.delete(component);
    if (state.overlayComponent === component) {
      state.overlayComponent = undefined;
      state.overlayDone = undefined;
      state.overlayTui = undefined;
    }
    if (state.owned.size === 0) state.restoreCompositorPatch?.();
  });
}

export default function activate(pi: ExtensionAPI) {
  /** The record for the session that is currently loaded, or undefined until a session starts. */
  let loaded: Loaded | undefined;
  /** Whether the panel is expanded. Per process, and off by default: the file is the state, the panel is a view. */
  let panelVisible = false;
  /** Which terminal this activation drew itself onto, and what it has mounted there. */
  const panel = newPanelState();

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
   * The status line and the panel. Deliberately short: the goal and the list are also in the prompt, where the model
   * reads them in full, and the compact line exists to answer "what is this session for" without being looked at
   * directly.
   */
  const paint = (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;
    const record = loaded;
    if (!record) return;
    if (record.problem) {
      ctx.ui.setStatus(STATUS_KEY, `⚠️ ${record.problem.slice(0, 60)}`);
      panel.data = undefined;
      closePanelOverlay(panel);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const plan = record.plan;
    const counts = countTodos(plan);
    const aim = plan.goal ?? plan.direction;
    const open = counts.open + counts.inProgress;
    const tally = plan.todos.length > 0 ? `${open} step${open === 1 ? "" : "s"} open` : "";
    // The aim's own mark, not always the goal's: a session steered but not aimed reads as `↳`, and a `🎯` in front of
    // a direction would claim there was a goal when the whole point is that there is not one yet.
    const aimMark = plan.goal ? MARK : DIRECTION_MARK;
    const line = [aim ? `${aimMark} ${truncate(aim, 46)}` : "", tally].filter(Boolean).join(" · ");
    ctx.ui.setStatus(STATUS_KEY, line || undefined);

    panel.data = plan;
    // Nothing to say, nothing *listed*: a compact line on every session that never set a goal is a tax, which is the
    // one place this differs from the team room. An opened panel is a different case - the keypress is the request,
    // and a panel that refuses to appear because the session is three minutes old just teaches you that the key is
    // broken. So an empty session draws its empty state, which is the one thing worth saying: what to type.
    const hasContent = Boolean(plan.goal || plan.direction || plan.todos.length > 0);
    if (!hasContent && !panelVisible) {
      closePanelOverlay(panel);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    if (ctx.mode !== "tui") {
      // RPC and print have no overlay surface and no theme, so the widget is the panel: plain lines, expanded or
      // not, capped by the same rules.
      closePanelOverlay(panel);
      ctx.ui.setWidget(WIDGET_KEY, planLines(plan, panelVisible));
      return;
    }

    // In scrollback ("regular") mode an expanded widget cannot uncover lines that have already scrolled past, so
    // the widget stays one line and the detail goes into the overlay that rises from it. Anywhere else the widget
    // itself draws the expanded box. Pi hands us its terminal when it builds the widget, which is not necessarily
    // before this runs, so an unknown mode is read as scrollback: that is Pi's interactive default, and the widget
    // factory below re-decides with the terminal it was actually given.
    const widgetMode = (panel.widgetTui as (TUI & { mode?: string }) | undefined)?.mode;
    const regularMode = widgetMode === undefined ? true : widgetMode === "regular";
    if (panelVisible && regularMode) openPanelOverlay(panel, ctx);
    else closePanelOverlay(panel);

    ctx.ui.setWidget(WIDGET_KEY, (tui: TUI, theme: unknown) => {
      panel.widgetTui = tui;
      const regular = (tui as TUI & { mode?: string }).mode === "regular";
      // Decided here, from the terminal Pi actually handed us, so the widget and the overlay cannot both carry the
      // detail: in scrollback the widget is always the compact line.
      const drawExpanded = panelVisible && !regular;
      const panelTheme = theme as PanelTheme;
      let box = buildPlanBox(panel.data ?? plan, panelTheme, drawExpanded);
      return {
        render: (width: number) => box.render(width),
        // Rebuilt on invalidate so a theme change (or a plan mutation redrawn by Pi) does not leave the panel
        // painted in last frame's colours.
        invalidate: () => {
          box = buildPlanBox(panel.data ?? plan, ctx.ui.theme as unknown as PanelTheme, drawExpanded);
        },
      };
    }, { placement: "aboveEditor" });
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
    // A session that came back is not an ended one, and leaving the stamp on would tell the next reader of this file
    // that its owner is gone while it is sitting right there. Cleared here rather than in `load`, because `load` runs
    // on every turn through `current` and must not write.
    const reopened = reopenPlan(loaded.plan);
    if (reopened.changed && !loaded.problem) {
      loaded = { ...loaded, plan: reopened.plan };
      const wrote = writePlan(ctx.cwd, reopened.plan);
      if (!wrote.ok) warn(ctx, `not saved · ${wrote.error}`);
    }
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

  /**
   * Stamp, never delete. The plan is the human's record and a quit is not a licence to erase it - but every other
   * session that lists this directory has to be able to tell that this one is over, instead of reading its open steps
   * as live instructions. Measured, and it is not hypothetical: a fresh session in an empty sandbox `find`ed
   * `.pi/plan/`, cat-ed a finished session's paperclip todos, and started working through a plan that was not its own.
   */
  pi.on("session_shutdown", async (_event, ctx) => {
    const record = loaded ?? load(ctx);
    if (record.problem) return; // a damaged plan is reported, not rewritten, by any path
    const ended = endPlan(record.plan, now());
    if (!ended.changed) return;
    const wrote = writePlan(ctx.cwd, ended.plan);
    if (!wrote.ok) warn(ctx, `plan not stamped · ${wrote.error}`);
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

  /**
   * `/direction` is a second door onto the same record, not a second format: the human sets it, the replaced line is
   * kept one deep, and it is clipped by the same cap. Where `/goal` is what the session is for, this is the current
   * line of attack inside it - the thing that changes while the aim does not, when a plan turns out to be the wrong
   * shape and you want that on the record rather than implied by a deleted todo. That is also why the panel draws it
   * under the aim in the warning colour rather than beside it: an aim and a route to it are different kinds of thing,
   * and a reader should be able to tell which of the two they are re-reading.
   */
  pi.registerCommand("direction", {
    description: "Set, show, or clear this session's direction (the aim stays the goal)",
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
        const aim = record.plan.goal ? `goal: ${record.plan.goal}` : `no goal (${path})`;
        ctx.ui.notify(
          record.plan.direction
            ? `${DIRECTION_MARK} ${record.plan.direction}${record.plan.direction_at ? ` · set ${record.plan.direction_at}` : ""} · toward ${aim}`
            : `${DIRECTION_MARK} no direction · /direction <text> sets it · ${aim}`,
          "info",
        );
        return;
      }

      const at = now();
      if (CLEAR_WORDS.test(text)) {
        const cleared = clearDirection(record.plan, at);
        if (!cleared.changed) {
          if (ctx.hasUI) ctx.ui.notify(`${DIRECTION_MARK} no direction to clear`, "info");
          return;
        }
        if (commit(ctx, { ...record, plan: cleared.plan })) {
          if (ctx.hasUI) ctx.ui.notify(`${DIRECTION_MARK} direction cleared${record.plan.direction_prev ? ` (was: ${record.plan.direction_prev})` : ""}`, "info");
        }
        return;
      }

      const next = setDirection(record.plan, text, at);
      if (next.problem) {
        warn(ctx, `${DIRECTION_MARK} ${next.problem}`);
        return;
      }
      if (!next.changed) {
        if (ctx.hasUI) ctx.ui.notify(`${DIRECTION_MARK} already the direction`, "info");
        return;
      }
      if (commit(ctx, { ...record, plan: next.plan })) {
        if (ctx.hasUI) {
          const note = record.plan.direction ? ` · replaced: ${record.plan.direction}` : "";
          ctx.ui.notify(`${DIRECTION_MARK} direction set · ${next.plan.direction}${note}`, "info");
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
        // In a terminal the panel is its own answer. Only say something where nothing can appear on screen.
        if (ctx.hasUI && ctx.mode !== "tui") show(`${MARK} plan ${panelVisible ? "shown" : "hidden"}`);
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
    description: "Expand or collapse this session's plan panel",
    handler: (ctx) => {
      panelVisible = !panelVisible;
      paint(ctx);
    },
  });
}
