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
}

const DEFAULTS = {
  dreams: true,
  flushMs: 4_000,
  maxTextChars: 12_000,
  idleDreamMinutes: 10,
  resumeDreamMinutes: 10,
} satisfies Partial<Config>;

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
    tuples.push(`($1, $2, $${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5}, (select coalesce(max(seq), 0) from event where session_id = $1) + ${tuples.length + 1})`);
    // `text` is a column and `meta` is what surrounded it: which tool produced a result, whether it errored,
    // whether the text was clipped, which redaction rules fired. Collapsing one into the other is how a history
    // table stops being queryable.
    values.push(row.sourceEntryId, row.at, row.kind, row.toolName ?? null, row.text ?? null, JSON.stringify(row.meta));
    index += 6;
  }
  return {
    sql: `insert into event (session_id, agent_id, source_entry_id, at, kind, tool_name, text, meta, seq) values ${tuples.join(", ")} on conflict (session_id, source_entry_id) do nothing`,
    values,
  };
}

export function agentStatement(agentId: string, repo: string): Statement {
  return {
    sql: `insert into agent (id, name, host, repos)
          values ($1, $1, split_part($1, ':', 1), array[$2])
          on conflict (id) do update
            set last_seen = now(),
                repos = (select array(select distinct unnest(array_cat(agent.repos, array[$2]))))`,
    values: [agentId, repo],
  };
}

export function sessionStatement(options: { sessionId: string; agentId: string; cwd: string; repo: string; firstAt: string; lastAt: string }): Statement {
  return {
    sql: `insert into session (id, agent_id, repo, cwd, source, started_at, last_activity_at)
          values ($1, $2, $3, $4, 'pi-extension', $5, $6)
          on conflict (id) do update
            set last_activity_at = greatest (session.last_activity_at, excluded.last_activity_at),
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
export function formatMemoryHit(row: Record<string, unknown>, agentId: string): string {
  const mine = row.agent_id === agentId;
  const subjects = Array.isArray(row.subjects) ? (row.subjects as string[]).join(", ") : "";
  const feel = row.feel ? ` — felt: ${String(row.feel)}` : "";
  const score = (Number(row.rank) || 0) + (Number(row.weight) || 0);
  return `- ${mine ? "mine" : String(row.agent_id)} ${String(row.created_at ?? "").slice(0, 16)} [score ${score.toFixed(3)}] [${subjects}] ${String(row.summary ?? "")}${feel}`;
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
          from memory m
          where ${filters.join(" and ")}
          order by (${rank} + case when m.agent_id = $2 then 1.0 else 0.65 end) desc, m.created_at desc
          limit $3`,
    values: [query, agentId, limit, sinceDays],
  };
}

/** The lean view of an agent's head: which subjects it actually has memories about, most recent first. */
export function subjectsStatement(agentId: string, limit = 12): Statement {
  return { sql: `select subject, memories, most_recent from subject_index where agent_id = $1 order by most_recent desc limit $2`, values: [agentId, limit] };
}

/** How a memory row is written, with the span of events it summarizes resolved in SQL rather than guessed here. */
export function dreamStatement(options: { sessionId: string; agentId: string; trigger: Trigger; summary: string; subjects: string[]; feel?: string }): Statement {
  return {
    sql: `with span as (
            select min(id) as first_id, max(id) as last_id
            from event
            where session_id = $1
              and seq > coalesce((select dream_seq from session where id = $1), 0)
          )
          insert into memory (agent_id, session_id, trigger, span_first_event, span_last_event, summary, subjects, feel, detail)
          select $2, $1, $3, span.first_id, span.last_id, $4, $5, $6, jsonb_build_object('written_by', 'memory_dream')
          from span`,
    values: [options.sessionId, options.agentId, options.trigger, options.summary, options.subjects, options.feel ?? null],
  };
}

export function dreamCursorStatement(sessionId: string): Statement {
  return {
    sql: `update session set dream_seq = (select coalesce(max(seq), dream_seq) from event where session_id = $1) where id = $1`,
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
].join("\n");

/** How long a dream turn is allowed to look in-flight before a later trigger may run again. */
const DREAM_TURN_TIMEOUT_MS = 5 * 60_000;

/* ------------------------------------------------------------------ extension */

type Db = {
  connect: () => Promise<{ query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; release: () => void }>;
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
  let written = 0;
  let queued: Row[] = [];
  const seen = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;
  let dreamTimer: NodeJS.Timeout | undefined;
  let dreamStartedAt = 0;
  let recorded = 0;
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
      connectError = error instanceof Error ? error.message : String(error);
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
      writeSpool(batch.map((row) => ({ ...row, sessionId })));
      lastError = connectError || "no database connection";
      return lastError;
    }

    const replay = readSpool().rows;
    const all = [...replay, ...batch];
    let client: Awaited<ReturnType<Db["connect"]>> | undefined;
    try {
      client = await db.connect();
      const branch = ctx?.sessionManager.getBranch() ?? [];
      const firstAt = branch.length ? entryTime(branch[0] as unknown as Record<string, unknown>) : new Date().toISOString();
      const cwd = ctx?.cwd ?? process.cwd();
      const repo = basename(cwd);

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
      await client.query(`update session set event_count = (select count(*) from event where session_id = $1) where id = $1`, [sessionId]);
      await client.query("commit");
      written += all.length;
      lastError = "";
      lastFlushAt = Date.now();
      rewriteSpool([]);
      return undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
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
      return lastError;
    } finally {
      client?.release();
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
    if (!dreamPending(recorded, dreamed)) return;
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
    dreamed = 0;
    dreamStartedAt = 0;
    // A session that came back is continuing something; ten minutes in is long enough to know what it is continuing.
    // `pi -c` reports "startup" rather than "resume", so both are treated as a session that arrived from history.
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
      const statement = keywordSearch(String(params.query ?? ""), agent, { limit: params.limit, sinceDays: params.since_days, ownOnly: params.own_only });
      let client: Awaited<ReturnType<Db["connect"]>> | undefined;
      try {
        client = await db.connect();
        const result = await client.query(statement.sql, statement.values);
        const rows = result.rows;
        const lines = rows.map((row) => formatMemoryHit(row, agent));
        const text = rows.length ? lines.join("\n") : `no memories match "${params.query}" for ${agent}`;
        return { content: [{ type: "text", text }], details: { count: rows.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
      subjects: Type.Array(Type.String(), { description: "Three to six loose generic labels; the index a future self scans" }),
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
      const subjects = (params.subjects ?? []).map((subject) => String(subject).trim().toLowerCase()).filter(Boolean).slice(0, 8);
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
        const dream = dreamStatement({ sessionId, agentId: agent, trigger, summary, subjects, feel });
        await client.query(dream.sql, dream.values);
        const cursor = dreamCursorStatement(sessionId);
        await client.query(cursor.sql, cursor.values);
        await client.query("refresh materialized view subject_index");
        dreamStartedAt = 0;
        dreamed = seen.size;
        triggers.delete(sessionId);
        if (ctx.hasUI) ctx.ui.notify(`memory: dream written (${subjects.join(", ") || "no subjects"})`, "info");
        return { content: [{ type: "text", text: `dream recorded for session ${sessionId} (${trigger}); subjects: ${subjects.join(", ") || "none"}` }], details: { subjects, trigger } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
      const spool = readSpool();
      if (spool.rows.length) lines.push(`spooled     ${spool.rows.length} row(s) waiting for a reachable store`);
      if (db) {
        let client: Awaited<ReturnType<Db["connect"]>> | undefined;
        try {
          client = await db.connect();
          const counts = await client.query(
            `select (select count(*) from session where agent_id = $1) as sessions,
                    (select count(*) from event where agent_id = $1) as events,
                    (select count(*) from memory where agent_id = $1) as memories,
                    (select count(*) from memory where agent_id = $1 and embedding is null) as unembedded`,
            [agent],
          );
          const row = counts.rows[0] ?? {};
          lines.push(`counts     ${row.sessions} session(s), ${row.events} event(s), ${row.memories} memor(y|ies), ${row.unembedded} without a vector`);
          const subjects = await client.query(subjectsStatement(agent).sql, subjectsStatement(agent).values);
          const listed = subjects.rows.map((subject) => `${String(subject.subject)}(${String(subject.memories)})`);
          lines.push(`subjects   ${listed.join(" ") || "none yet"}`);
        } catch (error) {
          lines.push(`store      unreadable: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          client?.release();
        }
      }
      lines.push(`dreams     ${cfg.dreams ? `idle ${cfg.idleDreamMinutes ?? DEFAULTS.idleDreamMinutes}m, resume ${cfg.resumeDreamMinutes ?? DEFAULTS.resumeDreamMinutes}m, before compaction` : "off"}`);
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
