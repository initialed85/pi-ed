#!/usr/bin/env node
/**
 * Would a cache warm have paid for itself, on this fleet, in the last few hours?
 *
 * Pi's warmer is written for a world where input tokens cost dollars. On this fleet they cost GPU seconds,
 * and Pi refuses to warm anything here before it even reaches its own arithmetic: `cache-warmer.js` prices a
 * refresh from `model.cost`, the catalogue entries for rooter, strata and sushi carry no `cost` block at all,
 * and a model with no pricing gets `{action: "stop", reason: "no catalogue pricing"}`. So the question "should
 * we warm?" has never been answered here, in either direction. This answers it in GPU units, from rooter's own
 * per-call rows, using the *same* gate `extensions/cache-warm-policy.ts` applies in a session. It is read-only.
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
const reArmSec = num("re-arm", 2000);
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

/** Which catalogue entries can carry a warm decision at all: Pi needs a `cost` block before it prices one. */
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
  const rhythm = {
    windowMs: cfg.evidenceWindowMs,
    arrivals: list.length,
    arrivalsPerHour: list.length / (cfg.evidenceWindowMs / 3_600_000),
    medianGapMs: gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : undefined,
    lastArrivalMs: stamps[stamps.length - 1],
    sinceLastMs: newest - stamps[stamps.length - 1],
  };
  const decision = armDecision(evidence, rhythm, cfg, "warm");

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
const unpriced = catalogueRows.filter((row) => !row.cost);

if (json) {
  console.log(JSON.stringify({ windowMs: newest - sinceMs, sessions, totals: { sessions: sessions.length, piSessions: piSessions.length, warmable: warmable.length, warmablePiSessions: warmable.filter((session) => session.piSession).length, fleetColdCalls, fleetColdTokens, fleetColdSeconds, totalFires, warmRestoreSec: warmRestore, warmColdSec: warmCold, savedTokens }, rates, unpriced }, null, 2));
} else {
  console.log(`rooter ${door.root} boot ${eventsBody.boot_id} (rooter uptime ${stats.uptime}, dropped_total ${eventsBody.dropped_total})`);
  console.log(`window ${(newest - sinceMs) / 60000}m to ${new Date(newest).toISOString().slice(0, 19)}  gate: floor ${cfg.minRecomputeTokens} tokens, arrivals ${cfg.minArrivalsPerHour}/h, veto >= ${cfg.vetoCacheHitRate} cache read, ${cfg.evidenceCalls} calls`);
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
  console.log(`  catalogue entries with no \`cost\` block (Pi stops with "no catalogue pricing" before any of that arithmetic): ${unpriced.length} of ${catalogueRows.length}`);
  for (const row of catalogueRows.filter((entry) => /rooter|strata|sushi/.test(entry.provider)).slice(0, 8)) {
    console.log(`    ${row.provider}/${row.model}: cost ${row.cost ?? "none"}, promptCache ${row.promptCache ?? "none"}`);
  }
}
