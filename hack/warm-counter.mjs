#!/usr/bin/env node
/**
 * Would a cache warm have paid for itself, on this fleet, in the last few hours?
 *
 * Pi's warmer is written for a world where input tokens cost dollars. On this fleet they cost GPU seconds, and
 * Pi never gets as far as noticing: `cache-warmer.js` starts a run by asking `getPromptCacheTtlMs(model, options)`
 * for the lifetime of the entry it would refresh, every catalogue entry in /root/.pi/agent/models.json omits
 * `promptCache`, so the warmer stops with `{action: "stop", reason: "cache lifetime unavailable"}` and no decision
 * is ever scheduled or emitted. Declaring `promptCache` without `cost` is the other half of the story: the
 * config loader defaults a missing `cost` to all zeros (verified against the 1.6.1 registry), so
 * `evaluateCacheWarming` returns `economicsAvailable: false` with `warmCost` and `missCost` both 0 and action
 * `stop` — it does not throw, and it does ask extensions, which is exactly the hole this policy steps into. So
 * the question "should we warm?" has never been answered here, in either direction. This answers it in GPU
 * units, from rooter's own per-call rows, using the *same* gate `extensions/cache-warm-policy.ts` applies in a
 * session. It is read-only.
 *
 * Why the counter imports the gate rather than restating it (`lib/cache-warm.ts`, which Node 26 runs directly):
 * a fleet tool that paraphrases the policy drifts from it, and the only number worth trusting is the one the
 * policy itself produced.
 *
 * What it prints, per rooter session key:
 *
 *   - the session's own recompute evidence: median and max `prompt_tokens_computed`, median prompt size, aborts;
 *   - its call rhythm, which is an *upper bound* on its arrival rhythm — a turn makes several calls, so a call
 *     rate overstates how often something arrived. Inside a session the extension reads the real arrivals off
 *     the branch; the fleet cannot, and the difference always errs toward warming too much;
 *   - the verdict the gate reached, with its reason;
 *   - and what a warm cadence would actually have cost that session, as a range: refreshes every `--re-arm`
 *     seconds, priced at the box's *restore* rate (the prefix was still resident, so the refresh is a reload)
 *     and at its *cold prefill* rate (the prefix had gone, so the refresh is a full re-prefill).
 *
 * Both rates come from rooter live (`GET /rooter/backends`: `coldPrefillTokS`, `restoreTokS`, with sample
 * counts), because the hand-copied figures an earlier draft used were wrong in the flattering direction: sushi
 * was assumed at 460 tok/s cold and measures 236.7 tok/s today.
 *
 * Two things the window is not, stated rather than discovered by the next reader:
 *
 *   - Rooter's event buffer is boot-scoped. `dropped_total: 0` and `available` equal to the number of calls since
 *     `boot_id` mean this endpoint can only see since rooter last restarted (2h18m and 347 generations when this
 *     header was written). `--since` is a clamp on that window, not a way to reach past it. For a longer window
 *     read the pod-side logs, which is what `hack/cliff-counter.mjs` does.
 *   - Most session keys are `p:` (rooter derived them from the request, `key_source: "prefix"`), not `h:` (a Pi
 *     session that sent its session key in a header). Only `h:` keys are Pi sessions, and that is the difference
 *     between the two populations this counter exists to separate.
 *
 * Usage:
 *   node hack/warm-counter.mjs                      # last 3h, gate at the shipped defaults
 *   node hack/warm-counter.mjs --hours 6 --re-arm 1800
 *   node hack/warm-counter.mjs --floor 5000 --arrivals 1 --top 30
 *   node hack/warm-counter.mjs --json               # for diffing two windows
 *
 * The first run (2026-11-27, rooter boot d7f15035b14e, 347 generations, 139 minutes, 24 sessions) is the reason
 * the extension ships dark: 0 sessions were warmable. The three Pi sessions had median recompute of 259, 285 and
 * 993 tokens; every session with a recompute worth saving (10k-51k tokens) was a single call that then stayed
 * silent for 100+ minutes, which is exactly the shape a warm must not pay for. The fleet's whole cold-prefill
 * spend in that window was 29 calls, 823,580 tokens and 1,519 seconds of box time.
 */
import { readFileSync } from "node:fs";

import { armDecision, DEFAULT_WARM_CONFIG, parseCallEvents } from "../lib/cache-warm.ts";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : argv[i + 1];
};
const num = (name, fallback) => Number(flag(name, fallback));
const json = argv.includes("--json");

const MODELS_JSON = flag("models", process.env.MODELS_JSON || "/root/.pi/agent/models.json");
const hours = num("hours", 3);
// 1800s is the value hack/models-json-promptcache-draft.md recommends declaring, because Pi times the refresh at
// short x 0.9 from the request that opened the run and stops a run whose next refresh falls past +30 minutes.
// 2000s is the arithmetic edge (its refresh is exactly 1800s) and any elapsed time pushes it past, so pricing a
// cadence at 2000 flatters the change.
const reArmSec = num("re-arm", 1800);
const top = num("top", 14);
const eventLimit = num("limit", 1000);

function rooterDoor() {
  if (process.env.ROOTER_URL && process.env.ROOTER_KEY) {
    return { root: process.env.ROOTER_URL.replace(/\/+$/, "").replace(/\/v1$/, ""), key: process.env.ROOTER_KEY };
  }
  const catalogue = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
  for (const [name, provider] of Object.entries(catalogue.providers ?? {})) {
    const base = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    if (!/rooter/.test(name) && !/rooter/.test(base)) continue;
    if (typeof provider.apiKey !== "string" || !provider.apiKey) continue;
    return { name, root: base.replace(/\/+$/, "").replace(/\/v1$/, ""), key: provider.apiKey, models: provider.models ?? [] };
  }
  throw new Error(`no rooter provider with a baseUrl and apiKey in ${MODELS_JSON} (or set ROOTER_URL and ROOTER_KEY)`);
}

async function getJson(root, path, key) {
  const response = await fetch(`${root}${path}`, {
    method: "GET",
    headers: { "x-api-key": key, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`rooter ${path} HTTP ${response.status}`);
  return response.json();
}

/** Live per-call rates, straight from rooter, with the sample counts that make them meaningful. */
function ratesFrom(backends) {
  const out = {};
  for (const b of backends ?? []) {
    out[b.name] = {
      coldTokS: typeof b.coldPrefillTokS === "number" ? b.coldPrefillTokS : undefined,
      coldSamples: b.coldSamples ?? 0,
      restoreTokS: typeof b.restoreTokS === "number" ? b.restoreTokS : undefined,
      restoreSamples: b.restoreSamples ?? 0,
      requests: b.requests ?? 0,
    };
  }
  return out;
}

/**
 * What the catalogue file actually declares, per entry. Two blocks decide whether a warm is even possible, and
 * they fail differently: `promptCache` is what Pi's warmer needs to schedule a run at all, and a `cost` block that
 * is *absent from the file* is silently defaulted to zeros by the 1.6.1 config loader, which yields
 * `economicsAvailable: false` rather than an error. So this reports both, and the reader must not assume the file
 * is what the runtime saw.
 */
function pricedModels(cataloguePath) {
  const catalogue = JSON.parse(readFileSync(cataloguePath, "utf8"));
  const rows = [];
  for (const [name, provider] of Object.entries(catalogue.providers ?? {})) {
    for (const model of provider.models ?? []) {
      rows.push({
        provider: name,
        model: model.id,
        cost: model.cost ? `${model.cost.input}/${model.cost.output}` : undefined,
        promptCache: model.promptCache ? JSON.stringify(model.promptCache) : undefined,
      });
    }
  }
  return rows;
}

const seconds = (value) => `${Math.round(value)}s`;
const med = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const at = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[at] : Math.round((sorted[at - 1] + sorted[at]) / 2);
};

const door = rooterDoor();
const [backends, eventsBody, stats] = await Promise.all([
  getJson(door.root, "/rooter/backends", door.key),
  getJson(door.root, `/rooter/events?limit=${eventLimit}`, door.key),
  getJson(door.root, "/rooter/stats", door.key),
]);
const rates = ratesFrom(backends);
const allEvents = eventsBody.events ?? [];
const newest = allEvents.length ? Date.parse(allEvents[allEvents.length - 1].ts) : Date.now();
const sinceMs = Math.max(newest - hours * 3_600_000, allEvents.length ? Date.parse(allEvents[0].ts) : newest);

const cfg = {
  ...DEFAULT_WARM_CONFIG,
  mode: "arm",
  minRecomputeTokens: num("floor", DEFAULT_WARM_CONFIG.minRecomputeTokens),
  minArrivalsPerHour: num("arrivals", DEFAULT_WARM_CONFIG.minArrivalsPerHour),
  vetoCacheHitRate: num("veto", DEFAULT_WARM_CONFIG.vetoCacheHitRate),
  evidenceCalls: num("calls", DEFAULT_WARM_CONFIG.evidenceCalls),
  // The gate's window is widened to the counter's window: a 60-minute evidence window inside a 139-minute
  // event buffer would silently drop most of what rooter can still see.
  evidenceWindowMs: newest - sinceMs,
  // The idle bar is "longer than the interval a refresh would have to cover", so it is derived from the cadence
  // being priced rather than left at the library default: pass --re-arm and the bar moves with it.
  maxIdleMs: Math.round(reArmSec * 0.9 * 1000),
};

const byKey = new Map();
for (const event of allEvents) {
  if (event.kind !== "gen") continue;
  const at = Date.parse(event.ts);
  if (at < sinceMs) continue;
  if (!byKey.has(event.key)) byKey.set(event.key, []);
  byKey.get(event.key).push(event);
}

const sessions = [];
let fleetColdTokens = 0;
let fleetColdSeconds = 0;
let fleetColdCalls = 0;
for (const [key, list] of byKey) {
  const evidence = parseCallEvents({ events: list }, key, newest, cfg);
  const stamps = list.map((event) => Date.parse(event.ts)).sort((a, b) => a - b);
  const spanMs = Math.max(0, stamps[stamps.length - 1] - stamps[0]);
  const gaps = [];
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
  // Arrivals are per hour over the counter's window, which is the only rate that is well defined for a session
  // that made one call: an active span of zero seconds turns a single call into 60 arrivals/hour, which is the
  // kind of number that would have this counter arming warming for callers that called once. Whether a session is
  // *still* awake is the idle bar's job, and it reads `sinceLastMs`.
  //
  // Note the mismatch, since it bounds what this tool may be used for: rooter rows are generations, and a `p:`
  // caller's generation is not a human turn. On a pod the gate's `humanArrivalsPerHour` counts user-role messages
  // only, so every figure below is an **upper bound** on what the gate would arm, not a prediction of it.
  const rhythm = {
    windowMs: cfg.evidenceWindowMs,
    arrivals: list.length,
    humanArrivalsPerHour: list.length / (cfg.evidenceWindowMs / 3_600_000),
    medianGapMs: gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : undefined,
    lastArrivalMs: stamps[stamps.length - 1],
    sinceLastMs: newest - stamps[stamps.length - 1],
  };
  // The catalyst precondition cannot be evaluated from rooter rows, so it is assumed clear and the caveat is
  // printed. The alternative - letting it default to `unknown` - would report 0 warmable for a reason that has
  // nothing to do with the evidence, which is the kind of number that gets quoted as a finding.
  const decision = armDecision(evidence, rhythm, cfg, "warm", {
    compacting: false,
    catalyst: { catalyst: "terminal", basis: "assumed by warm-counter: rooter rows carry no transcript, so no catalyst can be named" },
  });

  for (const event of evidence) {
    if (event.computedTokens >= 5000) {
      fleetColdCalls++;
      fleetColdTokens += event.computedTokens;
      fleetColdSeconds += (event.prefillMs ?? 0) / 1000;
    }
  }
  if (!evidence.length) {
    sessions.push({ key, piSession: key.startsWith("h:"), calls: list.length, warmable: false, verdict: "stop", reason: "no rows with token accounting", medianComputed: 0, maxComputed: 0, medianPrompt: 0, aborts: 0, spanMs, rhythm, fires: 0, warmRestoreSec: 0, warmColdSec: 0 });
    continue;
  }

  const backend = evidence[evidence.length - 1].backend;
  const rate = rates[backend] ?? {};
  const promptMed = med(evidence.map((row) => row.promptTokens));
  const computedMed = med(evidence.map((row) => row.computedTokens));
  const fires = spanMs > 0 ? Math.max(1, Math.floor(spanMs / 1000 / reArmSec)) : 0;
  sessions.push({
    key,
    piSession: key.startsWith("h:"),
    backend,
    calls: evidence.length,
    aborts: evidence.filter((row) => row.aborted).length,
    medianComputed: computedMed,
    maxComputed: Math.max(...evidence.map((row) => row.computedTokens)),
    medianPrompt: promptMed,
    lastCacheHit: evidence[evidence.length - 1].cacheHitRate,
    spanMs,
    idleMs: rhythm.sinceLastMs,
    medianGapMs: rhythm.medianGapMs,
    callsPerHour: list.length / Math.max(1, spanMs / 3_600_000),
    verdict: decision.action,
    warmable: decision.action === "warm",
    reason: decision.reason,
    detail: decision.detail,
    fires,
    // A refresh is a reload when the prefix is still resident and a re-prefill when it is not. Both bounds are
    // shown because which one you get is the whole question, and rooter reports both rates separately.
    warmRestoreSec: rate.restoreTokS ? (fires * promptMed) / rate.restoreTokS : undefined,
    warmColdSec: rate.coldTokS ? (fires * promptMed) / rate.coldTokS : undefined,
    coldTokS: rate.coldTokS,
    restoreTokS: rate.restoreTokS,
  });
}

sessions.sort((a, b) => b.medianComputed - a.medianComputed);
const warmable = sessions.filter((session) => session.warmable);
const piSessions = sessions.filter((session) => session.piSession);
const totalFires = sessions.reduce((sum, session) => sum + session.fires, 0);
const warmRestore = sessions.reduce((sum, session) => sum + (session.warmRestoreSec ?? 0), 0);
const warmCold = sessions.reduce((sum, session) => sum + (session.warmColdSec ?? 0), 0);
const savedTokens = warmable.reduce((sum, session) => sum + session.medianComputed, 0);
const catalogueRows = pricedModels(MODELS_JSON);
const undeclaredLifetime = catalogueRows.filter((row) => !row.promptCache);

if (json) {
  console.log(JSON.stringify({ windowMs: newest - sinceMs, sessions, totals: { sessions: sessions.length, piSessions: piSessions.length, warmable: warmable.length, warmablePiSessions: warmable.filter((session) => session.piSession).length, fleetColdCalls, fleetColdTokens, fleetColdSeconds, totalFires, warmRestoreSec: warmRestore, warmColdSec: warmCold, savedTokens }, rates, undeclaredLifetime }, null, 2));
} else {
  console.log(`rooter ${door.root} boot ${eventsBody.boot_id} (rooter uptime ${stats.uptime}, dropped_total ${eventsBody.dropped_total})`);
  console.log(`window ${(newest - sinceMs) / 60000}m to ${new Date(newest).toISOString().slice(0, 19)}  gate: floor ${cfg.minRecomputeTokens} tokens, human arrivals ${cfg.minArrivalsPerHour}/h, saved >= ${cfg.minSavedSeconds}s, veto >= ${cfg.vetoCacheHitRate} cache read, idle bar ${Math.round(cfg.maxIdleMs / 60000)}m, ${cfg.evidenceCalls} calls`);
  console.log("catalyst rule assumed clear (a rooter row names no catalyst), and the arrival rate here counts generations, not human turns: these warmable counts are an upper bound on what the gate would arm");
  console.log(`re-arm cadence priced: every ${reArmSec}s`);
  for (const [name, rate] of Object.entries(rates)) {
    console.log(`  ${name}: cold prefill ${rate.coldTokS} tok/s over ${rate.coldSamples} samples, restore ${Math.round(rate.restoreTokS)} tok/s over ${rate.restoreSamples} samples, ${rate.requests} proxied calls`);
  }
  console.log("");
  // Every Pi session is printed whatever its rank, because Pi sessions are the population a warm could ever be
  // armed for, and sorting by recompute alone hides exactly the ones that prove they do not need one.
  const shown = [...sessions.filter((session) => session.piSession), ...sessions.filter((session) => !session.piSession).slice(0, top)];
  console.log("key              kind  calls aborts  medComputed  maxComputed  medPrompt  lastHit  span   idle  calls/h  verdict  warm fires  warm cost (restore|cold)");
  for (const session of shown) {
    const hit = session.lastCacheHit === undefined ? "-" : `${Math.round(session.lastCacheHit * 100)}%`;
    const cost = session.warmRestoreSec === undefined && session.warmColdSec === undefined ? "-" : `${seconds(session.warmRestoreSec ?? 0)}|${seconds(session.warmColdSec ?? 0)}`;
    console.log(
      `${session.key.padEnd(16)} ${(session.piSession ? "pi" : "other").padEnd(5)} ${String(session.calls).padStart(5)} ${String(session.aborts).padStart(6)} ` +
        `${String(session.medianComputed).padStart(11)} ${String(session.maxComputed).padStart(11)} ${String(session.medianPrompt).padStart(10)} ${hit.padStart(7)} ` +
        `${String(Math.round(session.spanMs / 60000)).padStart(5)} ${String(Math.round((session.idleMs ?? 0) / 60000)).padStart(5)} ${session.callsPerHour.toFixed(1).padStart(8)}  ${session.verdict.padEnd(8)} ${String(session.fires).padStart(10)}  ${cost}`,
    );
  }
  console.log("");
  for (const session of shown) {
    console.log(`  ${session.key}: ${session.reason}`);
  }
  console.log("");
  console.log(`fleet: ${sessions.length} session keys (${piSessions.length} Pi sessions), ${fleetColdCalls} cold calls (>=5000 recomputed tokens), ${fleetColdTokens} cold tokens, ${seconds(fleetColdSeconds)} of box prefill`);
  console.log(`warmable now: ${warmable.length} session keys (${warmable.filter((session) => session.piSession).length} Pi sessions), worth ${savedTokens} recomputed tokens`);
  console.log(`if everything were armed at a ${reArmSec}s cadence: ${totalFires} refreshes, ${seconds(warmRestore)} of box time if the prefixes were resident, ${seconds(warmCold)} if they were not`);
  console.log("");
  console.log("Pi's own gate, for reference (cache-warmer.js):");
  console.log(`  a warm is priced as price(model, {cacheRead: promptTokens, output: 1}) and the miss as the difference between a full re-prefill and a cached read,`);
  console.log(`  so an idle refresh arms only when 0.15 x (miss - hit) - warm >= $0.05, i.e. roughly input price >= $${(0.4 / Math.max(0.001, med(sessions.map((session) => session.medianPrompt)) / 1e6)).toFixed(2)}/M input tokens at this fleet's median prompt of ${med(sessions.map((session) => session.medianPrompt))} tokens with cache reads at 10% of input price.`);
  console.log(`  catalogue entries declaring no \`promptCache\` (Pi's warmer stops at start() with "cache lifetime unavailable", so no decision is ever scheduled): ${undeclaredLifetime.length} of ${catalogueRows.length}`);
  console.log(`  a missing \`cost\` in this file is not what Pi sees at runtime: the config loader defaults it to zeros, giving economicsAvailable=false and action "stop" with warmCost and missCost both 0.`);
  for (const row of catalogueRows.filter((entry) => /rooter|strata|sushi/.test(entry.provider)).slice(0, 8)) {
    console.log(`    ${row.provider}/${row.model}: cost ${row.cost ?? "none"}, promptCache ${row.promptCache ?? "none"}`);
  }
}
