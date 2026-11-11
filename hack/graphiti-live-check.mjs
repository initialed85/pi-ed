#!/usr/bin/env node
// Live check for extensions/graphiti.ts: what the fleet's memory door actually stored, not what it answered.
//
// Why this exists rather than a curl one-liner: every failure this door has had arrived behind a 2xx. home-ops
// measured ~100 episodes lost behind `202 accepted` during the historical import; a mis-set LLM URL on 2026-11-11
// answered 202 in ~300 ms and produced zero episodes and zero facts on three polls over 45 seconds. A status code is
// not evidence. The evidence is `/episodes/{group}` and `/search`, and this script asserts those.
//
// Run it after changing the extension, the door's LLM/embedder config, or the Neo4j deployment:
//
//   node hack/graphiti-live-check.mjs                 # contract, one write, extraction proof, cleanup
//   node hack/graphiti-live-check.mjs --prove-delete  # a credential-shaped note, then prove the literal is gone
//   node hack/graphiti-live-check.mjs --url http://cognee-that-no-longer-exists:9999   # prove your failure text
//
// Writes go to a throwaway group (`--group`, default `pi-ed-probe`) and the group is deleted at the end. Writing to
// a real agent group is refused outright unless `--allow-shared` is passed, because a probe note in `fleet-note` is
// indistinguishable from a real one afterwards, and the group name is the partition — a probe that guesses
// `Quake` instead of `quake` creates a brain nobody reads from.
//
// Exit 0 means every assertion below held. Non-zero prints which one, and leaves the group in place so it can be
// inspected, printing the cleanup command rather than silently deleting the evidence.

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = opt("url", process.env.MEMORY_GRAPH_URL ?? "http://memory-graph.memory.svc.cluster.local:9999").replace(/\/+$/, "");
const GROUP = opt("group", "pi-ed-probe");
// The groups that hold real fleet memory. A probe must never land in one.
const SHARED = new Set(["fleet-note", "cognee-note", "camry", "chromium", "coral", "home-ops", "maclet", "modelcalls", "pi-ed", "quake", "rooter", "slopyphus", "structmeta"]);
if (SHARED.has(GROUP) && !flag("allow-shared")) {
  console.error(`refusing to write a probe into the real group "${GROUP}". Use --group pi-ed-probe, or --allow-shared if you genuinely mean it.`);
  process.exit(2);
}

const MARK = `PIED-LIVECHECK-${Date.now()}`;
const FAKE_KEY = `sk-probe-${"0".repeat(24)}`;
const started = Date.now();
const log = (label, ...parts) => console.log(`${label.padEnd(24)} ${parts.join(" · ")}`);

const call = async (path, init = {}, timeout = 30_000) => {
  const t = Date.now();
  try {
    const r = await fetch(`${URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
    const raw = await r.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    return { status: r.status, ms: Date.now() - t, raw, body };
  } catch (error) {
    return { status: "transport", ms: Date.now() - t, raw: `${error.name}: ${String(error.cause?.code ?? error.message)}`, body: null };
  }
};

const factsFor = async (query) => {
  const r = await call("/search", { method: "POST", body: JSON.stringify({ query, group_ids: [GROUP], max_facts: 20 }) });
  const facts = r.body?.facts ?? [];
  return { ...r, facts };
};

const episodesFor = async (lastN = 10) => {
  // `last_n` is a required query parameter: without it the door answers 422. That is a trap this script would
  // otherwise walk into and report as "the service has nothing".
  const r = await call(`/episodes/${encodeURIComponent(GROUP)}?last_n=${lastN}`);
  const items = Array.isArray(r.body) ? r.body : (r.body?.items ?? r.body?.episodes ?? []);
  return { ...r, items };
};

const failures = [];
const check = (ok, label, detail) => { log(ok ? "ok" : "FAIL", label, detail); if (!ok) failures.push(label); };

// 1. Health. `/health` is a 404 here; the route is `/healthcheck`. Asserting the route name catches a door that
//    moved underneath the extension rather than a door that is down.
const health = await call("/healthcheck");
check(health.status === 200 && health.body?.status === "healthy", "healthcheck", `HTTP ${health.status} in ${health.ms} ms · ${health.raw.slice(0, 60)}`);

// 2. The door is empty before we start, so every number below is attributable to this run.
const before = await episodesFor();
const beforeFacts = await factsFor(MARK);
check(before.status === 200, "episodes readable before write", `HTTP ${before.status} · ${before.items.length} item(s)`);
check(beforeFacts.facts.length === 0, "probe marker absent before write", `${beforeFacts.facts.length} fact(s)`);

// 3. Write, the way the extension does it: role present, no uuid, group named exactly.
const note = flag("prove-delete")
  ? `Probe note ${MARK}: the deployer credential for this check was ${FAKE_KEY} and it must never be retrievable.`
  : `Probe note ${MARK}: this note exists to prove a write becomes a fact. Sender pi-ed, group ${GROUP}.`;
const write = await call("/messages", {
  method: "POST",
  body: JSON.stringify({
    group_id: GROUP,
    update_mode: "append",
    messages: [{ content: note, role_type: "assistant", role: GROUP, name: "pi-ed", timestamp: new Date().toISOString() }],
  }),
}, 15_000);
check(write.status === 202, "write accepted", `HTTP ${write.status} in ${write.ms} ms`);

// 4. Extraction, polled. It is asynchronous and the drain queue is in-process, so a 202 here means nothing until an
//    episode and a fact agree. The bounds are generous because a contended Neo4j or a slow extract LLM is exactly the
//    case an agent would otherwise be told "remembered" about.
let episodeCount = 0, factHits = 0, pollLog = [];
for (const wait of [10, 15, 20, 30, 45]) {
  await new Promise((r) => setTimeout(r, wait * 1000));
  const e = await episodesFor();
  const f = await factsFor(MARK);
  episodeCount = e.items.length; factHits = f.facts.length;
  pollLog.push(`+${wait}s: episodes ${e.status}=${episodeCount}, facts ${f.status}=${factHits}`);
  if (episodeCount > 0 && factHits > 0) break;
}
log("polls", pollLog.join(" | "));
check(episodeCount > 0, "episode actually stored", `${episodeCount} episode(s) visible for ${GROUP}`);
check(factHits > 0, "fact retrievable by query", `${factHits} fact(s) mention ${MARK}`);

// 5. Verbatim storage is asserted; composition is only reported. The distinction is measured, not stylistic:
// `/episodes/{group}` returns the text the service was handed, so the marker has to appear in it, while `/search`
// returns extracted facts reworded by the extract LLM — on 2026-11-11 a probe note whose marker was `PIED-LIVECHECK-…`
// came back as "The deployer credential for pi-ed-probe is …", which is a correct fact that does not quote the
// marker. Asserting a marker inside a composed fact would fail a healthy door, and a check that fails a healthy door
// gets ignored, which is worse than no check.
if (episodeCount > 0) {
  const e = await episodesFor();
  const stored = e.items.map((i) => String(i?.content ?? i?.text ?? JSON.stringify(i)).slice(0, 140).replace(/\s+/g, " "));
  check(stored.some((t) => t.includes(MARK)), "stored episode carries the note verbatim", stored[0] ?? "no text");
}
if (factHits > 0) {
  const quoted = (await factsFor(MARK)).facts.map((x) => String(x?.text ?? x?.fact ?? JSON.stringify(x)).slice(0, 140).replace(/\s+/g, " "));
  check(quoted.length > 0 && quoted.every((t) => t.length > 12), "composition returns real text, not a stub", quoted[0] ?? "no text");
}

// 6. Prove-delete: redaction on the way out is the extension's job; this asserts the literal is not retrievable
//    afterwards, which is the fleet's credential promise (this door has no auth).
if (flag("prove-delete")) {
  // What this script proves is storage and deletion semantics, not redaction. It writes over HTTP directly, so it
  // deliberately bypasses the extension — and that is the point worth stating rather than hiding: the door keeps
  // whatever literal it is handed. Redaction is the extension's job and is asserted there (test/graphiti.test.ts,
  // "redacts an OpenAI-shaped key"). Measured on 2026-11-11: a note carrying `sk-probe-<zeros>` became a retrievable
  // fact, which is how the missing `sk-` rule in lib/redact.ts was found.
  const leak = await factsFor(FAKE_KEY);
  check(leak.facts.length > 0, "literal is retrievable while the group lives", `${leak.facts.length} fact(s) carry the literal key (this is why the extension must redact before the wire)`);
  const del = await call(`/group/${encodeURIComponent(GROUP)}`, { method: "DELETE" });
  check(del.status === 200, "group deleted", `HTTP ${del.status} in ${del.ms} ms`);
  const after = await factsFor(MARK);
  const afterKey = await factsFor(FAKE_KEY);
  check(after.facts.length === 0 && afterKey.facts.length === 0, "nothing retrievable after delete", `marker ${after.facts.length}, key ${afterKey.facts.length}`);
  console.log("\ncleanup: the probe group was deleted by this run.");
  console.log(`\n${failures.length ? `${failures.length} check(s) failed` : "all checks passed"} in ${((Date.now() - started) / 1000).toFixed(0)} s · group ${GROUP}`);
  process.exit(failures.length ? 1 : 0);
}

// 7. Cleanup for the default path.
const del = await call(`/group/${encodeURIComponent(GROUP)}`, { method: "DELETE" });
check(del.status === 200, "cleanup deleted the probe group", `HTTP ${del.status} in ${del.ms} ms`);

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : "all checks passed"} in ${((Date.now() - started) / 1000).toFixed(0)} s · group ${GROUP} · ${URL}`);
if (failures.length) {
  console.log("the probe group was left in place on purpose. Clear it with:");
  console.log(`  curl -sX DELETE ${URL}/group/${GROUP}`);
}
process.exit(failures.length ? 1 : 0);
