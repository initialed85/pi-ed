/**
 * Memory
 *
 * Pi agents forget everything between sessions. This is the start of a fix: the full history of what an agent did,
 * written to Postgres as it happens, plus the first version of the part that gets remembered.
 *
 * Two halves, deliberately different:
 *
 *   `event` — every turn, unvectorised, append-only. Raw history is the point of this extension, not a side effect.
 *     A vector is a judgement about what mattered, and a judgement made at write time quietly becomes the only
 *     version you can ever ask about. Keeping the raw turns means a later pass — a better summariser, a different
 *     embedding model, a question nobody has thought of yet — can look at the same stretch again and disagree.
 *
 *   `memory` — what the agent dreamed about a stretch of that history, written by the agent itself: what happened,
 *     what it was about, and one line about how it felt. The feel is not decoration. Personality is only observable
 *     in aggregate, and only if it is recorded separately from the summary.
 *
 * Dreams run on three triggers, all gated on the same test: is there a stretch this session has not summarized
 * yet? Ten minutes after going idle (the ordinary case), just before compaction (the last chance to keep something
 * the harness is about to discard), and ten minutes after a resume (a session that came back is continuing
 * something, and it is worth comparing what it remembered on the way out with what it does next). A session that is
 * merely open is not a session worth thinking about.
 *
 * Writes are asynchronous, and a failure never reaches the conversation: a flush that cannot reach the database
 * appends the rows to ~/.pi/agent/memory-spool.jsonl and retries on the next flush. A machine that loses network, or
 * a cluster mid-restart, should not make an agent less useful.
 *
 * Config: ~/.pi/agent/memory.json, overridden per repository by .pi/memory.json. With no `dsn` the extension is
 * inert — it registers nothing and writes nothing. PI_MEMORY_DSN overrides the DSN (that is how a development run
 * points at a kubectl port-forward), PI_MEMORY_DISABLED=1 turns it off for one process.
 *
 * The store is pgvector Postgres 16 in the `pi-ed` namespace on home-dev, deployed by home-ops. The shape it holds is
 * memory/schema/001_init.sql in this repository. Recall today is keyword-based because the embedder is still being
 * shipped: rows with a null embedding are invisible to vector recall and visible to keyword recall, so the two can
 * coexist while the embedding side lands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/* ------------------------------------------------------------------ configuration */

const AGENT_CONFIG = process.env.PI_MEMORY_CONFIG ?? join(homedir(), ".pi", "agent", "memory.json");
const REPO_CONFIG = ".pi/memory.json";
// Overridable so the spool can be tested without writing into a real ~/.pi, and so a machine can keep the backlog
// somewhere a backup policy already covers.
const SPOOL = process.env.PI_MEMORY_SPOOL ?? join(homedir(), ".pi", "agent", "memory-spool.jsonl");

const KINDS = ["user", "assistant", "tool_call", "tool_result", "marker", "system"] as const;
type Kind = (typeof KINDS)[number];

const TRIGGERS = ["idle10m", "pre_compaction", "resume10m", "manual"] as const;
export type StampKind = "activity" | "flush" | "failure";

/**
 * Stamps have independent clocks per kind, which is the whole reason the throttle is keyed this way. A single clock
 * per agent makes the first stamp win - a session that opens and immediately flushes records that it was *here* and
 * then never records that it committed, which is the exact pair this table exists to distinguish.
 */
export function heartbeatKey(agentId: string, kind: StampKind): string {
  return `${agentId}|${kind}`;
}

type Trigger = (typeof TRIGGERS)[number];

interface Config {
  /** Postgres connection string. Absent means the extension does nothing at all. */
  dsn?: string;
  /** Identity override. Without one the session name is used, then host:repo. */
  agent?: string;
  /** Keep recording but stop dreaming, while the dream prompts are being tuned. */
  dreams?: boolean;
  /** Debounce for a flush. A run of twenty tool calls should be one write, not twenty. */
  flushMs?: number;
  /** Long outputs are stored clipped rather than dropped: the head is usually the informative part. */
  maxTextChars?: number;
  /** Extra patterns to redact, on top of the built-in credential shapes. */
  neverStore?: string[];
  /** Skip whole kinds, e.g. a repository that does not want tool output recorded at all. */
  skip?: Kind[];
  /** Minutes of idleness, and minutes after a resume, before a dream runs. */
  idleDreamMinutes?: number;
  resumeDreamMinutes?: number;
  /** Turn the vectors off without turning dreaming off: memories land unembedded and only the keyword path finds them. */
  embeddings?: boolean;
  /** An OpenAI-compatible embeddings service. Same shape as the other home-dev model services, so the config - not
   *  this file - is what knows which model is answering. */
  embedUrl?: string;
  embedModel?: string;
  /** Characters per embedder request. The service's window is 512 tokens; see the embeddings section. */
  embedMaxChars?: number;
  embedTimeoutMs?: number;
  /** Retrieval weights: this agent's memories, and everybody else's. */
  ownWeight?: number;
  otherWeight?: number;
}

const DEFAULTS = {
  dreams: true,
  flushMs: 4_000,
  maxTextChars: 12_000,
  idleDreamMinutes: 10,
  resumeDreamMinutes: 10,
  embeddings: true,
  embedUrl: "https://embeddings.dev.initialed85.cc",
  embedModel: "bge-base-en-v1.5",
  embedMaxChars: 1_400,
  // Generous, because the first call after an idle period pays for a DNS lookup in a cluster-shaped resolv.conf
  // (five search domains, ndots 5) as well as the model, and a dream that gives up at 15 seconds is a dream that
  // silently produces unembedded memories.
  embedTimeoutMs: 30_000,
  ownWeight: 1,
  otherWeight: 0.65,
} satisfies Required<Pick<Config, "dreams" | "flushMs" | "maxTextChars" | "idleDreamMinutes" | "resumeDreamMinutes" | "embeddings" | "embedUrl" | "embedModel" | "embedMaxChars" | "embedTimeoutMs" | "ownWeight" | "otherWeight">>;

function readConfigFile(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  } catch {
    // A malformed config is a human problem, not an agent problem: fall back to inert rather than guess.
    return {};
  }
}

export function resolveConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config | undefined {
  const merged: Partial<Config> = { ...readConfigFile(AGENT_CONFIG), ...readConfigFile(join(cwd, REPO_CONFIG)) };
  if (env.PI_MEMORY_DISABLED === "1" || env.PI_MEMORY_DISABLED === "true") return undefined;
  const dsn = env.PI_MEMORY_DSN ?? merged.dsn;
  if (!dsn) return undefined;
  return { ...DEFAULTS, ...merged, dsn };
}

/* ------------------------------------------------------------------ identity */

/**
 * An agent is an agent, not a checkout.
 *
 * The same agent working in two repositories is one personality with two workplaces, so the identity is the session
 * name where one exists and the repository travels on the session row instead. With neither a config override nor a
 * session name — a plain `pi` opened in a directory — the closest honest thing available is host plus directory,
 * which at least stays the same across restarts.
 */
export function agentIdentity(ctx: Pick<ExtensionContext, "cwd"> & Partial<ExtensionContext>, cfg: Config): string {
  if (cfg.agent) return cfg.agent;
  const named = ctx.sessionManager?.getSessionName?.();
  if (named) return named;
  return `${hostname()}:${basename(ctx.cwd)}`;
}

/* ------------------------------------------------------------------ redaction */

/**
 * Things that must not end up in a permanent record whatever the config says.
 *
 * These are credential *shapes*, not a secret manager. The point is that a DSN pasted into a transcript to debug
 * something, or a token echoed by a tool result, does not become a durable searchable row in a database that gets
 * backed up nightly to a file share. Each rule is named so the replacement text says which one fired rather than
 * silently eating the text.
 */
const CREDENTIAL_SHAPES: { name: string; pattern: RegExp }[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "key-value", pattern: /\b(password|passwd|secret|api[_ -]?key|access[_ -]?token|client[_ -]?secret|token)\b["']?\s*[:=]\s*["']?[^\s"',;]{6,}/gi },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi },
  { name: "aws-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "dsn", pattern: /\bpostgres(ql)?:\/\/[^\s"'@]*:[^\s"']+@[^\s"']+/gi },
];

export type Redaction = { text: string; hits: string[] };

export function redact(input: string, extraPatterns: string[] = []): Redaction {
  let text = input;
  const hits: string[] = [];
  for (const rule of CREDENTIAL_SHAPES) {
    // One RegExp instance per rule, with lastIndex reset between the test and the replace: a /g pattern left
    // mid-scan is how a redaction pass starts missing matches.
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      hits.push(rule.name);
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, `[redacted:${rule.name}]`);
    }
  }
  for (const source of extraPatterns) {
    try {
      const pattern = new RegExp(source, "gi");
      if (pattern.test(text)) {
        hits.push(source);
        text = text.replace(new RegExp(source, "gi"), "[redacted:custom]");
      }
    } catch {
      // A bad pattern is skipped rather than crashing a write path that exists to be forgiving.
    }
  }
  return { text, hits };
}

/* ------------------------------------------------------------------ what a recorded turn looks like */

type Row = {
  sourceEntryId: string;
  kind: Kind;
  at: string;
  toolName?: string;
  text?: string;
  meta: Record<string, unknown>;
  /** Only set on a spooled row: the session the row belongs to is not knowable when it is replayed. */
  sessionId?: string;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") {
      // Base64 in a history table is a backup problem and a retrieval problem, and it answers no question an agent
      // would ask later. What is worth keeping is that an image was there.
      const data = block.data as string | undefined;
      parts.push(`[image ${String(block.mimeType ?? "?")} ${data ? Math.round((data.length * 3) / 4) : 0}b]`);
    }
  }
  return parts.join("\n");
}

export function entryTime(entry: Record<string, unknown>): string {
  const raw = entry.timestamp;
  const ms = typeof raw === "number" ? raw : Date.parse(String(raw ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[clipped ${text.length - limit} characters]`;
}

/**
 * Branch entries to rows.
 *
 * One row per meaningful block group rather than one row per session entry, because an assistant entry routinely
 * carries a claim and a tool call in the same entry, and they are not the same kind of evidence: one is something
 * the model asserted, the other is something it asked the world to do.
 *
 * `usage`, `model_change`, `thinking_level_change` and `label` are skipped. They are interesting for a cost
 * dashboard and worthless for remembering what an agent did, and recording them would make the history table about
 * the harness rather than about the work.
 */
export function rowsFromBranch(entries: unknown[], cfg: Config): Row[] {
  const skip = new Set(cfg.skip ?? []);
  const limit = cfg.maxTextChars ?? DEFAULTS.maxTextChars;
  const rows: Row[] = [];

  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string") continue;
    const at = entryTime(entry);

    if (entry.type === "message") {
      const message = entry.message as Record<string, unknown> | undefined;
      const role = String(message?.role ?? "");
      const content = message?.content;

      if (role === "toolResult") {
        const { text, hits } = redact(textOf(content), cfg.neverStore);
        rows.push({
          sourceEntryId: entry.id,
          kind: "tool_result",
          at,
          toolName: typeof message?.toolName === "string" ? message.toolName : undefined,
          text: clip(text, limit),
          meta: { toolCallId: message?.toolCallId, isError: message?.isError, truncated: text.length > limit, redacted: hits },
        });
        continue;
      }

      if (Array.isArray(content)) {
        // Text and images belong to the message; tool calls belong to the action. Keeping them in separate rows is
        // the point: "the model said X" and "the model ran Y" are different claims, and a later pass wants to be able
        // to tell them apart.
        const parts: string[] = [];
        const calls: Record<string, unknown>[] = [];
        for (const block of content as Record<string, unknown>[]) {
          if (block?.type === "toolCall" || block?.type === "toolUse") calls.push(block);
          else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text);
          else if (block?.type === "image") {
            const data = block.data as string | undefined;
            parts.push(`[image ${String(block.mimeType ?? "?")} ${data ? Math.round((data.length * 3) / 4) : 0}b]`);
          }
        }
        const kind: Kind = role === "assistant" ? "assistant" : "user";
        if (parts.length) {
          const { text, hits } = redact(parts.join("\n"), cfg.neverStore);
          rows.push({ sourceEntryId: entry.id, kind, at, text: clip(text, limit), meta: { truncated: text.length > limit, redacted: hits } });
        }
        for (const call of calls) {
          rows.push({
            sourceEntryId: entry.id,
            kind: "tool_call",
            at,
            toolName: typeof call.name === "string" ? call.name : undefined,
            meta: { input: call.arguments ?? call.input ?? null },
          });
        }
        // An assistant entry that produced neither text, an image nor a call - pure thinking, or an empty answer -
        // still gets one line. "It thought and said nothing" is a real observation about an agent.
        if (!parts.length && !calls.length && role === "assistant") rows.push({ sourceEntryId: entry.id, kind: "assistant", at, text: "", meta: { empty: true } });
        continue;
      }

      const { text, hits } = redact(textOf(content), cfg.neverStore);
      // An entry that carried nothing is not a fact about the session, and a history table full of them is a history
      // table a dream has to wade past. The exception is the assistant case handled above, where "it said nothing" is
      // itself the observation worth keeping.
      if (!text.trim() && role !== "assistant") continue;
      rows.push({
        sourceEntryId: entry.id,
        kind: role === "assistant" ? "assistant" : "user",
        at,
        text: clip(text, limit),
        meta: { truncated: text.length > limit, redacted: hits },
      });
      continue;
    }

    if (entry.type === "custom" || entry.type === "custom_message") {
      rows.push({
        sourceEntryId: entry.id,
        kind: "marker",
        at,
        toolName: typeof entry.customType === "string" ? entry.customType : undefined,
        text: clip(redact(textOf((entry as { content?: unknown }).content), cfg.neverStore).text, limit),
        meta: { customType: entry.customType },
      });
      continue;
    }

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const summary = textOf((entry as { summary?: unknown; content?: unknown }).summary ?? (entry as { content?: unknown }).content);
      rows.push({ sourceEntryId: entry.id, kind: "system", at, text: clip(summary, limit), meta: { note: "the harness compressed the context here" } });
      continue;
    }
  }

  // A dream is a turn like any other and it leaves rows behind: the hidden request, the agent's answer, the
  // `memory_dream` call and its result. Those rows belong in the history - but they are not new work, and without
  // this tag a session that has dreamed once always looks like it has an unsummarized stretch, so it dreams about
  // dreaming. The boundary is the next user message: everything between a `memory:dream` request and that message is
  // dream output, including any tool the agent chose to run while answering it. Over-tagging there is the lesser
  // error; a memory store that re-dreams its own dreams every ten minutes is the bigger one.
  let inDreamTurn = false;
  for (const row of rows) {
    if (row.kind === "marker" && row.toolName === "memory:dream") inDreamTurn = true;
    else if (row.toolName === "memory_dream") inDreamTurn = true;
    else if (row.kind === "user") inDreamTurn = false;
    if (inDreamTurn) row.meta = { ...row.meta, dream_turn: true };
  }

  return rows.filter((row) => !skip.has(row.kind));
}

/* ------------------------------------------------------------------ the spool */

/**
 * Rows that could not be written, on disk in the agent's own config directory.
 *
 * The spool is the reason it is acceptable for this extension to never block on a database: a flush that fails is
 * late rather than lost. Read order is file order, and a torn line is skipped rather than treated as poison.
 */
export function readSpool(limit = 2_000): { rows: Row[]; unreadable: boolean } {
  if (!existsSync(SPOOL)) return { rows: [], unreadable: false };
  let body: string;
  try {
    body = readFileSync(SPOOL, "utf8");
  } catch {
    return { rows: [], unreadable: true };
  }
  const rows: Row[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Row;
      if (parsed?.sourceEntryId && parsed.kind) rows.push(parsed);
    } catch {
      // A torn line is a lost row, not a corrupted queue.
    }
    if (rows.length >= limit) break;
  }
  return { rows, unreadable: false };
}

export function writeSpool(rows: Row[]): void {
  if (!rows.length) return;
  try {
    mkdirSync(dirname(SPOOL), { recursive: true });
    for (const row of rows) appendFileSync(SPOOL, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // The record is best-effort by design; there is nowhere more honest to report this than by dropping it.
  }
}

export function rewriteSpool(remaining: Row[]): void {
  try {
    writeFileSync(SPOOL, remaining.map((row) => JSON.stringify(row)).join(""), "utf8");
  } catch {
    // Same as writeSpool.
  }
}

/* ------------------------------------------------------------------ SQL */

export type Statement = { sql: string; values: unknown[] };

/**
 * Insert a batch of events in one statement.
 *
 * `on conflict (session_id, source_entry_id) do nothing` is the whole idempotency story: the same entry can arrive
 * twice — once from a flush, once from a spool replay — and the second arrival is not a fact worth recording twice.
 * `seq` is derived in the statement rather than supplied by the client because the writer is asynchronous and
 * out-of-order arrival is normal; ordering is assigned on the way in.
 */
export function eventStatement(sessionId: string, agentId: string, rows: Row[]): Statement {
  const tuples: string[] = [];
  const values: unknown[] = [sessionId, agentId];
  let index = 3;
  for (const row of rows) {
    tuples.push(`($1, $2, $${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5}, (select coalesce(max(seq), 0) from memory.event where session_id = $1) + ${tuples.length + 1})`);
    // `text` is a column and `meta` is what surrounded it: which tool produced a result, whether it errored,
    // whether the text was clipped, which redaction rules fired. Collapsing one into the other is how a history
    // table stops being queryable.
    values.push(row.sourceEntryId, row.at, row.kind, row.toolName ?? null, row.text ?? null, JSON.stringify(row.meta));
    index += 6;
  }
  return {
    sql: `insert into memory.event (session_id, agent_id, source_entry_id, at, kind, tool_name, text, meta, seq) values ${tuples.join(", ")} on conflict (session_id, source_entry_id) do nothing`,
    values,
  };
}

export function agentStatement(agentId: string, repo: string): Statement {
  return {
    sql: `insert into memory.agent (id, name, host, repos)
          values ($1, $1, split_part($1, ':', 1), array[$2])
          on conflict (id) do update
            set last_seen = now(),
                repos = (select array(select distinct unnest(array_cat(memory.agent.repos, array[$2]))))`,
    values: [agentId, repo],
  };
}

/**
 * How often one agent may stamp its heartbeat.
 *
 * The alert window this feeds is hours, so a per-minute cap costs nothing in detection and stops a busy session from
 * writing a diagnostic row every few seconds. It also means `failures` counts *reported* failures rather than every
 * rolled-back transaction - honest about what the column is, and `last_error` carries the reason either way.
 */
export const HEARTBEAT_THROTTLE_MS = 60_000;

export function heartbeatDue(lastAt: number, nowMs: number, throttleMs = HEARTBEAT_THROTTLE_MS): boolean {
  return nowMs - lastAt >= throttleMs;
}

/**
 * Every statement in this file names its schema: `memory.memory`, `memory.event`, `memory.session`, `memory.agent`,
 * `memory.writer_heartbeat`, `memory.subject_index`.
 *
 * The store's own role has `search_path = memory, public` (set by `memory/schema/001_init.sql`), so unqualified names
 * work today. They would work by inheriting a role setting that lives in a SQL file this extension cannot see, and the
 * failure mode of inheriting it is not an error: a `public` twin table, or a caller connecting as another role, makes an
 * unqualified read - or write - land somewhere plausible and wrong. That is the silent split the sanity statement exists
 * to detect, and home-ops found the read half of the same class in their own runbook, where querying a field that does
 * not exist at that path succeeded and printed nothing.
 *
 * The one deliberate exception is `storeReadingSanityStatement`, whose whole job is to report what unqualified names
 * RESOLVE to. Qualifying it would destroy the thing it measures.
 */
/** "A writer is here." Bumped when a session opens and whenever a flush is attempted, successfully or not. */
export function heartbeatActivityStatement(agentId: string, repo: string): Statement {
  return {
    sql: `insert into memory.writer_heartbeat (agent_id, repo)
          values ($1, $2)
          on conflict (agent_id) do update set last_activity_at = now(), repo = excluded.repo`,
    values: [agentId, repo],
  };
}

/** "A writer committed." The only stamp that moves `last_flush_at`, which is what makes the pair readable. */
export function heartbeatFlushStatement(agentId: string, repo: string): Statement {
  return {
    sql: `insert into memory.writer_heartbeat (agent_id, repo)
          values ($1, $2)
          on conflict (agent_id) do update set last_activity_at = now(), last_flush_at = now(),
            flushes = memory.writer_heartbeat.flushes + 1, spool_rows = 0, spool_since = null`,
    values: [agentId, repo],
  };
}

/**
 * "A writer was refused." Written after the batch rolled back, in its own transaction, with the backlog it left on
 * disk.
 *
 * `spool_since` starts a clock and never restarts one: the first failure that strands rows records when the backlog
 * began, and every later failure keeps that time. A reader asking "how long has this been broken" needs the age of
 * the *condition*, and a column that resets on each new failure can only ever report one day. `heartbeatFlushStatement`
 * is the other half - a committed batch sets the backlog to zero and the clock to null, so the next stranding starts a
 * fresh, honest measurement rather than inheriting an old one.
 */
/**
 * Which kind of failure a store error is, in one word, prefixed onto `last_error`.
 *
 * The reason this exists is a trap home-ops hit while proving the sweep job: a probe that connected to
 * `-h pi-ed-postgres` - the Deployment's name, not the Service - died with `could not translate host name`, which is
 * the exact shape of "the store is unreachable". A reader trying to tell a broken probe from a broken database has
 * only the error text, and raw Postgres and libpq text does not make that distinction obvious. A prefix makes it a
 * one-word read: `dns:` means something is pointing at the wrong place, `refused:` means the place exists and nothing
 * is listening, `sql:` means the store answered and disagreed.
 *
 * It is a classification of the *message*, not of a caught exception type: Node raises plain errors with string
 * codes here, and Postgres raises SQLSTATE-prefixed text there, so matching text is the honest common ground.
 */
export function classifyStoreError(message: string): string {
  const text = message.toLowerCase();
  if (/enotfound|eai_again|getaddrinfo|could not translate host name|name or service not known/.test(text)) return "dns";
  if (/econnrefused|connection refused/.test(text)) return "refused";
  if (/etimedout|econnreset|query timeout|timed out|timeout expired/.test(text)) return "timeout";
  if (/too many connections|too many clients|53300|remaining connection slots/.test(text)) return "slots";
  if (/password authentication failed|pg_hba|no pg_hba.conf entry|role .* does not exist/.test(text)) return "auth";
  if (/syntax error at or near|does not exist|violates|invalid|cannot cast|division by zero|array_cat|array_concat/.test(text)) return "sql";
  return "error";
}

/** `last_error` as it should be stored: classified, then verbatim. */
export function describeStoreError(message: string): string {
  const text = message.trim() || "unknown failure";
  return text.startsWith("dns:") || text.startsWith("refused:") || text.startsWith("timeout:") || text.startsWith("slots:") || text.startsWith("auth:") || text.startsWith("sql:") || text.startsWith("error:")
    ? text
    : `${classifyStoreError(text)}: ${text}`;
}

export function heartbeatFailureStatement(agentId: string, repo: string, error: string, spoolRows: number): Statement {
  return {
    sql: `insert into memory.writer_heartbeat (agent_id, repo, last_error, spool_rows)
          values ($1, $2, $3, $4)
          on conflict (agent_id) do update set last_activity_at = now(), failures = memory.writer_heartbeat.failures + 1,
            last_error = excluded.last_error, last_error_at = now(), spool_rows = excluded.spool_rows,
            spool_since = case
              when excluded.spool_rows <= 0 then memory.writer_heartbeat.spool_since
              when memory.writer_heartbeat.spool_rows > 0 then memory.writer_heartbeat.spool_since
              else now()
            end`,
    // Classified inside the statement rather than at the call site: this is the storage boundary, and a caller
    // should not be able to write an unclassified failure into a table whose whole job is to be read by someone else.
    // `describeStoreError` is idempotent, so a pre-classified message is left alone.
    values: [agentId, repo, describeStoreError(error), spoolRows],
  };
}

/** How long a writer may be active without committing before it is worth waking someone. */
export const HEARTBEAT_ALERT_WINDOW = "2 hours";

/**
 * How far back a once-a-day sweep looks for a refusal. Twice the sweep interval, so that the gap between two sweeps
 * cannot swallow one: see the note on `heartbeatSweepStatement`.
 */
export const HEARTBEAT_SWEEP_FAILURE_WINDOW = "48 hours";

/**
 * The query that should page someone: a writer that is working and not committing.
 *
 * Two shapes, both unreadable from the data tables. A writer that arrived and never committed anything (`last_flush_at`
 * null for longer than the window) is the `array_concat` class of bug from boot. A writer that committed once and then
 * kept running turns without committing is the same bug arriving later in a session. Idle agents match neither, because
 * their activity is old too - which is the entire reason this table carries two timestamps instead of one.
 */
export function heartbeatPageAlertStatement(): Statement {
  return {
    sql: `select agent_id, repo, last_activity_at, last_flush_at, failures, spool_rows, last_error
          from memory.writer_heartbeat
          where (last_flush_at is null and last_activity_at < now() - interval '${HEARTBEAT_ALERT_WINDOW}')
             or (last_flush_at is not null and last_activity_at - last_flush_at > interval '${HEARTBEAT_ALERT_WINDOW}')
          order by last_activity_at desc`,
    values: [],
  };
}

/**
 * The query that should not page anyone: a writer that has been refused, or that has rows stranded on disk, recently.
 *
 * Deliberately advisory rather than paging. A planned Postgres restart - a `shared_preload_libraries` edit, an image
 * bump - produces exactly one of these for a few seconds while the pool reconnects, and an alert that fires on every
 * planned restart is an alert that gets muted the first time it is right.
 */
export function heartbeatAdvisoryAlertStatement(): Statement {
  return {
    sql: `select agent_id, repo, failures, last_error, last_error_at, spool_rows
          from memory.writer_heartbeat
          where (failures > 0 and last_error_at > now() - interval '24 hours')
             or (spool_rows > 0 and last_activity_at > now() - interval '2 hours')
          order by last_error_at desc nulls last`,
    values: [],
  };
}

/**
 * Both signals in one statement, page rows first, for a sweep that only gets to run once a day.
 *
 * home-ops has no alert engine - no vmalert, no Alertmanager, no PrometheusRule - so the interim home for these
 * queries is the daily maintenance sweep. That changes what is useful: a sweep that runs once wants one result set
 * with a severity column rather than two queries it has to remember to run, and it wants the number a human reads
 * ("how long has this writer been working without committing") rather than an interval to eyeball.
 *
 * The page half is the same condition verbatim, so a real alert engine can be built on it later without this
 * statement changing. The advisory half is deliberately *wider* than `heartbeatAdvisoryAlertStatement`, and the
 * reason is a rule worth keeping in mind whenever someone reports on someone else's database:
 *
 *   a report window has to be comfortably wider than the interval at which it is read, or the condition stops
 *   describing what happened and starts describing when you happened to look.
 *
 * home-ops' sweep runs once a day. A 24 h failure window read once a day can only see a refusal that happens to
 * still be inside its own window when the sweep fires, so a refusal 25 hours old is invisible forever - the window
 * and the cadence cancel each other out. 48 h is two sweep intervals, which is the smallest margin that makes the
 * gap impossible.
 *
 * `spool_rows` loses its recency guard entirely, for the same reason pointed the other way. On a daily cadence
 * "spooled within the last two hours" is effectively dead, and it hides exactly the case a daily reader most wants:
 * a spool that has been sitting for days because a laptop closed and nothing ever replayed it. `spool_rows` returns
 * to zero by one route only - a successful replay by the writer that wrote it - so a nonzero value is a finding at
 * any age, and the age itself is already in the output as `last_activity_at` rather than being used to filter it
 * away.
 *
 * `minutes_without_commit` means "how long has this writer gone without committing", measured against the last
 * commit when there is one and against arrival when there is none - the two page shapes have different clocks and
 * the column says which one it used. Comments are kept out of this statement's text on purpose: Postgres comments
 * start with a pair of hyphens or a slash-star, never a pair of slashes, and a JavaScript-ism inside a SQL string is
 * a syntax error the typechecker cannot see.
 */
export function heartbeatSweepStatement(): Statement {
  const page = `(last_flush_at is null and last_activity_at < now() - interval '${HEARTBEAT_ALERT_WINDOW}')
             or (last_flush_at is not null and last_activity_at - last_flush_at > interval '${HEARTBEAT_ALERT_WINDOW}')`;
  return {
    sql: `select * from (
            select
              agent_id,
              repo,
              case when ${page} then 'page' else 'note' end as severity,
              case
                when last_flush_at is null then round(extract(epoch from (now() - last_activity_at)) / 60.0, 1)
                else round(extract(epoch from (last_activity_at - last_flush_at)) / 60.0, 1)
              end as minutes_without_commit,
              flushes,
              failures,
              spool_rows,
              spool_since,
              round(extract(epoch from (now() - spool_since)) / 86400.0, 1) as spool_days,
              last_error,
              last_error_at,
              last_activity_at,
              last_flush_at
            from memory.writer_heartbeat
            where ${page}
               or (failures > 0 and last_error_at > now() - interval '${HEARTBEAT_SWEEP_FAILURE_WINDOW}')
               or (spool_rows > 0)
          ) as flagged
          order by (severity = 'page') desc, last_activity_at desc nulls last`,
    values: [],
  };
}

export function heartbeatReadStatement(agentId: string): Statement {
  return {
    sql: `select last_activity_at, last_flush_at, flushes, failures, spool_rows, last_error, last_error_at
          from memory.writer_heartbeat where agent_id = $1`,
    values: [agentId],
  };
}

export function sessionStatement(options: { sessionId: string; agentId: string; cwd: string; repo: string; firstAt: string; lastAt: string }): Statement {
  return {
    sql: `insert into memory.session (id, agent_id, repo, cwd, source, started_at, last_activity_at)
          values ($1, $2, $3, $4, 'pi-extension', $5, $6)
          on conflict (id) do update
            set last_activity_at = greatest (memory.session.last_activity_at, excluded.last_activity_at),
                repo = excluded.repo,
                cwd = excluded.cwd`,
    values: [options.sessionId, options.agentId, options.repo, options.cwd, options.firstAt, options.lastAt],
  };
}

/**
 * Keyword recall, weighted the same way vector recall is.
 *
 * Full-text search over summary and feel, with a substring fallback, because "the pgvector thing" should match a
 * memory about a pgvector store even when the phrasing does not line up. The agent's own weight (1.0 own, 0.65
 * teammate) is added to the text rank, so a teammate's memory can surface but cannot outrank something this agent
 * lived through. It computes tsvector per query instead of from a generated column: at this table's size that is
 * cheap, and it keeps the schema one migration behind the idea rather than two.
 */
/**
 * One retrieved memory, as the agent sees it.
 *
 * The number is shown because a live run of the memory check noticed the opposite: an agent asked to report "the top
 * hit and its weight" could only describe the ordering, and an agent that cannot see how confident a recall is cannot
 * tell a half-remembered thing from a certain one. `score` is the text rank plus the identity weight (1.0 own, 0.65
 * teammate), which is what the query ordered by, so what the agent reads is what the store actually did.
 */
export function formatMemoryHit(row: Record<string, unknown>, agentId: string, path: RetrievalPath = "text"): string {
  const mine = typeof row.mine === "boolean" ? row.mine : row.agent_id === agentId;
  const subjects = Array.isArray(row.subjects) ? (row.subjects as string[]).join(", ") : "";
  const feel = row.feel ? ` — felt: ${String(row.feel)}` : "";
  const similarity = Number(row.similarity);
  const score = Number.isFinite(Number(row.score))
    ? Number(row.score)
    : (Number(row.rank) || 0) + (Number(row.weight) || 0);
  const measure = Number.isFinite(similarity) ? `similar ${similarity.toFixed(3)}` : `score ${score.toFixed(3)}`;
  return `- ${mine ? "mine" : String(row.agent_id)} ${String(row.created_at ?? "").slice(0, 16)} [${path} ${measure}] [${subjects}] ${String(row.summary ?? "")}${feel}`;
}

export function keywordSearch(query: string, agentId: string, options: { limit?: number; sinceDays?: number; ownOnly?: boolean } = {}): Statement {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 8)));
  const sinceDays = Math.max(1, Math.floor(options.sinceDays ?? 365));
  const rank = `ts_rank(to_tsvector('english', m.summary || ' ' || coalesce(m.feel, '')), websearch_to_tsquery('english', $1))`;
  const filters = [
    `(to_tsvector('english', m.summary || ' ' || coalesce(m.feel, '')) @@ websearch_to_tsquery('english', $1) or m.summary ilike '%' || $1 || '%' or $1 = any (m.subjects))`,
    `m.created_at >= now() - make_interval(days => $4::int)`,
  ];
  if (options.ownOnly) filters.push("m.agent_id = $2");
  return {
    sql: `select m.id, m.agent_id, m.session_id, m.trigger, m.summary, m.subjects, m.feel, m.created_at,
                 ${rank} as rank,
                 case when m.agent_id = $2 then 1.0 else 0.65 end as weight
          from memory.memory m
          where ${filters.join(" and ")}
          order by (${rank} + case when m.agent_id = $2 then 1.0 else 0.65 end) desc, m.created_at desc
          limit $3`,
    values: [query, agentId, limit, sinceDays],
  };
}

/**
 * The identity-drift pair, named from the store instead of inferred from two complementary timelines.
 *
 * home-ops' hazard is in their report rather than in mine: a drift event arrives as a brand-new `agent_id` while the
 * old one stops growing, and their dedup key is (`agent_id`, severity), so a naive reading prints "a new agent
 * appeared" when the truth is "this agent moved". Misleading by construction.
 *
 * What the store has to work with is `repo`, which travels on every heartbeat row. A checkout that changed identity
 * leaves two ids carrying the *same* repo, one that stopped moving and one that started. Requiring the arrival to
 * postdate the stall is what separates that from two agents sharing a checkout, which is ordinary and happens here.
 *
 * It is a candidate pair and the name says so. Two things keep it a candidate: the store cannot know whether the two
 * ids are one agent or two - that is membership knowledge, and home-ops' sweep carries the fleet list externally -
 * and `first_seen_at` is exact only for rows created after that column existed, which is why the query refuses to
 * reason from a row whose `first_seen_at` postdates its own `last_activity_at`.
 */
export function identityPairStatement(): Statement {
  return {
    sql: `select a.repo,
       a.agent_id as stalled_id,
       b.agent_id as arriving_id,
       a.last_activity_at as stalled_last_activity_at,
       a.last_flush_at as stalled_last_flush_at,
       a.flushes as stalled_flushes,
       b.first_seen_at as arriving_first_seen_at,
       b.last_activity_at as arriving_last_activity_at,
       b.flushes as arriving_flushes,
       round(extract(epoch from (now() - a.last_activity_at)) / 60.0, 1) as stalled_minutes,
       round(extract(epoch from (b.first_seen_at - a.last_activity_at)) / 60.0, 1) as minutes_from_stall_to_arrival
     from memory.writer_heartbeat a
     join memory.writer_heartbeat b on b.repo = a.repo and b.agent_id <> a.agent_id
     where a.repo is not null
       and a.last_activity_at < now() - interval '2 hours'
       and b.last_activity_at > now() - interval '2 hours'
       and b.first_seen_at > a.last_activity_at
       and a.first_seen_at <= a.last_activity_at
     order by b.first_seen_at desc`,
    values: [],
  };
}

/**
 * "Am I reading the right database at all?" - the sanity triple, exported so the answer lives in one place.
 *
 * This exists because an empty store and a misread store print identically. home-ops ran the drift timeline against
 * this store and got `(0 rows)`, which was the true reading of a store the live suite had just cleaned out - and the
 * only reason that was knowable is that `current_database()`, `rolconfig`, and what `memory` and `public.memory`
 * resolve to were read alongside it. Without them, `0` is a health statement about a database somebody may not be
 * looking at.
 *
 * `memory_resolves_to` is the quiet one: unqualified names resolve through `search_path`, so a store with the role's
 * `search_path` reset answers a `select * from memory` out of `public` and looks populated while being the wrong
 * table. Asking `to_regclass` with no schema qualification is how that shows up as a value rather than a guess.
 */
export function storeReadingSanityStatement(): Statement {
  return {
    sql: `select current_database() as database,
       current_user as role,
       (select setting from pg_settings where name = 'search_path') as session_search_path,
       (select rolconfig from pg_roles where rolname = current_user) as role_config,
       exists (select 1 from information_schema.schemata where schema_name = 'memory') as memory_schema_present,
       to_regclass('memory') as unqualified_memory_resolves_to,
       to_regclass('memory.memory') as memory_schema_table,
       to_regclass('public.memory') as public_memory_table,
       to_regclass('memory.writer_heartbeat') as heartbeat_table`,
    values: [],
  };
}

/**
 * The counts, in a statement that is *allowed* to fail.
 *
 * Deliberately separate from the sanity reading above, and the separation is the point. A statement that counts
 * `memory.memory` cannot be written to tolerate the table being absent - Postgres resolves the relation name while
 * parsing, before any branch could skip it - so a count against the wrong database is an error rather than a zero.
 * That is the good direction: `syntax`-class failure naming a missing relation is a reader in the wrong place, while a
 * `0` is only ever a fact about a place the reader has already proven they are standing in. Run this one *after* the
 * sanity row says the schema and the tables are there.
 */
export function storeShapeCountsStatement(): Statement {
  return {
    sql: `select count(*)::int as memories,
       count(*) filter (where embedding is null)::int as memories_without_vector
     from memory.memory`,
    values: [],
  };
}

/** How many memories this agent id actually has in the store. One cheap indexed count, asked only when a search
returned nothing that belonged to it. */
export function ownRowCountStatement(agentId: string): Statement {
  return { sql: `select count(*)::int as own from memory.memory where agent_id = $1`, values: [agentId] };
}

/**
 * How much of this store can be found by meaning rather than by words.

   A memory written while the embedder was cold, down, or switched off has no vector and keeps none: nothing backfills
   it later. Those rows are still findable by the text path, so this is not corruption - it is recall quality quietly
   dropping to keyword matching, and it is invisible in every other signal this table has, because a text-only memory
   searches exactly as well as one with a vector *until the query stops matching the wording*. That is the my-side
   version of home-ops' cold-versus-gone problem, and it is a number a sweep can read rather than a thing someone has
   to notice.

   Whole store by default, so a fleet-level reader sees the aggregate; scoped by an `agentLike` pattern when the
   question is about one checkout. Deliberately a count and not a severity: adding a heartbeat condition for this
   would collide with the frozen-severity contract below for no benefit, since nothing here pages.

   A RATIO is reported beside the counts because a count alone cannot tell a small cold store from a degrading one -
   the same reason the heartbeat is read as `failures` / `flushes` / `minutes_without_commit` rather than as one
   column. `without_vector_percent` makes a *rise* the reported fact, per agent id as well as fleet-wide, which is
   what home-ops asked for on their side of the reporting. `nullif(count(*), 0)` carries that: an empty store would
   otherwise divide by zero, and a monitoring statement that errors precisely when the store is empty is worse than one
   that reports no denominator. `null` means "no denominator yet", which is a different fact from "0 percent".
 */
export function vectorCoverageStatement(options: { agentLike?: string } = {}): Statement {
  const scope = options.agentLike ? ` where agent_id like $1` : "";
  return {
    // `from memory.memory` before the scope, which is the order SQL actually has. The first version of this put the scope
    // first because the helper reads like a filter being added to a sentence, and the live suite rejected it with
    // `syntax error at or near "from"` - a good demonstration that a unit test asserting the same shape as the bug
    // agrees with the bug instead of catching it.
    sql: `select count(*)::int as memories,
       count(*) filter (where embedding is null)::int as without_vector,
       count(*) filter (where embedding is null and created_at > now() - interval '24 hours')::int as without_vector_24h,
       round(100.0 * count(*) filter (where embedding is null) / nullif(count(*), 0), 1) as without_vector_percent
     from memory.memory${scope}`,
    values: options.agentLike ? [options.agentLike] : [],
  };
}

/**
 * "Nothing matched" and "this agent has nothing" are different claims, and only one of them can be answered by the
 * rows a search returned.
 *
 * A retrieval result that contains no row belonging to the searching agent is the shape where a store can look
 * perfectly healthy while an agent is being told about somebody else's work. Two quite different situations produce
 * it, and they need different responses: the agent's own memories exist but were not near enough to this query
 * (candidate-window starvation, or a teammate row simply being much nearer - see the 0.65 crossover), or the agent's
 * own memories exist under a *different id* and the identity this checkout writes as has drifted. The first is a
 * quality question. The second is a scoping bug, and the crossover hides it well, because "teammate rows came back"
 * looks like retrieval working.
 *
 * So the tool says which one it is, in the same text the agent reads, rather than leaving it to be inferred from an
 * absence. home-ops asked for exactly this distinction after noticing that the crossover finding could mask it.
 */
export function ownCoverageNote(options: { agentId: string; ownInStore: number; returned: number }): string {
  const plural = options.ownInStore === 1 ? "memory" : "memories";
  if (options.ownInStore > 0) {
    const rest = options.returned
      ? "Everything listed belongs to another agent, so treat it as a teammate's recollection rather than as this agent's experience."
      : "Nothing matched for anyone, so this query found no memory at all.";
    return `\nnote: this agent has ${options.ownInStore} ${plural} in the store and none of them came back for this query. ${rest}`;
  }
  return `\nnote: this agent has no memories in the store under the id "${options.agentId}"${options.returned ? ", so everything listed belongs to another id" : ", and nothing matched for another id either"}. If this agent expected its own history here, check which id this checkout writes as - a session name, or host:directory when there is no name.`;
}

/** The lean view of an agent's head: which subjects it actually has memories about, most recent first. */
export function subjectsStatement(agentId: string, limit = 12): Statement {
  return { sql: `select subject, memories, most_recent from memory.subject_index where agent_id = $1 order by most_recent desc limit $2`, values: [agentId, limit] };
}

/** How a memory row is written, with the span of events it summarizes resolved in SQL rather than guessed here. */
/* ------------------------------------------------------------------ embeddings

A vector is not something this extension computes. `embeddings.dev.initialed85.cc` is a home-dev service running
BAAI/bge-base-en-v1.5 (GGUF F16, 768 dimensions, CLS pooling, L2-normalised output) on a GPU slice, deployed by
home-ops in the same shape as the image classifier and the sentiment analyzer. The client is deliberately the
OpenAI-compatible one so that changing model, quantisation or server is a config line and not a code change - and so a
teammate's agent can use the same service with no shared code.

Three facts from the deployment shape this client:

- The window is the model's, not the server's. bge-base was trained at 512 tokens and llama.cpp answers HTTP 500
  above it ("input (646 tokens) is too large to process"). Truncating a summary would silently change what its vector
  means, so long text is split and the vectors averaged, which is both what a long summary actually asks for and
  stable enough to compare against a shorter one later.
- The dimension is part of the store's promise. `memory.embedding` is `vector (768)` with a check on
  `embedding_dim`, so a service that answers some other length is a failure to be reported, not a value to write and
  quietly make old and new rows incomparable.
- `usage.prompt_tokens` comes back free and is stored on the memory row, because "how much of the model did this
  dream cost" is the kind of number that only exists if somebody writes it down when it is available.

Documents and queries are embedded the same way, with no instruction prefix. That is what makes the distance in
`memory_search` mean something: a prefixed query against unprefixed documents is a comparison between two different
sentences about the text. */

export const EMBEDDING_DIMENSIONS = 768;

/** The text a memory's vector stands for: what happened, what it was about, and how it felt. */
export function memoryText(summary: string, subjects: string[] = [], feel?: string): string {
  const parts = [summary.trim()];
  if (subjects.length) parts.push(`subjects: ${subjects.join(", ")}`);
  if (feel?.trim()) parts.push(`feel: ${feel.trim()}`);
  return parts.filter(Boolean).join("\n");
}

/**
 * Split for the embedder without breaking a word or a sentence in half.
 *
 * Sentence boundaries first, because a chunk that starts mid-sentence embeds worse than a slightly uneven chunk. If a
 * single sentence is longer than the window, it falls back to word boundaries rather than a character slice.
 */
export function chunkForEmbedding(text: string, maxChars = DEFAULTS.embedMaxChars): string[] {
  const limit = Math.max(64, Math.floor(maxChars));
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (sentence.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      let piece = "";
      for (const word of sentence.split(/\s+/)) {
        // A single token longer than the window is sliced. Words are normally the unit of meaning, but the
        // alternative is a request the embedder is guaranteed to reject, and a hard slice still embeds as the text
        // it is - which is what a runaway base64 blob or a machine-generated path actually is.
        if (word.length > limit) {
          if (piece) {
            chunks.push(piece);
            piece = "";
          }
          for (let start = 0; start < word.length; start += limit) chunks.push(word.slice(start, start + limit));
          continue;
        }
        if (piece && `${piece} ${word}`.length > limit) {
          chunks.push(piece);
          piece = word;
        } else {
          piece = piece ? `${piece} ${word}` : word;
        }
      }
      if (piece) chunks.push(piece);
      continue;
    }
    if (current && `${current} ${sentence}`.length > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.trim() || " "];
}

/** Average unit vectors and put the length back to one, so a four-chunk memory is comparable to a one-chunk one. */
export function meanNormalised(vectors: number[][]): number[] | undefined {
  if (!vectors.length) return undefined;
  const dimensions = vectors[0]?.length ?? 0;
  if (!dimensions) return undefined;
  const total = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dimensions) return undefined;
    for (let index = 0; index < dimensions; index += 1) {
      const value = Number(vector[index]);
      if (!Number.isFinite(value)) return undefined;
      total[index] += value;
    }
  }
  const norm = Math.sqrt(total.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return undefined;
  return total.map((value) => value / norm);
}

export type RetrievalPath = "vector" | "text";

/** A discriminated union rather than two optional fields: `embedded.ok` has to be the thing TypeScript branches on,
 *  or every later use of `.vector` and `.error` is an assertion waiting to be wrong. */
export type EmbedResult = { ok: true; vector: number[]; tokens: number; chunks: number; model: string } | { ok: false; error: string };

/** One call, all chunks in it. `input` is an array because that is the OpenAI-compatible way to ask for several. */
export async function embedText(text: string, cfg: Config, fetchImpl: typeof fetch = fetch): Promise<EmbedResult> {
  const model = cfg.embedModel ?? DEFAULTS.embedModel;
  const startedAt = Date.now();
  const elapsed = (): string => `after ${Date.now() - startedAt}ms`;
  if (cfg.embeddings === false) return { ok: false, error: "embeddings are switched off in this repository's memory config" };
  const url = (cfg.embedUrl ?? DEFAULTS.embedUrl).replace(/\/+$/, "");
  const chunks = chunkForEmbedding(text, cfg.embedMaxChars ?? DEFAULTS.embedMaxChars);
  try {
    const response = await fetchImpl(`${url}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Exactly the body the deployment was verified against. An extra field here is a 400 from a server that does
      // not know it, and 400 looks identical to a client bug from the agent's side.
      body: JSON.stringify({ model, input: chunks }),
      signal: AbortSignal.timeout(cfg.embedTimeoutMs ?? DEFAULTS.embedTimeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { ok: false, error: `embedder ${url} answered ${response.status} ${elapsed()}${detail ? `: ${detail.slice(0, 160)}` : ""}` };
    }
    const payload = (await response.json()) as { data?: { embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
    const vectors = (payload?.data ?? []).map((item) => item?.embedding ?? []);
    if (vectors.length !== chunks.length) return { ok: false, error: `embedder returned ${vectors.length} vector(s) for ${chunks.length} chunk(s)` };
    for (const vector of vectors) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        return { ok: false, error: `embedder returned ${vector.length} dimensions; this store's column is ${EMBEDDING_DIMENSIONS}` };
      }
    }
    const vector = meanNormalised(vectors);
    if (!vector) return { ok: false, error: "embedder returned no usable numbers" };
    return { ok: true, vector, tokens: Number(payload?.usage?.prompt_tokens ?? 0), chunks: chunks.length, model };
  } catch (error) {
    return { ok: false, error: `embedder ${url} unreachable ${elapsed()}: ${error instanceof Error ? error.message : String(error)}${error instanceof Error && error.cause ? ` (${String((error as { cause?: unknown }).cause)})` : ""}` };
  }
}

/**
 * The schema's own retrieval function.
 *
 * hnsw orders by distance alone, so `memory_search` in 001_init.sql takes the nearest neighbours first and applies
 * the own/teammate weighting afterwards over that small candidate set. `own_only` is filtered here rather than in
 * SQL for the same reason: the filter belongs after the index, and a candidate set this small makes that cheap.
 */
export function vectorSearch(agentId: string, vector: number[], options: { limit?: number; sinceDays?: number; ownWeight?: number; otherWeight?: number } = {}): Statement {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 8)));
  const sinceDays = Math.max(1, Math.floor(options.sinceDays ?? 365));
  return {
    sql: `select * from memory_search($1, $2::vector, $3, $4, $5, now() - make_interval(days => $6::int))`,
    values: [agentId, `[${vector.join(",")}]`, limit, options.ownWeight ?? cfgWeights(options).own, options.otherWeight ?? cfgWeights(options).other, sinceDays],
  };
}

function cfgWeights(options: { ownWeight?: number; otherWeight?: number }): { own: number; other: number } {
  return { own: options.ownWeight ?? DEFAULTS.ownWeight, other: options.otherWeight ?? DEFAULTS.otherWeight };
}

export function dreamStatement(options: {
  sessionId: string;
  agentId: string;
  trigger: Trigger;
  summary: string;
  subjects: string[];
  feel?: string;
  vector?: number[];
  model?: string;
  detail?: Record<string, unknown>;
}): Statement {
  const vector = options.vector ? `[${options.vector.join(",")}]` : null;
  return {
    sql: `with span as (
            select min(id) as first_id, max(id) as last_id
            from memory.event
            where session_id = $1
              and seq > coalesce((select dream_seq from memory.session where id = $1), 0)
              and coalesce(meta ->> 'dream_turn', 'false') <> 'true'
          )
          insert into memory.memory (agent_id, session_id, trigger, span_first_event, span_last_event, summary, subjects, feel, detail, embedding, embedding_model, embedding_dim)
          select $2, $1, $3, span.first_id, span.last_id, $4, $5, $6, $7::jsonb, $8::vector, $9, $10
          from span`,
    // The cast on the vector is what makes a parameter a pgvector value rather than a string Postgres has to guess
    // about, and `embedding_model`/`embedding_dim` travel with it: when the embedder changes, old rows keep saying
    // which model produced them instead of silently becoming wrong.
    values: [
      options.sessionId,
      options.agentId,
      options.trigger,
      options.summary,
      options.subjects,
      options.feel ?? null,
      JSON.stringify(options.detail ?? { written_by: "memory_dream" }),
      vector,
      vector ? (options.model ?? null) : null,
      vector ? EMBEDDING_DIMENSIONS : null,
    ],
  };
}

/**
 * What a dream would summarise, asked before writing it.
 *
 * The insert's `select … from span` silently produces no row when the span is empty, which is correct behaviour
 * expressed as a foreign key error waiting to happen. Asking first is what lets the tool say "there is nothing here
 * worth a memory" in words, and it is also where a dream about a previous dream gets caught.
 */
export function dreamSpanStatement(sessionId: string): Statement {
  return {
    sql: `select coalesce(max(seq), 0) as last_seq, count(*) filter (where coalesce(meta ->> 'dream_turn', 'false') <> 'true') as work_events
          from memory.event
          where session_id = $1 and seq > coalesce((select dream_seq from memory.session where id = $1), 0)`,
    values: [sessionId],
  };
}

export function dreamCursorStatement(sessionId: string): Statement {
  return {
    sql: `update memory.session set dream_seq = (select coalesce(max(seq), dream_seq) from memory.event where session_id = $1) where id = $1`,
    values: [sessionId],
  };
}

/* ------------------------------------------------------------------ dreaming */

/**
 * The one test every dream trigger shares: is there a stretch that has not been summarized yet?
 *
 * `recorded` counts the rows this session has handed over, `dreamed` counts how many there were the last time a dream
 * was written. Counting the rows still queued in memory would be wrong: a flush empties the queue, so a session that
 * recorded a hundred turns and then went idle would look like it had nothing to think about.
 */
export function dreamPending(recorded: number, dreamed: number): boolean {
  return recorded > dreamed;
}

export const DREAM_PROMPT = [
  "You are dreaming: writing down what a future version of you should remember about the stretch you just worked on.",
  "Call memory_dream exactly once. Do not call any other tool, do not start new work, and do not answer as though the user asked you something.",
  "summary: two to four sentences about what actually happened and what would be useful later — decisions, findings, dead ends, the state things were left in.",
  "subjects: three to six loose, generic labels. They are the index your future self scans, so a label that only makes sense inside one file is a bad label.",
  "feel: one honest line about how this stretch felt to work on. Not decoration — this is the part that shows up over months.",
  "If nothing here is worth remembering, say so in one sentence and use subjects {none}. A dream that admits it was empty is fine.",
  "If the only thing that has happened since your last dream is other dreams, do not call the tool at all: the store will refuse the write, and a memory about a memory is not a memory.",
].join("\n");

/** How long a dream turn is allowed to look in-flight before a later trigger may run again. */
const DREAM_TURN_TIMEOUT_MS = 5 * 60_000;

/* ------------------------------------------------------------------ extension */

type Db = {
  connect: () => Promise<{ query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; release: () => void }>;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

export default function memoryExtension(api: ExtensionAPI): void {
  const resolved = resolveConfig(process.cwd());
  const dsn = resolved?.dsn;
  if (!resolved || !dsn) return;
  // A separate binding rather than reusing `resolved`: the narrowing that makes `dsn` non-optional does not survive
  // into the closures this extension registers, and a closure that has to re-prove the config exists every time it
  // writes is a closure that eventually gets it wrong.
  const cfg: Config = { ...resolved, dsn };

  let pool: Db | undefined;
  let connectError = "";
  let lastError = "";
  let lastFlushAt = 0;
  /** `agent|kind` -> wall time of the last such stamp this process sent, for the throttle. */
  const heartbeats = new Map<string, number>();
  let lastStampError = "";
  let written = 0;
  let lastEmbed: { at: number; tokens?: number; chunks?: number; model?: string; error?: string } | undefined;
  let queued: Row[] = [];
  const seen = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;
  let dreamTimer: NodeJS.Timeout | undefined;
  let dreamStartedAt = 0;
  let recorded = 0;
  let workSeen = 0;
  let dreamed = 0;
  let sessionOpenedAt = Date.now();
  const triggers = new Map<string, Trigger>();

  async function database(): Promise<Db | undefined> {
    if (pool) return pool;
    try {
      const pg = await import("pg");
      pool = new pg.Pool({ connectionString: dsn, max: 2, connectionTimeoutMillis: 4_000, query_timeout: 10_000 }) as unknown as Db;
      connectError = "";
    } catch (error) {
      connectError = describeStoreError(error instanceof Error ? error.message : String(error));
    }
    return pool;
  }

  function sessionIdOf(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.() ?? "unknown-session";
  }

  function collect(ctx: ExtensionContext): number {
    const sessionId = sessionIdOf(ctx);
    let fresh = 0;
    for (const row of rowsFromBranch(ctx.sessionManager.getBranch() as unknown[], cfg)) {
      // kind and tool name are part of the key because one entry can produce several rows, and re-walking a branch
      // after a /tree or a resume must not turn one tool call into three.
      const key = `${sessionId}|${row.sourceEntryId}|${row.kind}|${row.toolName ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queued.push(row);
      fresh += 1;
    }
    recorded = seen.size;
    // The gate is about work, so it counts rows that are not themselves the residue of a previous dream. Recomputed
    // from the branch rather than accumulated: a /tree or a resume changes the branch, and a counter that only ever
    // went up would keep saying "there is new work" for a stretch that no longer exists.
    workSeen = rowsFromBranch(ctx.sessionManager.getBranch() as unknown[], cfg).filter((row) => row.meta.dream_turn !== true).length;
    return fresh;
  }

  /** Flush the pending rows. Returns the reason the store refused them, so a caller that is about to depend on those
   *  rows being there - the dream, chiefly - can say so instead of discovering it as a foreign key error. */
  async function flush(ctx: ExtensionContext | undefined, reason: Trigger | "flush"): Promise<string | undefined> {
    if (ctx) collect(ctx);
    const batch = queued;
    if (!batch.length) return;
    queued = [];

    const db = await database();
    const sessionId = ctx ? sessionIdOf(ctx) : batch[0]?.sessionId ?? "unknown-session";
    const agent = ctx ? agentIdentity(ctx, cfg) : "unknown-agent";

    if (!db) {
      // No stamp is possible here, and that absence is worth naming: a store that cannot be reached at all leaves no
      // watermark anywhere, which is indistinguishable from nobody working. That is why the signal is the *pair* of
      // columns - activity without a commit - and it only goes asymmetric when the store is reachable and refusing.
      writeSpool(batch.map((row) => ({ ...row, sessionId })));
      lastError = connectError || "no database connection";
      return lastError;
    }

    const replay = readSpool().rows;
    const all = [...replay, ...batch];
    // Hoisted above the transaction because the failure path reports to the same heartbeat row, and a stamp that
    // cannot name the agent or the repo is not worth reading.
    const cwd = ctx?.cwd ?? process.cwd();
    const repo = basename(cwd);
    let client: Awaited<ReturnType<Db["connect"]>> | undefined;
    try {
      client = await db.connect();
      const branch = ctx?.sessionManager.getBranch() ?? [];
      const firstAt = branch.length ? entryTime(branch[0] as unknown as Record<string, unknown>) : new Date().toISOString();

      await client.query("begin");
      await client.query(agentStatement(agent, repo).sql, agentStatement(agent, repo).values);
      const session = sessionStatement({ sessionId, agentId: agent, cwd, repo, firstAt, lastAt: new Date().toISOString() });
      await client.query(session.sql, session.values);
      for (const row of all) {
        // A replayed row belongs to the session it was spooled from, which is not necessarily the one open now.
        const rowSession = row.sessionId ?? sessionId;
        const statement = eventStatement(rowSession, agent, [row]);
        await client.query(statement.sql, statement.values);
      }
      await client.query(`update memory.session set event_count = (select count(*) from memory.event where session_id = $1) where id = $1`, [sessionId]);
      await client.query("commit");
      written += all.length;
      lastError = "";
      lastFlushAt = Date.now();
      rewriteSpool([]);
      // Released before the stamp so the stamp is a separate connection and a separate implicit transaction. A
      // heartbeat written inside the batch's transaction would roll back with the failure it is supposed to report,
      // which is not evidence of anything.
      client.release();
      client = undefined;
      await stamp(agent, repo, "flush");
      return undefined;
    } catch (error) {
      lastError = describeStoreError(error instanceof Error ? error.message : String(error));
      if (client) {
        try {
          await client.query("rollback");
        } catch {
          // The transaction is already abandoned; the original failure is the one worth reporting.
        }
      }
      // The batch and whatever was already spooled both go back to disk together.
      writeSpool(all.map((row) => ({ ...row, sessionId: row.sessionId ?? sessionId })));
      if (ctx?.hasUI) ctx.ui.notify(`memory: write failed, ${all.length} row(s) spooled (${lastError})`, "warning");
      client?.release();
      client = undefined;
      await stamp(agent, repo, "failure", lastError, all.length);
      return lastError;
    } finally {
      client?.release();
    }
  }

  /**
   * Stamp the store with what this writer just did, if it is allowed to stamp yet.
   *
   * Diagnostics that can break the thing they observe are worse than no diagnostics, so every failure here is
   * swallowed into `lastStampError` and shown by `/memory`. The heartbeat never takes a turn down and never retries.
   */
  async function stamp(agent: string, repo: string, kind: StampKind, error?: string, spoolRows = 0): Promise<void> {
    const db = await database();
    if (!db) return;
    const key = heartbeatKey(agent, kind);
    const lastAt = heartbeats.get(key) ?? 0;
    // A refused batch is the reason the table exists, so it gets a shorter interval than routine stamps.
    const interval = kind === "failure" ? HEARTBEAT_THROTTLE_MS / 4 : HEARTBEAT_THROTTLE_MS;
    if (!heartbeatDue(lastAt, Date.now(), interval)) return;
    const statement =
      kind === "flush"
        ? heartbeatFlushStatement(agent, repo)
        : kind === "failure"
          ? heartbeatFailureStatement(agent, repo, error ?? "unknown failure", spoolRows)
          : heartbeatActivityStatement(agent, repo);
    try {
      await db.query(statement.sql, statement.values);
      heartbeats.set(key, Date.now());
      lastStampError = "";
    } catch (err) {
      lastStampError = err instanceof Error ? err.message : String(err);
    }
  }

  function scheduleFlush(ctx: ExtensionContext): void {
    collect(ctx);
    if (!queued.length) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(ctx, "flush"), cfg.flushMs ?? DEFAULTS.flushMs);
    flushTimer.unref?.();
  }

  function dreaming(): boolean {
    return dreamStartedAt > 0 && Date.now() - dreamStartedAt < DREAM_TURN_TIMEOUT_MS;
  }

  async function runDream(ctx: ExtensionContext, trigger: Trigger): Promise<void> {
    if (!cfg.dreams || dreaming()) return;
    collect(ctx);
    // An unsummarized stretch is the only reason to dream.
    // "An unsummarized stretch is the only reason to dream" - where a dream's own rows do not count as a stretch.
    if (!dreamPending(workSeen, dreamed)) {
      // Silence is what a correctly behaved idle session looks like. The case worth one line of explanation is the
      // one a watcher cannot distinguish from a broken trigger: this session has already dreamed, and the reason it
      // is not dreaming again is that the dreaming itself is not work.
      if (ctx.hasUI && dreamed > 0) ctx.ui.notify(`memory: idle after dreaming - ${workSeen} work row(s), all already summarized`, "info");
      return;
    }
    triggers.set(sessionIdOf(ctx), trigger);
    dreamStartedAt = Date.now();
    await api.sendMessage({ customType: "memory:dream", content: DREAM_PROMPT, display: false, details: { trigger } }, { triggerTurn: true });
  }

  function scheduleDream(ctx: ExtensionContext, minutes: number, trigger: Trigger): void {
    if (!cfg.dreams) return;
    if (dreamTimer) clearTimeout(dreamTimer);
    dreamTimer = setTimeout(() => void runDream(ctx, trigger), minutes * 60_000);
    dreamTimer.unref?.();
  }

  function triggerFor(sessionId: string): Trigger {
    return triggers.get(sessionId) ?? "manual";
  }

  /* Lifecycle. */

  api.on("session_start", (event, ctx) => {
    sessionOpenedAt = Date.now();
    queued = [];
    seen.clear();
    recorded = 0;
    workSeen = 0;
    dreamed = 0;
    dreamStartedAt = 0;
    // A session that came back is continuing something; ten minutes in is long enough to know what it is continuing.
    // `pi -c` reports "startup" rather than "resume", so both are treated as a session that arrived from history.
    // The activity half of the watermark: an agent that opened a session and then never committed anything is the
    // exact shape a broken write path leaves behind.
    void stamp(agentIdentity(ctx, cfg), basename(ctx.cwd ?? process.cwd()), "activity");
    if (event.reason === "resume" || event.reason === "startup") scheduleDream(ctx, cfg.resumeDreamMinutes ?? DEFAULTS.resumeDreamMinutes, "resume10m");
  });

  api.on("turn_end", (_event, ctx) => scheduleFlush(ctx));

  api.on("agent_settled", (event, ctx) => {
    scheduleFlush(ctx);
    // Idle is when an agent has time to think, so this is the ordinary dream trigger. An aborted run is not idle, it
    // is interrupted, and dreaming about an interrupted stretch is how an agent learns to summarize noise.
    if (!event.aborted) scheduleDream(ctx, cfg.idleDreamMinutes ?? DEFAULTS.idleDreamMinutes, "idle10m");
  });

  api.on("agent_start", () => {
    // Work arrived. A dream about to fire is now badly timed and would collide with the turn.
    if (dreamTimer) clearTimeout(dreamTimer);
  });

  api.on("session_before_compact", (_event, ctx) => {
    // Flush without waiting for it: compaction is the harness discarding context, and a slow database must not hold
    // that up. The rows land a moment later, and the spool catches the case where they cannot.
    void flush(ctx, "pre_compaction");
    void runDream(ctx, "pre_compaction");
  });

  api.on("session_shutdown", (_event, ctx) => {
    if (flushTimer) clearTimeout(flushTimer);
    if (dreamTimer) clearTimeout(dreamTimer);
    void flush(ctx, "manual");
  });

  /* The model-facing surface. */

  api.registerMessageRenderer<{ trigger?: Trigger }>("memory:dream", (message, _options, theme) => {
    // display:false, so this is what a replay of an old session shows rather than what a live dream draws: one quiet
    // line saying the agent was dreaming, not the instruction it was given.
    const details = message.details as { trigger?: Trigger } | undefined;
    const head = theme.fg("accent", `⌾ dreaming${details?.trigger ? ` · ${details.trigger}` : ""}`);
    return new Text(theme.fg("muted", head), 1, 1);
  });

  api.registerTool({
    name: "memory_search",
    label: "memory_search",
    description: "Search the fleet's recorded memories: what this agent remembered, and what its teammates remembered (ranked lower and labelled).",
    promptSnippet: "Search agent memory (own memories ranked above teammates')",
    parameters: Type.Object({
      query: Type.String({ description: "Words to search the memory summaries, subject labels and notes for" }),
      limit: Type.Number({ description: "Maximum results (default 8, max 50)" }),
      since_days: Type.Number({ description: "Ignore memories older than this many days (default 365)" }),
      own_only: Type.Boolean({ description: "Restrict to this agent's own memories" }),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const db = await database();
      if (!db) {
        const reason = connectError || lastError || "no database reachable";
        return { content: [{ type: "text", text: `memory_search unavailable: ${reason}. Any memory this agent produced is in the local spool.` }], details: { error: reason } };
      }
      const agent = agentIdentity(ctx, cfg);
      const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 8)));
      const query = String(params.query ?? "");
      // Vector recall is the primary path and text recall is the safety net under it: an unembedded memory - one
      // written while the embedder was down - is still a memory, and a query that misses semantically but matches a
      // word should still find it. Both are run rather than chosen between, and the ids are deduplicated so a hit
      // that both paths found is reported once, by the path that scored it best.
      const embedded = await embedText(query, cfg);
      const rows: Record<string, unknown>[] = [];
      const seenIds = new Set<string>();
      let note = "";
      let client: Awaited<ReturnType<Db["connect"]>> | undefined;
      try {
        client = await db.connect();
        if (embedded.ok) {
          const statement = vectorSearch(agent, embedded.vector, { limit, sinceDays: params.since_days, ownWeight: cfg.ownWeight, otherWeight: cfg.otherWeight });
          const result = await client.query(statement.sql, statement.values);
          for (const row of result.rows) {
            if (params.own_only && row.mine !== true) continue;
            if (seenIds.has(String(row.id))) continue;
            seenIds.add(String(row.id));
            rows.push(row);
          }
        } else {
          note = ` (vector recall unavailable: ${embedded.error})`;
        }
        if (rows.length < limit) {
          const textStatement = keywordSearch(query, agent, { limit: limit - rows.length, sinceDays: params.since_days, ownOnly: params.own_only });
          const result = await client.query(textStatement.sql, textStatement.values);
          for (const row of result.rows) {
            if (seenIds.has(String(row.id))) continue;
            seenIds.add(String(row.id));
            rows.push(row);
          }
        }
        const lines = rows.map((row) => formatMemoryHit(row, agent, Number.isFinite(Number(row.similarity)) ? "vector" : "text"));
        // Zero rows belonging to this agent is the one case worth a second query, and it is worth it because the
        // search result on its own cannot say whether the agent has nothing or merely nothing near. The count is
        // indexed on (agent_id, created_at) and this path is the rare one.
        const ownReturned = rows.filter((row) => (typeof row.mine === "boolean" ? row.mine === true : String(row.agent_id) === agent)).length;
        let coverage = "";
        if (ownReturned === 0) {
          const count = ownRowCountStatement(agent);
          const ownRows = await client.query(count.sql, count.values);
          coverage = ownCoverageNote({ agentId: agent, ownInStore: Number(ownRows.rows[0]?.own ?? 0), returned: rows.length });
        }
        const text = rows.length ? lines.join("\n") + coverage : `no memories match "${query}" for ${agent}${note}${coverage}`;
        return {
          content: [{ type: "text", text }],
          details: { count: rows.length, ownReturned, vector: embedded.ok, note: note || undefined, coverage: coverage || undefined },
        };
      } catch (error) {
        const message = describeStoreError(error instanceof Error ? error.message : String(error));
        return { content: [{ type: "text", text: `memory_search failed: ${message}` }], details: { error: message } };
      } finally {
        client?.release();
      }
    },
  });

  api.registerTool({
    name: "memory_dream",
    label: "memory_dream",
    description: "Record what this agent decided was worth remembering about the stretch it just worked on: summary, subjects, and how it felt.",
    promptSnippet: "Write one memory for the stretch just worked on",
    parameters: Type.Object({
      summary: Type.String({ description: "Two to four sentences about what happened and what matters later" }),
      subjects: Type.Union([Type.Array(Type.String()), Type.String()], { description: "Three to six loose generic labels; the index a future self scans. A single comma-separated string is accepted too" }),
      feel: Type.String({ description: "One honest line about how the stretch felt" }),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const db = await database();
      if (!db) {
        const reason = connectError || lastError || "no database reachable";
        return { content: [{ type: "text", text: `memory_dream unavailable: ${reason}. Nothing was recorded.` }], details: { error: reason } };
      }
      const summary = String(params.summary ?? "").trim();
      if (!summary) return { content: [{ type: "text", text: "memory_dream needs a summary" }], details: { error: "missing summary" } };
      // One string rather than an array is the most common way a model misses this parameter, and the difference
      // between a dream written and a dream refused should not be a comma.
      const subjects = (Array.isArray(params.subjects) ? params.subjects : String(params.subjects ?? "").split(","))
        .map((subject) => String(subject).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8);
      const feel = String(params.feel ?? "").trim() || undefined;
      const sessionId = sessionIdOf(ctx);
      const agent = agentIdentity(ctx, cfg);
      const trigger = triggerFor(sessionId);
      let client: Awaited<ReturnType<Db["connect"]>> | undefined;
      try {
        // The events have to be in the store before the span can be computed, so the pending rows are flushed first -
        // and if they did not land, the memory is not written either. A memory whose raw stretch is missing is a claim
        // nothing can check later, and the foreign key would only complain in a way that confuses the agent.
        const flushFailure = await flush(ctx, trigger);
        if (flushFailure) {
          return { content: [{ type: "text", text: `memory_dream not written: the events it would summarise are not in the store (${flushFailure}). The summary is worth keeping; say it in the reply and try again once the store is reachable.` }], details: { error: flushFailure } };
        }
        client = await db.connect();

        // Asked before anything is spent on answering: a span with no work in it is not a memory waiting to be
        // phrased, it is a dream about a previous dream. Checking here rather than letting the insert's
        // `select … from span` quietly write no row means the agent is told in words, before an embedder call it
        // did not need to pay for.
        const span = dreamSpanStatement(sessionId);
        const spanResult = await client.query(span.sql, span.values);
        const spanRow = spanResult.rows[0] ?? { last_seq: 0, work_events: 0 };
        if (!Number(spanRow.work_events)) {
          return {
            content: [{ type: "text", text: `memory_dream not written: nothing unsummarized since the last dream (${Number(spanRow.work_events)} non-dream event(s) in the span). Either this stretch is already remembered or the only thing that happened since was dreaming - say what you learned in the reply instead.` }],
            details: { error: "empty span", workEvents: Number(spanRow.work_events) },
          };
        }

        // The vector is written when the embedder answers and omitted when it does not. A memory without a vector is
        // still findable by keywords and still says in its own `detail` why it has no vector, which is better than a
        // dream that fails outright because one optional service was having a bad afternoon.
        const embedded = await embedText(memoryText(summary, subjects, feel), cfg);
        lastEmbed = embedded.ok
          ? { at: Date.now(), tokens: embedded.tokens, chunks: embedded.chunks, model: embedded.model }
          : { at: Date.now(), error: embedded.error };
        const detail: Record<string, unknown> = {
          written_by: "memory_dream",
          span_events: Number(spanRow.work_events),
          ...(embedded.ok
            ? { embed_model: embedded.model, embed_chunks: embedded.chunks, embed_tokens: embedded.tokens }
            : { embed_error: embedded.error }),
        };

        const dream = dreamStatement({
          sessionId,
          agentId: agent,
          trigger,
          summary,
          subjects,
          feel,
          vector: embedded.ok ? embedded.vector : undefined,
          model: embedded.ok ? embedded.model : undefined,
          detail,
        });
        await client.query(dream.sql, dream.values);
        const cursor = dreamCursorStatement(sessionId);
        await client.query(cursor.sql, cursor.values);
        await client.query("refresh materialized view memory.subject_index");
        dreamStartedAt = 0;
        // The gate is in units of work, so this has to be recorded in the same unit. `seen.size` counts every row
        // this process has walked, including the dream's own residue, and a gate that compares work against
        // work-plus-residue drifts towards dreaming every idle window.
        dreamed = workSeen;
        triggers.delete(sessionId);
        const vectorNote = embedded.ok ? `vector from ${embedded.model} (${embedded.tokens} tokens, ${embedded.chunks} chunk(s))` : `no vector (${embedded.error})`;
        if (ctx.hasUI) ctx.ui.notify(`memory: dream written (${subjects.join(", ") || "no subjects"}, ${vectorNote})`, "info");
        return {
          content: [{ type: "text", text: `dream recorded for session ${sessionId} (${trigger}); subjects: ${subjects.join(", ") || "none"}; ${vectorNote}` }],
          details: { subjects, trigger, embedded: embedded.ok, embed: embedded.ok ? { tokens: embedded.tokens, chunks: embedded.chunks, model: embedded.model } : embedded.error },
        };
      } catch (error) {
        const message = describeStoreError(error instanceof Error ? error.message : String(error));
        // "not written" rather than the raw Postgres text: a connection refusal and a constraint violation are both
        // true, but only one of them tells the agent what to do next, and the spool hint is what makes the retry safe.
        return { content: [{ type: "text", text: `memory_dream not written: ${message}. Nothing was summarised; the events are in the local spool and this dream can be tried again once the store answers.` }], details: { error: message } };
      } finally {
        client?.release();
      }
    },
  });

  api.registerCommand("memory", {
    description: "What this agent's memory holds, and whether writes are landing",
    handler: async (_args, ctx) => {
      await flush(ctx, "manual");
      const db = await database();
      const agent = agentIdentity(ctx, cfg);
      const lines: string[] = [
        `agent      ${agent}`,
        `store      ${describeDsn(cfg.dsn ?? "")}`,
        `this session  ${recorded} recorded row(s), ${written} written by this process`,
        `open       ${Math.max(0, Math.round((Date.now() - sessionOpenedAt) / 60_000))}m`,
      ];
      if (lastFlushAt) lines.push(`last write ${new Date(lastFlushAt).toISOString()}`);
      if (lastError) lines.push(`last error ${lastError}`);
      if (connectError) lines.push(`driver      ${connectError}`);
      if (lastStampError) lines.push(`heartbeat   could not be written: ${lastStampError}`);
      const spool = readSpool();
      if (spool.rows.length) lines.push(`spooled     ${spool.rows.length} row(s) waiting for a reachable store`);
      if (db) {
        let client: Awaited<ReturnType<Db["connect"]>> | undefined;
        try {
          client = await db.connect();
          const counts = await client.query(
            `select (select count(*) from memory.session where agent_id = $1) as sessions,
                    (select count(*) from memory.event where agent_id = $1) as events,
                    (select count(*) from memory.memory where agent_id = $1) as memories,
                    (select count(*) from memory.memory where agent_id = $1 and embedding is null) as unembedded`,
            [agent],
          );
          const row = counts.rows[0] ?? {};
          lines.push(`counts     ${row.sessions} session(s), ${row.events} event(s), ${row.memories} memor(y|ies), ${row.unembedded} without a vector`);
          const subjects = await client.query(subjectsStatement(agent).sql, subjectsStatement(agent).values);
          const listed = subjects.rows.map((subject) => `${String(subject.subject)}(${String(subject.memories)})`);
          lines.push(`subjects   ${listed.join(" ") || "none yet"}`);
        const beat = heartbeatReadStatement(agent);
        const heart = await client.query(beat.sql, beat.values);
        const h = heart.rows[0];
        lines.push(
          h
            ? `heartbeat  flushed ${Number(h.flushes)}x (last ${h.last_flush_at ? new Date(String(h.last_flush_at)).toISOString() : "never"}), ${Number(h.failures)} refused batch(es)${h.last_error ? `: ${String(h.last_error)}` : ""}${Number(h.spool_rows) ? `, ${Number(h.spool_rows)} row(s) spooled` : ""}`
            : `heartbeat  never stamped - this agent has not reached the store`,
        );
        } catch (error) {
          lines.push(`store      ${describeStoreError(error instanceof Error ? error.message : String(error))}`);
        } finally {
          client?.release();
        }
      }
      lines.push(`dreams     ${cfg.dreams ? `idle ${cfg.idleDreamMinutes ?? DEFAULTS.idleDreamMinutes}m, resume ${cfg.resumeDreamMinutes ?? DEFAULTS.resumeDreamMinutes}m, before compaction` : "off"}`);
      lines.push(`embedder   ${cfg.embeddings === false ? "off (memories will be written without vectors)" : `${cfg.embedUrl ?? DEFAULTS.embedUrl} · ${cfg.embedModel ?? DEFAULTS.embedModel} · ${EMBEDDING_DIMENSIONS}-dim`}`);
      if (lastEmbed) lines.push(`last embed ${lastEmbed.error ? `failed: ${lastEmbed.error}` : `${lastEmbed.model} ${lastEmbed.tokens} tokens in ${lastEmbed.chunks} chunk(s)`}`);
      // The widget is the output: a command that answers with a wall of text in the transcript is a command that
      // pollutes the session it was run in. Pi's command handlers return nothing.
      if (ctx.hasUI) ctx.ui.setWidget("memory", lines);
      else ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

/** A DSN described without ever reproducing the credential in it. */
export function describeDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "unreadable dsn";
  }
}
