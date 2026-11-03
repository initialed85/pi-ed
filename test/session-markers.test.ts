import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createFakePi, createContext, type FakePi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/session-markers.ts");

// The two strings the analysis pass depends on. Duplicated on purpose: if someone renames the file
// or the customType, the reader of old sessions and this test disagree, and that has to be a
// conscious decision rather than a silent refactor.
const ENTRY_TYPE = "model-marker";

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
    timestamp: "2026-11-03T22:32:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

function marker(data: unknown, id = "k1", parentId = "m2"): SessionEntry {
  return { type: "custom", customType: ENTRY_TYPE, data, id, parentId, timestamp: "2026-11-03T22:33:00.000Z" } as SessionEntry;
}

/** The branch a mark would be made on: a user prompt, an assistant answer, then the mark. */
const BRANCH = [message("m1", "user", "deploy the config", null), message("m2", "assistant", "deployed, three pods restarted", "m1")];

/** The last entry appended, which is what the extension wrote. */
function lastEntry(pi: FakePi): any {
  return pi.appendedEntries.at(-1);
}

/**
 * Invoke a command with its own context and return what it told the user. The context carries its
 * own ui, so notifications have to be read back from there rather than from the suite's.
 */
async function run(pi: FakePi, command: "comment" | "score", args: string, options = {}) {
  const { ui, context } = createContext(options);
  await pi.commands.get(command)!.handler!(args, context);
  return ui.notifications.map((n) => n.message as string);
}

describe("session markers", () => {
  let pi: FakePi;

  beforeEach(async () => {
    pi = await load();
  });

  it("registers both commands and a renderer for the entries they write", () => {
    expect([...pi.commands.keys()].sort()).toEqual(["comment", "score"]);
    expect(pi.entryRenderers.has(ENTRY_TYPE)).toBe(true);
  });

  it("writes a comment as a marker, and says so", async () => {
    const { context, ui } = createContext({ branch: BRANCH });
    await pi.commands.get("comment")!.handler!("the rollback took nine minutes", context);

    expect(lastEntry(pi)).toEqual({
      type: ENTRY_TYPE,
      data: {
        v: 1,
        kind: "comment",
        text: "the rollback took nine minutes",
        model: "test-provider/test-model",
        thinkingLevel: "high",
        target: { entryId: "m2", role: "assistant" },
      },
    });
    expect(ui.notifications.map((n) => n.message)).toEqual(["commented"]);
  });

  it("scores each value, including the neutral one", async () => {
    const { context } = createContext({ branch: BRANCH });
    for (const [score, label] of [[0, "bad"], [1, "neutral"], [2, "good"]] as const) {
      await pi.commands.get("score")!.handler!(String(score), context);
      const data = lastEntry(pi).data;
      expect(data).toMatchObject({ kind: "score", score, label });
      // A score is a number in the record, not a string, so a reader can average it without parsing.
      expect(typeof data.score).toBe("number");
    }
    // 1 is not a no-op: absence of a mark must not read as "neutral", or the analysis cannot tell an
    // unrated turn from a rated-neutral one.
    expect(pi.appendedEntries).toHaveLength(3);
  });

  it("takes the words as well as the numbers", async () => {
    const { context } = createContext({ branch: BRANCH });
    for (const [word, score] of [["bad", 0], ["neutral", 1], ["ok", 1], ["good", 2], ["GOOD", 2]] as const) {
      await pi.commands.get("score")!.handler!(word, context);
      expect(lastEntry(pi).data, word).toMatchObject({ score });
    }
  });

  it("keeps the rest of the line as a note", async () => {
    const { context } = createContext({ branch: BRANCH });
    await pi.commands.get("score")!.handler!("0 hallucinated the namespace", context);
    expect(lastEntry(pi).data).toMatchObject({ score: 0, label: "bad", note: "hallucinated the namespace" });
  });

  it("refuses anything that is not a score and writes nothing", async () => {
    const { context } = createContext({ branch: BRANCH });
    for (const bad of ["3", "-1", "10", "meh", "0.5"]) {
      const messages = await run(pi, "score", bad);
      expect(messages[0], bad).toContain("score must be 0 (bad), 1 (neutral) or 2 (good)");
    }
    expect(pi.appendedEntries).toEqual([]);
  });

  it("asks for text instead of writing an empty comment", async () => {
    expect(await run(pi, "comment", "   ")).toEqual(["usage: /comment <text>"]);
    expect(await run(pi, "score", "")).toEqual(["usage: /score <0 bad | 1 neutral | 2 good> [note]"]);
    expect(pi.appendedEntries).toEqual([]);
  });

  it("marks the message, not the previous mark", async () => {
    // Two marks in a row: the leaf after the first is a custom entry, so taking the leaf would make
    // the second one rate the first one and the two would never join up.
    const { context } = createContext({ branch: [...BRANCH, marker({ v: 1, kind: "score", score: 0, label: "bad" })] });
    await pi.commands.get("score")!.handler!("2", context);
    await pi.commands.get("comment")!.handler!("correction", context);
    expect(pi.appendedEntries.map((e: any) => e.data.target)).toEqual([
      { entryId: "m2", role: "assistant" },
      { entryId: "m2", role: "assistant" },
    ]);
  });

  it("records the model and thinking level that were in use, not the ones in use now", async () => {
    pi.setThinkingLevel("low");
    const { context } = createContext({
      branch: BRANCH,
      model: { provider: "sushi", id: "qwen3.8-flash-next" },
    });
    await pi.commands.get("score")!.handler!("1", context);
    expect(lastEntry(pi).data).toMatchObject({ model: "sushi/qwen3.8-flash-next", thinkingLevel: "low" });
  });

  it("writes the marker anyway when there is nothing to mark", async () => {
    const { context } = createContext({ branch: [] });
    await pi.commands.get("comment")!.handler!("a note before any turn", context);
    expect(lastEntry(pi).data).toEqual({
      v: 1,
      kind: "comment",
      text: "a note before any turn",
      model: "test-provider/test-model",
      thinkingLevel: "high",
    });
  });

  // The guarantee the whole feature rests on, asserted against Pi's own context builder rather than
  // against a comment in this file. If a future Pi starts projecting custom entries into context,
  // this fails and the marks are no longer private.
  it("does not reach the model", () => {
    const data = { v: 1, kind: "score" as const, score: 2, label: "good", note: "secretly judging" };
    const context = buildSessionContext([...BRANCH, marker(data)]);
    const text = JSON.stringify(context.messages);
    expect(context.messages).toHaveLength(2);
    expect(text).not.toContain("secretly judging");
    expect(text).not.toContain(ENTRY_TYPE);
  });

  it("renders in the transcript so the marks are visible to the human", () => {
    const renderer = pi.entryRenderers.get(ENTRY_TYPE)!;
    const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text };
    const render = (data: unknown) => {
      const component = renderer(marker(data), { expanded: false }, theme);
      return component ? (component.render(80).join("\n") as string) : undefined;
    };

    expect(render({ v: 1, kind: "score", score: 2, label: "good", note: "nailed it" })).toContain("score 2 (good) nailed it");
    expect(render({ v: 1, kind: "score", score: 0, label: "bad" })).toContain("score 0 (bad)");
    expect(render({ v: 1, kind: "comment", text: "nine minutes" })).toContain("comment nine minutes");
    // A malformed entry from an older session must not take the TUI down.
    expect(render(undefined)).toBeUndefined();
    expect(render("nonsense")).toBeUndefined();
  });

  it("offers completions that all carry a string value", async () => {
    // pi's getBestAutocompleteMatchIndex calls item.value.startsWith(prefix) unguarded, so a
    // completion with no value, or a non-string one, crashes the TUI.
    const complete = pi.commands.get("score")!.getArgumentCompletions!;
    for (const prefix of ["", "0", "1", "2", " 1"]) {
      const items = complete(prefix) as Array<{ value: string; label: string }> | null;
      expect(items, `prefix "${prefix}"`).not.toBeNull();
      for (const item of items!) {
        expect(typeof item.value).toBe("string");
        expect(item.value.length).toBeGreaterThan(0);
      }
    }
    expect(complete("zzz")).toBeNull();
  });
});
