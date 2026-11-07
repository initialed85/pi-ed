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
/**
 * A refused write lands asynchronously, on a real socket to a port nothing is listening on, and waiting for it with
 * a fixed sleep is the wrong shape of wait. Measured on this machine: four suites run concurrently produced four
 * failures, three of them here, at 10s and 15s timeouts - failures that described the machine, not the writer. Poll
 * for what the test actually needs and let the deadline carry the diagnosis.
 */
async function spooled(deadlineMs = 15_000): Promise<string[]> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const lines = spool();
    if (lines.length) return lines;
    if (Date.now() > until) return lines;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

describe("the writer's heartbeat", () => {
  it("throttles stamps without throttling reports of failure", async () => {
    const { heartbeatDue, HEARTBEAT_THROTTLE_MS } = await loadModule();
    const now = 1_800_000_000_000;
    expect(heartbeatDue!(0, now)).toBe(true);
    expect(heartbeatDue!(now - 30_000, now)).toBe(false);
    expect(heartbeatDue!(now - HEARTBEAT_THROTTLE_MS!, now)).toBe(true);
    // A failure is the reason the table exists, so it gets a shorter interval than routine activity.
    expect(heartbeatDue!(now - 20_000, now, HEARTBEAT_THROTTLE_MS! / 4)).toBe(true);
    expect(heartbeatDue!(now - 5_000, now, HEARTBEAT_THROTTLE_MS! / 4)).toBe(false);
  });

  it("separates having been here from having committed", async () => {
    const { heartbeatActivityStatement, heartbeatFlushStatement, heartbeatFailureStatement, heartbeatReadStatement } = await loadModule();
    const activity = heartbeatActivityStatement!("pi-ed:pi-ed", "pi-ed");
    const flush = heartbeatFlushStatement!("pi-ed:pi-ed", "pi-ed");
    const failure = heartbeatFailureStatement!("pi-ed:pi-ed", "pi-ed", "syntax error at or near \"array_concat\"", 12);

    // Two columns, two meanings: an idle fleet is old in both, a broken writer is fresh in one.
    expect(activity.sql).toContain("set last_activity_at = now()");
    expect(activity.sql).not.toContain("last_flush_at");
    expect(flush.sql).toContain("last_flush_at = now()");
    expect(flush.sql).toContain("flushes = writer_heartbeat.flushes + 1");
    expect(flush.sql).toContain("spool_rows = 0");
    expect(failure.sql).toContain("failures = writer_heartbeat.failures + 1");
    expect(failure.sql).toContain("last_error = excluded.last_error");
    expect(failure.sql).toContain("spool_rows = excluded.spool_rows");
    // The backlog clock starts only on a transition into a backlog, and a committed batch clears it. A reader asking
    // "how long has this been broken" needs the age of the condition, not of the last failure to arrive.
    expect(failure.sql).toContain("spool_since = case");
    expect(failure.sql).toContain("when writer_heartbeat.spool_rows > 0 then writer_heartbeat.spool_since");
    expect(flush.sql).toContain("spool_rows = 0, spool_since = null");
    // A refused batch does not move the commit watermark, and it must not pretend to.
    expect(failure.sql).not.toContain("last_flush_at = now()");
    // The kind is part of what gets stored, not something a reader has to infer from Postgres's phrasing.
    expect(failure.values).toEqual(["pi-ed:pi-ed", "pi-ed", 'sql: syntax error at or near "array_concat"', 12]);
    expect(heartbeatReadStatement!("a1").values).toEqual(["a1"]);
  });

  it("gives each kind of stamp its own clock", async () => {
    const { heartbeatKey } = await loadModule();
    // One clock per agent would let the session_start stamp suppress the first flush stamp, and the table would then
    // say "was here, never committed" about a writer that worked perfectly. That is exactly what the first live run
    // of this table did before the clocks were separated.
    expect(heartbeatKey!("a1", "activity")).not.toBe(heartbeatKey!("a1", "flush"));
    expect(heartbeatKey!("a1", "failure")).not.toBe(heartbeatKey!("a1", "flush"));
    expect(heartbeatKey!("a1", "flush")).toBe(heartbeatKey!("a1", "flush"));
    expect(heartbeatKey!("a2", "flush")).not.toBe(heartbeatKey!("a1", "flush"));
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

  it("knows that a dream's own rows are not new work", async () => {
    const { rowsFromBranch, dreamPending } = await loadModule();
    const dreamBranch: any[] = [
      { type: "message", id: "d1", timestamp: "2026-11-08T02:00:00.000Z", message: { role: "user", content: "the real work happened here" } },
      { type: "custom", id: "d2", customType: "memory:dream", timestamp: "2026-11-08T02:00:10.000Z", content: "You are dreaming: write down what a future you should remember." },
      {
        type: "message",
        id: "d3",
        timestamp: "2026-11-08T02:00:20.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "the store was shipped and verified" }, { type: "toolCall", name: "memory_dream", arguments: { summary: "shipped" } }] },
      },
      { type: "message", id: "d4", timestamp: "2026-11-08T02:00:30.000Z", message: { role: "toolResult", toolName: "memory_dream", toolCallId: "call-9", isError: false, content: [{ type: "text", text: "dream recorded" }] } },
      { type: "message", id: "d5", timestamp: "2026-11-08T02:00:40.000Z", message: { role: "user", content: "now the next real thing" } },
    ];
    const rows = rowsFromBranch!(dreamBranch, {}) as any[];
    const tagged = rows.filter((row) => row.meta.dream_turn === true).map((row) => `${row.kind}:${row.sourceEntryId}`);
    // The hidden request, the answer to it, the tool call and its result: history, but not a stretch worth dreaming
    // about again. A session whose first dream makes it look like it has unsummarized work dreams about dreaming,
    // which is how a memory corpus becomes a hall of mirrors.
    expect(tagged).toEqual(["marker:d2", "assistant:d3", "tool_call:d3", "tool_result:d4"]);
    const work = rows.filter((row) => row.meta.dream_turn !== true);
    expect(work.map((row) => row.sourceEntryId)).toEqual(["d1", "d5"]);
    // Which is the whole point of the tag: after the dream lands, the gate sees the same amount of work it saw
    // before, and the next idle window has nothing to dream about.
    expect(dreamPending!(work.length, work.length)).toBe(false);
    expect(dreamPending!(work.length, 1)).toBe(true);
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
    expect(own).toContain("[text score 1.350]");
    expect(own).toContain("[infra, memory]");
    expect(own).toContain("felt: pleased");
    const teammate = formatMemoryHit!({ agent_id: "coral", created_at: "2026-11-08T01:00:00.000Z", subjects: ["dns"], summary: "fixed dns", rank: 0, weight: 0.65 }, "home-ops");
    expect(teammate).toContain("coral ");
    expect(teammate).not.toContain("mine ");
    expect(teammate).toContain("[text score 0.650]");
  });

  it("spans a dream over the events the last dream did not cover", async () => {
    const { dreamStatement, dreamCursorStatement } = await loadModule();
    const dream = dreamStatement!({ sessionId: "s1", agentId: "a1", trigger: "idle10m", summary: "shipped it", subjects: ["infra"], feel: "pleased" });
    expect(dream.sql).toContain("seq > coalesce((select dream_seq from session where id = $1), 0)");
    expect(dream.values).toEqual(["s1", "a1", "idle10m", "shipped it", ["infra"], "pleased", JSON.stringify({ written_by: "memory_dream" }), null, null, null]);
    const cursor = dreamCursorStatement!("s1");
    expect(cursor.sql).toContain("set dream_seq = (select coalesce(max(seq), dream_seq) from event where session_id = $1)");
  });

  it("spans only the events that are not the residue of a previous dream", async () => {
    const { dreamStatement, dreamSpanStatement } = await loadModule();
    const dream = dreamStatement!({ sessionId: "s1", agentId: "a1", trigger: "idle10m", summary: "shipped", subjects: [] });
    expect(dream.sql).toContain(`and coalesce(meta ->> 'dream_turn', 'false') <> 'true'`);
    const span = dreamSpanStatement!("s1");
    expect(span.sql).toContain(`count(*) filter (where coalesce(meta ->> 'dream_turn', 'false') <> 'true') as work_events`);
    expect(span.sql).toContain("seq > coalesce((select dream_seq from session where id = $1), 0)");
    expect(span.values).toEqual(["s1"]);
  });

  it("carries the model and the dimension with the vector, and nothing when there is no vector", async () => {
    const { dreamStatement } = await loadModule();
    const vector = new Array(768).fill(0.001);
    const dream = dreamStatement!({ sessionId: "s1", agentId: "a1", trigger: "manual", summary: "s", subjects: [], vector, model: "bge-base-en-v1.5", detail: { embed_tokens: 7 } });
    expect(dream.sql).toContain("embedding, embedding_model, embedding_dim");
    expect(dream.sql).toContain("$8::vector");
    // A pgvector value arrives as a bracketed literal: a JS array parameter is a Postgres array, and `::vector` on a
    // string is the difference between a vector column and a table that quietly holds text.
    expect(dream.values[7]).toBe(`[${vector.join(",")}]`);
    expect(dream.values[8]).toBe("bge-base-en-v1.5");
    expect(dream.values[9]).toBe(768);
    expect(JSON.parse(String(dream.values[6]))).toEqual({ embed_tokens: 7 });
  });
});

describe("embeddings", () => {
  it("embeds the whole memory, not just the summary", async () => {
    const { memoryText } = await loadModule();
    expect(memoryText!("shipped the store", ["infra", "memory"], "pleased")).toBe("shipped the store\nsubjects: infra, memory\nfeel: pleased");
    expect(memoryText!("only the summary")).toBe("only the summary");
  });

  it("splits at sentences rather than mid-word, because the window is the model's", async () => {
    const { chunkForEmbedding } = await loadModule();
    expect(chunkForEmbedding!("one sentence. another sentence.", 80)).toEqual(["one sentence. another sentence."]);
    const two = chunkForEmbedding!(`${"x".repeat(38)}. ${"y".repeat(38)}.`, 64);
    expect(two).toEqual([`${"x".repeat(38)}.`, `${"y".repeat(38)}.`]);
    // A single long sentence falls back to word boundaries rather than slicing a word in half, because a chunk that
    // starts mid-word embeds as noise.
    const long = chunkForEmbedding!("word ".repeat(40), 80);
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((chunk: string) => chunk.length <= 80)).toBe(true);
    expect(long.every((chunk: string) => chunk.split(" ").every((word: string) => word === "word"))).toBe(true);
    expect(chunkForEmbedding!("", 1400)).toEqual([" "]);
    // A token longer than the window is sliced rather than sent whole: the choice is between a vector over part of a
    // runaway blob and a request the embedder is guaranteed to answer 500 to.
    const runaway = chunkForEmbedding!("x".repeat(3000), 1400);
    expect(runaway.every((chunk: string) => chunk.length <= 1400)).toBe(true);
    expect(runaway.length).toBe(3);
    // A configured window this side of usable is clamped rather than honoured: a 1-character window would mean
    // thousands of requests to a service that costs a GPU slice to answer one.
    expect(chunkForEmbedding!("word ".repeat(40), 8).length).toBeGreaterThan(1);
    expect(chunkForEmbedding!("word ".repeat(40), 8).every((chunk: string) => chunk.length <= 64)).toBe(true);
  });

  it("averages chunks back to a unit vector, and refuses mismatched shapes", async () => {
    const { meanNormalised } = await loadModule();
    const averaged = meanNormalised([[1, 0, 0], [0, 1, 0]])!;
    expect(averaged[0]).toBeCloseTo(Math.SQRT1_2);
    expect(averaged[2]).toBe(0);
    expect(Math.sqrt(averaged.reduce((sum: number, v: number) => sum + v * v, 0))).toBeCloseTo(1);
    expect(meanNormalised([[1, 0], [0, 1, 0]])).toBeUndefined();
    expect(meanNormalised([[Number.NaN, 1]])).toBeUndefined();
    expect(meanNormalised([[0, 0]])).toBeUndefined();
    expect(meanNormalised([])).toBeUndefined();
  });

  it("asks the embedder the question the deployment was verified against", async () => {
    const { embedText } = await loadModule();
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: [{ embedding: new Array(768).fill(0.5) }], usage: { prompt_tokens: 7 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await embedText!("the pgvector store", { embedUrl: "https://embeddings.example", embedModel: "bge-base-en-v1.5" }, fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.tokens).toBe(7);
    expect(result.model).toBe("bge-base-en-v1.5");
    expect(calls[0]!.url).toBe("https://embeddings.example/v1/embeddings");
    // OpenAI-compatible shape: one request, `input` as an array, flat `data[].embedding`. Nothing else in the body -
    // an unknown field is a 400 that looks to an agent exactly like a client bug.
    expect(calls[0]!.body).toEqual({ model: "bge-base-en-v1.5", input: ["the pgvector store"] });
  });

  it("sends a long summary as several chunks in one request and averages the answers", async () => {
    const { embedText } = await loadModule();
    let inputs: string[] = [];
    const fetchImpl = (async (_url: string, init: any) => {
      inputs = JSON.parse(String(init.body)).input as string[];
      return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 40 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await embedText!("sentence. ".repeat(60), { embedUrl: "https://e", embedModel: "m", embedMaxChars: 200 }, fetchImpl);
    // The dimension guard is 768, so this fixture only proves the chunking and the averaging path; the shape guard is
    // tested on its own below.
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("3 dimensions");
    expect(result.ok ? "" : result.error).toContain("column is 768");
    expect(inputs.length).toBeGreaterThan(1);
  });

  it("treats a different dimension as a failure rather than a value to write", async () => {
    const { embedText } = await loadModule();
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ embedding: new Array(384).fill(0.1) }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await embedText!("q", { embedUrl: "https://e", embedModel: "m" }, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("384 dimensions");
  });

  it("reports an embedder that answers badly, and one that does not answer at all", async () => {
    const { embedText } = await loadModule();
    const bad = (async () => new Response("input (646 tokens) is too large to process", { status: 500 })) as unknown as typeof fetch;
    const tooLong = await embedText!("q", { embedUrl: "https://e", embedModel: "m" }, bad);
    expect(tooLong.ok ? "" : tooLong.error).toContain("answered 500");
    expect(tooLong.ok ? "" : tooLong.error).toContain("too large to process");

    const down = await embedText!("q", { embedUrl: "http://127.0.0.1:1", embedModel: "m", embedTimeoutMs: 500 });
    expect(down.ok).toBe(false);
    expect(down.ok ? "" : down.error).toContain("unreachable");

    const off = await embedText!("q", { embeddings: false });
    expect(off.ok).toBe(false);
    expect(off.ok ? "" : off.error).toContain("switched off");
  });

  it("asks the store's own retrieval function, weighted after the index", async () => {
    const { vectorSearch } = await loadModule();
    const statement = vectorSearch!("home-ops", [0.1, 0.2], { limit: 5, sinceDays: 30, ownWeight: 1, otherWeight: 0.65 });
    expect(statement.sql).toBe("select * from memory_search($1, $2::vector, $3, $4, $5, now() - make_interval(days => $6::int))");
    expect(statement.values).toEqual(["home-ops", "[0.1,0.2]", 5, 1, 0.65, 30]);
    expect(vectorSearch!("a", [0], { limit: 999 }).values[2]).toBe(50);
  });

  it("labels a vector hit by similarity and a text hit by score", async () => {
    const { formatMemoryHit } = await loadModule();
    const vectorRow = { agent_id: "coral", mine: false, created_at: "2026-11-08T01:00:00.000Z", subjects: ["dns"], summary: "fixed dns", score: 0.565, similarity: 0.868 };
    const line = formatMemoryHit!(vectorRow, "home-ops", "vector");
    expect(line).toContain("coral ");
    expect(line).toContain("[vector similar 0.868]");
    expect(formatMemoryHit!({ ...vectorRow, mine: true }, "home-ops", "vector")).toContain("mine ");
    expect(formatMemoryHit!({ agent_id: "home-ops", created_at: "2026-11-08T01:00:00.000Z", subjects: [], summary: "s", rank: 0.1, weight: 1 }, "home-ops", "text")).toContain("[text score 1.100]");
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
    const lines = await spooled();
    expect(lines.length, "rows never reached the spool; the writer swallowed them").toBeGreaterThan(0);
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
    // The dead DSN is a closed port on localhost, so the honest answer names the kind of failure. A reader - or a
    // sweep pairing this with `pg_isready` - should not have to guess whether the store is down or the address is wrong.
    expect(text).toMatch(/memory_search failed: (refused|dns|timeout|slots|auth|sql|error): /);
  });

  it("names the kind of store failure, because a probe bug must not look like an outage", async () => {
    const { classifyStoreError, describeStoreError } = await loadModule();
    // Home-ops' measured trap, verbatim: a sweep job that connected to the Deployment's name instead of the Service
    // (`memory`, not `pi-ed-postgres`). This is a configuration fault, and it presents as an unreachable store.
    expect(classifyStoreError!(`could not translate host name "pi-ed-postgres" to address: Name or service not known`)).toBe("dns");
    expect(classifyStoreError!("getaddrinfo ENOTFOUND memory.pi-ed.svc.cluster.local")).toBe("dns");
    expect(classifyStoreError!("connect ECONNREFUSED 10.43.5.96:5434")).toBe("refused");
    expect(classifyStoreError!("QueryFailedError: query timeout expired")).toBe("timeout");
    expect(classifyStoreError!("FATAL: remaining connection slots are reserved for non-replication superuser connections")).toBe("slots");
    expect(classifyStoreError!(`FATAL: password authentication failed for user "pi_ed"`)).toBe("auth");
    expect(classifyStoreError!(`syntax error at or near "array_concat"`)).toBe("sql");
    expect(classifyStoreError!("something unprecedented happened")).toBe("error");
    // Stored as classified-then-verbatim: the tag helps a reader, and the original text is what a diagnosis needs.
    expect(describeStoreError!(`syntax error at or near "array_concat"`)).toBe(`sql: syntax error at or near "array_concat"`);
    expect(describeStoreError!("refused: connect ECONNREFUSED 127.0.0.1:1")).toBe("refused: connect ECONNREFUSED 127.0.0.1:1");
    expect(describeStoreError!("")).toBe("error: unknown failure");
  });

  it("says which kind of absence a retrieval result is", async () => {
    const { ownCoverageNote, ownRowCountStatement } = await loadModule();
    // The agent has memories and none of them came back. A quality question, answered without letting the teammate
    // rows pass for this agent's own experience.
    const crowded = ownCoverageNote!({ agentId: "pi-ed", ownInStore: 3, returned: 2 });
    expect(crowded).toContain("3 memories in the store and none of them came back for this query");
    expect(crowded).toContain("another agent");
    expect(crowded).toContain("teammate's recollection");
    expect(ownCoverageNote!({ agentId: "pi-ed", ownInStore: 1, returned: 0 })).toContain("1 memory in the store");
    expect(ownCoverageNote!({ agentId: "pi-ed", ownInStore: 1, returned: 0 })).toContain("Nothing matched for anyone");
    // The agent has nothing under this id. A scoping question, and the wording points at identity rather than at the
    // store's judgement about the query, because that is the thing the reader has to go and check.
    const drifted = ownCoverageNote!({ agentId: "pi-ed", ownInStore: 0, returned: 4 });
    expect(drifted).toContain('no memories in the store under the id "pi-ed"');
    expect(drifted).toContain("belongs to another id");
    expect(drifted).toContain("host:directory");
    expect(drifted).not.toContain("none of them came back for this query");
    expect(ownCoverageNote!({ agentId: "pi-ed", ownInStore: 0, returned: 0 })).toContain("nothing matched for another id either");
    expect(ownRowCountStatement!("pi-ed").values).toEqual(["pi-ed"]);
    expect(ownRowCountStatement!("pi-ed").sql).toContain("from memory where agent_id = $1");
  });

  it("refuses to write a dream with no summary", async () => {
    const { context } = contextFor();
    const result = await callTool(pi, "memory_dream", { summary: "   ", subjects: ["infra"], feel: "flat" }, context);
    expect(String(result.content[0]?.text)).toContain("needs a summary");
  });

  it("refuses to write a dream whose events never reached the store", async () => {
    const { context } = contextFor();
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    // The precondition is the spool: memory_dream can only refuse honestly once the stretch it would summarise is
    // known to be unsaved.
    const landed = await spooled();
    expect(landed.length, "the stretch never reached the spool, so this test would be asserting a message about a case that did not happen").toBeGreaterThan(0);
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
    // "recorded row(s)" in the widget is only an honest claim after the spool exists to be reported.
    const landed = await spooled();
    expect(landed.length, "nothing spooled, so the widget text this test reads would have nothing to report").toBeGreaterThan(0);
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
