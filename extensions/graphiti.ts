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
 * `memory_expire` is the exception, and the distinction is the one that matters: it closes a validity window and
 * leaves the fact in the graph as history, so it cannot destroy a record — which is exactly what a wrong fact
 * needs, and what prose could not do (see `expireStatement`).
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
/**
 * Closing a fact's window is a Neo4j write, not a Graphiti one: the service exposes no invalidate route at all
 * (`GET /openapi.json` lists `POST /search`, `GET|DELETE /entity-edge/{uuid}`, `POST /entity-node`,
 * `GET /episodes/{group_id}`, `POST /get-memory`, `POST|DELETE /messages|/episode/{uuid}`, `POST /entity-node`,
 * `POST /clear`, `DELETE /group/{group_id}` — the only ways to change a fact edge are to delete it or to nuke the
 * partition). `invalid_at` and `expired_at` are plain properties on `:RELATES_TO`, so the directed operation is one
 * statement. It lives here because prose is not one: maclet measured, twice, that a `SUPERSEDE` note leaves the
 * false fact `still held` beside a correction the extractor stamps with a zero-length validity window, which is a
 * tombstone of the right answer and strictly worse than silence. Unset means the tool is not registered.
 */
const NEO4J_URL_ENV = "PI_MEMORY_NEO4J_URL";
const NEO4J_AUTH_ENV = "PI_MEMORY_NEO4J_AUTH";
const CLOSE_TIMEOUT_MS = 10_000;
const MAX_EXPIRE_IDS = 20;
/** Retrieval returns `max_facts` whatever the relevance; the door's own default is 10 and asking harder changes nothing. */
const DEFAULT_MAX_FACTS = 10;
const MAX_FACTS_CAP = 20;

type Config = { url: string; agent: string };

/**
 * Neo4j HTTP endpoint plus credentials; both must be present or expire is not offered.
 *
 * The separator is accepted in either form, because the two sources disagree by nature: the `memory-db` secret
 * stores it the way Neo4j's own `NEO4J_AUTH` is written (`user/password`), while a human pasting credentials into a
 * ConfigMap writes `user:password`. Requiring exactly one and registering nothing otherwise is the worst failure
 * shape this door can have — home-ops hit precisely that wiring it from the secret, and from the agent's side an
 * absent tool is indistinguishable from an unconfigured pod. So normalise both.
 */
export function resolveNeo4j(env: NodeJS.ProcessEnv = process.env): { url: string; auth: string } | null {
  const url = (env[NEO4J_URL_ENV] ?? "").trim().replace(/\/+$/, "");
  const raw = (env[NEO4J_AUTH_ENV] ?? "").trim();
  if (!url || !raw || !/^https?:\/\//.test(url)) return null;
  const colonAt = raw.indexOf(":");
  const slashAt = raw.indexOf("/");
  // Whichever separator appears first is the one that split this string, so a password containing the other form
  // survives intact instead of landing half of itself in the username.
  const separator = colonAt < 0 ? (slashAt < 0 ? null : "/")
    : slashAt < 0 ? ":"
    : slashAt < colonAt ? "/" : ":";
  if (!separator) return null;
  const [user, ...rest] = raw.split(separator);
  const password = rest.join(separator);
  if (!user || !password) return null;
  return { url, auth: `${user}:${password}` };
}

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

/** The statement that closes a fact's window, kept pure and named so a test can read what it writes. */
export function expireStatement(ids: string[], group: string, when: string, reason: string): { statement: string; parameters: Record<string, unknown> } {
  return {
    // Only edges in the named group, and only ones still open: an id from another partition matches nothing here
    // rather than quietly closing somebody else's fact.
    statement: "MATCH ()-[e:RELATES_TO]->() WHERE e.uuid IN $ids AND e.group_id = $group AND e.invalid_at IS NULL "
      + "SET e.invalid_at = datetime($when), e.expired_at = datetime($when), e.superseded_by = $reason "
      + "RETURN count(e) AS closed, collect(e.uuid) AS closed_ids",
    parameters: { ids, group, when, reason },
  };
}

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
    // The id is printed because it is the address: without it a recalled-but-wrong fact cannot be closed by the
    // agent that found it, which is the whole reason the fleet has been propagating retractions by prose.
    const id = f?.uuid ? ` · id ${String(f.uuid)}` : "";
    return `${index + 1}. ${fact} (valid ${valid}${invalid})${expired}${group}${id}`;
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
  const neo4j = resolveNeo4j();

  /** Close the window on the named fact edges. Returns how many actually moved, which is the only honest report. */
  async function expireFacts(ids: string[], group: string, reason: string): Promise<{ closed: number; closedIds: string[]; ms: number }> {
    const when = new Date().toISOString();
    const started = Date.now();
    const response = await fetch(`${neo4j!.url}/db/neo4j/tx/commit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(neo4j!.auth).toString("base64")}`,
      },
      body: JSON.stringify({ statements: [expireStatement(ids, group, when, reason)] }),
      signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(`HTTP ${response.status} from neo4j`);
    const errors = (body?.errors ?? []) as Array<{ code?: string; message?: string }>;
    if (errors.length) throw new Error(`${errors[0]?.code ?? "neo4j"}: ${errors[0]?.message ?? "no message"}`);
    const results = (body?.results ?? []) as Array<{ data?: Array<{ row?: unknown[] }> }>;
    const row = results[0]?.data?.[0]?.row as [number, string[]] | undefined;
    return { closed: Number(row?.[0] ?? 0), closedIds: (row?.[1] ?? []) as string[], ms: Date.now() - started };
  }

  api.registerTool({
    name: "memory_remember",
    label: "memory_remember",
    description: `Write something into the fleet's Graphiti memory graph (this agent's group: ${cfg.agent}). Returns as soon as the note is accepted; extraction into the graph takes up to a few minutes.`,
    promptSnippet: "Remember a decision, finding or state in the fleet memory graph",
    promptGuidelines: [
      "Remember the settled thing, not the exchange: a decision, a measured number, an incident cause, a blocker. Ask memory_recall before repeating yourself.",
      "Writes are cheap here (the call returns in well under a second), so err toward recording — but one note per fact, and never invent a group name: the group is this agent's name.",
      // Measured 2026-11-24: a six-paragraph note came back out of the graph as one sentence, and the caveat and
      // the pointer were the parts that were dropped. Extraction distils; it does not summarise on purpose.
      "One fact per note, stated as the sentence you would want back: extraction distils a paragraph into one or two facts and drops the rest, so the load-bearing clause goes first and the evidence goes in a commit, file or message id the note names.",
      "Record who decided and what it supersedes: 'X chose A over B because C, supersedes the note of DATE' survives extraction as an attributable, datable claim, where 'we discussed and it seems better' does not.",
      // Measured 2026-11-26 (maclet, group maclet, twice): a `SUPERSEDE (invalidated as of …)` note did not close the
      // fact it retracted. The false fact stayed `still held`, and the correction came out of the extractor with
      // valid_at == invalid_at — a zero-length window, i.e. a tombstone of the right answer. Contradiction does not
      // invalidate, and a negation-shaped sentence re-seeds the myth as a new live fact.
      "To reverse something already recorded, expire it by id with memory_expire; prose that negates it does not close it and often re-seeds it. If memory_expire is not offered in this pod, name the retracted claim exactly, say it is dead, and ask a human to close the edge.",
      "State what is true now rather than what is no longer true: 'nullfs is entitlement-gated and returns EPERM' survives extraction as a fact, 'nullfs does NOT fail for a missing module' survives as a negation that keeps the dead theory in circulation.",
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
          // Provenance, and it has to name the writer: the draft carried `slopyphus agent …` into every note the
          // fleet would ever write, which puts a wrong attribution on every node in a graph whose whole job is
          // saying who believed what.
          source: `pi-ed agent ${cfg.agent}, repository ${basename(ctx?.cwd ?? hostname())}`,
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
      "Every line ends with `id <uuid>`: that is the handle memory_expire takes, so a recalled-but-wrong fact is fixable in the same turn you found it. Quote the id when you report one you are about to retract.",
      // Measured 2026-11-24: three consecutive recall calls returned 8-10 confident facts, none of them about the
      // thing asked. The graph fills the quota; relevance is the reader's job.
      "A full-looking answer can be about something else: the graph returns up to maxFacts whether or not they match, so discard what does not address the question and say so rather than paraphrasing a near-miss.",
      "An empty or off-target recall is not evidence it was never recorded. Default scope is this agent's group, so retry with fleetWide before concluding absence — and note that a fresh write is not recallable for minutes, because extraction is asynchronous.",
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

  // Registered only when the pod has been given Neo4j write access, for the same reason the other doors are: an
  // unconfigured tool that always fails is worse than no tool, and this one cannot fall back to prose.
  if (neo4j) {
    api.registerTool({
      name: "memory_expire",
      label: "memory_expire",
      description: `Close the validity window on fact(s) this group has recorded, by the id memory_recall prints. Use it when a recorded claim is wrong or has stopped being true: writing a contradicting note does NOT expire the old one.`,
      promptSnippet: "Expire a recorded fact by id instead of leaving a contradiction in the graph",
      promptGuidelines: [
        "Expire, do not negate: a wrong fact stays `still held` until its window is closed, and a note that contradicts it just adds a second live claim.",
        "Take the id from memory_recall's `id <uuid>` suffix. Ids from another group close nothing here, so name the group only when you are deliberately closing that partition's fact.",
        "Expire is not delete: the fact stays in the graph as history with a closed window, so the record of what was believed and when it was dropped survives.",
      ],
      parameters: Type.Object({
        ids: Type.Array(Type.String(), { description: `Fact edge uuids to close (${MAX_EXPIRE_IDS} max), exactly as memory_recall prints them` }),
        group: Type.String({ description: `Group the facts belong to (default: ${cfg.agent}). A wrong group matches nothing rather than touching another partition.` }),
        reason: Type.String({ description: "One line on what replaced it — stored on the edge as superseded_by so a later reader can see why the window closed" }),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const ids = (Array.isArray(params.ids) ? params.ids : [])
          .map((id) => String(id ?? "").trim())
          .filter(Boolean)
          .slice(0, MAX_EXPIRE_IDS);
        if (!ids.length) {
          return { content: [{ type: "text", text: "memory_expire needs ids from memory_recall's `id <uuid>` suffix. Nothing was closed." }], details: { error: "no ids" } };
        }
        const group = resolveGroup(cfg, params.group);
        const reason = String(params.reason ?? "").replace(/\s+/g, " ").trim() || "expired by its writer";
        const started = Date.now();
        try {
          const result = await expireFacts(ids, group, reason);
          const missed = ids.length - result.closed;
          const lines = [
            result.closed
              ? `Closed the window on ${result.closed} fact(s) in group "${group}" (${result.ms} ms). They stay in the graph as history, marked expired.`
              : `Closed nothing. ${ids.length} id(s) matched no open fact in group "${group}" — wrong group, already closed, or not a fact edge.`,
          ];
          if (missed > 0 && result.closed > 0) lines.push(`  ${missed} of ${ids.length} id(s) matched nothing open in that group.`);
          lines.push("Write the corrected fact with memory_remember after this; expiry alone leaves the slot empty.");
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { group, closed: result.closed, requested: ids.length, ids: result.closedIds, reason, ms: Date.now() - started },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `memory_expire could not close these facts (${message}). The old claims are still held; retry or ask a human to run the close.`,
            }],
            details: { error: message, group, requested: ids.length, ms: Date.now() - started },
          };
        }
      },
    });
  }

  api.registerCommand("graphiti", {
    description: "Where this agent's memory goes: Graphiti URL, group, health, and what the service says it holds for this agent",
    handler: async (_args, ctx) => {
      const scoped = resolveConfig(process.env) ?? cfg;
      const lines = [
        `door:      ${scoped.url} (no auth: cluster-internal, every pod can read every group)`,
        `group:     ${scoped.agent}`,
        `redaction: lib/redact.ts applied to every write`,
      ];
      // Say whether expire is wired, and in what shape it would be misconfigured. home-ops spent time discovering
      // that a secret in `user/password` form had silently registered nothing; an operator reading this line should
      // not have to derive that from an absent tool.
      const neo4jNow = resolveNeo4j(process.env);
      const rawAuth = (process.env[NEO4J_AUTH_ENV] ?? "").trim();
      if (neo4jNow) {
        lines.push(`expire:    enabled via ${neo4jNow.url}`);
      } else if (process.env[NEO4J_URL_ENV] || rawAuth) {
        lines.push(`expire:    NOT enabled despite ${NEO4J_URL_ENV}/${NEO4J_AUTH_ENV} being set — needs a URL plus credentials as user:pass or user/pass`);
      } else {
        lines.push(`expire:    not configured (${NEO4J_URL_ENV}/${NEO4J_AUTH_ENV} unset on this pod), so memory_expire is absent`);
      }
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
