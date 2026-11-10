/**
 * cognee — the fleet's graph memory, spoken over HTTP.
 *
 * This replaces `parked/memory.ts` as the memory the fleet is given. The old extension wrote to a Postgres store it
 * owned; this one writes to Cognee 1.6.7 in namespace `cognee`, which ingests text, builds a knowledge graph out of
 * it (entities and relationships, via rooter for the LLM and the embeddings Service for the vectors), and answers
 * questions against that graph. Ed chose it over mem0 because mem0's FOSS build dropped the graph and the graph was
 * the point.
 *
 * Everything numeric here was measured on home-dev on 2026-11-10 from inside a pod, against
 * `http://cognee.cognee.svc.cluster.local:8000`, not copied from Cognee's documentation:
 *
 *   | call | shape | measured |
 *   | --- | --- | --- |
 *   | `POST /api/v1/remember` | `raw_data` text, foreground | 12–17 s for a one-sentence note on a quiet Cognee; **over 180 s and past this extension's own budget when a build was already running** (one API worker) |
 *   | `POST /api/v1/remember` | same with `run_in_background=true` | 0.2 s, `status: running`; dataset went ready → extracting → ready again in 60–80 s under load |
 *   | `POST /api/v1/recall` | `searchType: CHUNKS` | 245–526 ms, verbatim text back with a score |
 *   | `POST /api/v1/recall` | default (auto-routed → HYBRID_COMPLETION) | 12.5–22.4 s, a synthesized sentence, reworded |
 *   | `GET /api/v1/datasets/status/memory` | per-dataset build state | 200, `state: ready \| extracting \| empty` |
 *
 * Three traps that cost a probe each, written down so nobody pays them twice:
 *
 *   1. **`session_id` on a write is not attribution, it is a different store.** With it set, `remember` returned
 *      `status: session_stored`, `items_processed: 0`, elapsed ≈ 0, the dataset stayed `state: empty`, and `recall`
 *      answered `{"source":"system","status":"memory_warming_up"}`. Cognee puts session text in a session cache and
 *      bridges it into the graph later. The default here omits it so a write is actually in the graph when the tool
 *      returns.
 *   2. **A 200 can be a shrug.** `recall` answers 200 with `source: "system"` entries when there is nothing built
 *      yet. Treating a 200 as "here are the memories" would report a warming-up dataset as a successful read.
 *   3. **A completion answer is not the text you wrote.** HYBRID/GRAPH returned "Quokkalisk is a marker word used in
 *      the Pi-ed probe note written by Duke…" when the stored line said "The marker word is quokkalisk." Cognee
 *      capitalises and rephrases through the LLM, so exact-substring assertions against a completion result are
 *      testing the model's prose, not the memory. `CHUNKS` is the mode that returns what was actually stored.
 *   4. **Cognee answers 200 while it is mid-extraction**, with `source: "system"` and `status: memory_extracting`
 *      ("these results come from chunk-level search…"). A chunk read during a build is a partial answer, not an
 *      empty one, and the two need saying apart.
 *   5. **Aborting a write does not stop it.** A foreground `remember` blew through a 180 s budget while Cognee was
 *      busy with a previous cognify — and the note landed anyway: a recall a moment later found it. So a timeout here
 *      means "we stopped waiting", never "nothing was stored", and the extension says it that way. The same run left
 *      the dataset reporting `extracting` for two minutes afterwards. Cognee serves one worker and `strategy=recreate`
 *      (home-ops `applications/cognee/README.md`), so writes serialize: under contention `background: true` is the
 *      honest choice — 0.2 s to return, the build happens server-side.
 *
 * Which is also why `memory_recall` defaults to `chunks`: it is 50× cheaper, it is the one that shows the stored
 * words, and an agent that has to wait twenty seconds and an LLM round trip per recall will stop recalling. The
 * synthesis modes are there when a question needs the graph rather than the notes.
 *
 * Config, in the house order (a file beats an environment variable beats a default, because a mounted Secret is
 * harder to leak into a shell history than an env var):
 *
 *   - base URL — `COGNEE_URL`, then `COGNEE_BASE_URL` (the name home-ops puts in the agent manifest, usually the
 *     public door `https://cognee.dev.initialed85.cc`), default the in-cluster Service
 *     `http://cognee.cognee.svc.cluster.local:8000`.
 *   - API key — `COGNEE_API_KEY_FILE` if given, else `<mount>/api-key` where `<mount>` is `COGNEE_MOUNT_DIR` default
 *     `/run/secrets/cognee` (the `api-key` key of Secret `cognee-agent-keys`, which is where home-ops mounts it),
 *     else `/etc/cognee/api-key`, then `COGNEE_API_KEY`. With none of them, the extension is inert: it registers
 *     nothing, so a pod that has not been given the Secret simply has no memory tools rather than a tool that
 *     always fails.
 *   - dataset — `COGNEE_DATASET_FILE`, else `<mount>/dataset`, then `COGNEE_DATASET`, then
 *     `COGNEE_MEMORY_DATASET` (home-ops' name for it), default `fleet-ops`. Cognee creates a dataset on first write,
 *     so the fleet's dataset name is set once in the Secret rather than invented per agent.
 *   - agent label — `COGNEE_AGENT` then `NAME` then the session name then `host:repo`, used as Cognee's `node_set`,
 *     which is how a write carries provenance and how a read can be restricted to one agent's nodes (`nodeName`,
 *     which must be a list — a bare string is a 400).
 *
 * The key is read from disk at activation, held in a closure, and never written to a result, a log line or an error
 * message: every upstream response body this extension echoes goes through `scrub()`, which adds the live key as a
 * literal pattern. That matters because a Cognee key is 64 unlabelled hex characters — the credential *shapes* in
 * `lib/redact.ts` would not recognise one.
 *
 * Out of scope, deliberately: forgetting. Cognee exposes `DELETE /api/v1/datasets/{id}/data/{data_id}` and this
 * extension does not offer it. Deleting from a shared graph should be a decision someone made on purpose, with the
 * ids in front of them, not a tool an agent reaches for when an answer annoys it.
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redact, scrub } from "../lib/redact.ts";

const DEFAULT_URL = "http://cognee.cognee.svc.cluster.local:8000";
const DEFAULT_DATASET = "fleet-ops";
const KEY_FILE = "api-key";
const DATASET_FILE = "dataset";
const MOUNT_DIR = "/run/secrets/cognee";
const LEGACY_MOUNT_DIR = "/etc/cognee";
/**
 * home-ops mounts the agent Secret (`cognee-agent-keys`, keys `api-key` and `dataset`) at `/run/secrets/cognee` and
 * names its variables `COGNEE_BASE_URL` and `COGNEE_MEMORY_DATASET`. Both spellings are read. A manifest that says
 * one thing and an extension that reads the other is how a memory silently starts writing into the wrong graph, and
 * the mismatch is invisible from inside the session. `COGNEE_MOUNT_DIR` is the same code path with the cluster
 * dialled down to a temp directory, which is what lets the configuration tests mean something on a laptop.
 */
function mountedCandidates(file: string, env: NodeJS.ProcessEnv): string[] {
  const dir = (env.COGNEE_MOUNT_DIR ?? MOUNT_DIR).replace(/\/+$/, "");
  return [`${dir}/${file}`, `${LEGACY_MOUNT_DIR}/${file}`];
}

/**
 * Timeouts, generous because they are budgets rather than expectations.
 *
 * The measured foreground write was 13–17 s on a quiet Cognee and past 17 s when one build was already running; a
 * chunk recall measures 0.3–0.5 s. A timeout shorter than the normal case is a bug that looks like an outage.
 */
const REMEMBER_TIMEOUT_MS = 180_000;
const QUICK_TIMEOUT_MS = 30_000;
const RECALL_TIMEOUT_MS = 90_000;

/** Beyond this, a "memory" is a document, and a document is chunked and re-extracted per piece at LLM cost. */
const MAX_TEXT_CHARS = 20_000;

const MODES = {
  chunks: "CHUNKS",
  rag: "RAG_COMPLETION",
  graph: "GRAPH_COMPLETION",
  hybrid: "HYBRID_COMPLETION",
} as const;
type Mode = keyof typeof MODES;

export type CogneeConfig = {
  url: string;
  key: string;
  dataset: string;
  agent: string;
  keySource: string;
};

function readSecretFile(path: string | undefined): { value?: string; source?: string } {
  if (!path) return {};
  try {
    const value = readFileSync(path, "utf8").trim();
    // An empty mounted file is how a Secret with the wrong key name looks. Treating it as unset keeps the failure
    // at "no credentials" rather than "401 with a blank key".
    return value ? { value, source: path } : {};
  } catch {
    return {};
  }
}

/** The first candidate that exists and is non-empty, reported with the path it came from. */
function readFirstFile(paths: string[]): { value?: string; source?: string } {
  for (const path of paths) {
    const found = readSecretFile(path);
    if (found.value) return found;
  }
  return {};
}

/**
 * Resolve the configuration, or return undefined when this process has no business talking to Cognee.
 *
 * `agent` is resolved last and from the caller's context rather than from the environment alone, because the
 * session name is the one identity a human chose on purpose. The rest of the fleet's fallback order lives in
 * `parked/memory.ts` and in the schedule extension; this repeats the short version rather than importing it from a
 * parked module, so a parked extension is not load-bearing for a live one.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  ctx?: Pick<ExtensionContext, "cwd"> & Partial<ExtensionContext>,
): CogneeConfig | undefined {
  const namedKeyFile = readSecretFile(env.COGNEE_API_KEY_FILE);
  const fromFile = namedKeyFile.value ? namedKeyFile : readFirstFile(mountedCandidates(KEY_FILE, env));
  const key = fromFile.value ?? env.COGNEE_API_KEY?.trim();
  if (!key) return undefined;
  const namedDatasetFile = readSecretFile(env.COGNEE_DATASET_FILE);
  const datasetFile = namedDatasetFile.value ? namedDatasetFile : readFirstFile(mountedCandidates(DATASET_FILE, env));
  const named = ctx?.sessionManager?.getSessionName?.()?.trim();
  const agent = env.COGNEE_AGENT?.trim() || env.NAME?.trim() || named || `${hostname()}:${basename(ctx?.cwd ?? process.cwd())}`;
  return {
    url: (env.COGNEE_URL ?? env.COGNEE_BASE_URL ?? DEFAULT_URL).replace(/\/+$/, ""),
    key,
    dataset: datasetFile.value ?? env.COGNEE_DATASET?.trim() ?? env.COGNEE_MEMORY_DATASET?.trim() ?? DEFAULT_DATASET,
    agent,
    keySource: fromFile.source ?? "COGNEE_API_KEY",
  };
}

export type RememberInput = {
  text: string;
  dataset?: string;
  tags?: string[];
  background?: boolean;
};

/** The multipart body of a write. Its own function so the field names can be asserted without a network. */
export function rememberForm(input: RememberInput, cfg: Pick<CogneeConfig, "dataset" | "agent">): FormData {
  const form = new FormData();
  // `raw_data` is Cognee's string path. The alternative is `data`, which wants file uploads: an agent's sentence is
  // not a file, and inventing one to satisfy the API would be theatre.
  form.set("raw_data", input.text);
  form.set("datasetName", input.dataset ?? cfg.dataset);
  const tags = [cfg.agent, ...(input.tags ?? [])].filter((tag, index, all) => tag && all.indexOf(tag) === index);
  if (tags.length) form.set("node_set", tags.join(","));
  // Deliberately no session_id: see the header. Cognee's session path defers the graph, and a tool that returns
  // "stored" about something still sitting in a cache is a lie with extra latency.
  if (input.background) form.set("run_in_background", "true");
  return form;
}

export type RecallInput = {
  query: string;
  dataset?: string;
  mode?: Mode;
  topK?: number;
  tags?: string[];
};

/** The JSON body of a read. `datasets` is omitted rather than sent empty: empty means a different question. */
export function recallPayload(input: RecallInput, cfg: Pick<CogneeConfig, "dataset">): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    query: input.query,
    topK: Math.min(20, Math.max(1, Math.floor(input.topK ?? 5))),
    searchType: MODES[input.mode ?? "chunks"],
  };
  if (input.dataset) payload.datasets = [input.dataset];
  const tags = (input.tags ?? []).filter(Boolean);
  // Cognee validates nodeName as a list; a bare string is a 400 with a body that blames the caller.
  if (tags.length) payload.nodeName = tags;
  return payload;
}

export type FormattedRecall = { text: string; hits: number; note?: string };

/**
 * Turn Cognee's discriminated recall entries into something an agent can read, and say which kind they were.
 *
 * `source: "system"` entries are Cognee talking about itself — "memory is still warming up", a failed extraction —
 * not a memory. They are reported as what they are rather than counted as results, because the difference between
 * "nothing matched" and "nothing has been built yet" is the difference between a bad question and an unhealthy
 * service.
 */
export function formatRecall(items: unknown, datasetLabel: string): FormattedRecall {
  const entries = Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
  const lines: string[] = [];
  const system: string[] = [];
  let hits = 0;
  for (const entry of entries) {
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    if (!text) continue;
    if (entry?.source === "system") {
      system.push(`${String(entry.status ?? "notice")}: ${text}`);
      continue;
    }
    hits += 1;
    const meta = [
      typeof entry?.kind === "string" ? entry.kind : undefined,
      typeof entry?.search_type === "string" ? entry.search_type : undefined,
      typeof entry?.score === "number" ? `score ${entry.score.toFixed(3)}` : undefined,
      typeof entry?.dataset_name === "string" ? entry.dataset_name : datasetLabel,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${hits}. ${text}${meta ? `  _${meta}_` : ""}`);
  }
  const text = [...(system.length ? [`cognee says: ${system.join(" | ")}`] : []), ...lines].join("\n");
  const note = !hits && system.length ? "no memories returned" : hits ? undefined : "nothing matched";
  return { text: text || "nothing matched", hits, note };
}

export type CallResult = { ok: boolean; status: number; body: unknown; raw: string; ms: number };

/** A Cognee call that a test can replace. Everything above this line is pure. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class Cognee {
  private cfg: CogneeConfig;
  private fetch: FetchLike;

  constructor(cfg: CogneeConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
  }

  /** One place builds the request, so the auth header (and its absence from any output) is asserted once. */
  private async call(path: string, init: RequestInit, timeoutMs: number): Promise<CallResult> {
    const started = Date.now();
    const response = await this.fetch(`${this.cfg.url}${path}`, {
      ...init,
      headers: { "X-Api-Key": this.cfg.key, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    // `scrub` carries the live key as a literal rule: an upstream body that ever echoes a credential back must not
    // be the way this fleet finds out about it.
    const shown = scrub(raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw, [this.cfg.key]);
    let body: unknown = undefined;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    return { ok: response.ok, status: response.status, body, raw: shown.text, ms: Date.now() - started };
  }

  async remember(input: RememberInput): Promise<CallResult> {
    return this.call("/api/v1/remember", { method: "POST", body: rememberForm(input, this.cfg) }, input.background ? QUICK_TIMEOUT_MS : REMEMBER_TIMEOUT_MS);
  }

  async recall(input: RecallInput): Promise<CallResult> {
    return this.call("/api/v1/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(recallPayload(input, this.cfg)) }, RECALL_TIMEOUT_MS);
  }

  /** Per-dataset build state. The distinction between "searchable" and "graph built" is the one a dashboard hides. */
  async status(): Promise<CallResult> {
    return this.call("/api/v1/datasets/status/memory", { method: "GET" }, QUICK_TIMEOUT_MS);
  }
}

/** How a failed call should be described to an agent, with enough to act on and no secrets in it. */
/**
 * A failed call is two different facts, and an agent needs to know which one it was told.
 *
 * A connection that was refused or a name that did not resolve means the store is not there. A call that ran out of
 * its budget means the store exists and is busy — Cognee serves one worker, so an in-flight build blocks reads
 * outright (measured: recall calls timing out at 120 s with zero bytes while a cognify ran). The first is "no
 * information available"; the second is "unknown", and neither one is "nothing was remembered".
 */
export function describeCallFailure(error: unknown, url: string, ms: number, tool: string): string {
  const message = scrub(error instanceof Error ? error.message : String(error), []).text.replace(/\s+/g, " ").trim();
  const timedOut = /timeout|aborted|deadline/i.test(message);
  if (timedOut) {
    return `${tool} stopped waiting for cognee at ${url} after ${ms} ms. cognee serves one worker, so it is likely busy building rather than refusing — treat this as unknown, not as nothing remembered, and not as a licence to write the same note again.`;
  }
  return `${tool} could not reach cognee at ${url}: ${message} (${ms} ms). Treat this as no information, not as a negative.`;
}

export function describeFailure(result: CallResult, action: string): string {
  const detail = result.raw.replace(/\s+/g, " ").trim();
  if (result.status === 401 || result.status === 403) {
    return `${action} refused by cognee (${result.status}): the API key is wrong, revoked, or not permitted for that dataset. Check the mounted Secret cognee-agent-keys.`;
  }
  if (result.status === 422) return `${action} rejected by cognee (422): the request was malformed. ${detail}`;
  return `${action} failed (HTTP ${result.status}): ${detail || "no response body"}`;
}

export function describeStatus(body: unknown, dataset: string): string {
  if (!body || typeof body !== "object") return "cognee did not describe its datasets";
  const entries = Object.entries(body as Record<string, Record<string, unknown>>);
  if (!entries.length) return "cognee reports no datasets";
  return entries
    .map(([id, state]) => {
      const name = typeof state?.dataset_name === "string" ? state.dataset_name : id.slice(0, 8);
      const flagged = name === dataset ? " ← this agent writes here" : "";
      return `${name}: ${String(state?.state ?? "?")} (${String(state?.message ?? "no message")})${flagged}`;
    })
    .join("\n");
}

export default function activate(api: ExtensionAPI): void {
  const cfg = resolveConfig();
  if (!cfg) return;
  const client = new Cognee(cfg);

  api.registerTool({
    name: "memory_remember",
    label: "memory_remember",
    // Built from the resolved config rather than the constant: a pod whose mounted dataset is `fleet-ops` and a pod
    // whose Secret says something else must not be shown the same sentence about where its memory goes.
    description: `Write something into the fleet's cognee graph (this agent's dataset: ${cfg.dataset}). Foreground by default: the graph is built before this returns.`,
    promptSnippet: "Remember a decision, finding or state in the fleet graph",
    // The old extension captured transcripts continuously; cognee is not fed that way — it re-extracts every
    // sentence it is given through an LLM, at roughly one call per chunk. So the guidance is about choosing: the
    // graph is worth paying for once per decision, not once per message.
    promptGuidelines: [
      "Remember the settled thing, not the exchange: a decision, a measured number, an incident cause, a blocker. Ask memory_recall before repeating yourself.",
      "One memory_remember per decision. Background (background=true) when the note is long or the answer does not need it yet — it returns in ~0.1 s and the graph lands seconds later.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: `What to remember (${MAX_TEXT_CHARS} characters max). Credential-shaped text is redacted before it is sent.` }),
      dataset: Type.String({ description: `Cognee dataset to write to (this agent's default: ${cfg.dataset})` }),
      tags: Type.Array(Type.String(), { description: "Extra node-set labels (this agent's name is always included)" }),
      background: Type.Boolean({ description: "Return as soon as the note is accepted; cognee builds the graph server-side" }),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agent = resolveConfig(process.env, ctx) ?? cfg;
      const text = String(params.text ?? "").trim();
      if (!text) return { content: [{ type: "text", text: "memory_remember needs text. An empty note is not a memory." }], details: { error: "empty text" } };
      if (text.length > MAX_TEXT_CHARS) {
        return { content: [{ type: "text", text: `memory_remember refuses ${text.length} characters; the cap is ${MAX_TEXT_CHARS}. Summarise the note, or write the document to the repo and remember the decision about it.` }], details: { error: "too long", chars: text.length } };
      }
      const scrubbed = redact(text);
      const started = Date.now();
      try {
        const result = await client.remember({ text: scrubbed.text, dataset: params.dataset ?? agent.dataset, tags: params.tags, background: params.background === true });
        if (!result.ok) return { content: [{ type: "text", text: describeFailure(result, "memory_remember") }], details: { error: `http ${result.status}` } };
        const body = (result.body ?? {}) as Record<string, unknown>;
        const flags = [`dataset ${String(body.dataset_name ?? params.dataset ?? cfg.dataset)}`, `cognee ${result.ms} ms`];
        if (body.status) flags.push(`status ${String(body.status)}`);
        if (typeof body.items_processed === "number") flags.push(`${body.items_processed} item(s) processed`);
        const lines = [`remembered (${flags.join(", ")})`];
        if (body.status === "session_stored") {
          lines.push("cognee stored this in a session cache rather than the graph; it will be bridged later, so memory_recall may not see it yet.");
        }
        if (params.background) lines.push("the graph is still building — memory_recall may lag this write by tens of seconds.");
        if (scrubbed.hits.length) lines.push(`redacted: ${scrubbed.hits.join(", ")}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { dataset: body.dataset_name, status: body.status, ms: result.ms, redacted: scrubbed.hits } };
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : String(error), [cfg.key]).text.replace(/\s+/g, " ");
        // A timeout is not a rollback. Cognee's pipeline outlives this request (measured: a write that aborted at
        // 180 s was found by a recall a moment later), so saying "nothing was stored" would invite a duplicate write.
        return { content: [{ type: "text", text: `${describeCallFailure(error, cfg.url, Date.now() - started, "memory_remember")} The note may still be building server-side either way — check with memory_recall or /cognee before writing it again, or use background=true next time.` }], details: { error: message } };
      }
    },
  });

  api.registerTool({
    name: "memory_recall",
    label: "memory_recall",
    description: `Ask the fleet's cognee graph (this agent's dataset: ${cfg.dataset}). Default mode is chunks (verbatim stored text, sub-second); graph/hybrid modes synthesize across the graph and cost an LLM round trip (10–25 s).`,
    promptSnippet: "Recall from the fleet graph (chunks = fast verbatim, graph = synthesized)",
    promptGuidelines: [
      "Run one memory_recall before web_search or a guess about something this fleet already settled. chunks is the default for a fact; graph only when the question spans several notes.",
      "Absence is an answer. If chunks returns nothing, say so — cognee's completion modes rephrase, so never quote them as a stored sentence.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The question or the words to look for" }),
      mode: Type.Union([Type.Literal("chunks"), Type.Literal("rag"), Type.Literal("graph"), Type.Literal("hybrid")], { description: "chunks = vector search over stored text (default); rag = completion over chunks; graph = walk the graph; hybrid = both" }),
      dataset: Type.String({ description: `Restrict to one dataset (this agent's default: ${cfg.dataset}). Omit to search every dataset the key can read.` }),
      topK: Type.Number({ description: "Maximum results (default 5, max 20)" }),
      tags: Type.Array(Type.String(), { description: "Restrict to node sets, e.g. one agent's name" }),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agent = resolveConfig(process.env, ctx) ?? cfg;
      const query = String(params.query ?? "").trim();
      if (!query) return { content: [{ type: "text", text: "memory_recall needs a query." }], details: { error: "empty query" } };
      const mode = (params.mode ?? "chunks") as Mode;
      // A completion mode asks rooter to write prose; chunks does not. Say which one is being paid for, in the
      // result, so an agent can decide whether the second call is worth it.
      const started = Date.now();
      try {
        const result = await client.recall({ query, dataset: params.dataset, mode, topK: params.topK, tags: params.tags });
        if (!result.ok) return { content: [{ type: "text", text: describeFailure(result, "memory_recall") }], details: { error: `http ${result.status}` } };
        const formatted = formatRecall(result.body, params.dataset ?? cfg.dataset);
        const head = `${formatted.hits} result(s) · ${mode} · ${result.ms} ms${formatted.note ? ` · ${formatted.note}` : ""}`;
        return { content: [{ type: "text", text: [head, formatted.text].filter(Boolean).join("\n") }], details: { hits: formatted.hits, mode, ms: result.ms } };
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : String(error), [cfg.key]).text.replace(/\s+/g, " ");
        return { content: [{ type: "text", text: describeCallFailure(error, cfg.url, Date.now() - started, "memory_recall") }], details: { error: message } };
      }
    },
  });

  api.registerCommand("cognee", {
    description: "Where this agent's memory goes: cognee URL, dataset, agent label, and whether the graph is built",
    handler: async (_args, ctx) => {
      const agent = resolveConfig(process.env, ctx) ?? cfg;
      const lines = [
        `cognee ${agent.url}`,
        `dataset ${agent.dataset} · agent label ${agent.agent} · key from ${agent.keySource} (value not shown)`,
      ];
      try {
        const result = await client.status();
        lines.push(result.ok ? describeStatus(result.body, agent.dataset) : describeFailure(result, "cognee status"));
      } catch (error) {
        lines.push(`status unavailable: ${scrub(error instanceof Error ? error.message : String(error), [cfg.key]).text}`);
      }
      lines.push("parked/memory.ts is still parked; this fleet's durable memory is in cognee now.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
