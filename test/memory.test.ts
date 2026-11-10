import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext, callTool, fakeTheme, painted, type FakePi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../parked/memory.ts");

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

/**
 * A context in the state Pi puts one in after `/reload`, a new session, a fork or a session switch.
 *
 * Pi's `assertActive` throws from any property read on a replaced context, `hasUI` included - and `hasUI` is a getter,
 * so a bare "is there a UI to talk to" check is enough to trip it. Mutating the object the extension already captured
 * is closer to what actually happens than handing it a different object: the capture is the bug.
 */
function makeStale(ctx: any): void {
  const boom = () => {
    throw new Error("This extension ctx is stale after session replacement or reload.");
  };
  for (const key of ["hasUI", "ui", "cwd", "sessionManager"]) Object.defineProperty(ctx, key, { get: boom, configurable: true });
}

/**
 * Node's verdict on a discarded promise, which is also Pi's: an unhandled rejection is reported as an
 * uncaughtException and the agent exits. A writer that cannot crash the process it lives in has to be able to see
 * the moment it is about to.
 */
function watchUnhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const onRejection = (reason: unknown) => reasons.push(reason);
  process.on("unhandledRejection", onRejection);
  return { reasons, stop: () => process.off("unhandledRejection", onRejection) };
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
    // The pod this suite runs in exports NAME, and the deployment name outranks the host below, so the last-resort
    // branch has to be reached with it removed or the assertion is measuring the environment rather than the code.
    const saved = process.env.NAME;
    delete process.env.NAME;
    try {
      const fallback = agentIdentity!(unnamed as any, {});
      expect(fallback.split(":")[1]).toBe("pi-ed");
    } finally {
      if (saved !== undefined) process.env.NAME = saved;
    }
  });

  it("does not make a pod restart look like a different agent", async () => {
    const { agentIdentity } = await loadModule();
    // The case that orphans a whole agent's memories: an unnamed checkout in a pod, where `hostname()` is the pod
    // name and therefore changes with every rollout. `NAME` is exported by the deployment and is what the schedule
    // extension also falls back through, so the same agent must resolve to the same id across both pod names.
    const { context } = createContext({ cwd: "/workspace/camry", sessionName: undefined });
    const previous = process.env.NAME;
    try {
      process.env.NAME = "camry";
      const first = agentIdentity!(context as any, {});
      expect(first).toBe("camry");
      // Called twice because the assertion that matters is that the id does not depend on anything the pod renames
      // when it comes back; the hostname is not reachable in-process, so this pins the branch that outranks it.
      expect(agentIdentity!(context as any, {})).toBe(first);
      // And a session a human named still wins over the deployment's idea of who it is.
      const { context: named } = createContext({ cwd: "/workspace/camry", sessionName: "camry-nightly" });
      expect(agentIdentity!(named as any, {})).toBe("camry-nightly");
    } finally {
      if (previous === undefined) delete process.env.NAME;
      else process.env.NAME = previous;
    }
    // With neither a session name nor a deployment name, the host and directory remain the last resort, and the
    // assertion worth keeping is what that id actually looks like: in a pod the host half is the pod name
    // (`pi-ed-5d4d47d856-f7hdv`), which is exactly why this branch is last rather than first.
    const saved = process.env.NAME;
    delete process.env.NAME;
    try {
      const lastResort = agentIdentity!(context as any, {});
      expect(lastResort.endsWith(":camry")).toBe(true);
      expect(lastResort.split(":")[0]).not.toBe("camry");
    } finally {
      if (saved !== undefined) process.env.NAME = saved;
    }
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
    expect(flush.sql).toContain("flushes = memory.writer_heartbeat.flushes + 1");
    expect(flush.sql).toContain("spool_rows = 0");
    expect(failure.sql).toContain("failures = memory.writer_heartbeat.failures + 1");
    expect(failure.sql).toContain("last_error = excluded.last_error");
    expect(failure.sql).toContain("spool_rows = excluded.spool_rows");
    // The backlog clock starts only on a transition into a backlog, and a committed batch clears it. A reader asking
    // "how long has this been broken" needs the age of the condition, not of the last failure to arrive.
    expect(failure.sql).toContain("spool_since = case");
    expect(failure.sql).toContain("when memory.writer_heartbeat.spool_rows > 0 then memory.writer_heartbeat.spool_since");
    expect(flush.sql).toContain("spool_rows = 0, spool_since = null");
    // A refused batch does not move the commit watermark, and it must not pretend to.
    expect(failure.sql).not.toContain("last_flush_at = now()");
    // The kind is part of what gets stored, not something a reader has to infer from Postgres's phrasing.
    expect(failure.values).toEqual(["pi-ed:pi-ed", "pi-ed", 'sql: syntax error at or near "array_concat"', 12]);
    expect(heartbeatReadStatement!("a1").values).toEqual(["a1"]);
  });

  it("carries the never-attempted discriminator without touching what page means", async () => {
    const { heartbeatSweepStatement, heartbeatPageAlertStatement } = await loadModule();
    const sweep = heartbeatSweepStatement!();
    expect(sweep.sql).toContain("as never_attempted");
    expect(sweep.sql).toContain("flushes = 0 and failures = 0 and spool_rows = 0 and last_flush_at is null");

    // The contract, asserted as text. home-ops deduplicates on (agent_id, severity), so a page row that quietly
    // stopped being a page row is a severity rename wearing a column addition. The page condition in the sweep has to
    // stay the condition the near-real-time alert statement exports, clause for clause.
    const page = heartbeatPageAlertStatement!().sql;
    for (const fragment of [
      `last_flush_at is null and last_activity_at < now() - interval '2 hours'`,
      `last_flush_at is not null and last_activity_at - last_flush_at > interval '2 hours'`,
    ]) {
      expect(page, `the page condition lost a clause: ${fragment}`).toContain(fragment);
      expect(sweep.sql, `the sweep's page half no longer matches the alert statement: ${fragment}`).toContain(fragment);
    }
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

  it("knows that a dream turn ended, and counts the work that came after it", async () => {
    const { rowsFromBranch } = await loadModule();
    // The tag used to run until the next user message, and that assumption is what made a session go blind: a
    // teammate steer, a scheduled prompt or a resume is not a user message, so every turn after a dream was filed as
    // residue and the memory system stopped being told any work had happened. One session on the fleet had 363 rows
    // of real work in that state.
    const afterDream: any[] = [
      { type: "message", id: "w1", timestamp: "2026-11-08T02:00:00.000Z", message: { role: "user", content: "the work before the dream" } },
      { type: "custom", id: "d2", customType: "memory:dream", timestamp: "2026-11-08T02:00:10.000Z", content: "You are dreaming." },
      { type: "message", id: "d3", timestamp: "2026-11-08T02:00:20.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "memory_dream", arguments: { summary: "shipped" } }] } },
      { type: "message", id: "d4", timestamp: "2026-11-08T02:00:30.000Z", message: { role: "toolResult", toolName: "memory_dream", toolCallId: "call-9", isError: false, content: [{ type: "text", text: "dream recorded" }] } },
      { type: "custom", id: "s5", customType: "team-room", timestamp: "2026-11-08T02:10:00.000Z", content: "a steer from a teammate, not a user message" },
      { type: "message", id: "s6", timestamp: "2026-11-08T02:10:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "did the thing the steer asked for" }] } },
    ];
    const blind = rowsFromBranch!(afterDream, {}) as any[];
    expect(blind.filter((row) => row.meta.dream_turn !== true).map((row) => row.sourceEntryId)).toEqual(["w1"]);
    // With the boundary the dream turn recorded when the harness settled, the same branch reads honestly: the dream
    // is still residue, and the work after it is not.
    const awake = rowsFromBranch!(afterDream, {}, "d4") as any[];
    const work = awake.filter((row) => row.meta.dream_turn !== true).map((row) => row.sourceEntryId);
    expect(work).toEqual(["w1", "s5", "s6"]);
    expect(awake.filter((row) => row.meta.dream_turn === true).map((row) => `${row.kind}:${row.sourceEntryId}`)).toEqual(["marker:d2", "tool_call:d3", "tool_result:d4"]);
  });

  it("finds the boundary again after a restart, with no state to remember it", async () => {
    const { rowsFromBranch } = await loadModule();
    // The case the previous test still leaves open: `closeDreamTurn` records the boundary in memory, and memory does
    // not survive a pod. Roll out a fix, and every session that had already dreamed reopens the same blindness on
    // resume. This is the transcript of a real fleet session after the 14:33 UTC bounce - a dream, its own settling
    // turn, then three hours later a teammate wake with real work in it - and no boundary is passed.
    const afterRollout: any[] = [
      { type: "message", id: "w1", timestamp: "2026-11-08T12:55:00.000Z", message: { role: "user", content: "the work before the dream" } },
      { type: "custom", id: "d2", customType: "memory:dream", timestamp: "2026-11-08T12:55:53.000Z", content: "You are dreaming." },
      { type: "message", id: "d3", timestamp: "2026-11-08T12:56:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "memory_dream", arguments: { summary: "shipped" } }] } },
      { type: "message", id: "d4", timestamp: "2026-11-08T12:56:03.000Z", message: { role: "toolResult", toolName: "memory_dream", toolCallId: "call-9", isError: false, content: [{ type: "text", text: "dream recorded" }] } },
      { type: "custom", id: "s5", customType: "turn-stats", timestamp: "2026-11-08T12:56:05.000Z", content: "settled" },
      { type: "custom", id: "s6", customType: "pi-team-room-wake", timestamp: "2026-11-08T16:06:24.000Z", content: "a steer from a teammate" },
      { type: "message", id: "s7", timestamp: "2026-11-08T16:06:48.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "team_room", arguments: { action: "reply" } }] } },
      { type: "message", id: "s8", timestamp: "2026-11-08T16:06:52.000Z", message: { role: "toolResult", toolName: "team_room", toolCallId: "call-10", isError: false, content: [{ type: "text", text: "Reply sent" }] } },
    ];
    // Nothing passed, nothing remembered: the boundary comes from the harness's own settling turn.
    const rows = rowsFromBranch!(afterRollout, {}) as any[];
    const residue = rows.filter((row) => row.meta.dream_turn === true).map((row) => row.sourceEntryId);
    // The settling turn is the last thing the dream produced, so it counts as residue too.
    expect(residue).toEqual(["d2", "d3", "d4", "s5"]);
    // The teammate's reply and the work behind it are visible again, which is the whole point of the split.
    expect(rows.filter((row) => row.meta.dream_turn !== true).map((row) => row.sourceEntryId)).toEqual(["w1", "s6", "s7", "s8"]);
    // And a dream that never settled still falls back to the next user message rather than running forever.
    const unsettled: any[] = [
      { type: "custom", id: "d1", customType: "memory:dream", timestamp: "2026-11-08T12:55:53.000Z", content: "You are dreaming." },
      { type: "message", id: "d2", timestamp: "2026-11-08T12:56:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } },
      { type: "message", id: "u3", timestamp: "2026-11-08T13:00:00.000Z", message: { role: "user", content: "the user speaks again" } },
    ];
    expect((rowsFromBranch!(unsettled, {}) as any[]).filter((row) => row.meta.dream_turn === true).map((row) => row.sourceEntryId)).toEqual(["d1", "d2"]);
  });

  it("closes a dream at its settling turn and re-opens only for a dream row that arrives later", async () => {
    const { rowsFromBranch } = await loadModule();
    // The rule the offline repair has to mirror, in one branch. Residue is not "everything a dream touched"; it is a
    // union of short turns - the prompt plus the turn it closes, and then each `memory_dream` row plus the turn it
    // re-arms. Everything between those windows is work, and this is where the two implementations fell out: the
    // tagger closes and re-arms row by row, while the repair looked for one boundary per dream and, finding a stray
    // `memory_dream` result 248 rows on, treated a whole day of editing as the dream's own.
    const branchWithLateDream: any[] = [
      { type: "custom", id: "p1", customType: "memory:dream", timestamp: "2026-11-08T09:00:00.000Z", content: "You are dreaming." },
      { type: "message", id: "a2", timestamp: "2026-11-08T09:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "declining: the stretch was thin" }] } },
      { type: "custom", id: "s3", customType: "turn-stats", timestamp: "2026-11-08T09:00:07.000Z", content: "settled" },
      // Real work, in its own settled turns, with no dream in any of it.
      { type: "message", id: "w4", timestamp: "2026-11-08T09:05:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm run check" } }] } },
      { type: "message", id: "w5", timestamp: "2026-11-08T09:05:10.000Z", message: { role: "toolResult", toolName: "bash", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "431 passed" }] } },
      { type: "custom", id: "s6", customType: "turn-stats", timestamp: "2026-11-08T09:05:12.000Z", content: "settled" },
      // A dream row arriving late re-arms the tag for its own turn and nothing wider.
      { type: "message", id: "d7", timestamp: "2026-11-08T10:30:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "memory_dream", arguments: { summary: "the check passed" } }] } },
      { type: "message", id: "d8", timestamp: "2026-11-08T10:30:05.000Z", message: { role: "toolResult", toolName: "memory_dream", toolCallId: "call-2", isError: false, content: [{ type: "text", text: "dream recorded" }] } },
      { type: "custom", id: "s9", customType: "turn-stats", timestamp: "2026-11-08T10:30:07.000Z", content: "settled" },
      { type: "message", id: "w10", timestamp: "2026-11-08T10:35:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "git push" } }] } },
    ];
    const residue = (rowsFromBranch!(branchWithLateDream, {}) as any[])
      .filter((row) => row.meta.dream_turn === true).map((row) => row.sourceEntryId);
    expect(residue).toEqual(["p1", "a2", "s3", "d7", "d8", "s9"]);
    // The work between the two dreams is visible to the gate. Four rows, which is over the floor of four, so a later
    // dream is asked about real editing rather than told the session did nothing for ninety minutes.
    expect((rowsFromBranch!(branchWithLateDream, {}) as any[])
      .filter((row) => row.meta.dream_turn !== true).map((row) => row.sourceEntryId)).toEqual(["w4", "w5", "s6", "w10"]);
  });

  it("treats research done inside a dream turn as residue, and that is a decision rather than an oversight", async () => {
    const { rowsFromBranch } = await loadModule();
    // The finding worth being blunt about: a dream turn that researches before calling the tool hides that research
    // from the work count. It was measured rather than assumed, and on this fleet it amounts to one tagged tool call
    // in total, because the agents call the tool on the row after the prompt. Splitting machinery from work sounds
    // tidy and buys nothing at that size, while costing the guard its point: the prose a model writes about whether
    // anything was worth remembering is by far the commonest row in a dream turn, and counting it as work lets a dream
    // satisfy the floor with dreaming alone. So this behaviour is pinned as intended, not left as a latent bug.
    const researchDream: any[] = [
      { type: "custom", id: "p1", customType: "memory:dream", timestamp: "2026-11-08T11:00:00.000Z", content: "You are dreaming." },
      { type: "message", id: "q2", timestamp: "2026-11-08T11:00:10.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "web_search", arguments: { query: "pgvector hnsw m" } }] } },
      { type: "message", id: "q3", timestamp: "2026-11-08T11:00:20.000Z", message: { role: "toolResult", toolName: "web_search", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "results" }] } },
      { type: "message", id: "d4", timestamp: "2026-11-08T11:00:30.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "memory_dream", arguments: { summary: "hnsw m is the default" } }] } },
      { type: "message", id: "d5", timestamp: "2026-11-08T11:00:35.000Z", message: { role: "toolResult", toolName: "memory_dream", toolCallId: "call-2", isError: false, content: [{ type: "text", text: "dream recorded" }] } },
      { type: "custom", id: "s6", customType: "turn-stats", timestamp: "2026-11-08T11:00:37.000Z", content: "settled" },
    ];
    const rows = rowsFromBranch!(researchDream, {}) as any[];
    expect(rows.filter((row) => row.meta.dream_turn === true).map((row) => row.sourceEntryId)).toEqual(["p1", "q2", "q3", "d4", "d5", "s6"]);
  });

  it("records markers and compactions, and skips harness bookkeeping", async () => {
    const { rowsFromBranch } = await loadModule();
    const rows = rowsFromBranch!(branch(), {}) as any[];
    expect(rows.filter((row) => row.kind === "marker").map((row) => row.toolName)).toEqual(["model-marker"]);
    expect(rows.filter((row) => row.kind === "system").map((row) => row.text)).toEqual(["compacted: pgvector store shipped and verified"]);
    expect(rows.some((row) => row.sourceEntryId === "e6")).toBe(false);
  });

  it("carries an extension's details into the store, scrubbed like everything else beside it", async () => {
    const { rowsFromBranch } = await loadModule();
    // The finding worth stating plainly: `details` is the harness's own field for metadata an extension attaches to a
    // message, the schedule and team-room extensions both use it, and this extension was copying it into `meta`
    // verbatim - the one write path in this file where the redactor was never applied. A job's note, a relayed
    // authorisation quote, a wake's message ids all arrived untouched while the identical words in the message body
    // beside them were being scrubbed.
    const detailed: any[] = [
      {
        type: "custom", id: "c1", customType: "schedule:fire", timestamp: "2026-11-08T18:00:00.000Z",
        content: "the job prompt arrived here", details: { jobId: 12, occurrence: "2026-11-09T02:00:00+08:00", tz: "Australia/Perth", note: "read the runbook first" },
      },
      {
        type: "custom", id: "c2", customType: "teamroom:delegated", timestamp: "2026-11-08T18:01:00.000Z",
        content: "a wake from a teammate", details: { messageIds: ["m-1"], from: "camry", kinds: ["delegation"], authorization: "token: hunter2hunter2hunter2", rotation: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
      },
    ];
    const rows = rowsFromBranch!(detailed, {}) as any[];
    const fired = rows.find((row) => row.sourceEntryId === "c1")!;
    expect(fired.meta.details).toEqual({ jobId: 12, occurrence: "2026-11-09T02:00:00+08:00", tz: "Australia/Perth", note: "read the runbook first" });
    const wake = rows.find((row) => row.sourceEntryId === "c2")!;
    expect(wake.meta.details.from).toBe("camry");
    expect(wake.meta.details.messageIds).toEqual(["m-1"]);
    // The whole pair goes, not just the value: `key-value` matches the key name too, which is the right shape for
    // this - a field called `authorization` whose value was scrubbed still tells a reader what was there.
    expect(wake.meta.details.authorization).toBe("[redacted:key-value]");
    expect(wake.meta.details.rotation).toBe("[redacted:github-token]");
    expect(wake.meta.redacted).toEqual(expect.arrayContaining(["key-value", "github-token"]));
    // Not merely "the field was scrubbed" - the secret is nowhere in the row at all, which is the property that
    // actually matters when someone greps the store.
    expect(JSON.stringify(wake)).not.toMatch(/hunter2|ghp_/);
  });

  it("bounds details by leaf and by total, and keeps the key names when the total is blown", async () => {
    const { redactDetails } = await loadModule();
    expect(redactDetails({ jobId: 3, note: "short" }, []).details).toEqual({ jobId: 3, note: "short" });
    expect(redactDetails({ jobId: 3, note: "short" }, []).truncated).toBeUndefined();
    expect(redactDetails(undefined, []).details).toBeUndefined();
    // Numbers and booleans survive untouched: a jobId is a number in the schedule extension today and coercing it to
    // a string would make the equality the repair queries fail.
    expect(redactDetails({ jobId: 12, occurred: true }, []).details).toEqual({ jobId: 12, occurred: true });
    const leaf = redactDetails({ note: "x".repeat(500) }, [], { total: 2_000, leaf: 40 });
    expect((leaf.details as Record<string, unknown>).note).toBe(`${"x".repeat(40)}…`);
    // Over the total the payload is reduced to which keys arrived, not thrown away: "this wake carried messageIds and
    // kinds" is a fact about the event even when none of the values were worth keeping.
    const huge = redactDetails({ jobId: 3, note: "y".repeat(5_000), tz: "Australia/Perth" }, [], { total: 200, leaf: 200 });
    expect(huge.truncated).toBe(true);
    expect(huge.details).toEqual({ keys: ["jobId", "note", "tz"] });
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
    expect(statement.sql).toContain("(select coalesce(max(seq), 0) from memory.event where session_id = $1) + 1");
    expect(statement.sql).toContain("(select coalesce(max(seq), 0) from memory.event where session_id = $1) + 2");
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
    expect(dream.sql).toContain("seq > coalesce((select dream_seq from memory.session where id = $1), 0)");
    expect(dream.values).toEqual(["s1", "a1", "idle10m", "shipped it", ["infra"], "pleased", JSON.stringify({ written_by: "memory_dream" }), null, null, null]);
    const cursor = dreamCursorStatement!("s1");
    expect(cursor.sql).toContain("set dream_seq = (select coalesce(max(seq), dream_seq) from memory.event where session_id = $1)");
  });

  it("spans only the events that are not the residue of a previous dream", async () => {
    const { dreamStatement, dreamSpanStatement } = await loadModule();
    const dream = dreamStatement!({ sessionId: "s1", agentId: "a1", trigger: "idle10m", summary: "shipped", subjects: [] });
    expect(dream.sql).toContain(`and coalesce(meta ->> 'dream_turn', 'false') <> 'true'`);
    const span = dreamSpanStatement!("s1");
    expect(span.sql).toContain(`count(*) filter (where coalesce(meta ->> 'dream_turn', 'false') <> 'true') as work_events`);
    expect(span.sql).toContain("seq > coalesce((select dream_seq from memory.session where id = $1), 0)");
    expect(span.values).toEqual(["s1"]);
  });

  it("seeds the gate from where the last dream ended, so a resume does not re-dream its whole history", async () => {
    const { dreamSpanStatement, dreamWatermarkStatement } = await loadModule();
    const seed = dreamWatermarkStatement!("s1");
    // The mirror of the span query: the span counts what is ahead of the cursor, the seed counts what is behind it,
    // and the two together are the whole history. If the gate starts at zero instead, a resumed session's every row
    // is unsummarized work and the first clock tick asks about it.
    expect(seed.sql).toContain("seq <= coalesce((select greatest(dream_seq, dream_considered_seq) from memory.session where id = $1), 0)");
    expect(seed.sql).toContain(`count(*) filter (where coalesce(meta ->> 'dream_turn', 'false') <> 'true') as work_before`);
    expect(seed.values).toEqual(["s1"]);
    // Same definition of work, or the two halves would disagree about what the gate is counting.
    expect(seed.sql.match(/dream_turn', 'false'} <> 'true'/g)?.length).toBe(dreamSpanStatement!("s1").sql.match(/dream_turn', 'false'} <> 'true'/g)?.length);
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

  it("keeps more than one row when it rewrites the queue", async () => {
    // `rewriteSpool` used to join rows with "", which put both JSON objects on a single line. `readSpool` splits on
    // newlines, so the pair read back as one torn line and neither row survived - a queue that reported itself as
    // holding rows and replayed as nothing. Measured against the pre-fix source: `readSpool` returned 0 of 2.
    const mod = await loadModule();
    const rows = [
      { sourceEntryId: "e1", kind: "user", at: "2026-11-08T01:00:00.000Z", sessionId: "s1", meta: {}, text: "first" },
      { sourceEntryId: "e2", kind: "assistant", at: "2026-11-08T01:00:05.000Z", sessionId: "s1", meta: {}, text: "second" },
    ];
    expect(mod.rewriteSpool!(rows)).toBe(2);
    expect(mod.readSpool!().rows.map((row: any) => row.sourceEntryId)).toEqual(["e1", "e2"]);
  });

  it("refuses to spool something that is not a row, and says how much it wrote", async () => {
    // The spool exists so a failed write is late rather than lost. A queue full of lines that parse but carry no
    // `sourceEntryId` is the other outcome - it looks like a backlog and replays as nothing - so the writer side
    // checks the shape too. Iterating a string is how that class of file got made in the first place: `for (const row
    // of "agent-id")` is eight perfectly good JSON values, and the call that produced them reported success.
    const mod = await loadModule();
    mod.rewriteSpool!([]);
    expect(mod.writeSpool!("agent-id" as unknown as never)).toBe(0);
    expect(mod.writeSpool!(["agent-id"] as unknown as never)).toBe(0);
    expect(mod.writeSpool!([{ kind: "user", text: "no source id" } as never])).toBe(0);
    // Absent and empty are the same claim here, and the queue is empty either way.
    expect(existsSync(spoolPath) ? readFileSync(spoolPath, "utf8") : "").toBe("");

    const valid = { sourceEntryId: "e1", kind: "user", at: "2026-11-08T01:00:00.000Z", sessionId: "s1", meta: {}, text: "real" };
    expect(mod.writeSpool!([valid as never, "x" as never, null as never])).toBe(1);
    expect(mod.readSpool!().rows.map((row: any) => row.sourceEntryId)).toEqual(["e1"]);
  });
});

describe("dream gate", () => {
  it("dreams only when there is a stretch that has not been summarized", async () => {
    const { dreamPending } = await loadModule();
    expect(dreamPending!(3, 0)).toBe(true);
    expect(dreamPending!(3, 3)).toBe(false);
    expect(dreamPending!(0, 0)).toBe(false);
  });

  it("holds a thin stretch below the floor, which is what keeps a no-op from buying a dream", async () => {
    const { dreamPending } = await loadModule();
    // A wake that accomplished nothing is a row or two of prompt and reply. The floor is what says so without
    // asking the model to spend a turn discovering it.
    expect(dreamPending!(3, 0, 4)).toBe(false);
    expect(dreamPending!(4, 0, 4)).toBe(true);
    expect(dreamPending!(12, 8, 4)).toBe(true);
    expect(dreamPending!(11, 8, 4)).toBe(false);
    // A gate with no floor is the old gate: any new row re-opens it, which is how a refused dream came back every
    // idle window.
    expect(dreamPending!(1, 0)).toBe(true);
  });
  it("refuses a span with nothing in it and annotates one that is merely short", async () => {
    // Two things the old single function conflated, and the conflation is what lost the fleet a question about the
    // Earl: a count of rows is a good way to decide whether a dream is worth *asking* about, and a terrible way to
    // decide whether a sentence is worth remembering. Only the empty span is refused outright.
    const { dreamRefusal, dreamThinNote } = await loadModule();
    expect(dreamRefusal!(2)).toBeUndefined();
    expect(dreamRefusal!(0)).toContain("nothing unsummarized since the last dream");
    expect(dreamRefusal!(0)).toContain("0 non-dream events");
    // Below the floor the write goes ahead, and the thinness travels with it as a note, not a veto.
    expect(dreamThinNote!(3, 4)).toContain("thin span: 3 work event(s), under the 4");
    expect(dreamThinNote!(3, 4)).toContain("written anyway");
    expect(dreamThinNote!(4, 4)).toBeUndefined();
    expect(dreamThinNote!(9, 4)).toBeUndefined();
    // An empty span is refused by the refusal, so the note must not double up on it.
    expect(dreamThinNote!(0, 4)).toBeUndefined();
  });

  it("tells the dreamer it is the judge of a short stretch, not the row count", async () => {
    const { DREAM_PROMPT } = await loadModule();
    expect(String(DREAM_PROMPT)).toContain("you are the judge of that, not the row count");
    expect(String(DREAM_PROMPT)).toContain("The store refuses only a span with nothing in it");
    // The old wording told the agent to decline a thin stretch before it had read it, which is what macker obeyed.
    expect(String(DREAM_PROMPT)).not.toContain("too few work events");
    expect(String(DREAM_PROMPT)).toContain("A memory about a memory is not a memory");
    expect(String(DREAM_PROMPT)).toContain("Call memory_dream exactly once");
    expect(String(DREAM_PROMPT)).not.toContain("use subjects {none}");
    // A decline no longer burns the rows: the promise is that the next span still holds them.
    expect(String(DREAM_PROMPT)).toContain("the next dream's span will still hold it");
  });

  it("tells a pre-compaction dream to go back to the work it interrupted", async () => {
    // The dream that ate slopyphus's fix: 09:27:18 a syntax error in hand, 09:32:01 the context filled and the dream
    // arrived as a turn, and "do not start new work" was obeyed so literally that the run stopped and the Earl had to
    // poke it seven minutes later. The base prompt is written for a session that is idle; a mid-task one has to be
    // told the work is still its own.
    const { dreamPromptFor, DREAM_PROMPT } = await loadModule();
    expect(dreamPromptFor!("idle10m")).toBe(DREAM_PROMPT);
    expect(dreamPromptFor!("resume10m")).toBe(DREAM_PROMPT);
    expect(dreamPromptFor!("manual")).toBe(DREAM_PROMPT);
    const compact = String(dreamPromptFor!("pre_compaction"));
    expect(compact).toContain(DREAM_PROMPT);
    expect(compact).toContain("You were interrupted mid-task");
    expect(compact).toContain("take the next step of the task you were doing in the same turn");
    expect(compact).not.toContain("awaiting the next instruction");
  });

  it("keeps the two watermarks honest about which one each path moves", async () => {
    const { dreamCursorStatement, dreamConsiderStatement } = await loadModule();
    // A written memory closes the stretch for both questions: nothing left to summarise, nothing left to ask about.
    const written = dreamCursorStatement!("s1");
    expect(written.sql).toContain("set dream_seq =");
    expect(written.sql).toContain("dream_considered_seq");
    // A dream that wrote nothing closes only the asking. Moving `dream_seq` here is what buried the rows: the memory
    // was never written, so the span was never summarised, whatever the dream decided to say.
    const declined = dreamConsiderStatement!("s1");
    expect(declined.sql).toContain("set dream_considered_seq =");
    expect(declined.sql).not.toContain("set dream_seq");
    expect(declined.values).toEqual(["s1"]);
  });

  it("exempts compaction from the floor, because that is where a thin stretch is the one worth keeping", async () => {
    const { dreamFloorFor, dreamPending } = await loadModule();
    // The floor exists to stop a dream being paid for out of reflex. Before compaction the turn is already spent and
    // the context is about to be discarded, so a two-row stretch holding one dense decision - "do not apply the kill
    // switch, and do not re-report it" - is the memory that matters most and the only version that survives.
    expect(dreamFloorFor!("pre_compaction", 4)).toBe(1);
    expect(dreamFloorFor!("idle10m", 4)).toBe(4);
    expect(dreamFloorFor!("resume10m", 4)).toBe(4);
    expect(dreamFloorFor!("idle10m", 0)).toBe(1);
    expect(dreamPending!(2, 0, dreamFloorFor!("pre_compaction", 4))).toBe(true);
    expect(dreamPending!(2, 0, dreamFloorFor!("idle10m", 4))).toBe(false);
  });

  it("tells the agent that declining an empty stretch is safe, because the asking closes either way", async () => {
    // The instruction used to end the other way: "a dream that admits it was empty is fine", which is exactly what put
    // four paragraphs of "nothing happened" into a store that other agents then retrieve.
    const { DREAM_PROMPT } = await loadModule();
    expect(String(DREAM_PROMPT)).toContain("do not call the tool");
    expect(String(DREAM_PROMPT)).toContain("closed for asking");
    expect(String(DREAM_PROMPT)).not.toContain("use subjects {none}");
    expect(String(DREAM_PROMPT)).toContain("Call memory_dream exactly once");
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

  it("survives a context replaced under a debounced write", async () => {
    // 2026-11-08, slopyphus: every agent that ran /reload exited with `pi exiting due to uncaughtException ... This
    // extension ctx is stale after session replacement or reload`, the stack frame naming `flush` in this file. The
    // debounce had captured a context, the human replaced the session inside the debounce window, and the timer fired
    // the captured context into a getter that no longer allows being read.
    const watcher = watchUnhandledRejections();
    try {
      const live = contextFor();
      await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, live.context);
      makeStale(live.context);
      vi.useFakeTimers();
      vi.advanceTimersByTime(5_000);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(watcher.reasons, "a flush that outlived its context reached Node as an unhandled rejection, and Pi exits on that").toEqual([]);
      const lines = await spooled();
      expect(lines.length, "the aborted flush dropped the queued rows instead of rescuing them").toBeGreaterThan(0);
      expect(JSON.parse(lines[0]!).sessionId, "a row has to carry its session from the moment the context was still live, because the flush that writes it out may not have one").toBe("session-1");
    } finally {
      watcher.stop();
    }
  });

  it("survives a context already dead when shutdown asks for the last write", async () => {
    const watcher = watchUnhandledRejections();
    try {
      const live = contextFor();
      await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, live.context);
      const dead = contextFor();
      makeStale(dead.context);
      await pi.emit("session_shutdown", { reason: "reload" }, dead.context);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(watcher.reasons, "the shutdown flush is the one place a writer is guaranteed to be mid-await when the context goes").toEqual([]);
      expect((await spooled()).length, "rows queued against a live context must not evaporate with the dead one").toBeGreaterThan(0);
    } finally {
      watcher.stop();
    }
  });

  it("keeps every asynchronous call site holding its own rejection", () => {
    // The rule, not one instance of it. Internal correctness cannot fix a call site that throws a promise away, so
    // the source itself is asserted: no fire-and-forget in a file that runs inside somebody else's process.
    //
    // Comment lines are excluded, and not as a convenience. The first run of this assertion failed on the comment
    // that documents the bug it exists to prevent, which is the lesson this repository already has written down twice:
    // a scan that cannot tell prose from code reports its own description as a violation and then gets ignored.
    const source = readFileSync(MODULE, "utf8");
    // One prose test for both assertions below, because both are counts and a count over prose counts the prose.
    const isProse = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);
    const dropped = source
      .split("\n")
      .flatMap((line, index) => (isProse(line) ? [] : [...line.matchAll(/\bvoid\s+(flush|runDream|stamp|collect|database|dream)\(/g)].map((match) => `line ${index + 1}: ${match[0]}`)));
    expect(dropped, "a discarded promise here is an unhandled rejection, and Pi treats one as fatal").toEqual([]);
    const code = source.split("\n").filter((line) => !isProse(line)).join("\n");
    // Every read of `hasUI` has to live inside ui(ctx), the one place that wraps it. Counting the whole file against
    // the count inside the helper is what makes it a rule rather than a review note: a new `if (ctx.hasUI)` anywhere
    // else changes one number and not the other.
    const startsAt = code.indexOf("function ui(ctx");
    expect(startsAt, "ui(ctx) is the wrapper every UI read goes through; without it this assertion has nothing to allow").toBeGreaterThan(-1);
    const helper = code.slice(startsAt, code.indexOf("\n  }", startsAt));
    const inHelper = (helper.match(/ctx\??\.hasUI/g) ?? []).length;
    const everywhere = (code.match(/ctx\??\.hasUI/g) ?? []).length;
    expect(inHelper, "ui(ctx) itself has to be the one reading hasUI").toBeGreaterThan(0);
    expect(everywhere, "a `ctx.hasUI` read outside ui(ctx) is a getter on a context that may already be dead").toBe(inHelper);
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

  it("does not dream about a stretch thinner than the floor", async () => {
    // The shape a no-op leaves behind: one message, one answer, nothing else. Asking a model to reflect on that
    // costs a turn and puts the asking itself in the context.
    vi.useFakeTimers();
    const { context } = contextFor({ branch: branch().slice(0, 1) });
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    vi.useRealTimers();
    expect(pi.sentMessages, "a one-row scrap is not a stretch").toHaveLength(0);
  });

  it("asks about the same thin stretch when the repository lowers the floor", async () => {
    // The pair of the test above, so that one is known to be about the floor rather than about the branch being
    // unreadable. A repository that wants every stretch dreamed about can still ask for that.
    writeFileSync(agentConfigPath, JSON.stringify({ flushMs: 50, minDreamWork: 1 }), "utf8");
    vi.useFakeTimers();
    const keen = await load();
    const { context } = contextFor({ branch: branch().slice(0, 1) });
    await keen.emit("session_start", { reason: "new" }, context);
    await keen.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    vi.useRealTimers();
    expect(keen.sentMessages).toHaveLength(1);
    expect(keen.sentMessages[0]?.message).toMatchObject({ customType: "memory:dream", details: { trigger: "idle10m" } });
  });

  it("dreams a thin stretch before compaction, where the floor would have lost it", async () => {
    // The pair of "does not dream about a stretch thinner than the floor". Same one-row branch, different trigger: the
    // context is about to be thrown away and the turn is already paid for, so this is the stretch a memory exists for.
    vi.useFakeTimers();
    const { context } = contextFor({ branch: branch().slice(0, 1) });
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("session_before_compact", {}, context);
    vi.useRealTimers();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0]?.message).toMatchObject({ customType: "memory:dream", details: { trigger: "pre_compaction" } });
  });

  it("counts the work a session does after a dream, even when nobody spoke to it", async () => {
    // The second half of the same blindness: the dream's rows used to be residue until the next user message, and a
    // session that carries on taking steers and scheduled prompts without one has its real work filed as dreaming.
    // This is the shape that made a store-side refusal correct-looking and wrong - the span said zero work events
    // because 363 rows had been tagged as a dream that had ended hours earlier.
    vi.useFakeTimers();
    const live = branch();
    const { context } = contextFor({ branch: live });
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
    // The dream answers, and the turn settles. Its rows are residue, and the settle marks where they stop.
    live.push(
      { type: "custom", id: "d1", parentId: "e6", timestamp: "2026-11-08T01:10:00.000Z", customType: "memory:dream", content: "You are dreaming." },
      { type: "message", id: "d2", parentId: "d1", timestamp: "2026-11-08T01:10:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "that stretch was already remembered" }] } },
    );
    await pi.emit("agent_settled", { aborted: false }, context);
    // A teammate steers the session, and the agent does four rows of actual work. No user message anywhere.
    live.push(
      { type: "custom", id: "s1", parentId: "d2", timestamp: "2026-11-08T01:20:00.000Z", customType: "team-room", content: "the floor also silences a short stretch with a decision in it" },
      { type: "message", id: "s2", parentId: "s1", timestamp: "2026-11-08T01:20:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "compaction is exempted then" }, { type: "toolCall", name: "edit", arguments: { path: "extensions/memory.ts" } }] } },
      { type: "message", id: "s3", parentId: "s2", timestamp: "2026-11-08T01:20:20.000Z", message: { role: "toolResult", toolName: "edit", toolCallId: "call-2", isError: false, content: [{ type: "text", text: "ok" }] } },
      { type: "message", id: "s4", parentId: "s3", timestamp: "2026-11-08T01:20:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "tests next" }] } },
    );
    await pi.emit("turn_end", { turnIndex: 1, messageEntryId: "s2", toolResultEntryIds: ["s3"] }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    vi.useRealTimers();
    // The dream did not swallow the session: four rows of post-dream work are a stretch, and it gets asked about.
    expect(pi.sentMessages).toHaveLength(2);
    expect(pi.sentMessages.at(-1)?.message).toMatchObject({ customType: "memory:dream", details: { trigger: "idle10m" } });
  });

  it("closes the stretch when a dream wrote nothing, so the next idle window is quiet", async () => {
    // The runaway this exists to stop: five dream turns in one session, the last three with no work between them.
    // The watermark only moved on a successful write, so an agent that answered "nothing here is worth remembering"
    // - or declined to call the tool, exactly as the dream prompt tells it to - was asked again every window, and
    // each asking left hidden rows in the branch that collect() counts.
    vi.useFakeTimers();
    const { context } = contextFor();
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
    // The dream turn ends, and it wrote nothing.
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(21 * 60_000);
    vi.useRealTimers();
    expect(pi.sentMessages, "a dream that wrote nothing must still close its stretch").toHaveLength(1);
  });

  it("keeps the stretch open when the store refused the write, so a memory is not lost to a connection", async () => {
    // The exception to closing: a stretch the store would not take really is unsummarized, and dreaming twice
    // about real work is far better than forgetting it because Postgres was restarting.
    vi.useFakeTimers();
    const { context } = contextFor();
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
    const result = await callTool(pi, "memory_dream", { summary: "shipped the store", subjects: ["infra"], feel: "wary" }, context);
    expect(String(result.content[0]?.text)).toContain("memory_dream not written");
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    vi.useRealTimers();
    expect(pi.sentMessages, "a refused write leaves the stretch unsummarized, and it should be").toHaveLength(2);
    expect(pi.sentMessages.at(-1)?.message).toMatchObject({ customType: "memory:dream" });
  });

  it("does not stack a second dream prompt on a dream that is still running", async () => {
    vi.useFakeTimers();
    const { context } = contextFor();
    await pi.emit("session_start", { reason: "new" }, context);
    await pi.emit("turn_end", { turnIndex: 0, messageEntryId: "e2", toolResultEntryIds: ["e3"] }, context);
    await pi.emit("agent_settled", { aborted: false }, context);
    vi.advanceTimersByTime(11 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
    // Compaction arrives while the dream turn is still in flight.
    await pi.emit("session_before_compact", {}, context);
    vi.useRealTimers();
    expect(pi.sentMessages, "a session that is dreaming is not due for another dream").toHaveLength(1);
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

  it("exports the drift pair and the reading sanity check as statements, not as prose", async () => {
    const { identityPairStatement, storeReadingSanityStatement, storeShapeCountsStatement } = await loadModule();
    const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

    // The pair query's whole meaning is in three comparisons, so they are asserted by name: same repo, the arrival
    // postdates the stall, and a row whose `first_seen_at` postdates its own `last_activity_at` is not evidence about
    // anything (it predates the column).
    const pair = identityPairStatement!();
    expect(pair.values).toEqual([]);
    expect(flat(pair.sql)).toContain("b.repo = a.repo and b.agent_id <> a.agent_id");
    expect(flat(pair.sql)).toContain("b.first_seen_at > a.last_activity_at");
    expect(flat(pair.sql)).toContain("a.first_seen_at <= a.last_activity_at");
    expect(flat(pair.sql)).toContain("as stalled_id");
    expect(flat(pair.sql)).toContain("as arriving_id");

    // The sanity reading must not touch the tables it is checking the presence of, or it cannot answer "am I in the
    // right database" in a database that has none of them.
    const sanity = storeReadingSanityStatement!();
    expect(sanity.values).toEqual([]);
    expect(flat(sanity.sql)).toContain("to_regclass('memory.memory')");
    expect(flat(sanity.sql)).toContain("to_regclass('public.memory')");
    expect(flat(sanity.sql)).toContain("from pg_roles where rolname = current_user");
    expect(flat(sanity.sql)).not.toContain("from memory.memory");

    // ... and the counts live in a statement that is allowed to fail, because a missing relation failing loudly is a
    // reader standing in the wrong place, which is a better outcome than a plausible zero.
    const counts = storeShapeCountsStatement!();
    expect(flat(counts.sql)).toContain("from memory.memory");
    expect(counts.sql).toContain("memories_without_vector");
  });

  it("names the schema in every statement it hands to another reader", async () => {
    const mod = await loadModule();
    // The list must grow with the schema. Before `edge` was added here, `insert into memory.edge` left the word
    // `memory` behind after subtraction and the guard reported a perfectly qualified statement as an offender - the
    // failure mode where a guard starts lying about clean code, which is worse than not having the guard.
    const tables = ["memory", "event", "session", "agent", "writer_heartbeat", "subject_index", "edge", "graph_edges", "graph_degree", "subject_merge"];
    // Detection is by subtraction: delete every properly qualified reference (`memory.memory`, `memory.event`,
    // `memory.writer_heartbeat.flushes`) and whatever table name is left over was written unqualified. A pattern keyed
    // on `from`/`join` alone misses the column-qualifier form (`failures = writer_heartbeat.failures + 1`), which this
    // store actually uses in its ON CONFLICT clauses, and that is the form that resolves through search_path just as
    // quietly. The store's role has `search_path = memory, public`, so every one of these works today and fails
    // silently tomorrow - a `public` twin, or a caller connecting as another role, and the read or write lands
    // somewhere plausible and wrong. home-ops `51e4ea4` found the read half of that class in their own runbook, where a
    // path that does not exist succeeded and printed nothing.
    const qualified = new RegExp(`memory\\.(${tables.join("|")})\\b`, "g");
    const leftover = new RegExp(`\\b(${tables.join("|")})\\b`, "g");
    // The one statement allowed to name an object without its schema. Its entire job is to report what `memory` and
    // `public.memory` RESOLVE to for whoever is running it; qualifying it would destroy the thing it measures.
    const exempt = new Set(["storeReadingSanityStatement"]);
    const argShapes: unknown[][] = [
      [],
      ["agent-id", "repo"],
      ["agent-id"],
      ["agent-id", 12],
      ["agent-id", "a rolled-back flush", 3],
      [{ sessionId: "s1", agentId: "a", cwd: "/w", repo: "r", firstAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-01T00:00:00Z" }],
      [{ agentLike: "a%" }],
      ["how do I roll this back", "agent-id"],
      ["agent-id", [0.1, 0.2]],
    ];

    const checked: string[] = [];
    const offenders: string[] = [];
    // The spool helpers are exported for tests, and they iterate their argument: calling them with a fixture string is
    // how a sweep over every export wrote 1,014 one-character JSON lines into the real ~/.pi/agent/memory-spool.jsonl
    // on 2026-11-08. This guard reads SQL text, so it has no business calling anything with a file handle.
    const nonSql = new Set(["readSpool", "writeSpool", "rewriteSpool"]);
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      if (nonSql.has(name)) continue;
      // An async export is not a statement builder, and calling one with a half-matching argument shape produces a
      // rejected promise that surfaces as an unhandled rejection somewhere else in the run. This guard reads SQL text,
      // so it does not want the ones that reach for the network.
      if ((value as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") continue;
      let spec: unknown;
      for (const args of argShapes) {
        try {
          const result = (value as (...a: unknown[]) => unknown)(...args);
          if (result && typeof (result as Promise<unknown>).then === "function") {
            void Promise.resolve(result).catch(() => undefined);
            break;
          }
          spec = result;
          break;
        } catch {
          // wrong argument shape for this factory; try the next one
        }
      }
      const sql = (spec as { sql?: unknown } | undefined)?.sql;
      if (typeof sql !== "string") continue;
      checked.push(name);
      if (exempt.has(name)) continue;
      // Single-quoted text is payload, not a relation. `meta ->> 'agent'` names a JSON key that happens to spell a
      // table name, and counting it as an unqualified reference is how a guard ends up objecting to correct SQL, so
      // quoted literals are blanked first. The exemption is narrow on purpose: only quoted text, never identifiers.
      const body = sql.replace(/'[^']*'/g, "''");
      const bad = body.replace(/\s+/g, " ").replace(qualified, " ").match(leftover);
      if (bad) offenders.push(`${name}: ${[...new Set(bad)].join(", ")}`);
    }

    // A guard, not a census: a factory that stops being callable with these shapes quietly leaves the checked set, so
    // the number checked is asserted rather than assumed.
    expect(checked.length).toBeGreaterThanOrEqual(18);
    expect(checked).toContain("storeShapeCountsStatement");
    // Inside the checked set, exempt from the rule, for the reason above.
    expect(checked).toContain("storeReadingSanityStatement");
    expect(offenders).toEqual([]);
  });

  it("quotes the statements it exports, not a paraphrase of them", async () => {
    const mod = await loadModule();
    const doc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../memory/README.md"), "utf8");
    const flatten = (sql: string) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
    const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) =>
      flatten(m[1].split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").replace(/--\s.*$/gm, "")),
    );

    // Statements a reader is expected to run *from the documentation*. Writers and internal helpers are deliberately
    // not in this list: the README is a reader's entry point, and a sweep that copies a block should be copying a
    // reader statement. The rule exists because home-ops already got bitten by the alternative - they had to re-copy
    // my sweep SQL after I changed it - and because a stale block is worse than no block: it looks authoritative.
    const quoted = [
      "heartbeatPageAlertStatement",
      "heartbeatAdvisoryAlertStatement",
      "heartbeatSweepStatement",
      "identityPairStatement",
      "vectorCoverageStatement",
      "storeReadingSanityStatement",
    ];

    const missing = quoted.filter((name) => {
      const build = mod[name] as (() => { sql: string }) | undefined;
      if (typeof build !== "function") return true;
      return !blocks.some((block) => block.includes(flatten(build().sql)));
    });
    expect(missing).toEqual([]);
  });

  it("counts how much of the store is findable by meaning rather than by wording", async () => {
    const { vectorCoverageStatement } = await loadModule();
    // Whole store by default, because the fleet-level question is "is recall quality dropping", and one checkout's
    // answer to it is not comparable to another's.
    // Assertions read the SQL on one line, because the statement is written across several for readability and a test
    // that depends on the line breaks would fail for formatting reasons.
    const flatten = (sql: string) => sql.replace(/\s+/g, " ").trim();
    const whole = vectorCoverageStatement!();
    expect(whole.values).toEqual([]);
    expect(flatten(whole.sql)).toContain("count(*) filter (where embedding is null)");
    expect(flatten(whole.sql)).toContain("without_vector_24h");
    // A count cannot tell a small cold store from a degrading one, so the exported statement carries its own
    // denominator, and `nullif` is what keeps an empty store from erroring at the moment it is most worth reading.
    expect(flatten(whole.sql)).toContain("without_vector_percent");
    expect(flatten(whole.sql)).toContain("nullif(count(*), 0)");
    expect(flatten(whole.sql)).not.toContain("agent_id like");
    // Scoped when the question is about one checkout, and the scope lands before `from memory.memory` rather than after it,
    // which is the kind of mistake a string-concatenated SQL helper makes.
    const scoped = vectorCoverageStatement!({ agentLike: "pi-ed" });
    expect(scoped.values).toEqual(["pi-ed"]);
    expect(flatten(scoped.sql)).toContain("from memory.memory where agent_id like $1");
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
    expect(ownRowCountStatement!("pi-ed").sql).toContain("from memory.memory where agent_id = $1");
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

  it("puts the /memory panel away when asked, twice over", async () => {
    // 2026-11-08, Ed: "it seems to pin a memory state to the bottom of the chat, but then you can't make it go away."
    // Correct, and the reason is a rule about Pi rather than a bug in a line: a widget stays until something clears
    // it, and this extension had no code path that cleared one. So the panel was furniture.
    const { context, ui } = contextFor();
    const command = pi.commands.get("memory")!;

    await command.handler!("", context);
    expect(ui.widgets.get("memory"), "the widget is the output of /memory").toBeTruthy();
    // Running the same command again is the dismiss a user reaches for first, before any subcommand exists.
    await command.handler!("", context);
    expect(ui.widgets.get("memory"), "a panel above the editor that the user cannot dismiss takes the editor's space forever").toBeUndefined();

    await command.handler!("", context);
    expect(ui.widgets.get("memory")).toBeTruthy();
    await command.handler!("off", context);
    expect([...ui.widgets.keys()], "`/memory off` has to actually unregister the widget, not leave it there empty").not.toContain("memory");
  });

  it("gets out of the way when work resumes", async () => {
    // A diagnostic is worth its height only while it is the thing being read. Once a turn starts, a panel above the
    // editor is competing with the work it was describing.
    const { context, ui } = contextFor();
    await pi.commands.get("memory")!.handler!("", context);
    expect(ui.widgets.get("memory")).toBeTruthy();
    await pi.emit("agent_start", { type: "agent_start" }, context);
    expect(ui.widgets.get("memory"), "the panel survived into a new turn, which is how it stopped being a diagnostic").toBeUndefined();
  });

  it("does not need the store to put the panel away", async () => {
    // The dismiss runs before any database work on purpose. A command whose only job is to stop drawing should not be
    // the slowest command in the session, and unreachable-store sessions are exactly where people reach for it.
    const { context, ui } = contextFor();
    const command = pi.commands.get("memory")!;
    await command.handler!("", context);
    const opened = ui.widgets.get("memory") as string[] | undefined;
    expect(opened).toBeTruthy();
    expect(opened!.some((line) => line.includes("127.0.0.1:1/memory-test")), "this test's store is unreachable, and the panel is reporting that").toBe(true);
    const started = Date.now();
    await command.handler!("off", context);
    expect(ui.widgets.get("memory")).toBeUndefined();
    expect(Date.now() - started, "hiding a panel must not wait on a connection").toBeLessThan(250);
  });
});

describe("subject labels", () => {
  it("accepts the three ways a model writes them, and keeps none of the punctuation", async () => {
    const { parseSubjects } = await loadModule();
    expect(parseSubjects!(""), "required export").toEqual([]);
    expect(parseSubjects!("CI Memory Limits \n  Vitest Forks ")).toEqual(["ci memory limits", "vitest forks"]);
    expect(parseSubjects!("ci memory limits, vitest forks")).toEqual(["ci memory limits", "vitest forks"]);
    // The shape that used to reach the store: a JSON array written as a plain string. Splitting that on commas left
    // `["ci memory limits"` as a subject, and 33 of the store's 105 labels were a fragment of that kind.
    const jsonish = parseSubjects!('["ci memory limits", "vitest forks"]');
    expect(jsonish).toEqual(["ci memory limits", "vitest forks"]);
    expect(jsonish.join("|"), "a label with a bracket welded on is one no future search will match").not.toMatch(/[\[\]"]/);
    // "nothing here was worth remembering" is an honest answer, not a subject. Two memories were indexed under `none`.
    expect(parseSubjects!("none")).toEqual([]);
    expect(parseSubjects!("{none}")).toEqual([]);
    expect(parseSubjects!('["{none}"]')).toEqual([]);
    expect(parseSubjects!(undefined)).toEqual([]);
    expect(parseSubjects!(Array.from({ length: 20 }, (_unused, index) => `subject ${index}`)), "eight labels is the ceiling").toHaveLength(8);
  });

  it("keeps the prompt-side footprint a nudge rather than a policy", async () => {
    const pi = await load();
    const search = pi.tools.get("memory_search");
    const dream = pi.tools.get("memory_dream");
    expect(search?.promptGuidelines, "nothing on the prompt side currently motivates a search; this is the lever").toBeTruthy();
    const bullets = [...(search?.promptGuidelines ?? []), ...(dream?.promptGuidelines ?? [])];
    expect(bullets.join(" "), "the ordering this exists to change: web search is the reflex for a question this fleet already answered").toContain("web_search");
    expect(bullets.some((bullet) => /budget/i.test(bullet)), "a nudge with no ceiling is an invitation to wade").toBe(true);
    expect(dream?.promptGuidelines?.length, "the subject index is shaped at the moment the labels are born").toBeGreaterThan(0);
    // The character count is the guard. Two short bullets is a lean inkling; the same idea written earnestly becomes a
    // paragraph per tool, and every agent in the fleet pays for that on every request, forever.
    expect(bullets.join(" ").length, "measured footprint of these bullets, in characters").toBeLessThan(430);
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
