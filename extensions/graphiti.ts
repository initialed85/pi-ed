/**
 * graphiti — the fleet's agent memory, spoken over HTTP.
 *
 * This is the memory door. It writes to Graphiti (graphiti_core 0.31.2) in namespace `memory`, which takes an
 * agent's sentence, extracts entities and relationships from it against Neo4j, and answers questions by combining
 * cosine similarity, BM25 and graph traversal. Ed chose it after cognee's ingest stalled forever retrying
 * schema-invalid graph output; home-ops ran the historical import here on 2026-11-10.
 *
 * It replaces `extensions/cognee.ts`, which is deleted. Read that file's history in git before doubting anything
 * below: every trap here is the same shape — a request that returned 2xx and had not remembered a thing.
 *
 * Everything numeric was measured on home-dev on 2026-11-10/11 from inside a slopyphus agent pod, against
 * `http://memory-graph.memory.svc.cluster.local:9999`, and not copied from documentation:
 *
 *   | call | shape | measured |
 *   | --- | --- | --- |
 *   | `POST /search` | `query`, `group_ids`, `max_facts: 8..40` | **200 in 0.21–0.66 s**, JSON `{"facts":[…]}`. No LLM in the loop, so it never stalls and never refuses in prose |
 *   | `POST /messages` | one message, `group_id`, `update_mode: append` | **202 accepted**, returns at once; the fact is *not* in the graph yet |
 *   | `GET /episodes/{group_id}?last_n=N` | the fresh-note door | 200. **`last_n` is a required query parameter** — without it: 422 `{"type":"missing","loc":["query","last_n"]}` |
 *   | `GET /healthcheck` | not `/health` | `{"status":"healthy"}`; `/health` answers 404 |
 *   | `DELETE /group/{group_id}` | whole-partition forget | available — unlike cognee, this door can be emptied by a probe |
 *
 * Extraction is asynchronous and the queue that drains it is in-memory asyncio, so **a 202 is an acknowledgement,
 * not a memory**. home-ops measured the bound the hard way on 2026-11-10: importing at concurrency 10 pushed
 * rooter into marking every backend unhealthy (a minute of fleet-wide 503 "no healthy backend serves model auto")
 * and **lost roughly 100 episodes behind 202 responses** — accepted, queued, never extracted, gone when the pod
 * restarted. Concurrency is 4 now. Two consequences this extension encodes: verify a write through
 * `/episodes/{group_id}` rather than trusting the 202, and never let an agent believe a fact is recallable the
 * second it was accepted.
 *
 * Four traps, each of which cost somebody a probe:
 *
 *   1. **`role` is required on a message.** The schema lists `content`, `role_type` and `role` as required; `role`
 *      has no default. Omit it and `/messages` answers 422 and nothing queues.
 *   2. **Never send a `uuid` on a message.** graphiti_core treats a supplied uuid as an existing episode and
 *      re-raises `NodeNotFoundError`, so the write fails *behind a 202* — the worst possible failure shape, an
 *      accepted memory that never existed. This extension does not include the field at all.
 *   3. **A group id that is spelled differently is a different brain.** Groups are the agent names exactly as the
 *      import used them (camry, chromium, coral, …, quake, rooter, slopyphus, structmeta, plus the fleet notes
 *      fleet-note and cognee-note). An agent that writes to `Quake` or `quake-2` silently creates a second
 *      partition nobody recalls from, and recall over `group_ids: [MEMORY_AGENT]` will never surface it.
 *   4. **This door has no auth.** It is cluster-internal by design, which means every pod in home-dev can read
 *      every group, and so can anything else that lands in one. Redaction before writing is not optional and is
 *      done here unconditionally, on the way out.
 *
 * Deliberately omitted: `POST /clear` and `DELETE /episode/{uuid}` are real and destructive and an agent asking to
 * "forget" in the same breath as it asks to remember something is an accident waiting to happen. Forgetting is a
 * human command, so it lives in `hack/graphiti-live-check.mjs --prove-delete`, not in a tool a model can call.
 */

import { hostname } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redact, scrub } from "../lib/redact.ts";

const MAX_TEXT_CHARS = 20_000;
/** Recall is measured at 0.21–0.66 s. 20 s is slack for Neo4j warming, not hope; past that the door is down. */
const RECALL_TIMEOUT_MS = 20_000;
/** The write returns a 202 immediately, so this budget only covers the cluster being briefly weird. */
const WRITE_TIMEOUT_MS = 15_000;
const URL_ENV = "MEMORY_GRAPH_URL";
/** Retrieval returns `max_facts` whatever the relevance; the door's own default is 10 and asking harder changes nothing. */
const DEFAULT_MAX_FACTS = 10;
const MAX_FACTS_CAP = 20;

type Config = { url: string; agent: string };

/**
 * The door is configured by exactly one variable. Unset means the extension registers nothing at all: a pod that
 * has not been given the URL simply has no graphiti tools rather than a tool that cannot be reached. That is the
 * acceptance condition home-ops asked for — unset must be a clean no-op, never a hang on session start.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
  const url = (env[URL_ENV] ?? "").trim().replace(/\/+$/, "");
  if (!url) return null;
  if (!/^https?:\/\//.test(url)) return null;
  const agent = (env.MEMORY_AGENT ?? "").trim() || hostname();
  return { url, agent };
}

/** The group a read or write targets: this agent's own partition unless a caller deliberately names another. */
function resolveGroup(cfg: Config, requested?: string): string {
  const g = (requested ?? "").trim();
  return g || cfg.agent;
}

type CallResult = { ok: boolean; status: number; body: unknown; raw: string; ms: number };

class Graphiti {
  constructor(private cfg: Config) {}

  private async post(path: string, payload: unknown, timeoutMs: number): Promise<CallResult> {
    const started = Date.now();
    const response = await fetch(this.cfg.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body, raw, ms: Date.now() - started };
  }

  /** Read. Synchronous, no LLM in the loop, and the only call whose answer can be quoted this turn. */
  search(input: { query: string; groups: string[] | null; maxFacts?: number }): Promise<CallResult> {
    return this.post("/search", {
      query: input.query,
      group_ids: input.groups,
      max_facts: Math.min(MAX_FACTS_CAP, Math.max(1, Math.floor(input.maxFacts ?? DEFAULT_MAX_FACTS))),
    }, RECALL_TIMEOUT_MS);
  }

  /** Write. Returns a 202 acknowledgement; extraction lands later or, if rooter is unhealthy, never. */
  addMessage(input: { group: string; content: string; name?: string; when?: string; source?: string }): Promise<CallResult> {
    // No `uuid` field, deliberately: see trap 2 in the header.
    const message: Record<string, unknown> = {
      content: input.content,
      role_type: "assistant",
      role: input.group,
      timestamp: input.when ?? new Date().toISOString(),
    };
    if (input.name) message.name = input.name;
    if (input.source) message.source_description = input.source;
    return this.post("/messages", {
      group_id: input.group,
      update_mode: "append",
      messages: [message],
    }, WRITE_TIMEOUT_MS);
  }

  /** The fresh-note door: what the service says it has been handed for this group, most recent first. */
  async episodes(group: string, lastN: number): Promise<{ ok: boolean; status: number; items: unknown[]; raw: string }> {
    const started = Date.now();
    const response = await fetch(
      `${this.cfg.url}/episodes/${encodeURIComponent(group)}?last_n=${Math.max(1, Math.min(50, Math.floor(lastN)))}`,
      { signal: AbortSignal.timeout(RECALL_TIMEOUT_MS) },
    );
    const raw = await response.text();
    let items: unknown[] = [];
    try {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : (parsed?.episodes ?? parsed?.items ?? []);
    } catch {
      items = [];
    }
    return { ok: response.ok, status: response.status, items, raw };
  }
}

/**
 * What an agent is told when a read comes back empty, and why it is worded this way.
 *
 * Graphiti answers fast and never refuses with prose, which is better than cognee's rephrasing completion — but it
 * also means "no facts" and "no facts because nothing in this group matches" and "nothing has been extracted into
 * this group yet" are the same visible shape. The most damaging thing a memory system can say is that the fleet
 * never wrote something down, when the truth is that the write is still in a queue or was dropped by an unhealthy
 * worker. So an empty read is reported as *this door being quiet*, never as absence.
 */
const EMPTY_HINT =
  "Graphiti returned no facts for that query. That is not proof the fleet never wrote it down: writes are extracted asynchronously and a 202 only means accepted, " +
  "so a note written in the last few minutes may still be in the queue (check with memory_recall again shortly, or ask a human to run the episodes door). " +
  "Say that this memory door found nothing, not that the fact does not exist.";

/** `fact (valid <valid_at>, invalid <invalid_at>)` — home-ops' contract, so staleness is visible rather than swallowed. */
export function formatFacts(body: unknown): { hits: number; text: string } {
  const facts = Array.isArray((body as Record<string, unknown>)?.facts)
    ? ((body as Record<string, unknown>).facts as Record<string, unknown>[])
    : Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  if (!facts.length) return { hits: 0, text: "" };
  const lines = facts.map((f, index) => {
    const fact = String(f?.fact ?? "").replace(/\s+/g, " ").trim();
    const valid = String(f?.valid_at ?? "unknown");
    const invalid = f?.invalid_at ? `, invalid ${String(f.invalid_at)}` : ", still held";
    const expired = f?.expired_at ? " [expired]" : "";
    const group = f?.group_id ? ` · ${String(f.group_id)}` : "";
    return `${index + 1}. ${fact} (valid ${valid}${invalid})${expired}${group}`;
  });
  return { hits: facts.length, text: lines.join("\n") };
}

/** The note as stored: attribution first, then the sentence, so a recalled fact says who meant it and when. */
export function buildNote(input: { agent: string; text: string; repo: string; when: string; tags?: string[] }): string {
  const tags = (input.tags ?? []).filter(Boolean);
  const tagSuffix = tags.length ? ` (tags: ${tags.join(", ")})` : "";
  return `agent ${input.agent} recorded this on ${input.when} (repository: ${input.repo}${tagSuffix}). ${input.text}`;
}

export default function activate(api: ExtensionAPI): void {
  const cfg = resolveConfig();
  if (!cfg) return;
  const client = new Graphiti(cfg);

  api.registerTool({
    name: "memory_remember",
    label: "memory_remember",
    description: `Write something into the fleet's Graphiti memory graph (this agent's group: ${cfg.agent}). Returns as soon as the note is accepted; extraction into the graph takes up to a few minutes.`,
    promptSnippet: "Remember a decision, finding or state in the fleet memory graph",
    promptGuidelines: [
      "Remember the settled thing, not the exchange: a decision, a measured number, an incident cause, a blocker. Ask memory_recall before repeating yourself.",
      "Writes are cheap here (the call returns in well under a second), so err toward recording — but one note per fact, and never invent a group name: the group is this agent's name.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: `What to remember (${MAX_TEXT_CHARS} characters max). Credential-shaped text is redacted before it is sent.` }),
      group: Type.String({ description: `Graphiti group to write into (default: this agent, ${cfg.agent}). Only name another group to hand a note to the fleet note corpus.` }),
      tags: Type.Array(Type.String(), { description: "Extra labels carried in the note's preamble" }),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = String(params.text ?? "").trim();
      if (!text) return { content: [{ type: "text", text: "memory_remember needs text. An empty note is not a memory." }], details: { error: "empty text" } };
      const note = text.length > MAX_TEXT_CHARS
        ? text.slice(0, MAX_TEXT_CHARS) + "\n…[truncated by memory_remember]"
        : text;
      // Redaction happens before the wire, always: this graph has no auth and every pod in home-dev reads it.
      const redacted = redact(note);
      const group = resolveGroup(cfg, params.group);
      const when = new Date().toISOString();
      const started = Date.now();
      try {
        const result = await client.addMessage({
          group,
          content: redacted.text,
          name: cfg.agent,
          when,
          source: `slopyphus agent ${cfg.agent}, repository ${basename(ctx?.cwd ?? hostname())}`,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text", text: `memory_remember failed (${describeFailure(result, group)}). Nothing was written.` }],
            details: { error: `http ${result.status}`, group },
          };
        }
        // A 202 is an acknowledgement. Say so, and say what would prove it.
        const hit = redacted.hits.length ? ` · ${redacted.hits.length} credential-shaped string(s) redacted` : "";
        return {
          content: [{
            type: "text",
            text: [
              `Accepted into group "${group}" (${result.status}, ${Date.now() - started} ms)${hit}.`,
              "That is an acknowledgement, not a memory: extraction runs asynchronously and a note can still be dropped if the LLM worker fails. " +
              "If it matters that the fact is now recallable, check with memory_recall in a few minutes.",
            ].join("\n"),
          }],
          details: { group, status: result.status, ms: Date.now() - started, redactions: redacted.hits.length, when },
        };
      } catch (error) {
        return { content: [{ type: "text", text: describeCallFailure(error, cfg.url, Date.now() - started, "memory_remember") }], details: { error: String(error) } };
      }
    },
  });

  api.registerTool({
    name: "memory_recall",
    label: "memory_recall",
    description: `Ask the fleet's Graphiti memory graph (this agent's group: ${cfg.agent}). Sub-second and synchronous; results are extracted facts, not the original sentences, each with the window it was valid for.`,
    promptSnippet: "Recall what the fleet has recorded about something",
    promptGuidelines: [
      "Recall before you re-derive: if the answer could already be recorded, ask memory_recall first — it costs about half a second.",
      "A fact is something somebody believed at a time. Quote its valid/invalid window when the timing matters, and treat a fact marked [expired] as history rather than instruction.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to ask the graph" }),
      group: Type.String({ description: `Only search this group (default: ${cfg.agent})` }),
      fleetWide: Type.Boolean({ description: "Search every group the key can reach instead of just this agent's (group_ids: null)" }),
      maxFacts: Type.Number({ description: `Facts to return (default ${DEFAULT_MAX_FACTS}, max ${MAX_FACTS_CAP})` }),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const query = String(params.query ?? "").trim();
      if (!query) return { content: [{ type: "text", text: "memory_recall needs a query." }], details: { error: "empty query" } };
      const groups = params.fleetWide ? null : [resolveGroup(cfg, params.group)];
      const started = Date.now();
      try {
        const result = await client.search({ query, groups, maxFacts: params.maxFacts });
        if (!result.ok) {
          return { content: [{ type: "text", text: `memory_recall failed (${describeFailure(result, groups?.join(", ") ?? "all groups")}).` }], details: { error: `http ${result.status}` } };
        }
        const formatted = formatFacts(result.body);
        const scope = params.fleetWide ? "all groups" : (groups?.[0] ?? cfg.agent);
        const head = `${formatted.hits} fact(s) · group: ${scope} · ${result.ms} ms`;
        // A fast non-empty answer is not proof of relevance: this door returns up to max_facts whatever matched, so
        // three facts about something else look exactly like three facts about the thing asked.
        const caution = formatted.hits
          ? "\n\nGraphiti returns up to max_facts whether or not they match: a full-looking answer can still be about something else. If these do not actually address the question, say so rather than paraphrasing them."
          : "\n\n" + EMPTY_HINT;
        return {
          content: [{ type: "text", text: head + "\n" + (formatted.text || "(no facts returned)") + caution }],
          details: { hits: formatted.hits, ms: result.ms, scope },
        };
      } catch (error) {
        return { content: [{ type: "text", text: describeCallFailure(error, cfg.url, Date.now() - started, "memory_recall") }], details: { error: String(error) } };
      }
    },
  });

  api.registerCommand("graphiti", {
    description: "Where this agent's memory goes: Graphiti URL, group, health, and what the service says it holds for this agent",
    handler: async (_args, ctx) => {
      const scoped = resolveConfig(process.env) ?? cfg;
      const lines = [
        `door:      ${scoped.url} (no auth: cluster-internal, every pod can read every group)`,
        `group:     ${scoped.agent}`,
        `redaction: lib/redact.ts applied to every write`,
      ];
      try {
        const health = await fetch(`${scoped.url}/healthcheck`, { signal: AbortSignal.timeout(5_000) });
        lines.push(`health:    HTTP ${health.status} ${(await health.text()).replace(/\s+/g, " ").slice(0, 80)}`);
      } catch (error) {
        lines.push(`health:    unreachable (${error instanceof Error ? error.message : String(error)})`);
      }
      try {
        const ep = await client.episodes(scoped.agent, 5);
        lines.push(`episodes:  HTTP ${ep.status}, ${ep.items.length} most recent accepted note(s)${ep.items.length ? "" : " — this group holds nothing yet"}`);
        for (const item of ep.items.slice(0, 3)) {
          const text = JSON.stringify(item).replace(/\s+/g, " ");
          lines.push(`   · ${text.slice(0, 140)}`);
        }
      } catch (error) {
        lines.push(`episodes:  could not read (${error instanceof Error ? error.message : String(error)})`);
      }
      await ctx.ui?.notify?.(lines.join("\n"), "info");
    },
  });
}

function describeFailure(result: CallResult, target: string): string {
  const detail = result.raw.replace(/\s+/g, " ").trim();
  if (result.status === 422) {
    return `422 rejected by graphiti for ${target}: the request was malformed. A message needs content, role_type and role; a group must be named exactly. ${detail}`;
  }
  if (result.status === 404) return `404 from graphiti: no such ${target}. Group names are the agent names exactly as the import used them.`;
  if (result.status >= 500) return `HTTP ${result.status} from graphiti (${target}): ${detail || "no body"}. Extraction depends on rooter being healthy — a 503 "no healthy backend serves model auto" means writes are being accepted and dropped.`;
  return `HTTP ${result.status}: ${detail || "no response body"}`;
}

function describeCallFailure(error: unknown, url: string, ms: number, action: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = /timed[ _-]?out|timeout|aborted|deadline|ETIMEDOUT/i.test(message);
  if (timedOut) {
    return `${action} stopped waiting after ${ms} ms against ${url}. A timeout means "we stopped waiting", never "nothing was remembered": a write already accepted is still being extracted, and a read that stalled says nothing about what the graph holds.`;
  }
  return `${action} could not reach graphiti at ${url} (${ms} ms): ${message}`;
}
