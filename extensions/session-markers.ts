/**
 * Session markers
 *
 * /comment <text>        leave a note in the session history
 * /score <0|1|2> [note]  rate the turn: 0 bad, 1 neutral, 2 good
 *
 * Both write a CustomEntry via pi.appendEntry(). Custom entries are ignored by
 * buildSessionContext(), so the model never sees them, and an extension command is executed
 * instead of being sent as a prompt, so the text you typed does not reach the model either.
 * Pi stamps each entry with id, parentId and an ISO timestamp, and puts it in the tree at the
 * point you made the mark, which is what makes them usable for later analysis:
 *
 *   jq -r 'select(.customType=="model-marker") | [.timestamp, .data.kind, .data.score, .data.text // .data.note] | @tsv'
 *
 * The point is to review model performance afterwards, so each marker also records the model
 * and thinking level in use at the time, and the entry id of the message it is about.
 *
 * A score of 1 is written, not skipped. If neutral meant "no entry", the analysis could not
 * tell a neutral rating from a turn nobody rated, which is the difference between a rating
 * scale and a count of complaints.
 *
 * Marks render in the transcript (registerEntryRenderer) but are absent from the model's
 * context, so you can see what you marked without the model seeing it.
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** The one string the analysis pass greps for. Changing it breaks old sessions' readings. */
const ENTRY_TYPE = "model-marker";
/** Bumped if the data shape changes incompatibly, so readers can tell which version they have. */
const MARKER_VERSION = 1;

const SCORES = {
  "0": { label: "bad", color: "error" },
  "1": { label: "neutral", color: "muted" },
  "2": { label: "good", color: "success" },
} as const;

/** The keys are quoted so this is a string union; unquoted, TypeScript reads them as numbers. */
type Score = keyof typeof SCORES;

/** Words as well as numbers, so `/score good` works and the intent is never guessed. */
const SCORE_WORDS: Record<string, Score> = {
  bad: "0",
  neutral: "1",
  ok: "1",
  good: "2",
};

interface Target {
  entryId: string;
  role?: string;
}

/**
 * What the mark was made against. None of this is recoverable from the entry's own position
 * later, so it is recorded at the time: the model changes mid-session, and the message a mark
 * is about is not necessarily the entry above it.
 */
interface Stamp {
  model?: string;
  thinkingLevel?: string;
  target?: Target;
}

interface CommentMarker extends Stamp {
  v: typeof MARKER_VERSION;
  kind: "comment";
  text: string;
}

interface ScoreMarker extends Stamp {
  v: typeof MARKER_VERSION;
  kind: "score";
  /** A number, not a string, so a reader can average and compare without parsing. */
  score: number;
  label: string;
  note?: string;
}

type Marker = CommentMarker | ScoreMarker;

/**
 * The message this mark is about. Walk back from the leaf to the nearest message rather than
 * taking the leaf itself: mark twice in a row and the second mark's leaf would be the first
 * mark, so two ratings of the same turn would not join up.
 */
function findTarget(ctx: ExtensionCommandContext): Target | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown };
    return { entryId: entry.id, ...(typeof message.role === "string" ? { role: message.role } : {}) };
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  /**
   * Say something, if there is a terminal to say it to. Print and JSON mode have no UI, and the
   * record is the point of these commands, so the write is never gated on this.
   */
  const report = (ctx: ExtensionCommandContext, message: string, level?: "info" | "warning" | "error") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  const stamp = (ctx: ExtensionCommandContext): Stamp => {
    const model = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    const target = findTarget(ctx);
    return {
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(target ? { target } : {}),
    };
  };

  /** Custom entries are not rendered by Pi, so without this the marks would be invisible. */
  pi.registerEntryRenderer<Marker>(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data || typeof data !== "object") return undefined;

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const when = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "";
    if (data.kind === "score") {
      const colour = SCORES[String(data.score) as Score]?.color ?? "muted";
      const note = data.note ? ` ${data.note}` : "";
      box.addChild(new Text(`${theme.fg(colour, `score ${data.score} (${data.label})`)}${note}`, 0, 0));
    } else {
      box.addChild(new Text(`${theme.fg("customMessageLabel", "comment")} ${data.text}`, 0, 0));
    }
    if (data.model) {
      box.addChild(new Text(theme.fg("dim", `${data.model}${data.thinkingLevel ? ` · ${data.thinkingLevel}` : ""}${when ? ` · ${when}` : ""}`)));
    } else if (when) {
      box.addChild(new Text(theme.fg("dim", when)));
    }
    return box;
  });

  pi.registerCommand("comment", {
    description: "Leave a note in the session history that the model cannot see",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        report(ctx, "usage: /comment <text>", "warning");
        return;
      }
      pi.appendEntry<Marker>(ENTRY_TYPE, { v: MARKER_VERSION, kind: "comment", text, ...stamp(ctx) });
      report(ctx, "commented", "info");
    },
  });

  pi.registerCommand("score", {
    description: "Rate the current turn 0 bad, 1 neutral, 2 good, in the session history",
    getArgumentCompletions: (prefix) => {
      const items = (Object.keys(SCORES) as Score[]).map((key) => ({ value: key, label: `${key} ${SCORES[key].label}` }));
      const matches = items.filter((item) => item.value.startsWith(prefix.trim()) || item.label.startsWith(prefix.trim()));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        report(ctx, "usage: /score <0 bad | 1 neutral | 2 good> [note]", "warning");
        return;
      }
      const [head, ...rest] = trimmed.split(/\s+/);
      const key = head === "0" || head === "1" || head === "2" ? head : SCORE_WORDS[head!.toLowerCase()];
      if (!key) {
        report(ctx, `score must be 0 (bad), 1 (neutral) or 2 (good), not "${head}"`, "warning");
        return;
      }
      const score = Number(key);
      const note = rest.join(" ").trim();
      pi.appendEntry<Marker>(ENTRY_TYPE, {
        v: MARKER_VERSION,
        kind: "score",
        score,
        label: SCORES[key].label,
        ...(note ? { note } : {}),
        ...stamp(ctx),
      });
      report(ctx, `scored ${score} (${SCORES[key].label})`, "info");
    },
  });
}
