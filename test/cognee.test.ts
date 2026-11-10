import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakePi, type FakePi } from "./harness.ts";
import { Cognee, describeFailure, describeStatus, formatRecall, recallPayload, rememberForm, resolveConfig } from "../extensions/cognee.ts";

/**
 * The cognee extension, tested without cognee.
 *
 * Everything asserted here is the part a live round trip cannot prove cheaply or honestly: that the field names are
 * the ones Cognee accepts (measured against the live OpenAPI document on 2026-11-10), that a credential does not
 * escape in an error, and that a 200 which means "nothing is built yet" is not reported as a successful read. The
 * live behaviour is proven separately, from inside a pod, by `hack/cognee-live-check.mjs`.
 */

const FAKE_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

let scratch: string;
let keyFile: string;
/** An empty directory standing in for the mount point, so the extension's default-path fallback is exercised
 * against a mount that has nothing in it unless a test deliberately puts a file there. Without this, a suite that
 * writes a key anywhere under the scratch dir would silently satisfy "no credentials" tests. */
let mountDir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pi-ed-cognee-"));
  mountDir = join(scratch, "run-secrets-cognee");
  mkdirSync(mountDir);
  keyFile = join(scratch, "api-key");
  writeFileSync(keyFile, `${FAKE_KEY}\n`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The environment an agent pod actually has: a mounted key file, a mounted dataset, NAME set, nothing else. */
function podEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // Stripped wholesale rather than name by name. This suite runs inside pods that really do have a cognee Secret
  // mounted and COGNEE_* set by home-ops, and a configuration test that inherits them is not testing the
  // extension's rules — it is testing the pod it happens to run in.
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) if (!key.startsWith("COGNEE_")) env[key] = process.env[key];
  return { ...env, COGNEE_MOUNT_DIR: mountDir, COGNEE_API_KEY_FILE: keyFile, COGNEE_DATASET_FILE: join(scratch, "dataset"), NAME: "pi-ed", ...extra };
}

function writeDataset(name = "fleet-ops"): string {
  const path = join(scratch, "dataset");
  writeFileSync(path, `${name}\n`);
  return path;
}

function fakeResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

/** A fetch double that records what was actually sent, which is the only way to assert on field names. */
function recordingFetch(response: () => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    seen.push({ url, init });
    return response();
  };
  return { seen, impl };
}

async function formEntries(body: BodyInit | null | undefined): Promise<Map<string, string[]>> {
  const entries = new Map<string, string[]>();
  if (!(body instanceof FormData)) return entries;
  for (const [key, value] of body.entries()) entries.set(key, [...(entries.get(key) ?? []), String(value)]);
  return entries;
}

describe("configuration", () => {
  it("is inert with no key anywhere, which is the state a pod without the Secret is in", () => {
    const env = podEnv();
    delete env.COGNEE_API_KEY_FILE;
    expect(resolveConfig(env)).toBeUndefined();
  });

  it("prefers a mounted Secret file over an environment variable, and says which one it used", () => {
    writeDataset();
    const cfg = resolveConfig(podEnv({ COGNEE_API_KEY: "an-env-key-should-lose-here" }));
    expect(cfg?.key).toBe(FAKE_KEY);
    expect(cfg?.keySource).toBe(keyFile);
    expect(cfg?.dataset).toBe("fleet-ops");
    expect(cfg?.agent).toBe("pi-ed");
    expect(cfg?.url).toBe("http://cognee.cognee.svc.cluster.local:8000");
  });

  it("falls back to the environment when there is no file, so a laptop can use it too", () => {
    const env = podEnv({ COGNEE_API_KEY: FAKE_KEY });
    delete env.COGNEE_API_KEY_FILE;
    delete env.COGNEE_DATASET_FILE;
    const cfg = resolveConfig(env, { cwd: "/workspace/pi-ed" });
    expect(cfg?.key).toBe(FAKE_KEY);
    expect(cfg?.keySource).toBe("COGNEE_API_KEY");
    // The default dataset is a decision, not a placeholder: agents inventing dataset names is how a fleet ends up
    // with eleven graphs that cannot see each other.
    expect(cfg?.dataset).toBe("fleet-ops");
  });

  it("finds a key at the mount point with no COGNEE_API_KEY_FILE, which is what a home-ops pod looks like", () => {
    // The pod manifest mounts the Secret and sets no per-file variable at all: the extension has to know where a
    // mount lands. `COGNEE_MOUNT_DIR` is the same code path with the cluster dialled down to a temp directory.
    const env = podEnv();
    delete env.COGNEE_API_KEY_FILE;
    delete env.COGNEE_API_KEY;
    expect(resolveConfig(env)).toBeUndefined(); // an empty mount is still no credentials

    writeFileSync(join(mountDir, "api-key"), `${FAKE_KEY}\n`);
    writeFileSync(join(mountDir, "dataset"), "from-the-mount\n");
    const cfg = resolveConfig(env);
    expect(cfg?.key).toBe(FAKE_KEY);
    expect(cfg?.keySource).toBe(join(mountDir, "api-key"));
    expect(cfg?.dataset).toBe("from-the-mount");
  });

  it("honours home-ops' spelling (COGNEE_BASE_URL) and a Secret mounted at /run/secrets/cognee", () => {
    // home-ops writes the agent manifest with COGNEE_BASE_URL and mounts cognee-agent-keys at /run/secrets/cognee.
    // Reading only my own preferred names would mean the pod's setting is silently ignored, which is how a fleet
    // ends up pointing at the wrong cognee and nobody noticing.
    const env = podEnv({ COGNEE_BASE_URL: "https://cognee.dev.initialed85.cc/" });
    delete env.COGNEE_URL;
    expect(resolveConfig(env)?.url).toBe("https://cognee.dev.initialed85.cc");

    // COGNEE_URL still wins when both are present, so an explicit override in a pod is never second-guessed.
    expect(resolveConfig(podEnv({ COGNEE_BASE_URL: "https://public.example", COGNEE_URL: "http://in-cluster.example" }))?.url).toBe("http://in-cluster.example");
  });

  it("reads a dataset from the mounted file, then COGNEE_MEMORY_DATASET, then the fleet default", () => {
    writeDataset();
    const env = podEnv({ COGNEE_MEMORY_DATASET: "from-the-env-var" });
    // An explicit COGNEE_DATASET_FILE is what a mount with a non-default key name looks like, so it outranks a
    // variable a manifest author typed by hand.
    expect(resolveConfig(env)?.dataset).toBe("fleet-ops");
    delete env.COGNEE_DATASET_FILE;
    expect(resolveConfig(env)?.dataset).toBe("from-the-env-var");
    delete env.COGNEE_MEMORY_DATASET;
    expect(resolveConfig(env)?.dataset).toBe("fleet-ops"); // the shared default, not an invented one
  });

  it("treats an empty mounted file as no credentials rather than a blank key", () => {
    writeFileSync(keyFile, "  \n");
    const env = podEnv();
    delete env.COGNEE_API_KEY;
    expect(resolveConfig(env)).toBeUndefined();
  });

  it("registers nothing at all when unconfigured, and the full surface when configured", async () => {
    const unconfigured = createFakePi();
    const mod = await import("../extensions/cognee.ts");
    const saved = { ...process.env };
    try {
      process.env = podEnv({ COGNEE_API_KEY_FILE: join(scratch, "does-not-exist") });
      delete process.env.COGNEE_API_KEY;
      mod.default(unconfigured as never);
    } finally {
      process.env = saved;
    }
    expect(unconfigured.tools.size).toBe(0);
    expect(unconfigured.commands.size).toBe(0);

    writeDataset();
    const configured = createFakePi();
    try {
      process.env = podEnv();
      mod.default(configured as never);
    } finally {
      process.env = saved;
    }
    expect([...configured.tools.keys()].sort()).toEqual(["memory_recall", "memory_remember"]);
    expect([...configured.commands.keys()]).toEqual(["cognee"]);
  });
});

describe("the write request", () => {
  it("sends raw_data, the dataset and the agent as a node set — and never a session_id", async () => {
    const { seen, impl } = recordingFetch(() => fakeResponse(200, { status: "completed", dataset_name: "fleet-ops", items_processed: 2 }));
    writeDataset();
    const cfg = resolveConfig(podEnv())!;
    const client = new Cognee(cfg, impl);
    const result = await client.remember({ text: "guppy needs a new disk.", tags: ["storage"] });
    const form = await formEntries(seen[0].init.body);
    expect(seen[0].url).toBe("http://cognee.cognee.svc.cluster.local:8000/api/v1/remember");
    expect(form.get("raw_data")).toEqual(["guppy needs a new disk."]);
    expect(form.get("datasetName")).toEqual(["fleet-ops"]);
    expect(form.get("node_set")).toEqual(["pi-ed,storage"]);
    // Measured on this cluster: with session_id set, remember returned session_stored with items_processed 0, the
    // dataset stayed empty, and recall answered memory_warming_up. Attribution must not cost the graph.
    expect(form.has("session_id")).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("deduplicates the agent label out of the tags it is given", () => {
    const form = rememberForm({ text: "x", tags: ["pi-ed", "storage", "pi-ed"] }, { dataset: "fleet-ops", agent: "pi-ed" });
    expect(form.get("node_set")).toBe("pi-ed,storage");
  });

  it("asks for the background path only when it was asked for", async () => {
    const { seen, impl } = recordingFetch(() => fakeResponse(200, { status: "running", dataset_name: "fleet-ops" }));
    const client = new Cognee(resolveConfig(podEnv())!, impl);
    await client.remember({ text: "a long note", background: true });
    const form = await formEntries(seen[0].init.body);
    expect(form.get("run_in_background")).toEqual(["true"]);
  });

  it("every request carries the key as X-Api-Key and nothing else", async () => {
    const { seen, impl } = recordingFetch(() => fakeResponse(200, {}));
    const client = new Cognee(resolveConfig(podEnv())!, impl);
    await client.recall({ query: "anything" });
    expect(seen[0].init.headers).toMatchObject({ "X-Api-Key": FAKE_KEY });
  });
});

describe("the read request", () => {
  it("defaults to chunks, because the alternative costs an LLM round trip", () => {
    expect(recallPayload({ query: "quokableisk" }, { dataset: "fleet-ops" })).toEqual({ query: "quokableisk", searchType: "CHUNKS", topK: 5 });
  });

  it("clamps topK rather than trusting the caller", () => {
    expect(recallPayload({ query: "q", topK: 900 }, { dataset: "fleet-ops" }).topK).toBe(20);
    expect(recallPayload({ query: "q", topK: 0 }, { dataset: "fleet-ops" }).topK).toBe(1);
  });

  it("omits datasets when the caller did not name one, which is a different question", () => {
    expect(recallPayload({ query: "q" }, { dataset: "fleet-ops" })).not.toHaveProperty("datasets");
    expect(recallPayload({ query: "q", dataset: "fleet-ops" }, { dataset: "fleet-ops" })).toEqual(expect.objectContaining({ datasets: ["fleet-ops"] }));
  });

  it("sends node restrictions as a list, because Cognee 400s a bare string", () => {
    const payload = recallPayload({ query: "q", tags: ["camry"] }, { dataset: "fleet-ops" });
    expect(payload.nodeName).toEqual(["camry"]);
  });

  it("maps the four modes onto Cognee's search types", () => {
    for (const [mode, searchType] of Object.entries({ chunks: "CHUNKS", rag: "RAG_COMPLETION", graph: "GRAPH_COMPLETION", hybrid: "HYBRID_COMPLETION" })) {
      expect(recallPayload({ query: "q", mode: mode as never }, { dataset: "fleet-ops" }).searchType).toBe(searchType);
    }
  });
});

describe("how results are reported", () => {
  it("counts only memories, and quotes cognee separately when it is talking about itself", () => {
    const warming = formatRecall([{ source: "system", status: "memory_warming_up", text: "Memory is still warming up: no knowledge graph data exists yet." }], "fleet-ops");
    expect(warming.hits).toBe(0);
    expect(warming.text).toContain("cognee says: memory_warming_up");
    expect(warming.note).toBe("no memories returned");

    const hits = formatRecall(
      [{ source: "graph", kind: "chunk", search_type: "CHUNKS", text: "guppy needs a new disk.", score: 0.327, dataset_name: "fleet-ops" }],
      "fleet-ops",
    );
    expect(hits.hits).toBe(1);
    expect(hits.text).toContain("guppy needs a new disk.");
    expect(hits.text).toContain("score 0.327");
  });

  it("survives a body that is not the array it expects", () => {
    expect(formatRecall(undefined, "fleet-ops").text).toBe("nothing matched");
    expect(formatRecall({ surprise: "object" }, "fleet-ops").hits).toBe(0);
  });

  it("explains a 401 as a Secret problem, not as a mystery", () => {
    const text = describeFailure({ ok: false, status: 401, body: undefined, raw: "Unauthorized", ms: 12 }, "memory_recall");
    expect(text).toContain("cognee-agent-keys");
  });

  it("describes dataset state, including the one this agent writes to", () => {
    const text = describeStatus({ "4de7843f-0f0d-5a20-ab2d-f94d1c5b99ee": { state: "ready", message: "Memory is fully built.", dataset_name: "fleet-ops" }, "a96c6aaa-242c-59ca-9149-a262fab22b0e": { state: "empty", message: "nothing yet", dataset_name: "pi-ed-probe" } }, "fleet-ops");
    expect(text).toContain("fleet-ops: ready");
    expect(text).toContain("← this agent writes here");
    expect(text).toContain("pi-ed-probe: empty");
  });
});

describe("the tools as an agent meets them", () => {
  let pi: FakePi;
  let saved: NodeJS.ProcessEnv;

  const ctx = { cwd: "/workspace/pi-ed", sessionManager: { getSessionName: () => "pi-ed" }, ui: { notify: vi.fn() } } as any;

  beforeEach(() => {
    saved = { ...process.env };
    writeDataset();
    process.env = podEnv();
  });

  /**
   * Activate the extension against a stubbed fetch.
   *
   * The order matters and is itself a fact about the code: `Cognee` captures `globalThis.fetch` when it is built,
   * which happens inside activation. A test that stubbed the global after importing would record nothing and pass.
   */
  async function activateWith(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): Promise<void> {
    vi.stubGlobal("fetch", fetchImpl);
    vi.resetModules();
    pi = createFakePi();
    const mod = await import("../extensions/cognee.ts");
    mod.default(pi as never);
  }

  afterEach(() => {
    process.env = saved;
  });

  async function run(tool: string, params: any): Promise<{ text: string; details: any }> {
    const definition = pi.tools.get(tool)!;
    const result = await definition.execute!("call-1", params, undefined, () => {}, ctx);
    return { text: result.content.map((part: any) => part.text).join("\n"), details: result.details };
  }

  it("refuses an empty or absurdly long note before it sends anything", async () => {
    const { seen, impl } = recordingFetch(() => fakeResponse(200, {}));
    await activateWith(impl);
    const empty = await run("memory_remember", { text: "   " });
    expect(empty.text).toContain("needs text");
    const long = await run("memory_remember", { text: "x".repeat(20_001) });
    expect(long.text).toContain("refuses 20001 characters");
    expect(seen.length).toBe(0);
  });

  it("redacts credential-shaped text before it leaves the process", async () => {
    const { seen, impl } = recordingFetch(() => fakeResponse(200, { status: "completed", dataset_name: "fleet-ops", items_processed: 1 }));
    await activateWith(impl);
    const out = await run("memory_remember", { text: "the store is postgres://writer:hunter2@pi-ed-postgres:5432/pi_ed and the api_key=abcdefghijklmnop" });
    const form = await formEntries(seen[0].init.body);
    expect(form.get("raw_data")![0]).not.toContain("hunter2");
    expect(form.get("raw_data")![0]).not.toContain("abcdefghijklmnop");
    expect(form.get("raw_data")![0]).toContain("[redacted:dsn]");
    expect(out.text).toContain("redacted: key-value, dsn");
  });

  it("never puts the key in an error message, even when cognee itself echoes it", async () => {
    const leaky = `upstream complained about ${FAKE_KEY} while talking to postgres://u:s3cret@host/db`;
    await activateWith(async () => fakeResponse(500, leaky));
    const out = await run("memory_remember", { text: "a thing worth keeping" });
    expect(out.text).not.toContain(FAKE_KEY);
    expect(out.text).not.toContain("s3cret");
    // `scrub` adds the live key as a literal rule, and a custom-pattern replacement is named [redacted:custom].
    expect(out.text).toContain("[redacted:custom]");
    expect(readFileSync(keyFile, "utf8")).toContain(FAKE_KEY);
  });

  it("reports a warming-up dataset as a shrug rather than as a read", async () => {
    await activateWith(async () => fakeResponse(200, [{ source: "system", status: "memory_warming_up", text: "no knowledge graph data exists yet" }]));
    const out = await run("memory_recall", { query: "quokkalisk" });
    expect(out.text).toContain("0 result(s) · chunks");
    expect(out.text).toContain("cognee says: memory_warming_up");
    expect(out.details.hits).toBe(0);
  });

  it("returns chunk hits with the mode and the cost in the header line", async () => {
    await activateWith(async () => fakeResponse(200, [{ source: "graph", kind: "chunk", search_type: "CHUNKS", text: "guppy needs a new disk", score: 0.41, dataset_name: "fleet-ops" }]));
    const out = await run("memory_recall", { query: "disk", dataset: "fleet-ops" });
    expect(out.text).toContain("1 result(s) · chunks");
    expect(out.text).toContain("guppy needs a new disk");
  });

  it("says plainly when cognee cannot be reached at all", async () => {
    await activateWith(async () => {
      throw new Error("connect ECONNREFUSED 10.43.230.228:8000");
    });
    const out = await run("memory_recall", { query: "anything" });
    expect(out.text).toContain("could not reach cognee");
    expect(out.text).toContain("Treat this as no information, not as a negative.");
  });

  it("distinguishes a store that is busy from a store that is gone, because the agent's next action differs", async () => {
    const busy = await activateWith(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const busyOut = await run("memory_recall", { query: "anything" });
    expect(busyOut.text).toMatch(/stopped waiting for cognee/i);
    expect(busyOut.text).toMatch(/likely busy building rather than refusing/i);
    expect(busyOut.text).toMatch(/not as a licence to write the same note again/i);
    expect(busyOut.text).not.toMatch(/Treat this as no information/);

    const gone = await activateWith(async () => {
      throw new Error("getaddrinfo ENOTFOUND cognee.cognee.svc.cluster.local");
    });
    const goneOut = await run("memory_recall", { query: "anything" });
    expect(goneOut.text).toMatch(/could not reach cognee/i);
    expect(goneOut.text).toMatch(/Treat this as no information, not as a negative\./);
  });

  it("a 409 says what cognee actually meant, because the status code alone reads like a busy store", async () => {
    // Measured: 409 after ~31 s with an embedding-connection body. An agent told "conflict, try again" would retry
    // forever against a dead embedder.
    const text = describeFailure({ ok: false, status: 409, body: { error: "An error occurred during remember: Embedding connection test timed out after 30s." }, raw: "Embedding connection test timed out after 30s.", ms: 31_000 }, "memory_remember");
    expect(text).toMatch(/409/);
    expect(text).toMatch(/embedding endpoint/i);
    expect(text).toMatch(/Nothing was stored/);
  });

  it("keeps the two doors' name rules apart, because cognee gives them different vocabularies", async () => {
    // Measured on home-dev with the agent key: status/memory answers 200 with a body keyed by fleet-ops's UUID,
    // while status/fleet-ops, status/FLEET-OPS and status/<fleet-ops's UUID> all answer 404 — and the reverse holds
    // for recall, where datasets:["memory"] 404s with "Dataset names resolve only among the datasets you own".
    const { seen, impl } = recordingFetch(() => fakeResponse(200, { "4de7843f-0f0d-5a20-ab2d-f94d1c5b99ee": { state: "ready" } }));
    const client = new Cognee(resolveConfig(podEnv({ COGNEE_MEMORY_DATASET: "fleet-ops" }))!, impl);
    await client.status();
    await client.recall({ query: "anything" });
    await client.recall({ query: "anything", dataset: "fleet-ops" });
    expect(seen[0]?.url).toBe("http://cognee.cognee.svc.cluster.local:8000/api/v1/datasets/status/memory");
    // Measured on home-dev: unscoped CHUNKS answered 200 in 1.7 s and returned fleet-ops text; datasets:["fleet-ops"]
    // answered the same query in 191 ms; datasets:["memory"] answered 404 because the key does not own that name.
    // The status door, meanwhile, only accepts the alias `memory`.
    expect(JSON.parse(String(seen[1]?.init.body)).datasets).toBeUndefined();
    expect(JSON.parse(String(seen[2]?.init.body)).datasets).toEqual(["fleet-ops"]);
  });

  it("the /cognee command reports where memory goes without revealing the key", async () => {
    await activateWith(async () => fakeResponse(200, { "4de7843f-0f0d-5a20-ab2d-f94d1c5b99ee": { state: "ready", message: "Memory is fully built.", dataset_name: "fleet-ops" } }));
    await pi.commands.get("cognee")!.handler!("", ctx);
    const shown = ctx.ui.notify.mock.calls.map((call: any[]) => call[0]).join("\n");
    expect(shown).toContain("dataset fleet-ops · agent label pi-ed");
    expect(shown).toContain(`key from ${keyFile} (value not shown)`);
    expect(shown).not.toContain(FAKE_KEY);
    expect(shown).toContain("fleet-ops: ready");
  });
});
