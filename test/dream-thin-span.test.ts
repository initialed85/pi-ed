/**
 * The thin-span contract, driven against a fake store.
 *
 * This exists because of a real loss on the fleet. At 10:04 on 10-Nov-26 a peer's question about the Earl himself
 * arrived in macker's session (01a1b9ad): "Today you told me to stop installing structure around these things ... but
 * you also spent the same day building: a new agent, a memory extension, a scheduler, a recall probe, a router. When
 * you build something for these agents, is it the building you want, or the result?" At 10:15 the idle dream fired,
 * the dream prompt told the agent to decline a thin stretch, the agent declined, and `closeDreamTurn` moved
 * `dream_seq` past the whole thing anyway - so the rows were neither remembered nor left in the next memory's span,
 * and no search on the fleet can find them.
 *
 * Two contracts, then, and both are about the store rather than the prose:
 *
 *   1. A short span is *written*. The count refuses only a span with nothing in it; below the floor but above zero,
 *      the memory lands and the thinness is a note in the result.
 *   2. A dream that writes nothing closes only the "has this been asked about" watermark. The summarization cursor
 *      stays put, so the stretch is folded into the next memory instead of being buried by the one that declined it.
 *
 * Every other suite here deliberately points at a closed port, because the write path has to be correct when the
 * store is unreachable. This one is the mirror image: it is the only place the *happy* path is exercised, and it is
 * worth a `vi.mock` to have it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext, callTool, type FakePi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/memory.ts");
const MEMORY_ID = "11111111-1111-1111-1111-111111111111";

const store = vi.hoisted(() => ({
  /** Every statement the extension sent, in order, so a test can ask what the writer actually did. */
  queries: [] as { sql: string; values: unknown[] }[],
  /** What the span query reports back: the number of non-dream rows since the summarization cursor. */
  workEvents: 2,
}));

vi.mock("pg", () => {
  function answer(sql: string, values: unknown[]) {
    store.queries.push({ sql, values });
    if (/as work_events/.test(sql)) return { rows: [{ last_seq: 12, work_events: store.workEvents }] };
    if (/as work_before/.test(sql)) return { rows: [{ work_before: 0 }] };
    if (/insert into memory\.memory /.test(sql)) return { rows: [{ id: MEMORY_ID }] };
    return { rows: [] };
  }
  class FakePool {
    async connect() {
      return { query: async (sql: string, values?: unknown[]) => answer(sql, values ?? []), release: () => {} };
    }
    async query(sql: string, values?: unknown[]) {
      return answer(sql, values ?? []);
    }
    async end() {}
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

let dir: string;
let agentConfigPath: string;
let spoolPath: string;

/** A branch that looks like a short stretch of conversation: one message, one reply, nothing built. */
function branch(): any[] {
  return [
    { type: "message", id: "e1", parentId: null, timestamp: "2026-11-10T02:04:00.000Z", message: { role: "user", content: "[Team inbox] ocr: a question for Ed about himself" } },
    { type: "message", id: "e2", parentId: "e1", timestamp: "2026-11-10T02:04:12.000Z", message: { role: "assistant", content: [{ type: "text", text: "Another packet from ocr, m'lord, delivered whole." }] } },
    { type: "custom", id: "e3", parentId: "e2", timestamp: "2026-11-10T02:04:13.000Z", customType: "turn-stats", content: "settled" },
    // The branch is the whole history, so the trigger sees enough rows to ask; the store's span is the two rows since
    // the last dream, which is the mismatch that made macker's stretch look worthless to a counter and interesting to
    // anybody who read it.
    { type: "message", id: "e4", parentId: "e3", timestamp: "2026-11-10T02:04:20.000Z", message: { role: "user", content: "hmm, did the drama interrupt you from the actual thing?" } },
  ];
}

async function load(): Promise<FakePi> {
  process.env.PI_MEMORY_CONFIG = agentConfigPath;
  process.env.PI_MEMORY_SPOOL = spoolPath;
  process.env.PI_MEMORY_DSN = "postgresql://memory-test:hunter2@127.0.0.1:5432/memory-test";
  delete process.env.PI_MEMORY_DISABLED;
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}

/** Start a session, settle a turn, and let the idle clock fire the dream prompt. */
async function dreaming(): Promise<{ pi: FakePi; context: any }> {
  vi.useFakeTimers();
  const pi = await load();
  const { context } = createContext({ branch: branch(), cwd: "/workspace/macker", sessionName: "macker", sessionId: "session-macker" });
  await pi.emit("session_start", { reason: "new" }, context);
  await pi.emit("agent_settled", { aborted: false }, context);
  vi.advanceTimersByTime(11 * 60_000);
  return { pi, context };
}

const sqlThat = (pattern: RegExp) => store.queries.filter((q) => pattern.test(q.sql));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pi-ed-thin-"));
  // A floor of 4 is the shipped default, and embeddings are off so the test does not reach for a model.
  agentConfigPath = path.join(dir, "agent-memory.json");
  spoolPath = path.join(dir, "spool.jsonl");
  writeFileSync(agentConfigPath, JSON.stringify({ flushMs: 50, embeddings: false, minDreamWork: 4 }), "utf8");
  store.queries = [];
  store.workEvents = 2;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PI_MEMORY_CONFIG;
  delete process.env.PI_MEMORY_SPOOL;
  delete process.env.PI_MEMORY_DSN;
});

describe("a thin stretch that is worth remembering", () => {
  it("is written, with the count kept as an opinion rather than a verdict", async () => {
    const { pi, context } = await dreaming();
    expect(pi.sentMessages, "the idle dream should still ask").toHaveLength(1);

    const result = await callTool(
      pi,
      "memory_dream",
      {
        summary: "ocr asked Ed whether it is the building he wants or the result, and the question is worth keeping.",
        subjects: ["Ed's building versus adjacency", "fleet messages relayed through the team room"],
        feel: "The gate nearly threw away the most interesting thing all day.",
      },
      context,
    );

    const text = String(result.content[0]?.text);
    expect(text).toContain("dream recorded");
    expect(text).toContain("thin span: 2 work event(s), under the 4");
    expect(text).not.toContain("memory_dream not written");
    expect(sqlThat(/insert into memory\.memory /), "a two-event span must still produce a memory row").toHaveLength(1);
    // The thinness is recorded on the row itself, so a future reader can see the count was overridden and by what.
    expect(JSON.stringify(result.details)).toContain("thin span");
  });

  it("closes the stretch for both watermarks once a memory really was written", async () => {
    const { pi, context } = await dreaming();
    await callTool(pi, "memory_dream", { summary: "written properly", subjects: ["pi-ed"], feel: "content" }, context);

    const cursors = sqlThat(/update memory\.session set dream_seq /);
    expect(cursors, "the write path must move the summarization cursor").toHaveLength(1);
    // ...and the considered one with it, or the next resume re-asks about work that has already been described.
    expect(cursors[0]!.sql).toContain("dream_considered_seq");
  });
});

describe("a dream that writes nothing", () => {
  it("refuses only a span with nothing in it", async () => {
    store.workEvents = 0;
    const { pi, context } = await dreaming();
    const result = await callTool(pi, "memory_dream", { summary: "surely something", subjects: ["pi-ed"], feel: "wary" }, context);

    expect(String(result.content[0]?.text)).toContain("nothing unsummarized since the last dream");
    expect(sqlThat(/insert into memory\.memory /)).toHaveLength(0);
    expect(result.details).toMatchObject({ error: "empty span" });
  });

  it("advances the asking watermark and leaves the summarization one alone", async () => {
    const { pi, context } = await dreaming();
    // The agent answers the prompt without calling the tool, which is exactly what macker did at 10:15.
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.useRealTimers();

    // The closing write is asynchronous, so wait for what actually happened rather than for a fixed sleep.
    await vi.waitFor(
      () => {
        expect(sqlThat(/update memory\.session set dream_considered_seq /).length, "the decline should close the stretch for asking").toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    expect(
      sqlThat(/update memory\.session set dream_seq /).length,
      "a decline is not a verdict on the content, and must not bury the rows",
    ).toBe(0);
  });
});
