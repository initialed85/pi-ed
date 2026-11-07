import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext, callTool, fakeTheme, painted, type FakePi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/memory.ts");

/**
 * A DSN to a closed port.
 *
 * Every test that touches the store goes through this, on purpose: the write path has to be correct when the database
 * is unreachable, and that is the case a unit test can actually reproduce. A local Postgres would make the tests
 * assert a happy path nobody is asking about and would need infrastructure in CI, which this suite deliberately does
 * not have.
 */
const DEAD_DSN = "postgresql://memory-test:hunter2@127.0.0.1:1/memory-test";

let dir: string;
let spoolPath: string;
let agentConfigPath: string;

function setEnv(extra: Record<string, string | undefined> = {}): void {
  process.env.PI_MEMORY_CONFIG = agentConfigPath;
  process.env.PI_MEMORY_SPOOL = spoolPath;
  process.env.PI_MEMORY_DSN = DEAD_DSN;
  delete process.env.PI_MEMORY_DISABLED;
  // Assigning undefined into process.env produces the string "undefined", which is a truthy DSN as far as the
  // extension is concerned. "No configuration" has to be expressed by the key being absent.
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function load(extra: Record<string, string | undefined> = {}): Promise<FakePi> {
  setEnv(extra);
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}

async function loadModule(extra: Record<string, string | undefined> = {}) {
  setEnv(extra);
  vi.resetModules();
  return import(MODULE);
}

function spool(): string[] {
  try {
    return readFileSync(spoolPath, "utf8")
      .split("\n")
      .filter((line) => line.trim());
  } catch {
    return [];
  }
}

/** A branch that looks like a real turn: a prompt, an answer with a tool call, and the tool's result. */
function branch(): any[] {
  return [
    { type: "message", id: "e1", parentId: null, timestamp: "2026-11-08T01:00:00.000Z", message: { role: "user", content: "ship the pgvector store" } },
    {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "2026-11-08T01:00:10.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "home-ops shipped it; vector 0.8.7 verified." },
          { type: "toolCall", name: "bash", arguments: { command: "kubectl get pods -n pi-ed" } },
        ],
      },
    },
    {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: "2026-11-08T01:00:20.000Z",
      message: { role: "toolResult", toolName: "bash", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "pi-ed-postgres-0 1/1 Running" }] },
    },
    { type: "custom", id: "e4", parentId: "e3", timestamp: "2026-11-08T01:00:30.000Z", customType: "model-marker", data: { note: "verified" }, content: "run settled idle" },
    { type: "compaction", id: "e5", parentId: "e4", timestamp: "2026-11-08T01:00:40.000Z", summary: "compacted: pgvector store shipped and verified" },
    { type: "usage", id: "e6", parentId: "e5", timestamp: "2026-11-08T01:00:50.000Z", kind: "turn", provider: "anthropic", model: "claude", usage: { input: 10, output: 5 } },
  ];
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pi-ed-memory-"));
  spoolPath = path.join(dir, "spool", "memory-spool.jsonl");
  agentConfigPath = path.join(dir, "agent-memory.json");
  // A short flush so a test does not have to sit in a 4-second debounce to learn what happens when the store refuses.
  writeFileSync(agentConfigPath, JSON.stringify({ flushMs: 50 }), "utf8");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PI_MEMORY_CONFIG;
  delete process.env.PI_MEMORY_SPOOL;
  delete process.env.PI_MEMORY_DSN;
});

describe("configuration", () => {
  it("is inert without a dsn, registering nothing at all", async () => {
    const pi = await load({ PI_MEMORY_DSN: undefined });
    expect([...pi.tools.keys()]).toEqual([]);
    expect([...pi.commands.keys()]).toEqual([]);
    expect(pi.lifecycleEvents).toEqual([]);
    expect([...pi.messageRenderers.keys()]).toEqual([]);
  });

  it("PI_MEMORY_DISABLED wins over a configured dsn", async () => {
    const pi = await load({ PI_MEMORY_DISABLED: "1" });
    expect([...pi.tools.keys()]).toEqual([]);
  });

  it("reads defaults, then the agent file, then the repository file, then the environment", async () => {
    const { resolveConfig } = await loadModule();
    writeFileSync(agentConfigPath, JSON.stringify({ idleDreamMinutes: 7, flushMs: 111 }), "utf8");
    mkdirRepoConfig(dir, { idleDreamMinutes: 3, maxTextChars: 400 });
    const cfg = resolveConfig!(path.join(dir, "repo"), { PI_MEMORY_DSN: "postgres://x@h/db", PI_MEMORY_CONFIG: agentConfigPath });
    expect(cfg?.dsn).toBe("postgres://x@h/db");
    expect(cfg?.idleDreamMinutes).toBe(3);
    expect(cfg?.maxTextChars).toBe(400);
    expect(cfg?.flushMs).toBe(111);
    expect(cfg?.dreams).toBe(true);
  });

  it("describes a dsn without reproducing the credential in it", async () => {
    const { describeDsn } = await loadModule();
    const described = describeDsn!(DEAD_DSN);
    expect(described).toBe("127.0.0.1:1/memory-test");
    expect(described).not.toContain("hunter2");
    expect(describeDsn!("not a url")).toBe("unreadable dsn");
  });
});

describe("identity", () => {
  it("prefers the configured agent, then the session name, then host and directory", async () => {
    const { agentIdentity } = await loadModule();
    const { context } = createContext({ cwd: "/workspace/home-ops", sessionName: "home-ops" });
    expect(agentIdentity!(context as any, { agent: "explicit" })).toBe("explicit");
    expect(agentIdentity!(context as any, {})).toBe("home-ops");
    const { context: unnamed } = createContext({ cwd: "/workspace/pi-ed", sessionName: undefined });
    const fallback = agentIdentity!(unnamed as any, {});
    expect(fallback.split(":")[1]).toBe("pi-ed");
  });
});

describe("redaction", () => {
  it("redacts the credential shapes and says which one fired", async () => {
    const { redact } = await loadModule();
    // The fixtures are assembled at runtime from pieces rather than written out. They have to look exactly like real
    // credentials for the test to mean anything, and a contiguous one in a pushed file trips GitHub's push protection
    // - which is the scanner doing its job, and a nuisance worth designing around once rather than arguing with.
    const awsKeyId = `AKIA${"ABCDEFGHIJKLMNOP"}`;
    const githubToken = `ghp${"_abcdefghijklmnopqrstuvwxyz1234"}`;
    const slackToken = `xox${"b-1234567890-abcdefghijklmnop"}`;
    const cases: [string, string][] = [
      ["dsn", "psql postgres://pi_ed:sup3rs3cret@10.43.5.96:5432/pi_ed to check"],
      ["bearer", "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://api.example"],
      ["aws-key-id", `uploaded with ${awsKeyId} for the backup`],
      ["github-token", `pi install used ${githubToken}`],
      ["slack-token", `notified ${slackToken}`],
      ["key-value", 'the config says password = "hunter2hunter2" here'],
      ["private-key", "key is -----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY----- done"],
    ];
    for (const [name, input] of cases) {
      const result = redact!(input);
      expect(result.hits, name).toContain(name);
      expect(result.text, name).toContain(`[redacted:${name}]`);
    }
  });

  it("applies configured patterns too, and survives a broken one", async () => {
    const { redact } = await loadModule();
    const result = redact!("the codeword is bluehammer9", ["codeword is \\w+"]);
    // The pattern is greedy, and the point of the assertion is that a configured pattern replaces the whole match it
    // was given rather than part of it.
    expect(result.text).toBe("the [redacted:custom]");
    const broken = redact!("anything", ["([unclosed"]);
    expect(broken.text).toBe("anything");
    expect(broken.hits).toEqual([]);
  });

  it("does not leave a credential in a recorded row", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!([{ type: "message", id: "x", timestamp: "2026-11-08T01:00:00.000Z", message: { role: "user", content: "connect with postgres://pi_ed:hunter2@10.43.5.96/pi_ed" } }], {});
    expect(rows[0]?.text).not.toContain("hunter2");
    expect((rows[0]?.meta as Record<string, unknown>).redacted).toContain("dsn");
  });
});

describe("recording a branch", () => {
  it("splits one assistant entry into what the model said and what it asked to do", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!(branch(), {});
    const assistant = rows.filter((row: any) => row.kind === "assistant");
    const calls = rows.filter((row: any) => row.kind === "tool_call");
    expect(assistant.map((row: any) => row.text)).toEqual(["home-ops shipped it; vector 0.8.7 verified."]);
    expect(calls.map((row: any) => row.toolName)).toEqual(["bash"]);
    expect((calls[0] as Record<string, unknown>).meta).toMatchObject({ input: { command: "kubectl get pods -n pi-ed" } });
  });

  it("keeps the tool's own output separate from the model's claim about it", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!(branch(), {}) as any[];
    const result = rows.find((row) => row.kind === "tool_result");
    expect(result.toolName).toBe("bash");
    expect(result.text).toContain("pi-ed-postgres-0");
    expect(result.meta).toMatchObject({ toolCallId: "call-1", isError: false });
  });

  it("records markers and compactions, and skips harness bookkeeping", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!(branch(), {}) as any[];
    expect(rows.filter((row) => row.kind === "marker").map((row) => row.toolName)).toEqual(["model-marker"]);
    expect(rows.filter((row) => row.kind === "system").map((row) => row.text)).toEqual(["compacted: pgvector store shipped and verified"]);
    expect(rows.some((row) => row.sourceEntryId === "e6")).toBe(false);
  });

  it("stores that an image was there rather than the image", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!([{ type: "message", id: "i", timestamp: "2026-11-08T01:00:00.000Z", message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "a".repeat(4096) }, { type: "text", text: "look at this" }] } }], {}) as any[];
    const text = rows.map((row) => row.text).join(" ");
    expect(text).toContain("[image image/png 3072b]");
    expect(text).toContain("look at this");
    expect(text).not.toContain("aaaa");
  });

  it("records that an assistant thought and said nothing", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!([{ type: "message", id: "t", timestamp: "2026-11-08T01:00:00.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }], {}) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ empty: true });
  });

  it("clips long output instead of dropping it", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!([{ type: "message", id: "l", timestamp: "2026-11-08T01:00:00.000Z", message: { role: "toolResult", toolName: "bash", content: "x".repeat(1000) } }], { maxTextChars: 100 }) as any[];
    expect(rows[0].text).toContain("[clipped 900 characters]");
    expect(rows[0].meta.truncated).toBe(true);
  });

  it("honours skip lists", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!(branch(), { skip: ["tool_result", "marker"] }) as any[];
    expect(rows.some((row) => row.kind === "tool_result")).toBe(false);
    expect(rows.some((row) => row.kind === "marker")).toBe(false);
    expect(rows.some((row) => row.kind === "user")).toBe(true);
  });
});

describe("sql", () => {
  it("skips an entry that carried nothing, and keeps the assistant one that did", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!([
      { type: "message", id: "u", timestamp: "2026-11-08T01:00:00.000Z", message: { role: "user", content: "" } },
      { type: "message", id: "t", timestamp: "2026-11-08T01:00:05.000Z", message: { role: "toolResult", toolName: "bash", content: [] } },
      { type: "message", id: "a", timestamp: "2026-11-08T01:00:10.000Z", message: { role: "assistant", content: [] } },
    ], {}) as any[];
    // An empty tool result is kept and an empty user message is not: the tool ran, which is a fact, while a message
    // that carried nothing is a harness artifact a dream would only have to step over.
    expect(rows.map((row) => `${row.kind}:${row.sourceEntryId}`)).toEqual(["tool_result:t", "assistant:a"]);
    expect(rows[1].meta).toMatchObject({ empty: true });
  });

  it("merges repositories with the function Postgres actually has", async () => {
    const { agentStatement } = await loadModule();
    const statement = agentStatement!("hermes:pi-ed", "pi-ed");
    // A function name Postgres does not have fails at parse time, so the statement is broken even on the branch that
    // never runs. That is invisible to every test in this file and was caught by the live check; the assertion is the
    // cheapest net for the class.
    expect(statement.sql).toContain("array_cat(");
    expect(statement.sql).not.toContain("array_concat(");
    expect(statement.sql).toContain("on conflict (id) do update");
  });

  it("keys an event on the session entry it came from, and assigns seq in the statement", async () => {
    const { eventStatement } = await loadModule();
    const statement = eventStatement!("session-1", "home-ops", [
      { sourceEntryId: "e1", kind: "user", at: "2026-11-08T01:00:00.000Z", meta: {} },
      { sourceEntryId: "e2", kind: "assistant", at: "2026-11-08T01:00:10.000Z", text: "hi", meta: {} },
    ]);
    expect(statement.sql).toContain("on conflict (session_id, source_entry_id) do nothing");
    expect(statement.sql).toContain("(select coalesce(max(seq), 0) from event where session_id = $1) + 1");
    expect(statement.sql).toContain("(select coalesce(max(seq), 0) from event where session_id = $1) + 2");
    // Two shared parameters plus six per row: a count mismatch is a Postgres error at 3am on a cron run.
    expect(statement.values).toHaveLength(2 + 6 * 2);
    expect(statement.values[0]).toBe("session-1");
    expect(statement.values[1]).toBe("home-ops");
  });

  it("keeps the text in the text column and the surrounding facts in meta", async () => {
    const { eventStatement } = await loadModule();
    const statement = eventStatement!("s", "a", [{ sourceEntryId: "e1", kind: "tool_result", at: "2026-11-08T01:00:00.000Z", toolName: "bash", text: "stdout here", meta: { isError: false } }]);
    expect(statement.values[6]).toBe("stdout here");
    const meta = JSON.parse(String(statement.values[7]));
    expect(meta).toMatchObject({ isError: false });
    expect(meta.text).toBeUndefined();
  });

  it("ranks keyword recall with the agent's own weight and can restrict to own memories", async () => {
    const { keywordSearch } = await loadModule();
    const statement = keywordSearch!("pgvector store", "home-ops");
    expect(statement.sql).toContain("websearch_to_tsquery('english', $1)");
    expect(statement.sql).toContain("case when m.agent_id = $2 then 1.0 else 0.65 end");
    expect(statement.sql).not.toContain("m.agent_id = $2 and");
    const own = keywordSearch!("pgvector", "home-ops", { ownOnly: true });
    expect(own.sql).toContain("and m.agent_id = $2");
    expect(keywordSearch!("q", "a", { limit: 999 }).values[2]).toBe(50);
    expect(keywordSearch!("q", "a", { limit: 0 }).values[2]).toBe(1);
    expect(keywordSearch!("q", "a", { sinceDays: 7 }).values[3]).toBe(7);
  });

  it("shows an agent how confident a recall is, and whose memory it is", async () => {
    const { formatMemoryHit } = await loadModule();
    const own = formatMemoryHit!({ agent_id: "home-ops", created_at: "2026-11-08T01:00:00.000Z", subjects: ["infra", "memory"], summary: "shipped the store", feel: "pleased", rank: 0.35, weight: 1 }, "home-ops");
    expect(own).toContain("mine ");
    expect(own).toContain("[score 1.350]");
    expect(own).toContain("[infra, memory]");
    expect(own).toContain("felt: pleased");
    const teammate = formatMemoryHit!({ agent_id: "coral", created_at: "2026-11-08T01:00:00.000Z", subjects: ["dns"], summary: "fixed dns", rank: 0, weight: 0.65 }, "home-ops");
    expect(teammate).toContain("coral ");
    expect(teammate).not.toContain("mine ");
    expect(teammate).toContain("[score 0.650]");
  });

  it("spans a dream over the events the last dream did not cover", async () => {
    const { dreamStatement, dreamCursorStatement } = await loadModule();
    const dream = dreamStatement!({ sessionId: "s1", agentId: "a1", trigger: "idle10m", summary: "shipped it", subjects: ["infra"], feel: "pleased" });
    expect(dream.sql).toContain("seq > coalesce((select dream_seq from session where id = $1), 0)");
    expect(dream.values).toEqual(["s1", "a1", "idle10m", "shipped it", ["infra"], "pleased"]);
    const cursor = dreamCursorStatement!("s1");
    expect(cursor.sql).toContain("set dream_seq = (select coalesce(max(seq), dream_seq) from event where session_id = $1)");
  });
});

describe("the spool", () => {
  it("round-trips rows, and survives a torn line", async () => {
    const mod = await loadModule();
    mod.writeSpool!([{ sourceEntryId: "e1", kind: "user", at: "2026-11-08T01:00:00.000Z", sessionId: "s1", meta: {}, text: "one" }]);
    appendBroken(spoolPath, "{not json");
    mod.writeSpool!([{ sourceEntryId: "e2", kind: "assistant", at: "2026-11-08T01:00:10.000Z", sessionId: "s1", meta: {}, text: "two" }]);
    const read = mod.readSpool!();
    expect(read.rows.map((row: any) => row.sourceEntryId)).toEqual(["e1", "e2"]);
    mod.rewriteSpool!([read.rows[1]!]);
    expect(mod.readSpool!().rows.map((row: any) => row.sourceEntryId)).toEqual(["e2"]);
  });
});

describe("dream gate", () => {
  it("dreams only when there is a stretch that has not been summarized", async () => {
    const { dreamPending } = await loadModule();
    expect(dreamPending!(3, 0)).toBe(true);
    expect(dreamPending!(3, 3)).toBe(false);
    expect(dreamPending!(0, 0)).toBe(false);
  });
});

describe("the extension", () => {
  let pi: FakePi;

  beforeEach(async () => {
    vi.useRealTimers();
    pi = await load();
  });

  function contextFor(options = {}) {
    return createContext({ branch: branch(), cwd: "/workspace/pi-ed", sessionName: "pi-ed", sessionId: "session-1", ...options });
  }

  it("registers the tools, the command and the dream renderer when configured", () => {
    expect([...pi.tools.keys()].sort()).toEqual(["memory_dream", "memory_search"]);
    expect([...pi.commands.keys()]).toEqual(["memory"]);
    expect([...pi.messageRenderers.keys()]).toEqual(["memory:dream"]);
    expect(pi.lifecycleEvents.sort()).toEqual(["agent_settled", "agent_start", "session_before_compact", "session_shutdown", "session_start", "turn_end"]);
  });

  it("renders a replayed dream as one quiet line naming the trigger", () => {
    const renderer = pi.messageRenderers.get("memory:dream")!;
    const component = renderer({ role: "custom", customType: "memory:dream", content: "you are dreaming", display: false, details: { trigger: "idle10m" }, timestamp: 1 }, { expanded: false, outputPad: 1 }, fakeTheme);
    expect(painted(component)).toContain("dreaming · idle10m");
  });

  it("spools rather than losing rows when the store is unreachable", async () => {
    const { context } = contextFor();
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    vi.useFakeTimers();
    vi.advanceTimersByTime(5_000);
    vi.useRealTimers();
    // The connect is real and asynchronous: refuse is fast on a closed port, and the rows must still land on disk.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const lines = spool();
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]!);
    expect(first.sessionId).toBe("session-1");
    expect(["user", "assistant", "tool_call", "tool_result", "marker", "system"]).toContain(first.kind);
  });

  it("dreams ten minutes after going idle, as a hidden message that starts a turn", async () => {
    // The dream clocks have to be under the fake clock before the events fire, because the timers are created inside
    // the handlers being emitted.
    vi.useFakeTimers();
    const { context } = contextFor();
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(9 * 60_000);
    expect(pi.sentMessages).toHaveLength(0);
    vi.advanceTimersByTime(2 * 60_000);
    vi.useRealTimers();
    const sent = pi.sentMessages.at(-1);
    expect(sent?.options).toMatchObject({ triggerTurn: true });
    expect(sent?.message).toMatchObject({ customType: "memory:dream", display: false, details: { trigger: "idle10m" } });
    expect(String(sent?.message?.content)).toContain("Call memory_dream exactly once");
    expect(String(sent?.message?.content)).toContain("feel");
  });

  it("does not dream when the session recorded nothing worth summarizing", async () => {
    vi.useFakeTimers();
    const { context } = contextFor({ branch: [] });
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    vi.useRealTimers();
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("does not dream about a run that was interrupted", async () => {
    vi.useFakeTimers();
    const { context } = contextFor();
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await pi.emit("agent_settled", { aborted: true }, context);
    vi.advanceTimersByTime(11 * 60_000);
    vi.useRealTimers();
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("dreams before compaction, and again ten minutes after a session arrived from history", async () => {
    vi.useFakeTimers();
    const { context } = contextFor();
    await pi.emit("session_start", { reason: "startup" }, context);
    await pi.emit("session_before_compact", {}, context);
    const compactDream = pi.sentMessages.at(-1);
    expect(compactDream?.message).toMatchObject({ customType: "memory:dream", details: { trigger: "pre_compaction" } });
    // The pre-compaction dream wrote nothing (there is no store to write to here), so the stretch is still
    // unsummarized and the resume clock that was already running is allowed to dream too.
    vi.advanceTimersByTime(11 * 60_000);
    vi.useRealTimers();
    const resumeDream = pi.sentMessages.at(-1);
    expect(resumeDream?.message).toMatchObject({ customType: "memory:dream", details: { trigger: "resume10m" } });
  });

  it("cancels a pending dream when new work arrives", async () => {
    vi.useFakeTimers();
    const { context } = contextFor();
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    await pi.emit("agent_start", {}, context);
    vi.advanceTimersByTime(15 * 60_000);
    vi.useRealTimers();
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("reports a failed search honestly instead of reporting nothing found", async () => {
    const { context } = contextFor();
    const result = await callTool(pi, "memory_search", { query: "pgvector" }, context);
    const text = String(result.content[0]?.text ?? "");
    expect(text).toContain("memory_search failed");
    expect(text).not.toContain("no memories match");
    expect(result.details).toHaveProperty("error");
  });

  it("refuses to write a dream with no summary", async () => {
    const { context } = contextFor();
    const result = await callTool(pi, "memory_dream", { summary: "   ", subjects: ["infra"], feel: "flat" }, context);
    expect(String(result.content[0]?.text)).toContain("needs a summary");
  });

  it("refuses to write a dream whose events never reached the store", async () => {
    const { context } = contextFor();
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const result = await callTool(pi, "memory_dream", { summary: "shipped the store", subjects: ["infra"], feel: "wary" }, context);
    const text = String(result.content[0]?.text ?? "");
    // The point of the wording: the agent should learn the events are missing, not be handed a foreign key error and
    // guess. And the spool still holds the stretch.
    expect(text).toContain("memory_dream not written");
    expect(text).toContain("the events are in the local spool");
    expect(text).not.toContain("memory_agent_id_fkey");
    expect(spool().length).toBeGreaterThan(0);
  });

  it("tells the user what memory holds, that the store is unreachable, and what is spooled", async () => {
    const { context, ui } = contextFor();
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const command = pi.commands.get("memory")!;
    await command.handler!("", context);
    const widget = [...(ui.widgets.get("memory") as string[] | undefined) ?? []].join("\n");
    expect(widget).toContain("agent      pi-ed");
    expect(widget).toContain("127.0.0.1:1/memory-test");
    expect(widget).not.toContain("hunter2");
    expect(widget).toContain("dreams     idle 10m, resume 10m, before compaction");
    expect(widget).toContain("recorded row(s)");
    expect([...ui.widgets.keys()]).toContain("memory");
  });
});

/* helpers */

function mkdirRepoConfig(root: string, config: Record<string, unknown>): void {
  const repo = path.join(root, "repo", ".pi");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "memory.json"), JSON.stringify(config), "utf8");
}

function appendBroken(file: string, line: string): void {
  appendFileSync(file, `${line}\n`, "utf8");
}
