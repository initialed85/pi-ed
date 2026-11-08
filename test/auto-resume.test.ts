import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createContext, createFakePi, fakeTheme, painted, type FakePi } from "./harness.ts";
import {
  decideFacts,
  describeTail,
  humanAge,
  markerSentence,
  parseDuration,
  promptText,
  type Config,
} from "../extensions/auto-resume.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/auto-resume.ts");
const ENTRY_TYPE = "auto-resume";
const PROMPT_TYPE = "auto-resume-prompt";
const STATUS_KEY = "auto-resume";

const NOW = Date.parse("2026-11-06T00:00:00.000Z");
const HOUR = 3_600_000;
const CONFIG_ENVS = ["AUTO_RESUME_OFF", "AUTO_RESUME_MAX_AGE", "AUTO_RESUME_SKIP_IDLE", "AUTO_RESUME_STATE_FILE", "AUTO_RESUME_DEBUG"];

const iso = (ms: number): string => new Date(ms).toISOString();
const cfg = (over: Partial<Config> = {}): Config => ({ v: 1, enabled: true, maxAgeMs: 0, skipIdle: false, ...over });

/* ------------------------------------------------------------------ entry builders */

function userMessage(id: string, at: number, text = "", parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

function assistantMessage(
  id: string,
  at: number,
  options: {
    text?: string;
    stopReason?: string;
    toolCalls?: Array<{ name: string; arguments?: unknown }>;
    model?: string;
    errorMessage?: string;
  } = {},
  parentId: string | null = null,
): SessionEntry {
  const content: unknown[] = [];
  if (options.text) content.push({ type: "text", text: options.text });
  for (const call of options.toolCalls ?? []) content.push({ type: "toolCall", id: `${id}-call`, name: call.name, arguments: call.arguments ?? {} });
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: { role: "assistant", content, model: options.model ?? "claude-test", stopReason: options.stopReason ?? "stop", errorMessage: options.errorMessage },
  } as unknown as SessionEntry;
}

function toolResultMessage(id: string, at: number, toolName: string, options: { isError?: boolean; text?: string } = {}, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: { role: "toolResult", toolName, isError: Boolean(options.isError), content: [{ type: "text", text: options.text ?? `${toolName} output` }] },
  } as unknown as SessionEntry;
}

function marker(id: string, at: number, data: unknown, parentId: string | null = null): SessionEntry {
  return { type: "custom", customType: ENTRY_TYPE, data, id, parentId, timestamp: iso(at) } as SessionEntry;
}

function ownPrompt(id: string, at: number, parentId: string | null = null): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: iso(at),
    customType: PROMPT_TYPE,
    content: [{ type: "text", text: "(auto-resume) ... Respond in this order" }],
    display: true,
  } as unknown as SessionEntry;
}

/* ------------------------------------------------------------------ durations and ages */

describe("durations", () => {
  it("reads the shapes a person types, and defaults a bare number to minutes", () => {
    expect(parseDuration("2h")?.ms).toBe(2 * HOUR);
    expect(parseDuration("45m")?.ms).toBe(45 * 60_000);
    expect(parseDuration("1d")?.ms).toBe(24 * HOUR);
    expect(parseDuration("45")?.ms).toBe(45 * 60_000);
    expect(parseDuration("1h 30m")?.ms).toBe(90 * 60_000);
    expect(parseDuration("1h 30m")?.text).toBe("1h 30m");
    expect(parseDuration("2 weeks")?.ms).toBe(14 * 24 * HOUR);
  });

  it("rejects anything that is not a duration, rather than guessing at it", () => {
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("off")).toBeUndefined();
  });

  it("says how long ago something stopped the way a person would read it", () => {
    expect(humanAge(30_000)).toBe("30s");
    expect(humanAge(9 * 60_000)).toBe("9m");
    expect(humanAge(2 * HOUR + 10 * 60_000)).toBe("2h 10m");
    expect(humanAge(30 * HOUR)).toBe("1d 6h");
    expect(humanAge(2 * 24 * HOUR)).toBe("2d");
  });
});

/* ------------------------------------------------------------------ reading the transcript tail */

describe("the transcript tail", () => {
  it("says which tool calls were asked for and never answered", () => {
    const tail = describeTail([
      userMessage("u1", NOW - 3 * HOUR),
      assistantMessage("a1", NOW - 2 * HOUR, {
        stopReason: "toolUse",
        toolCalls: [
          { name: "bash", arguments: { command: "npm run check" } },
          { name: "read", arguments: { path: "extensions/schedule.ts" } },
        ],
      }),
    ])!;

    expect(tail.from).toBe("model");
    expect(tail.pending).toBe(true);
    expect(tail.failed).toBe(false);
    expect(tail.line).toContain("stopReason toolUse");
    expect(tail.line).toContain("asking for");
    expect(tail.line).toContain("`bash` npm run check");
    expect(tail.line).toContain("`read` extensions/schedule.ts");
    expect(tail.line).toContain("no result for those tool calls was recorded");
  });

  it("reads a tool that answered as an action with its follow-up turn missing", () => {
    const tail = describeTail([assistantMessage("a1", NOW - 2 * HOUR), toolResultMessage("t1", NOW - HOUR, "bash", { isError: true, text: "exit 1: two tests failed" } , "a1")])!;

    expect(tail.from).toBe("tool");
    expect(tail.pending).toBe(true);
    expect(tail.failed).toBe(true);
    expect(tail.words).toContain("two tests failed");
  });

  it("treats a prompt nobody answered as unfinished work", () => {
    const tail = describeTail([
      assistantMessage("a1", NOW - 4 * HOUR, { text: "done: the node is back" }),
      userMessage("u2", NOW - 10 * 60_000, "now do the same on guppy"),
    ])!;

    expect(tail.from).toBe("you");
    expect(tail.pending).toBe(true);
    expect(tail.words).toBe("now do the same on guppy");
  });

  it("recognises its own resume prompt sitting unanswered at the end", () => {
    const tail = describeTail([assistantMessage("a1", NOW - 2 * HOUR), ownPrompt("p1", NOW - HOUR, "a1")])!;
    expect(tail.ownPrompt).toBe(true);
  });

  it("names a truncated turn and an errored turn for what they are", () => {
    const truncated = describeTail([assistantMessage("a1", NOW - HOUR, { text: "here is the plan, first", stopReason: "length" })])!;
    const errored = describeTail([assistantMessage("a2", NOW - HOUR, { stopReason: "error", errorMessage: "429 rate limited" })])!;

    expect(truncated.line).toContain("truncated by the token limit");
    expect(errored.failed).toBe(true);
    expect(errored.line).toContain("429 rate limited");
  });

  it("skips the quiet entries on the way to the last real action", () => {
    const tail = describeTail([
      userMessage("u1", NOW - 6 * HOUR),
      assistantMessage("a1", NOW - 5 * HOUR, { text: "working on it" }),
      marker("k1", NOW - 4 * HOUR, { v: 1, op: "settled", at: NOW - 4 * HOUR, tools: 2 }),
    ])!;

    expect(tail.from).toBe("model");
    expect(tail.at).toBe(NOW - 5 * HOUR);
  });

  it("returns nothing when the session has no actions in it", () => {
    expect(describeTail([])).toBeUndefined();
    expect(describeTail([marker("k1", NOW - HOUR, { v: 1, op: "start", at: NOW - HOUR })])).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ the judgement */

describe("what the record says", () => {
  it("leaves a session that never stopped alone", () => {
    for (const reason of ["new", "fork", "reload"]) {
      const facts = decideFacts([userMessage("u1", NOW - HOUR), assistantMessage("a1", NOW - 1, { text: "hi" })], reason, cfg(), NOW);
      expect(facts.eligible, reason).toBe(false);
      expect(facts.skipReason, reason).toContain(reason);
    }
  });

  it("has nothing to continue in a resumed session that is empty", () => {
    const facts = decideFacts([], "startup", cfg(), NOW);
    expect(facts.eligible).toBe(false);
    expect(facts.skipReason).toContain("no activity recorded");
  });

  it("refuses to stack a second resume prompt on top of the first", () => {
    const facts = decideFacts([userMessage("u1", NOW - 3 * HOUR), ownPrompt("p1", NOW - HOUR, "u1")], "startup", cfg(), NOW);
    expect(facts.eligible).toBe(false);
    expect(facts.skipReason).toContain("already a resume prompt");
  });

  it("believes the session's own exit note over anything it could infer", () => {
    const branch = [
      userMessage("u1", NOW - 3 * HOUR),
      assistantMessage("a1", NOW - 2 * HOUR, { text: "started the deploy" }),
      marker("k1", NOW - 2 * HOUR + 1000, { v: 1, op: "quit", at: NOW - 2 * HOUR + 1000, idle: true, reason: "quit" }),
    ];

    const idle = decideFacts(branch, "startup", cfg(), NOW);
    expect(idle.source).toBe("recorded");
    expect(idle.working).toBe(false);
    expect(idle.state).toBe("idle when it stopped");
    expect(idle.recorded).toContain("waiting for input");

    // Same transcript, the other exit note: a killed tmux window while the agent was mid-run.
    const busy = decideFacts(
      branch.map((entry) => (entry.type === "custom" ? { ...entry, data: { ...(entry as any).data, idle: false } } : entry)),
      "startup",
      cfg(),
      NOW,
    );
    expect(busy.working).toBe(true);
    expect(busy.state).toBe("mid-task when it stopped");
  });

  it("catches the crash a transcript cannot show: a run that started and never settled", () => {
    const facts = decideFacts(
      [userMessage("u1", NOW - 3 * HOUR), assistantMessage("a1", NOW - 2 * HOUR, { text: "running the migration" }), marker("k1", NOW - 2 * HOUR + 1000, { v: 1, op: "start", at: NOW - 2 * HOUR + 1000 })],
      "startup",
      cfg(),
      NOW,
    );

    expect(facts.source).toBe("recorded");
    expect(facts.working).toBe(true);
    expect(facts.state).toContain("never settled");
  });

  it("treats a settled run whose last tool failed as work left behind", () => {
    const facts = decideFacts(
      [
        userMessage("u1", NOW - 3 * HOUR),
        marker("k1", NOW - 2 * HOUR, { v: 1, op: "settled", at: NOW - 2 * HOUR, aborted: false, tools: 4, lastTool: "bash", lastToolFailed: true }),
      ],
      "startup",
      cfg(),
      NOW,
    );

    expect(facts.working).toBe(true);
    expect(facts.failed).toBe(true);
    expect(facts.recorded).toContain("(`bash`) failed");
  });

  it("knows an Escape is the human stopping something on purpose", () => {
    const facts = decideFacts(
      [userMessage("u1", NOW - 3 * HOUR), marker("k1", NOW - 2 * HOUR, { v: 1, op: "settled", at: NOW - 2 * HOUR, aborted: true, tools: 1 })],
      "startup",
      cfg(),
      NOW,
    );

    expect(facts.interrupted).toBe(true);
    expect(facts.working).toBe(false);
    expect(facts.state).toContain("Escape");
    expect(promptText(facts)).toContain("human stopping it on purpose");
  });

  it("prefers the transcript when the only marker is older than what happened after it", () => {
    // A reload writes an exit note; the user then typed something the session never answered.
    const facts = decideFacts(
      [
        userMessage("u1", NOW - 6 * HOUR),
        marker("k1", NOW - 5 * HOUR, { v: 1, op: "quit", at: NOW - 5 * HOUR, idle: true, reason: "reload" }),
        userMessage("u2", NOW - 5 * 60_000, "check guppy's disk again"),
      ],
      "resume",
      cfg(),
      NOW,
    );

    expect(facts.source).toBe("inferred");
    expect(facts.working).toBe(true);
    expect(facts.state).toContain("never got its follow-up turn");
  });

  it("reports an age cap it would honour", () => {
    const branch = [userMessage("u1", NOW - 30 * HOUR), assistantMessage("a1", NOW - 29 * HOUR, { text: "finished" })];
    const capped = decideFacts(branch, "startup", cfg({ maxAgeMs: 6 * HOUR }), NOW);

    expect(capped.eligible).toBe(true);
    expect(capped.stale).toBe(true);
    expect(capped.ageCap).toBe("6h");
    expect(capped.ago).toBe("1d 5h");
  });

  it("quotes the last words on screen so the model can see how a turn ended", () => {
    const facts = decideFacts([userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { text: "deployed. want me to roll guppy next?" })], "startup", cfg(), NOW);

    expect(facts.working).toBe(false);
    expect(promptText(facts)).toContain("want me to roll guppy next?");
    expect(promptText(facts)).toContain("from the transcript tail");
  });
});

/* ------------------------------------------------------------------ the message handed to the model */

describe("the resume prompt", () => {
  const facts = decideFacts(
    [
      userMessage("u1", NOW - 3 * HOUR),
      assistantMessage("a1", NOW - 2 * HOUR, { stopReason: "toolUse", toolCalls: [{ name: "bash", arguments: { command: "longhorn attach csi-a1b2" } }] }),
    ],
    "startup",
    cfg(),
    NOW,
  );

  it("puts the facts before the instructions, and both before the model acts", () => {
    const text = promptText(facts);
    expect(text.indexOf("Stopped")).toBeLessThan(text.indexOf("Respond in this order"));
    expect(text).toContain("Judgement: mid-task");
    expect(text).toContain("`bash` longhorn attach csi-a1b2");
  });

  it("tells the model not to redo work that already succeeded, and not to invent new work", () => {
    const text = promptText(facts);
    expect(text).toContain("Do not redo steps the transcript already shows succeeded");
    expect(text).toContain("No new work, no verification pass");
    expect(text).toContain("ask one short question instead of guessing");
  });

  it("describes a marker in the same words the prompt uses", () => {
    expect(markerSentence({ v: 1, op: "start", at: NOW })).toBe("a run started and never finished");
    expect(markerSentence({ v: 1, op: "settled", at: NOW, tools: 1, lastTool: "read", lastToolFailed: false })).toContain("1 tool call, the last one (`read`) returned");
    expect(markerSentence({ v: 1, op: "settled", at: NOW, tools: 2, lastTool: "bash", lastToolFailed: true })).toContain("(`bash`) failed");
    expect(markerSentence({ v: 1, op: "quit", at: NOW, idle: false, reason: "quit" })).toContain("while a run was still going");
  });
});

/* ------------------------------------------------------------------ the extension in a session */

describe("auto-resume in a session", () => {
  let dir: string;
  let pi: FakePi;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-ed-auto-resume-"));
    for (const name of CONFIG_ENVS) delete process.env[name];
    vi.resetModules();
    const mod = await import(MODULE);
    pi = createFakePi();
    mod.default(pi as any);
  });

  afterEach(() => {
    for (const name of CONFIG_ENVS) delete process.env[name];
    rmSync(dir, { recursive: true, force: true });
  });

  const enable = (over: Partial<Config> = {}): void => {
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(
      settingsFile(),
      `${JSON.stringify({ v: 1, enabled: true, maxAgeMs: 0, skipIdle: false, ...over }, null, 2)}\n`,
      "utf8",
    );
  };

  /** The path the extension writes its settings to for this cwd. */
  const settingsFile = (): string => path.join(dir, CONFIG_DIR_NAME, "auto-resume.json");

  const start = async (options: { reason?: string; branch?: SessionEntry[]; idle?: boolean; mode?: "tui" | "print" | "json"; hasUI?: boolean } = {}) => {
    const record = createContext({ cwd: dir, branch: options.branch ?? [], idle: options.idle ?? true, mode: options.mode, hasUI: options.hasUI });
    await pi.emit("session_start", { type: "session_start", reason: options.reason ?? "startup" }, record.context);
    return record;
  };

  const injected = (): any => pi.sentMessages.at(-1);

  it("does nothing in a repository that never switched it on", async () => {
    const { ui } = await start({ branch: [userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { stopReason: "toolUse", toolCalls: [{ name: "bash", arguments: { command: "make deploy" } }] })] });

    expect(pi.sentMessages).toHaveLength(0);
    expect(pi.appendedEntries).toHaveLength(0);
    expect(ui.statuses.get(STATUS_KEY)).toBeUndefined();
    expect(ui.notifications).toHaveLength(0);
  });

  it("hands a session that died mid-tool-call back to the model, once, immediately", async () => {
    enable();
    const { ui } = await start({
      branch: [
        userMessage("u1", NOW - 3 * HOUR),
        assistantMessage("a1", NOW - 2 * HOUR, { text: "attaching the volume", stopReason: "toolUse", toolCalls: [{ name: "bash", arguments: { command: "longhorn attach csi-a1b2" } }] }),
        marker("k1", NOW - 2 * HOUR + 1000, { v: 1, op: "start", at: NOW - 2 * HOUR + 1000 }),
      ],
    });

    const message = injected();
    expect(pi.sentMessages).toHaveLength(1);
    expect(message.message.customType).toBe(PROMPT_TYPE);
    expect(message.message.display).toBe(true);
    expect(message.options).toEqual({ triggerTurn: true });
    expect(message.message.content).toContain("a run started and never finished");
    expect(message.message.content).toContain("Respond in this order");
    expect(message.message.details.state).toContain("mid-task");
    expect(ui.statuses.get(STATUS_KEY)).toContain("mid-task");
  });

  it("writes the evidence as the session works, so a crash is readable afterwards", async () => {
    enable();
    const record = await start({ branch: [userMessage("u1", NOW - HOUR), assistantMessage("a1", NOW - 1, { text: "hi" })], idle: false });

    await pi.emit("agent_start", { type: "agent_start" }, record.context);
    expect(pi.appendedEntries.at(-1)?.data).toMatchObject({ op: "start" });

    await pi.emit(
      "tool_result",
      { type: "tool_result", toolCallId: "a2/1", toolName: "bash", input: { command: "npm run check" }, content: [{ type: "text", text: "failed" }], isError: true },
      record.context,
    );
    await pi.emit(
      "tool_result",
      { type: "tool_result", toolCallId: "a2/2", toolName: "read", input: { path: "test/schedule.test.ts" }, content: [{ type: "text", text: "ok" }], isError: false },
      record.context,
    );
    await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, record.context);

    const settled = pi.appendedEntries.at(-1)?.data as any;
    expect(settled).toMatchObject({ op: "settled", aborted: false, tools: 2, lastTool: "read", lastToolFailed: false });

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, createContext({ cwd: dir, idle: true }).context);
    expect(pi.appendedEntries.at(-1)?.data).toMatchObject({ op: "quit", idle: true, reason: "quit" });
  });

  it("marks a run that was interrupted with Escape as interrupted", async () => {
    enable();
    const record = await start({ branch: [userMessage("u1", NOW - HOUR)] });
    await pi.emit("agent_start", { type: "agent_start" }, record.context);
    await pi.emit("agent_settled", { type: "agent_settled", aborted: true }, record.context);

    expect(pi.appendedEntries.at(-1)?.data).toMatchObject({ op: "settled", aborted: true });
  });

  it("leaves an idle session alone when skip-idle is on, and says why", async () => {
    enable({ skipIdle: true });
    const { ui } = await start({
      branch: [userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { text: "all done, nothing pending" }), marker("k1", NOW - HOUR + 1000, { v: 1, op: "quit", at: NOW - HOUR + 1000, idle: true, reason: "quit" })],
    });

    expect(pi.sentMessages).toHaveLength(0);
    expect(ui.notifications.at(-1)?.message).toContain("idle when it stopped");
  });

  it("still hands an idle session to the model when skip-idle is off", async () => {
    enable();
    await start({
      branch: [userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { text: "all done, nothing pending" }), marker("k1", NOW - HOUR + 1000, { v: 1, op: "quit", at: NOW - HOUR + 1000, idle: true, reason: "quit" })],
    });

    expect(injected().message.content).toContain("idle when it stopped");
    expect(injected().message.content).toContain("say one short line and do nothing else");
  });

  /** A settings file that names `enabled` and nothing else, so the assertions below are about DEFAULT_CONFIG. */
  const enableAtDefault = (): void => {
    mkdirSync(path.join(dir, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(settingsFile(), `${JSON.stringify({ v: 1, enabled: true, maxAgeMs: 0 }, null, 2)}\n`, "utf8");
  };

  it("leaves a settled session alone without being told to, because a no-op wake is context nobody asked for", async () => {
    // The shape this default exists to prevent: a pod restart wakes a session that finished its work, the model says
    // one short line, and both rows sit in the transcript - where the memory extension then reads them as an
    // unsummarized stretch and asks the session to dream about the nothing it just made.
    enableAtDefault();
    const { ui } = await start({
      branch: [userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { text: "all done, nothing pending" }), marker("k1", NOW - HOUR + 1000, { v: 1, op: "quit", at: NOW - HOUR + 1000, idle: true, reason: "quit" })],
    });

    expect(pi.sentMessages, "a session whose last turn finished has nothing to resume").toHaveLength(0);
    expect(ui.notifications.at(-1)?.message).toContain("idle when it stopped");
  });

  it("wakes a session that stopped mid-task without being told to, because that is the whole point", async () => {
    enableAtDefault();
    await start({ branch: [userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { stopReason: "toolUse", toolCalls: [{ name: "bash", arguments: { command: "make deploy" } }] })] });

    expect(injected().message.details.state).toContain("mid-task");
  });

  it("leaves a session that has been sitting past the age cap, and says what the cap was", async () => {
    enable({ maxAgeMs: 2 * HOUR });
    const { ui } = await start({
      branch: [userMessage("u1", NOW - 26 * HOUR), assistantMessage("a1", NOW - 25 * HOUR, { stopReason: "toolUse", toolCalls: [{ name: "bash", arguments: { command: "make deploy" } }] })],
    });

    expect(pi.sentMessages).toHaveLength(0);
    expect(ui.notifications.at(-1)?.message).toContain("cap 2h");
  });

  it("keeps quiet in print and JSON mode, where the prompt already came from the command line", async () => {
    enable();
    const { ui } = await start({
      mode: "print",
      hasUI: false,
      branch: [userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { stopReason: "toolUse", toolCalls: [{ name: "bash", arguments: { command: "make deploy" } }] })],
    });

    expect(pi.sentMessages).toHaveLength(0);
    expect(pi.appendedEntries).toHaveLength(0);
    expect(ui.notifications).toHaveLength(0);
  });

  it("respects --auto-resume-off without changing what the repository has chosen", async () => {
    enable();
    pi.setFlag("auto-resume-off", true);
    const { ui } = await start({ branch: [userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { stopReason: "toolUse", toolCalls: [{ name: "bash", arguments: { command: "make deploy" } }] })] });

    expect(pi.sentMessages).toHaveLength(0);
    expect(ui.notifications.at(-1)?.message).toContain("--auto-resume-off");
    expect(readFileSync(settingsFile(), "utf8")).toContain('"enabled": true');
  });

  it("toggles with the bare command and remembers it in the repository", async () => {
    const record = createContext({ cwd: dir, branch: [] });
    await pi.commands.get("auto-resume")!.handler!("", record.context);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).enabled).toBe(true);

    await pi.commands.get("auto-resume")!.handler!("off", record.context);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).enabled).toBe(false);
    expect(record.ui.notifications.at(-1)?.message).toContain("off for");
  });

  it("sets an age cap and rejects one that is not a duration", async () => {
    const record = createContext({ cwd: dir, branch: [] });
    await pi.commands.get("auto-resume")!.handler!("max-age 2h", record.context);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).maxAgeMs).toBe(2 * HOUR);

    await pi.commands.get("auto-resume")!.handler!("max-age off", record.context);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).maxAgeMs).toBe(0);

    await pi.commands.get("auto-resume")!.handler!("max-age whenever", record.context);
    expect(record.ui.notifications.at(-1)?.level).toBe("error");
    expect(record.ui.notifications.at(-1)?.message).toContain("max-age wants 2h, 45m, 1d or off");
  });

  it("explains itself when asked why nothing happened", async () => {
    enable();
    const startRecord = await start({ branch: [] });
    expect(pi.sentMessages).toHaveLength(0);

    const record = createContext({ cwd: dir, branch: [] });
    await pi.commands.get("auto-resume")!.handler!("status", record.context);
    const widget = record.ui.widgets.get(STATUS_KEY);
    expect(typeof widget).toBe("function");
    const rendered = painted((widget as (tui: any, theme: any) => any)(null, fakeTheme));
    expect(rendered).toContain("would not inject");
    expect(rendered).toContain("no activity recorded");
    expect(startRecord.ui.statuses.get(STATUS_KEY)).toContain("nothing to continue");
  });

  it("injects on demand with fire, even for a session it would have left alone", async () => {
    enable();
    await start({ branch: [userMessage("u1", NOW - 2 * HOUR), assistantMessage("a1", NOW - HOUR, { text: "done" })] });
    expect(pi.sentMessages).toHaveLength(1);

    const record = createContext({ cwd: dir, branch: [] });
    await pi.commands.get("auto-resume")!.handler!("fire", record.context);
    expect(pi.sentMessages).toHaveLength(2);
  });

  it("offers the verbs it actually takes", () => {
    const completions = pi.commands.get("auto-resume")!.getArgumentCompletions!("ma");
    expect(completions).toEqual([{ value: "max-age", label: "max-age" }]);
    expect(pi.commands.get("auto-resume")!.getArgumentCompletions!("zz")).toBeNull();
  });

  it("renders the injected message with the judgement in the heading", () => {
    const renderer = pi.messageRenderers.get(PROMPT_TYPE)!;
    const component = renderer(
      { role: "custom", customType: PROMPT_TYPE, content: "(auto-resume) facts and rules", display: true, details: { state: "mid-task when it stopped", ago: "5h", source: "recorded" }, timestamp: 1 },
      { expanded: true, outputPad: 1 },
      fakeTheme,
    );
    const text = painted(component);
    expect(text).toContain("[accent]⏻ auto-resume · 5h ago · mid-task when it stopped · recorded[/accent]");
    expect(text).toContain("[customMessageText](auto-resume) facts and rules[/customMessageText]");
  });
});
