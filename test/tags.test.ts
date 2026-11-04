import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createContext, createFakePi, fakeTheme, painted, type FakePi, type FakeUi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/tags.ts");

// Duplicated from the extension on purpose, in both places it is used (here and in packaging.test.ts):
// if the customType changes, the reader of old sessions and this suite have to disagree loudly rather
// than quietly stop finding tags.
const ENTRY_TYPE = "tag";
const STATUS_KEY = "tags";

/** The tags this extension wrote, newest last. */
function written(pi: FakePi): any[] {
  return pi.appendedEntries.filter((entry) => entry.type === ENTRY_TYPE).map((entry) => entry.data);
}

function last(pi: FakePi): any {
  return written(pi).at(-1);
}

async function load(): Promise<FakePi> {
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}

function message(id: string, role: string, text: string, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-04T09:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

function tagEntry(data: unknown, id = "t1", parentId = "m2"): SessionEntry {
  return { type: "custom", customType: ENTRY_TYPE, data, id, parentId, timestamp: "2026-11-04T09:30:00.000Z" } as SessionEntry;
}

/** A record that is not ours but sits in the same tree with the same customType. */
function foreignTag(data: unknown, id = "f1", parentId = "m2"): SessionEntry {
  return tagEntry(data, id, parentId);
}

function compaction(id: string, parentId: string | null): SessionEntry {
  return { type: "compaction", id, parentId, timestamp: "2026-11-04T09:40:00.000Z", summary: "earlier work summarised", firstKeptEntryId: id } as SessionEntry;
}

/** One exchange: the prompt, then the answer. The branch a tag is normally made on. */
const TURN = [message("m1", "user", "deploy the config", null), message("m2", "assistant", "deployed, three pods restarted", "m1")];

/** The record a `message add` has to produce for that exchange. */
const TURN_TARGET = { turnId: "m1", messageId: "m2", role: "assistant" };

function tagRecord(scope: string, op: string, tags: string[], target?: unknown): any {
  return { v: 1, scope, op, tags, ...(target ? { target } : {}) };
}

/**
 * Invoke `/tag` and read back what the user was told and what the footer now says. The context carries
 * its own ui, so notifications and statuses have to come from there rather than from the suite's.
 */
async function run(pi: FakePi, args: string, options = {}): Promise<{ messages: string[]; status: string | undefined; ui: FakeUi }> {
  const { ui, context } = createContext(options);
  await pi.commands.get("tag")!.handler!(args, context);
  return { messages: ui.notifications.map((n) => n.message as string), status: ui.statuses.get(STATUS_KEY), ui };
}

describe("tags", () => {
  let pi: FakePi;

  beforeEach(async () => {
    pi = await load();
  });

  it("registers the command, the transcript renderer, and the two events that rebuild the footer", () => {
    expect([...pi.commands.keys()].sort()).toEqual(["tag"]);
    expect(pi.entryRenderers.has(ENTRY_TYPE)).toBe(true);
    expect([...new Set(pi.lifecycleEvents)].sort()).toEqual(["session_start", "session_tree"]);
  });

  it("tags the exchange, not the entry that happened to be the leaf", async () => {
    await run(pi, "message add prod winner", { branch: TURN });
    expect(last(pi)).toEqual({
      v: 1,
      scope: "message",
      op: "add",
      tags: ["prod", "winner"],
      target: TURN_TARGET,
    });
    // turnId is the prompt and messageId is the answer, so the record spans the prompt, the calls the
    // agent makes between them, and the response, which is the thing being labelled.
    expect(last(pi).target.turnId).toBe("m1");
    expect(last(pi).target.messageId).toBe("m2");
  });

  it("says what it did", async () => {
    const { messages } = await run(pi, "message add prod", { branch: TURN });
    expect(messages).toEqual(["tagged this turn with #prod"]);
  });

  it("normalizes tags so one idea cannot become two tags", async () => {
    // `#Prod`, `PROD` and `prod` have to be the same tag or no filter ever finds them both.
    await run(pi, "message add #Winner PROD winner", { branch: TURN });
    const data = last(pi);
    expect(data.tags).toEqual(["prod", "winner"]);
    // Stored sorted, so the record and what the command prints agree.
    expect(data.tags).toEqual([...data.tags].sort());
    expect(pi.appendedEntries).toHaveLength(1);
  });

  it("takes commas as well as spaces between tags", async () => {
    await run(pi, "message add #ci, home-ops ,2026-11-04", { branch: TURN });
    expect(last(pi).tags).toEqual(["2026-11-04", "ci", "home-ops"]);
  });

  it("joins two tags made at different points in the same exchange", async () => {
    // Tagged mid-turn (after a tool result), then again after the answer. Taking the leaf each time would
    // give the second tag a different subject, and the two would never join up.
    const branch = [
      message("m1", "user", "roll the rollout", null),
      message("m2", "assistant", "checking", "m1"),
      message("m3", "toolResult", "readiness probe ok", "m2"),
      tagEntry(tagRecord("message", "add", ["mid-turn"], { turnId: "m1", messageId: "m3", role: "toolResult" }), "t1", "m3"),
      message("m4", "assistant", "rolled out", "m3"),
    ];

    await run(pi, "message add after-the-answer", { branch });
    expect(last(pi).target).toEqual({ turnId: "m1", messageId: "m4", role: "assistant" });

    // Both records on the branch: the mid-turn tag and the one that names the same turn by its prompt.
    const { messages } = await run(pi, "message list", { branch: [...branch, tagEntry(last(pi), "t2", "m4")] });
    expect(messages[0]).toContain("turn #after-the-answer #mid-turn");
  });

  it("keeps a tag on the turn that opened it, not on the next turn", async () => {
    const branch = [...TURN, tagEntry(tagRecord("message", "add", ["prod"], TURN_TARGET), "t1", "m2"), message("m3", "user", "now check the logs", "m2")];
    const { messages } = await run(pi, "list", { branch });
    // The current turn is m3, which carries nothing; the tagged turn is the other one.
    expect(messages[0]).toContain("turn none (1 other tagged turn)");
  });

  it("writes nothing for an operation that would change nothing", async () => {
    const tagged = [tagEntry(tagRecord("message", "add", ["prod"], TURN_TARGET), "t1", "m2")];

    const already = await run(pi, "message add prod", { branch: [...TURN, ...tagged] });
    expect(already.messages[0]).toContain("this turn already carries #prod");

    const missing = await run(pi, "message remove bogus", { branch: [...TURN, ...tagged] });
    expect(missing.messages[0]).toContain("this turn is not tagged #bogus");

    const empty = await run(pi, "message clear", { branch: TURN });
    expect(empty.messages[0]).toContain("nothing is tagged on this turn");

    // A record that does nothing makes the log read as though something had been applied, and clutters a
    // transcript that is already showing the tag.
    expect(pi.appendedEntries).toEqual([]);
  });

  it("removes only the tags that are there and says which were not", async () => {
    const branch = [...TURN, tagEntry(tagRecord("message", "add", ["prod", "winner"], TURN_TARGET), "t1", "m2")];
    const { messages } = await run(pi, "message remove prod bogus", { branch });

    expect(last(pi)).toEqual({ v: 1, scope: "message", op: "remove", tags: ["prod"], target: TURN_TARGET });
    expect(messages[0]).toContain("untagged #prod from this turn");
    expect(messages[0]).toContain("this turn was not tagged #bogus");

    // Replay of the log the two records leave behind.
    const after = await run(pi, "message list", { branch: [...branch, tagEntry(last(pi), "t2", "m2")] });
    expect(after.messages[0]).toContain("turn #winner");
  });

  it("records what a clear removed, so the log says what was lost", async () => {
    const branch = [...TURN, tagEntry(tagRecord("message", "add", ["prod", "winner"], TURN_TARGET), "t1", "m2")];
    await run(pi, "message clear", { branch });
    expect(last(pi)).toEqual({ v: 1, scope: "message", op: "clear", tags: ["prod", "winner"], target: TURN_TARGET });
  });

  it("tags the session with no target, and keeps it in the footer", async () => {
    const added = await run(pi, "session add wip ci", { branch: TURN });
    expect(last(pi)).toEqual({ v: 1, scope: "session", op: "add", tags: ["ci", "wip"] });
    expect(added.status).toBe("tags #ci #wip");

    const removed = await run(pi, "session remove wip", { branch: [...TURN, tagEntry(last(pi), "t1", "m2")] });
    expect(removed.status).toBe("tags #ci");

    const cleared = await run(pi, "session clear", { branch: [...TURN, tagEntry(tagRecord("session", "add", ["ci"]), "t1", "m2")] });
    expect(last(pi)).toEqual({ v: 1, scope: "session", op: "clear", tags: ["ci"] });
    // Nothing left, so the footer slot is cleared rather than left holding the tags that were removed.
    expect(cleared.status).toBeUndefined();
  });

  it("leaves the footer alone for turn tags, which would go stale on the next turn", async () => {
    const { ui } = await run(pi, "message add prod", { branch: TURN });
    expect(ui.statuses.size).toBe(0);
  });

  it("rebuilds the footer from the branch on resume and on /tree", async () => {
    const branch = [...TURN, tagEntry(tagRecord("session", "add", ["retro", "wip"]), "t1", "m2")];
    for (const event of ["session_start", "session_tree"]) {
      const { context, ui } = createContext({ branch });
      await pi.emit(event, {}, context);
      expect(ui.statuses.get(STATUS_KEY), event).toBe("tags #retro #wip");
    }

    // A session with no tags has nothing to show, and the footer slot has to be cleared rather than left
    // holding the previous session's tags.
    const { context, ui } = createContext({ branch: TURN });
    await pi.emit("session_start", {}, context);
    expect(ui.statuses.get(STATUS_KEY)).toBeUndefined();
  });

  it("writes the tag even when there is no UI to show it", async () => {
    // Print and JSON mode set hasUI: false. The record is the point of the command, so a headless run
    // still has to persist it, and the notification and footer have to be skipped rather than thrown.
    const { context, ui } = createContext({ branch: TURN, hasUI: false, mode: "print" });
    await pi.commands.get("tag")!.handler!("session add retro", context);
    expect(last(pi).tags).toEqual(["retro"]);
    expect(ui.notifications).toEqual([]);
    expect(ui.statuses.size).toBe(0);
  });

  it("refuses a scope or verb it does not know and writes nothing", async () => {
    for (const args of ["mes add x", "massage add x", "message ad x", "message adds x", "list add", "prod"]) {
      const { messages } = await run(pi, args, { branch: TURN });
      expect(messages[0], args).toMatch(/usage: \/tag|list takes no tags/);
    }
    expect(pi.appendedEntries).toEqual([]);
  });

  it("keeps the valid tags and names the ones it ignored", async () => {
    const long = "x".repeat(80);
    const { messages, ui } = await run(pi, `session add good #also_ok "bad!tag" $weird ${long}`, { branch: TURN });
    expect(last(pi).tags).toEqual(["also_ok", "good"]);
    // One notification per invocation: the TUI replaces the last status line rather than stacking them,
    // so a second report would silently swallow this one.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("ignored");
    expect(messages[0]).toContain("bad!tag");
    expect(messages[0]).toContain(long);
    expect(ui.notifications[0].level).toBe("info");
  });

  it("writes nothing when every tag was rejected", async () => {
    const { messages } = await run(pi, "message add # ! ? @x", { branch: TURN });
    expect(messages[0]).toContain("ignored");
    expect(messages[0]).toContain("usage: /tag message add <tag>");
    expect(pi.appendedEntries).toEqual([]);
  });

  it("refuses to push a scope past the tag limit", async () => {
    const full = Array.from({ length: 64 }, (_unused, index) => `tag${index}`);
    const { messages } = await run(pi, "session add one-too-many", { branch: [...TURN, tagEntry(tagRecord("session", "add", full), "t1", "m2")] });
    expect(messages[0]).toContain("over 64 tags");
    expect(pi.appendedEntries).toEqual([]);
  });

  it("has nothing to tag before there is a turn", async () => {
    const { messages } = await run(pi, "message add prod", { branch: [] });
    expect(messages[0]).toContain("nothing to tag yet");
    expect(pi.appendedEntries).toEqual([]);
  });

  it("does not mistake the system prompt patch for a turn", async () => {
    // A `message` entry with role system is the prompt and tool loadout being patched, and it is often
    // the newest entry in the tree.
    const branch = [...TURN, { ...message("s1", "system", "", "m2"), message: { role: "system", content: "", sections: { tools: "read" } } } as unknown as SessionEntry];
    await run(pi, "message add prod", { branch });
    expect(last(pi).target).toEqual(TURN_TARGET);

    const onlySystem = await run(pi, "message add prod", { branch: [branch[2]!] });
    expect(onlySystem.messages[0]).toContain("nothing to tag yet");
    expect(pi.appendedEntries.filter((entry) => entry.type === ENTRY_TYPE)).toHaveLength(1);
  });

  it("keeps tags across a compaction", async () => {
    // The replay reads the raw branch. Compaction changes what the model sees, not what was tagged.
    const branch = [
      ...TURN,
      tagEntry(tagRecord("message", "add", ["prod"], TURN_TARGET), "t1", "m2"),
      compaction("c1", "t1"),
    ];
    const { messages } = await run(pi, "message list", { branch });
    expect(messages[0]).toContain("turn #prod");
  });

  it("ignores an entry that is not one of its own records", async () => {
    // customType is one flat namespace shared with every other extension and with Pi, and `tag` is a
    // common word. Foreign or unreadable records have to be ignored rather than misread.
    const foreign = [
      foreignTag({ scope: "session", tags: ["not-ours"] }),
      foreignTag({ v: 2, scope: "session", op: "add", tags: ["future-version"] }),
      foreignTag({ v: 1, scope: "message", op: "add", tags: ["no-target"] }),
      foreignTag("nonsense"),
    ];
    const { messages } = await run(pi, "list", { branch: [...TURN, ...foreign] });
    expect(messages[0]).toContain("session none");
    expect(messages[0]).toContain("turn none");
    expect(messages[0]).not.toContain("not-ours");
  });

  it("never reaches the model", () => {
    const branch = [...TURN, tagEntry(tagRecord("message", "add", ["judging-the-model"], TURN_TARGET))];
    const context = buildSessionContext(branch);
    const text = JSON.stringify(context.messages);
    expect(context.messages).toHaveLength(2);
    expect(text).not.toContain("judging-the-model");
    expect(text).not.toContain(ENTRY_TYPE);
  });

  it("lists both scopes in one line", async () => {
    const branch = [
      ...TURN,
      tagEntry(tagRecord("session", "add", ["wip"]), "t1", "m2"),
      tagEntry(tagRecord("message", "add", ["prod"], TURN_TARGET), "t2", "m2"),
    ];
    const { messages } = await run(pi, "", { branch });
    expect(messages[0]).toBe("tags · session #wip · turn #prod");
  });

  it("renders in the transcript so tags are visible to the human", () => {
    const renderer = pi.entryRenderers.get(ENTRY_TYPE)!;
    const render = (data: unknown) => {
      const component = renderer(tagEntry(data), { expanded: false }, fakeTheme);
      return component ? painted(component) : undefined;
    };

    const tagged = render(tagRecord("message", "add", ["prod"], TURN_TARGET));
    expect(tagged).toContain("tagged turn");
    // Labelled by the transcript's own custom-message colour, tags in accent, so they are readable in a
    // long transcript without hunting for them.
    expect(tagged).toContain("[customMessageLabel]tagged turn[/customMessageLabel]");
    expect(tagged).toContain("[accent]#prod[/accent]");
    // Which message was looked at, and when: the turn is identified by its prompt, so the answer's entry
    // id only appears when it is a different entry.
    expect(tagged).toContain("[dim]assistant · m2 · ");

    const session = render(tagRecord("session", "add", ["wip", "ci"]))!;
    expect(session).toContain("[customMessageLabel]tagged session[/customMessageLabel]");
    expect(session).toContain("[accent]#ci #wip[/accent]");
    // A session tag has no message to report, so the dim line carries only the time.
    expect(session).toContain("[dim]");
    expect(session).not.toContain("m2");

    expect(render(tagRecord("session", "remove", ["wip"]))).toContain("untagged session");
    expect(render(tagRecord("session", "remove", ["wip"]))).toContain("#wip");
    const clearedRecord = render(tagRecord("message", "clear", [], TURN_TARGET))!;
    expect(clearedRecord).toContain("cleared turn");
    // A clear removes everything, and the record names what was removed. With nothing named, the line has
    // to say so rather than show an empty tag list.
    expect(clearedRecord).toContain("(everything)");

    // A malformed entry from an older session, or another extension's record that happens to use the same
    // name, must not take the TUI down.
    expect(render(undefined)).toBeUndefined();
    expect(render("nonsense")).toBeUndefined();
    expect(render({ v: 2, scope: "session", op: "add", tags: [] })).toBeUndefined();
  });

  it("completes the grammar with values that still match what has been typed", () => {
    const complete = pi.commands.get("tag")!.getArgumentCompletions!;
    // Pi replaces the whole argument text with item.value and matches items with value.startsWith(prefix),
    // so a value that drops the words already typed corrupts the line.
    for (const prefix of ["", "l", "li", "me", "se", "session", " ", "  mes", "message ", "message a", "message re", "session cl"]) {
      const items = complete(prefix) as Array<{ value: string; label: string }> | null;
      expect(items, `prefix "${prefix}"`).not.toBeNull();
      for (const item of items!) {
        expect(typeof item.value).toBe("string");
        expect(item.value.length, prefix).toBeGreaterThan(0);
        expect(item.value.startsWith(prefix), `${prefix} -> ${item.value}`).toBe(true);
      }
    }

    expect(complete("message add ")).toBeNull();
    expect(complete("message add prod")).toBeNull();
    expect(complete("zzz")).toBeNull();
    expect(complete("list ")).toBeNull();
    expect(complete("list add")).toBeNull();
    expect(complete("list")).toEqual([{ value: "list", label: "list" }]);
  });
});
