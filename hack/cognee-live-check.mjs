/**
 * cognee, checked against cognee.
 *
 * The unit suite proves the request shapes and the error handling without a network. This proves the part a stub
 * cannot: that Cognee accepts these exact fields, builds a graph out of them, and gives the text back — and that the
 * redaction really happens on this side of the request, by asking Cognee what it stored.
 *
 * Run it from inside a pod, where the Secret is mounted and the Service DNS resolves:
 *
 *   node hack/cognee-live-check.mjs
 *   node hack/cognee-live-check.mjs --graph     # also ask the graph to synthesize (10–25 s, costs a rooter call)
 *   node hack/cognee-live-check.mjs --url https://cognee.dev.initialed85.cc --key-file ~/cognee-key.txt
 *
 * It writes to the `pi-ed-probe` dataset, never to `fleet-ops`, and deletes what it wrote unless --keep is passed.
 * Every line this script prints has been through `scrub` with the live key as a literal rule, so the check cannot
 * become the thing that leaks the credential it was given.
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

const { redact, scrub } = await import("../lib/redact.ts");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

// Inherited from the pod where the pod has it (home-ops sets COGNEE_BASE_URL and mounts /run/secrets/cognee),
// with laptop fallbacks behind that. Testing a pod by overriding everything the pod already says proves nothing.
const BASE = option("url", process.env.COGNEE_URL ?? process.env.COGNEE_BASE_URL ?? "http://cognee.cognee.svc.cluster.local:8000").replace(/\/+$/, "");
const KEY_FILE = option("key-file", process.env.COGNEE_API_KEY_FILE ?? "/run/secrets/cognee/api-key");
const DATASET = option("dataset", "pi-ed-probe");
const NODE_SET = "pi-ed-live-check";

const key = (process.env.COGNEE_API_KEY ?? readFileSync(KEY_FILE, "utf8")).trim();
if (!key) {
  console.error("no cognee key: expected a mounted file at /etc/cognee/api-key, or COGNEE_API_KEY, or --key-file");
  process.exit(2);
}
// The only printing this script does, and it is scrubbed. `console.error` goes through the same gate.
const say = (line) => console.log(scrub(line, [key]).text);

const MARK = `quokkalisk-${Date.now()}`;
const NOTE = `pi-ed live check ${new Date().toISOString()} on ${hostname()}: the marker word is ${MARK}. A credential for the check to swallow: postgres://probe:hunter2@pi-ed-postgres:5432/pi_ed and api_key=abcdefghijklmnop.`;

let failures = 0;
// `note` reports without failing. A leftover probe row is untidy; a memory that did not round trip is broken, and
// the exit code should only mean the second thing.
const note = (name, ok, detail) => console.log(`${ok ? "ok  " : "NOTE"} ${name}${detail ? ` — ${detail}` : ""}`);
const check = (name, ok, detail) => {
  say(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

async function call(path, init = {}, timeoutMs = 30_000) {
  const started = Date.now();
  // A transport failure is a result too. A check script that crashes with an uncaught TimeoutError tells the next
  // reader less than one that says which call gave up and after how long.
  let response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, headers: { "X-Api-Key": key, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error), [key]).text;
    return { status: 0, ok: false, body: undefined, raw: message, ms: Date.now() - started, error: message };
  }
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  return { status: response.status, ok: response.ok, body, raw: scrub(raw, [key]).text, ms: Date.now() - started };
}

const health = await call("/health");
check("health", health.ok, `HTTP ${health.status} in ${health.ms} ms`);

const status = await call("/api/v1/datasets/status/memory");
check("datasets/status/memory", status.ok, status.ok ? "" : `HTTP ${status.status}`);

// The fast path first, because it is the one an agent reaches for when Cognee is busy: it must return promptly and
// it must not pretend the build is finished.
const fastForm = new FormData();
fastForm.set("raw_data", redact(`background probe ${MARK}-bg on ${hostname()}: postgres://probe:hunter2@pi-ed-postgres:5432/pi_ed`).text);
fastForm.set("datasetName", DATASET);
fastForm.set("node_set", NODE_SET);
fastForm.set("run_in_background", "true");
const fast = await call("/api/v1/remember", { method: "POST", body: fastForm }, 30_000);
check("remember (background) returns promptly", fast.ok && fast.ms < 5_000 && fast.body?.status === "running", `HTTP ${fast.status} in ${fast.ms} ms · status ${String(fast.body?.status)}`);

// A foreground write: the claim being tested is that the graph has the note by the time the call returns. Cognee
// serves one worker, so this can legitimately out-wait the budget on a loaded graph — which the check treats as a
// second thing to prove rather than as a failure: the note must still be findable a moment later.
const form = new FormData();
form.set("raw_data", redact(NOTE).text);
form.set("datasetName", DATASET);
form.set("node_set", NODE_SET);
const written = await call("/api/v1/remember", { method: "POST", body: form }, 300_000);
const wroteInTime = written.ok && written.body?.status === "completed";
if (!wroteInTime) say(`note remember did not answer inside 300 s (HTTP ${written.status}, ${written.ms} ms) — continuing, because the note landing anyway is the other half of the contract`);
const datasetId = written.body?.dataset_id;
const writtenIds = Array.isArray(written.body?.items) ? written.body.items.map((item) => item?.id).filter(Boolean) : [];

// CHUNKS is the mode that returns what Cognee kept. That is what makes the redaction assertion mean something:
// if the password had reached the service, this is where it would show up.
const chunks = await call("/api/v1/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: `what is ${MARK}`, datasets: [DATASET], topK: 5, searchType: "CHUNKS", nodeName: [NODE_SET] }) }, 90_000);
const stored = JSON.stringify(chunks.body ?? []);
check("recall (chunks) finds the marker", chunks.ok && stored.includes(MARK), `HTTP ${chunks.status} in ${chunks.ms} ms${wroteInTime ? "" : " (written in the background / after the wait — proves the write landed regardless)"}`);
// Only a demonstrated read proves the redaction. If nothing landed, "the stored text contains no password" is
// vacuously true and must not be reported as a pass.
const demonstrated = stored.includes(MARK);
check("the credential never reached cognee", demonstrated && !stored.includes("hunter2") && !stored.includes("abcdefghijklmnop"), demonstrated ? (stored.includes("[redacted:") ? "[redacted:…] is what was stored" : "no redaction marker visible in the returned chunks") : "NOT PROVEN: nothing was read back, so an absence proves nothing");

if (flag("graph")) {
  const graph = await call("/api/v1/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: `what is ${MARK}, and what was redacted from the note?`, datasets: [DATASET], topK: 3, searchType: "GRAPH_COMPLETION" }) }, 90_000);
  const answer = JSON.stringify(graph.body ?? []);
  check("recall (graph) answers from the graph", graph.ok && graph.body?.[0]?.source === "graph", `HTTP ${graph.status} in ${graph.ms} ms`);
  check("the synthesized answer carries no credential", !answer.includes("hunter2"), answer.slice(0, 200));
}

if (!flag("keep")) {
  // Sweep by content rather than by the ids the write response handed back: a write that ran past the budget returns
  // no ids at all, and its note is exactly the row that needs removing. Both probes share the MARK prefix.
  const datasets = await call("/api/v1/datasets");
  const list = Array.isArray(datasets.body) ? datasets.body : datasets.body?.datasets ?? [];
  const target = list.find((entry) => entry.name === DATASET) ?? (datasetId ? { id: datasetId } : undefined);
  if (target?.id) {
    const rows = await call(`/api/v1/datasets/${target.id}/data`);
    const items = Array.isArray(rows.body) ? rows.body : rows.body?.data ?? rows.body?.items ?? [];
    let removed = 0;
    let found = 0;
    for (const row of items) {
      const raw = await call(`/api/v1/datasets/${target.id}/data/${row.id}/raw`);
      if (!raw.raw.includes(MARK)) continue;
      found += 1;
      // Deleting pulls nodes and edges out of the graph, which is slower than the 30 s a lookup gets — and it can
      // conflict with a build still running from a write this script gave up on.
      if ((await call(`/api/v1/datasets/${target.id}/data/${row.id}`, { method: "DELETE" }, 90_000)).ok) removed += 1;
    }
    note("cleanup removed the probe rows", removed === found, `${removed}/${found} row(s) carrying ${MARK} in ${DATASET}${removed < found ? ` — remove the rest by hand: DELETE /api/v1/datasets/${target.id}/data/{id}` : ""}`);
  }
}


if (flag("prove-delete")) {
  // slopyphus' caution, made testable: a DELETE that reports deletedNodes/deletedEdges proves *something* came out,
  // not that the credential did. Graph nodes routinely outlive the document that introduced them. So the proof is
  // written as a search for the literal before and after, with the counts recorded rather than trusted.
  const SECRET = `SCRUBME-${MARK}`;
  const secretNote = `note ${MARK}-secret carrying a credential: api_key=${SECRET}. It is a probe and belongs in the probe dataset.`;
  const secretForm = new FormData();
  secretForm.set("raw_data", secretNote);
  secretForm.set("datasetName", DATASET);
  secretForm.set("node_set", NODE_SET);
  const seeded = await call("/api/v1/remember", { method: "POST", body: secretForm }, 300_000);
  note("seeded a note carrying a literal credential", seeded.ok, `HTTP ${seeded.status} in ${seeded.ms} ms · status ${String(seeded.body?.status)}`);

  const before = await call("/api/v1/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: SECRET, datasets: [DATASET], topK: 8, searchType: "CHUNKS" }) }, 90_000);
  const seenBefore = JSON.stringify(before.body ?? []).includes(SECRET);
  check("the literal credential is retrievable before the delete", seenBefore, `HTTP ${before.status} in ${before.ms} ms`);

  const seededIds = Array.isArray(seeded.body?.items) ? seeded.body.items.map((item) => item?.id).filter(Boolean) : [];
  const removedCounts = [];
  for (const id of seededIds) {
    const del = await call(`/api/v1/datasets/${seeded.body?.dataset_id ?? datasetId}/data/${id}`, { method: "DELETE" }, 90_000);
    removedCounts.push(del.body ?? { status: del.status });
  }
  say(`     delete reported: ${JSON.stringify(removedCounts).slice(0, 300)}`);

  const after = await call("/api/v1/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: SECRET, datasets: [DATASET], topK: 8, searchType: "CHUNKS" }) }, 90_000);
  const inChunks = JSON.stringify(after.body ?? []).includes(SECRET);

  const datasetsAfter = await call("/api/v1/datasets");
  const listAfter = Array.isArray(datasetsAfter.body) ? datasetsAfter.body : datasetsAfter.body?.datasets ?? [];
  const targetAfter = listAfter.find((entry) => entry.name === DATASET);
  let inRawScan = false;
  if (targetAfter?.id) {
    const rowsAfter = await call(`/api/v1/datasets/${targetAfter.id}/data`);
    const itemsAfter = Array.isArray(rowsAfter.body) ? rowsAfter.body : rowsAfter.body?.data ?? rowsAfter.body?.items ?? [];
    for (const row of itemsAfter) {
      const raw = await call(`/api/v1/datasets/${targetAfter.id}/data/${row.id}/raw`);
      if (raw.raw.includes(SECRET)) inRawScan = true;
    }
  }

  const graphAfter = await call("/api/v1/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: `which api_key value appears in note ${MARK}-secret? answer with the exact string if you can find it, otherwise say none`, datasets: [DATASET], topK: 3, searchType: "GRAPH_COMPLETION" }) }, 90_000);
  const inGraphAnswer = JSON.stringify(graphAfter.body ?? []).includes(SECRET);

  // Every "after" assertion below is only worth stating if the credential was provably there "before". Otherwise a
  // failed seed passes the whole proof.
  const proven = seenBefore && seededIds.length > 0;
  check("the literal credential is gone from chunks after the delete", proven && !inChunks, !proven ? "NOT PROVEN: the seed never landed, so its absence afterwards means nothing" : (inChunks ? "still in stored chunks" : "not in stored chunks"));
  check("the literal credential is gone from every remaining data row", proven && !inRawScan, !proven ? "NOT PROVEN" : (inRawScan ? "a remaining row still carries it" : "raw scan of remaining rows is clean"));
  check("the literal credential is not answerable from the graph", proven && !inGraphAnswer, !proven ? "NOT PROVEN" : (inGraphAnswer ? "a synthesized answer still reproduces it — cognee's delete did not cascade to the nodes" : `graph answered without it in ${graphAfter.ms} ms`));
  say(`     caveat on the last one: a GRAPH_COMPLETION that omits the string is evidence the model did not find it, not proof no node holds it. No node-enumeration door is known to this script; if one is found, that assertion belongs on it.`);
}
say(`\n${failures ? "FAIL" : "PASS"} cognee live check against ${BASE} (dataset ${DATASET}, key from ${KEY_FILE} — value not shown)`);
process.exit(failures ? 1 : 0);
