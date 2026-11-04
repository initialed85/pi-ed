/**
 * Tags
 *
 * /tag                                          list both scopes
 * /tag list                                     list both scopes
 * /tag <message | session> [list]               list one scope
 * /tag <message | session> add <tag> [tag...]   put hashtags on one scope
 * /tag <message | session> remove <tag> [...]   take hashtags off one scope
 * /tag <message | session> clear                take every hashtag off one scope
 *
 * Two scopes because there are two different things worth labelling in a session. A `message` tag is
 * about one exchange: the prompt you sent, the tool calls the agent made, and the answer it came back
 * with. A `session` tag is about the session as a whole — `#wip`, `#rooter`, `#retro` — and it stays in
 * the footer so you can see which kind of session you are in.
 *
 * A message tag is keyed on the *turn*, not on whichever entry happened to be the leaf when you typed
 * the command. The turn is identified by the nearest user prompt walking back from the leaf, so a tag
 * made after the third tool result and a tag made after the final answer join up on the same exchange,
 * and neither one ends up describing the previous tag. Each record stores both ends of the span —
 * `turnId` is the prompt entry, `messageId` is the last message at the time — so one tag covers the
 * prompt, the calls and the response, and the span can be recovered from the log without re-walking the
 * tree.
 *
 * Like `/comment` and `/score`, these are `CustomEntry` values written with `pi.appendEntry()`:
 * `buildSessionContext()` ignores custom entries, and an extension command is executed rather than sent
 * as a prompt, so neither the tag nor the text you typed reaches the model. `test/tags.test.ts` asserts
 * that against Pi's own context builder rather than against this sentence.
 *
 * The log is append-only, which is the only thing the session tree allows. An entry is one operation on
 * one scope (`add`, `remove`, `clear`), and the tags that are "on" something are what the operations
 * leave behind when you replay them along the current branch. That means:
 *
 *   - tags are branch-relative, like everything else in the tree. Navigate to an earlier point with
 *     `/tree` and the tags you made after that point are not there;
 *   - tags survive compaction, because the replay reads the raw branch rather than the compacted
 *     context;
 *   - an operation that would change nothing writes nothing. A `remove` of a tag that is not there is
 *     not recorded, because a record that does nothing makes the log read as though something was there
 *     to remove.
 *
 * Reading the tags back out of a session file:
 *
 *   jq -r 'select(.customType=="tag")
 *          | [.timestamp, .data.scope, .data.op, (.data.tags | join(",")),
 *             .data.target.turnId // "session"] | @tsv' \
 *     ~/.pi/agent/sessions/<path>/<session>.jsonl
 *
 * (Written as `<path>/<session>` rather than as a star-slash glob, because a star followed by a slash
 * would close this comment.)
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/** The one string a reader greps for in the session JSONL. Renaming it splits old sessions from new ones. */
const ENTRY_TYPE = "tag";
/**
 * Bumped when the record shape changes incompatibly. A future version has to keep accepting 1: bumping
 * this and reading only the new shape would make a resumed old session look untagged.
 */
const TAG_VERSION = 1;

const MAX_TAG_LENGTH = 64;
/** Not a politeness limit: one `/tag session add a b c ...` line could otherwise write an unreadable set. */
const MAX_TAGS_PER_SCOPE = 64;
/** The footer slot these tags occupy. Pi renders extension statuses on their own line, keyed for sorting. */
const STATUS_KEY = "tags";

const SCOPES = ["message", "session"] as const;
type Scope = (typeof SCOPES)[number];

const OPS = ["add", "remove", "clear"] as const;
type Op = (typeof OPS)[number];

/**
 * Hashtags are stored lower-case, without the leading `#`, and matched exactly. `#Prod` and `#prod` have
 * to be one tag or a session ends up with two tags that mean the same thing and neither filter finds
 * both. Letters and numbers (any script), then `_`, `.`, `:` , `/` and `-`: enough for `#home-ops`,
 * `#2026-11-04`, `#v3.0`, `#pi/agent`, and nothing that can be mistaken for another part of the grammar.
 */
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.:/-]*$/u;

const USAGE = "usage: /tag [message | session] [list | add | remove | clear] [tags]";

interface TagTarget {
  /** The user prompt that opened the turn. Two tags on the same exchange join on this id. */
  turnId: string;
  /** The last message when the tag was made, usually the assistant answer. */
  messageId: string;
  /** That last message's role, recorded because "the last message" is what was being looked at. */
  role?: string;
}

interface TagRecord {
  v: number;
  scope: Scope;
  op: Op;
  /** Normalized and sorted. For `clear` these are the tags that were removed, so the log says what was lost. */
  tags: string[];
  /** Absent for session tags: they belong to the session, not to an exchange. */
  target?: TagTarget;
}

/** What the tags currently are, replayed along the branch. */
interface TagState {
  session: Set<string>;
  /** Turn entry id -> its tags. A cleared turn keeps its key with an empty set. */
  turns: Map<string, Set<string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

function isOp(value: string): value is Op {
  return (OPS as readonly string[]).includes(value);
}

/**
 * The only reader of these records. It is strict on purpose: `customType` is one flat namespace shared
 * with every other extension and with Pi itself, and `tag` is a common word. A foreign entry that
 * happens to use it has to be ignored rather than misread as one of ours.
 */
function toTagRecord(value: unknown): TagRecord | undefined {
  if (!isRecord(value) || value.v !== TAG_VERSION) return undefined;
  const { scope, op, tags, target } = value;
  if (typeof scope !== "string" || !isScope(scope)) return undefined;
  if (typeof op !== "string" || !isOp(op)) return undefined;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return undefined;

  let resolved: TagTarget | undefined;
  if (target !== undefined) {
    if (!isRecord(target) || typeof target.turnId !== "string" || target.turnId === "") return undefined;
    resolved = {
      turnId: target.turnId,
      ...(typeof target.messageId === "string" && target.messageId !== "" ? { messageId: target.messageId } : { messageId: target.turnId }),
      ...(typeof target.role === "string" && target.role !== "" ? { role: target.role } : {}),
    };
  }
  // A message tag with no turn cannot be joined to anything, so it is not a tag.
  if (scope === "message" && !resolved) return undefined;

  return { v: TAG_VERSION, scope, op, tags: [...tags].sort(), ...(resolved ? { target: resolved } : {}) };
}

/** `#prod` and `prod` are the same tag. Returns undefined for anything that is not a tag at all. */
function normalizeTag(raw: string): string | undefined {
  const tag = raw.replace(/^#+/, "").trim().toLowerCase();
  if (!tag || tag.length > MAX_TAG_LENGTH) return undefined;
  return TAG_PATTERN.test(tag) ? tag : undefined;
}

function normalizeTags(raw: string[]): { tags: string[]; rejected: string[] } {
  const tags = new Set<string>();
  const rejected: string[] = [];
  for (const item of raw) {
    const tag = normalizeTag(item);
    if (tag) tags.add(tag);
    else if (!rejected.includes(item)) rejected.push(item);
  }
  return { tags: [...tags].sort(), rejected };
}

const sorted = (tags: Set<string>): string[] => [...tags].sort();
const hash = (tags: string[]): string => tags.map((tag) => `#${tag}`).join(" ");
const formatTags = (tags: Set<string> | string[]): string => {
  const list = Array.isArray(tags) ? tags : sorted(tags);
  return list.length ? hash(list) : "none";
};

/** Tags are whitespace- or comma-separated: `#a #b` and `#a,#b` are the same two tags. */
function splitArguments(args: string): string[] {
  return args.trim().split(/[\s,]+/).filter(Boolean);
}

function splitWords(text: string): { leading: string; words: string[]; startingNewWord: boolean } {
  const first = text.search(/\S/);
  const leading = first === -1 ? text : text.slice(0, first);
  const body = first === -1 ? "" : text.slice(first);
  // split() leaves an empty last element after a trailing space, and an empty word is not a word.
  const words = body.length ? body.split(/\s+/).filter(Boolean) : [];
  // A trailing space means the next word is being started, not that the last one is being finished.
  return { leading, words, startingNewWord: body.length === 0 || /\s$/.test(body) };
}

/**
 * The message the current tag is about. Walks back from the leaf to the nearest user prompt rather than
 * taking the leaf, which is what makes two tags in one turn describe the same exchange.
 *
 * System entries are skipped: a `message` entry with role `system` is the prompt and tool loadout being
 * patched, not something anybody said, and the newest one of those is often the leaf.
 */
function findTarget(ctx: ExtensionContext): TagTarget | undefined {
  const branch = ctx.sessionManager.getBranch();
  let last: { id: string; role?: string } | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    // Custom entries, labels, compaction and usage records are all in the tree and none is a turn.
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown };
    if (message.role === "system") continue;
    if (typeof entry.id !== "string" || entry.id === "") continue;
    if (!last) last = { id: entry.id, ...(typeof message.role === "string" ? { role: message.role } : {}) };
    if (message.role === "user") {
      return { turnId: entry.id, messageId: last.id, ...(last.role ? { role: last.role } : {}) };
    }
  }
  if (!last) return undefined;
  // A turn that has not been prompted yet still needs a key, so the message itself stands in.
  return { turnId: last.id, messageId: last.id, ...(last.role ? { role: last.role } : {}) };
}

/** Replay the tag log along the branch. The branch is the tree you are actually on, not every entry. */
function readTags(entries: SessionEntry[]): TagState {
  const state: TagState = { session: new Set<string>(), turns: new Map<string, Set<string>>() };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const record = toTagRecord(entry.data);
    if (!record) continue;

    let tags: Set<string>;
    if (record.scope === "session") {
      tags = state.session;
    } else {
      const key = record.target!.turnId;
      const existing = state.turns.get(key);
      tags = existing ?? new Set<string>();
      if (!existing) state.turns.set(key, tags);
    }

    if (record.op === "clear") {
      tags.clear();
      continue;
    }
    for (const tag of record.tags) {
      if (record.op === "add") tags.add(tag);
      else tags.delete(tag);
    }
  }
  return state;
}

const scopeLabel = (scope: Scope): string => (scope === "session" ? "this session" : "this turn");

function describeTags(state: TagState, scope: Scope | undefined, target: TagTarget | undefined): string {
  const parts: string[] = [];
  if (!scope || scope === "session") parts.push(`session ${formatTags(state.session)}`);
  if (!scope || scope === "message") {
    const current = target ? state.turns.get(target.turnId) ?? new Set<string>() : new Set<string>();
    const others = [...state.turns].filter(([key, tags]) => key !== target?.turnId && tags.size > 0).length;
    const extra = others ? ` (${others} other tagged turn${others === 1 ? "" : "s"})` : "";
    parts.push(`turn ${formatTags(current)}${extra}`);
  }
  return `tags · ${parts.join(" · ")}`;
}

/**
 * Completions cover the grammar only: the scope, then the verb.
 *
 * Tag *names* are deliberately not offered. `getArgumentCompletions` receives the text typed so far and
 * nothing else — no session, no branch — so naming tags would mean caching the tags this extension last
 * wrote, and a cache goes stale across `/resume`, `/tree` and `/fork` and starts proposing tags that are
 * no longer there. Typing a hashtag yourself cannot be stale.
 *
 * Pi replaces the whole argument text with `item.value` and matches items with
 * `value.startsWith(prefix)`, so every value here repeats the words already typed.
 */
function completeArgument(prefix: string): AutocompleteItem[] | null {
  const text = typeof prefix === "string" ? prefix : "";
  const { leading, words, startingNewWord } = splitWords(text);
  const partial = startingNewWord ? "" : words.at(-1) ?? "";
  const fixed = startingNewWord ? words : words.slice(0, -1);

  let candidates: string[];
  if (fixed.length === 0) candidates = (["list", ...SCOPES] as string[]).filter((item) => item.startsWith(partial));
  else if (fixed.length === 1 && isScope(fixed[0]!)) candidates = (["list", ...OPS] as string[]).filter((item) => item.startsWith(partial));
  else return null;

  if (candidates.length === 0) return null;
  const stem = [leading, ...fixed].filter((part) => part.length > 0).join(" ");
  const separator = fixed.length ? " " : "";
  return candidates.map((item) => ({ value: `${stem}${separator}${item}`, label: item }));
}

export default function (pi: ExtensionAPI) {
  /**
   * One notification per invocation. The TUI keeps replacing the last status line rather than stacking
   * them, so two reports in a row mean the user only ever sees the second one — which is how a result
   * and its "ignored these" note would silently lose the note.
   */
  const report = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  /** Session tags live in the footer, where they cannot go stale: they describe the session, not a turn. */
  const showSessionTags = (ctx: ExtensionContext, tags: string[]) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, tags.length ? `tags ${hash(tags)}` : undefined);
  };

  const refreshFromBranch = (ctx: ExtensionContext) => showSessionTags(ctx, sorted(readTags(ctx.sessionManager.getBranch()).session));

  // On resume, `/clear`, `/fork` and `/tree` the footer has to be rebuilt from the branch that is now
  // current, because tags are branch-relative and a new session starts with none.
  pi.on("session_start", (_event, ctx) => refreshFromBranch(ctx));
  pi.on("session_tree", (_event, ctx) => refreshFromBranch(ctx));

  const writeTags = (scope: Scope, op: Op, tags: string[], target?: TagTarget) => {
    pi.appendEntry<TagRecord>(ENTRY_TYPE, {
      v: TAG_VERSION,
      scope,
      op,
      tags,
      ...(target ? { target } : {}),
    });
  };

  pi.registerEntryRenderer<TagRecord>(ENTRY_TYPE, (entry, _options, theme) => {
    const record = toTagRecord(entry.data);
    if (!record) return undefined;

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const action = record.op === "add" ? "tagged" : record.op === "remove" ? "untagged" : "cleared";
    const where = record.scope === "session" ? "session" : "turn";
    const tags = record.tags.map((tag) => `#${tag}`);
    const value = tags.length ? theme.fg("accent", tags.join(" ")) : theme.fg("dim", "(everything)");
    box.addChild(new Text(`${theme.fg("customMessageLabel", `${action} ${where}`)} ${value}`, 0, 0));

    const meta = [
      record.target?.role,
      record.target?.messageId && record.target.messageId !== record.target.turnId ? record.target.messageId : undefined,
      entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : undefined,
    ].filter(Boolean);
    if (meta.length > 0) box.addChild(new Text(theme.fg("dim", meta.join(" · ")), 0, 0));
    return box;
  });

  pi.registerCommand("tag", {
    description: "Hashtag the current turn or this session: /tag <message|session> <list|add|remove|clear> [tags]",
    getArgumentCompletions: completeArgument,
    handler: async (args, ctx) => {
      const state = readTags(ctx.sessionManager.getBranch());
      const tokens = splitArguments(args);
      // Resolved once: the listing paths need it to say *which* turn is being listed, and the mutating
      // paths need the same answer, so they must not walk the branch a second time and get a different
      // one if the agent appended something in between.
      const target = findTarget(ctx);

      // No argument and a bare `list` are the same question: what is tagged, anywhere.
      if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "list")) {
        report(ctx, describeTags(state, undefined, target));
        return;
      }

      const head = tokens[0]!;
      if (!isScope(head)) {
        report(ctx, USAGE, "warning");
        return;
      }
      const scope = head;
      const words = tokens.slice(1);

      if (words.length === 0) {
        report(ctx, describeTags(state, scope, target));
        return;
      }

      const verb = words[0]!;
      if (verb === "list") {
        if (words.length > 1) {
          report(ctx, `list takes no tags. ${USAGE}`, "warning");
          return;
        }
        report(ctx, describeTags(state, scope, target));
        return;
      }
      if (!isOp(verb)) {
        report(ctx, USAGE, "warning");
        return;
      }
      const op = verb;

      const { tags, rejected } = normalizeTags(words.slice(1));
      const note = rejected.length > 0 ? ` (ignored ${rejected.map((item) => JSON.stringify(item)).join(", ")})` : "";

      let current: Set<string>;
      // A session tag belongs to the session, so it is not anchored to a turn. A turn tag has to carry the
      // prompt id it belongs to, or the next turn would inherit it.
      const writeTarget = scope === "session" ? undefined : target;
      if (scope === "message") {
        if (!target) {
          report(ctx, `nothing to tag yet: this session has no message to tag${note}`, "warning");
          return;
        }
        current = state.turns.get(target.turnId) ?? new Set<string>();
      } else {
        current = state.session;
      }

      if (op === "clear") {
        if (current.size === 0) {
          report(ctx, `nothing is tagged on ${scopeLabel(scope)}${note}`, "warning");
          return;
        }
        const cleared = sorted(current);
        current.clear();
        writeTags(scope, "clear", cleared, writeTarget);
        if (scope === "session") showSessionTags(ctx, sorted(state.session));
        report(ctx, `cleared ${hash(cleared)} from ${scopeLabel(scope)}${note}`);
        return;
      }

      if (tags.length === 0) {
        report(ctx, `usage: /tag ${scope} ${op} <tag> [tag...]${note}`, "warning");
        return;
      }

      if (op === "add") {
        const additions = tags.filter((tag) => !current.has(tag));
        if (current.size + additions.length > MAX_TAGS_PER_SCOPE) {
          report(ctx, `that would put ${scopeLabel(scope)} over ${MAX_TAGS_PER_SCOPE} tags; /tag ${scope} clear first${note}`, "warning");
          return;
        }
        // Writing a record that adds nothing would make the log claim a tag was applied when the tag was
        // already there, and it would push the transcript renderer into noise.
        if (additions.length === 0) {
          report(ctx, `${scopeLabel(scope)} already carries ${formatTags(current)}${note}`);
          return;
        }
        for (const tag of additions) current.add(tag);
        writeTags(scope, "add", additions, writeTarget);
        if (scope === "session") showSessionTags(ctx, sorted(state.session));
        report(ctx, `tagged ${scopeLabel(scope)} with ${hash(additions)}${note}`);
        return;
      }

      const removals = tags.filter((tag) => current.has(tag));
      const misses = tags.filter((tag) => !current.has(tag));
      if (removals.length === 0) {
        report(ctx, `${scopeLabel(scope)} is not tagged ${hash(tags)}${note}`);
        return;
      }
      for (const tag of removals) current.delete(tag);
      writeTags(scope, "remove", removals, writeTarget);
      if (scope === "session") showSessionTags(ctx, sorted(state.session));
      const missed = misses.length > 0 ? `; ${scopeLabel(scope)} was not tagged ${hash(misses)}` : "";
      report(ctx, `untagged ${hash(removals)} from ${scopeLabel(scope)}${missed}${note}`);
    },
  });
}
