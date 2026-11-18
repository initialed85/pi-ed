/**
 * `/goal` — the aim of this session, in a file, and from there into the system prompt.
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
 * **Why the model cannot set the goal.** It reads `<plan>`, it does not write it. Overwriting a human's stated
 * goal is the authority question this sequence has not answered yet, and the direction of travel should be that a
 * tool gets added when there is a reason the model needs to change the goal, not because registering one is easy.
 * Everything else in the sequence (`/todo`, `/direction`) shares this file for the same reason: one reader of the
 * record, one writer, one paint.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearGoal,
  emptyPlan,
  planPath,
  readPlan,
  renderPlanBlock,
  setGoal,
  writePlan,
  type PlanRecord,
} from "../lib/plan.ts";

/** Status-bar key. Names here are a shared namespace across extensions (`schedules`, `tags`, `auto-resume`). */
const STATUS_KEY = "plan";
/** The prompt section this extension owns: rendered as `<plan>…</plan>` and patched only when it changes. */
const SECTION_KEY = "plan";
const MARK = "🎯";

/** What `/goal` with no argument clears to. Matched against the whole argument, so a goal may still contain the word. */
const CLEAR_WORDS = /^(clear|none|unset|reset)$/i;

type Loaded = { sessionId: string; plan: PlanRecord; problem?: string };

export default function activate(pi: ExtensionAPI) {
  /** The record for the session that is currently loaded, or undefined until a session starts. */
  let loaded: Loaded | undefined;

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
   * The status line. Deliberately one line and deliberately short: the goal is also in the prompt where the model
   * reads it in full, and the status bar exists to answer "which session am I in, and what is it for" without
   * being looked at directly.
   */
  const paint = (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;
    const record = loaded;
    if (!record) return;
    if (record.problem) {
      ctx.ui.setStatus(STATUS_KEY, `⚠️ ${record.problem.slice(0, 60)}`);
      return;
    }
    const goal = record.plan.goal;
    ctx.ui.setStatus(STATUS_KEY, goal ? `${MARK} ${goal.length > 58 ? `${goal.slice(0, 57)}…` : goal}` : undefined);
  };

  /** Commit a mutation: write it first, only then make it the loaded record. A failed write leaves the old one intact. */
  const commit = (ctx: ExtensionContext | ExtensionCommandContext, next: Loaded): boolean => {
    if (next.problem) {
      warn(ctx, `goal not saved · ${next.problem}`);
      return false;
    }
    const wrote = writePlan(ctx.cwd, next.plan);
    if (!wrote.ok) {
      warn(ctx, `goal not saved · ${wrote.error}`);
      return false;
    }
    loaded = next;
    paint(ctx);
    return true;
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
}
