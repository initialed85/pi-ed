#!/usr/bin/env node
/**
 * Read the fleet's idle-compaction drain and answer the four questions the rollout actually turns on:
 *
 *   1. did completions land in the band, and what did each one free (a completion that frees almost nothing
 *      still held the gate for its whole duration, so yield per held second is the number that matters);
 *   2. how many attempts hit the ceiling, and what they paid for nothing;
 *   3. how long peers queued behind a holder, which is the cost side of the gate;
 *   4. which build each pod is really running. Pods report `build` on every record and their resolved config on
 *      `start` and `compact` lines as of the commit that added the marker; for anything older the answer still has
 *      to be inferred from which fields exist, so the fingerprint table is kept as the fallback.
 *
 * Usage: node hack/idle-drain-read.mjs [--since 2026-11-27T02:16:00] [--root /workspace]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : argv[i + 1];
};
const root = flag("root", "/workspace");
const since = flag("since", "2026-11-27T00:00:00");

/** Defaults at the roll target f3df978, repeated here so the reader is not editing the extension to judge it. */
const DEFAULTS = {
  softPercent: 25,
  minFreeTokens: 30000,
  keptFloorTokens: 24000,
  deadlineMs: 240000,
  spreadMs: 90000,
  gateMaxWaitMs: 5400000,
  cooldownMs: 600000,
};
/** Landing band measured across the idle-path completions of 2026-11-26 and 2026-11-27 (24734-40770 across 6
 * completions). It was 25667-32374 until a fleet drain produced a landing at 40770 (freed only 9474) and one at
 * 24734 (freed 49305), i.e. the narrow end of the band was an artefact of a small sample, not a property of the
 * mechanism: a completion can land low and still free almost nothing, or land high and free a lot. */
const BAND = [24734, 40770];

/** Field-shape fingerprints, newest first. The build a pod runs has to be inferred until a marker is recorded. */
/**
 * Field-shape fingerprints, newest first. The build a pod runs has to be inferred until a marker is recorded.
 * Every test here must be satisfiable by an idle-path record too: an earlier version of this table matched only
 * Pi-path shapes, so eight pods that produced 100+ gate deferrals printed as pre-gate in the run that credited
 * them with those deferrals.
 */
const FINGERPRINTS = [
  { build: "f3df978 (Pi-path gate)", test: (r) => r.kind === "compacted" && r.msSource !== undefined },
  { build: "f3df978 (Pi-path gate)", test: (r) => r.kind === "gate" && String(r.action ?? "").startsWith("Pi compacting") },
  { build: "f3df978+ (arm records carry percent)", test: (r) => r.kind === "compact" && typeof r.percent === "number" },
  { build: "gate era (lease + spread deferrals)", test: (r) => r.kind === "gate" && typeof r.heldMs === "number" },
  { build: "d5edf91+ (compacted records tokensAfter)", test: (r) => r.kind === "compacted" && typeof r.tokensAfter === "number" },
  // The floor quoted in an arm refusal is whatever that pod's config says, not the shipped 25, so matching the
  // literal "25%" mislabelled a pod running a custom softPercent as merely "arm-stage skips" (pi-bot, 04:05Z).
  { build: "36492fb+ (arm refusal names the floor in force)", test: (r) => /under the \d+% floor/.test(String(r.reason ?? "")) },
  { build: "297def5+ (arm-stage skips)", test: (r) => r.kind === "skip" && String(r.stage ?? "") === "arm" },
  { build: "fleet default deadlineMs 240000", test: (r) => r.kind === "deadline" && r.deadlineMs === 240000 },
  { build: "older 120000ms deadline", test: (r) => r.kind === "deadline" && r.deadlineMs === 120000 },
];

function readLog(pod) {
  const path = join(root, pod, ".pi/idle-compaction/log.jsonl");
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line costs nothing here */
    }
  }
  return out;
}

const pods = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(root, e.name, ".pi/idle-compaction/log.jsonl")))
  .map((e) => e.name)
  .sort();

const records = [];
for (const pod of pods) {
  for (const r of readLog(pod)) {
    if (String(r.at ?? "") >= since) records.push({ ...r, pod });
  }
}

const gateDir = join(root, ".pi/idle-compaction");
const gateFiles = existsSync(gateDir) ? readdirSync(gateDir) : [];
const readJson = (name) => {
  const p = join(gateDir, name);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};

const header = (title) => console.log(`\n== ${title} ==`);

console.log(`window since ${since}  root ${root}  pods with logs ${pods.length}  records ${records.length}`);
console.log(`defaults assumed (roll target f3df978): ${JSON.stringify(DEFAULTS)}`);

const lease = readJson("lease.json");
const spacing = readJson("spacing.json");
header("gate directory");
console.log(gateFiles.join(" ") || "(empty)");
if (lease) {
  const delta = lease.expiresAt - lease.startedAt;
  console.log(
    `lease ${lease.repo} startedAt ${new Date(lease.startedAt).toISOString()} expiresAt ${new Date(lease.expiresAt).toISOString()} ` +
      `delta ${delta}ms deadlineMs ${lease.deadlineMs} (invariant expects deadlineMs + 30000 = ${lease.deadlineMs + 30000})`,
  );
}
if (spacing) {
  console.log(`stamp ${spacing.repo} at ${new Date(spacing.at).toISOString()} outcome "${spacing.outcome ?? "?"}"`);
  for (const p of spacing.prior ?? []) console.log(`  prior ${p.repo} ${new Date(p.at).toISOString()} "${p.outcome ?? "?"}"`);
}

header("completions");
const completions = records.filter((r) => r.kind === "compacted");
let totalFreed = 0;
let totalHeldMs = 0;
const lineRate = []; // summarisation rate per landed idle-path completion: the number that sizes the deadline
for (const r of completions.sort((a, b) => a.at.localeCompare(b.at))) {
  const freed = r.freed ?? 0;
  // Pi's path records `tailMs` (the span left over after an earlier handler did the summarising), never `ms`.
  // The idle path records `ms`, which is a real duration. They are not the same measurement and must not be summed.
  const piPath = String(r.trigger ?? "").startsWith("pi:");
  const ms = piPath ? r.tailMs ?? 0 : r.ms ?? 0;
  const landing = r.tokensAfter ?? 0;
  const total = r.tokensBefore ?? 0;
  const estimated = total - DEFAULTS.keptFloorTokens;
  const tags = [];
  if (piPath) {
    tags.push(
      r.tokensAfter !== undefined
        ? `Pi path landing is ${r.tokensAfterSource ?? "an unlabelled estimate"}, tail span ${ms}ms`
        : "Pi path: no landing recorded (build predates the estimate)",
    );
  } else {
    if (landing && (landing < BAND[0] || landing > BAND[1])) tags.push(`landing outside band ${BAND[0]}-${BAND[1]}`);
    if (freed < DEFAULTS.minFreeTokens) tags.push(`LOW YIELD: freed ${freed} < ${DEFAULTS.minFreeTokens}`);
    if (estimated - freed > 5000) tags.push(`arm estimate over-predicted by ${estimated - freed}`);
  }
  // A rate on a Pi-path line is meaningless: its tail span is not a duration, so the division produces 1.3M tok/s.
  const rate = !piPath && ms > 0 && total > 0 ? Math.round(total / (ms / 1000)) : 0;
  if (rate) lineRate.push(rate);
  totalFreed += freed;
  if (!piPath) totalHeldMs += ms;
  console.log(
    `${r.at} ${r.pod.padEnd(26)} ${String(r.trigger).padEnd(22)} ${total} -> ${landing} freed ${freed} in ${Math.round(ms / 1000)}s` +
      `${rate ? ` at ${rate} tok/s` : ""}` +
      (tags.length ? `  [${tags.join("] [")}]` : ""),
  );
}
const idleCompletions = completions.filter((r) => !String(r.trigger ?? "").startsWith("pi:"));
if (lineRate.length) {
  const sorted = [...lineRate].sort((a, b) => a - b);
  console.log(
    `measured summarisation rate (idle-path landings): ${sorted[0]}-${sorted[sorted.length - 1]} tok/s, median ${sorted[Math.floor(sorted.length / 2)]} ` +
      `-> at the ${DEFAULTS.deadlineMs}ms ceiling that is a ${Math.round((sorted[0] * DEFAULTS.deadlineMs) / 1000)}-${Math.round((sorted[sorted.length - 1] * DEFAULTS.deadlineMs) / 1000)} token reach`,
  );
}
console.log(
  `completed ${completions.length} (${idleCompletions.length} idle path, ${completions.length - idleCompletions.length} Pi path)  ` +
    `freed ${totalFreed} tokens  gate held ${Math.round(totalHeldMs / 1000)}s for the idle-path ones`,
);

header("what each completion cost to re-send");
// The price of a summarisation is not the summarisation. After one, the whole kept tail re-reads at 0.1x and the
// prefix is re-created at 1.25x, so a completion costs 0.84 x max(tokensBefore, tokensAfter) in uncached prompt
// tokens (measured by pi-bot on this fleet: 90666 prompt tokens with 55810 cached = 34856 written against a 20513
// token gain). Worth doing when the tokens it frees are worth more than the prefix it re-sends; worth doing twice a
// day when they are not. The break-even is in re-sends of this session's own prompt, which is what the bar compares.
const priceOf = (r) => 0.84 * Math.max(r.tokensBefore ?? 0, r.tokensAfter ?? 0);
let pricedFreed = 0;
let pricedCost = 0;
for (const r of completions.filter((r) => !String(r.trigger ?? "").startsWith("pi:")).sort((a, b) => a.at.localeCompare(b.at))) {
  const price = Math.round(priceOf(r));
  const freed = r.freed ?? 0;
  pricedFreed += freed;
  pricedCost += price;
  const verdict = freed >= DEFAULTS.minFreeTokens ? (freed >= price ? "pays for itself" : `net negative: needs ${Math.ceil(price / Math.max(freed, 1))} calls to break even`) : "below the bar: should not have been attempted";
  console.log(
    `${r.at} ${r.pod.padEnd(26)} freed ${String(freed).padStart(6)} against a ${String(price).padStart(6)} token re-send` +
      ` (return ${(freed / Math.max(price, 1)).toFixed(2)})  ${verdict}`,
  );
}
console.log(
  `idle-path completions in window: freed ${pricedFreed} tokens against ${pricedCost} tokens re-sent` +
    ` (fleet return ${(pricedFreed / Math.max(pricedCost, 1)).toFixed(2)})`,
);
// A prompt rewrite - which is what a plan mutation costs - is the other thing that re-sends a prefix, and it is the
// cheaper of the two: 1794 uncached tokens measured. A compaction has to beat that to be worth preferring.
const rewritePrice = 1794;
console.log(`for scale: a system prompt rewrite costs ${rewritePrice} uncached tokens, so a completion that frees less than that is worth less than leaving the plan section alone`);

header("attempts that paid for nothing");
// One aborted attempt is two records: the `deadline` line and a `skip error:"Compaction cancelled"` a second or two
// later. Count the attempt, not the records, and pair each abort with the arm that preceded *it*, not with the
// pod's first arm in the window - a pod that aborts twice re-arms at a larger size.
const compactByPod = new Map();
for (const r of records.filter((x) => x.kind === "compact").sort((a, b) => a.at.localeCompare(b.at))) {
  const list = compactByPod.get(r.pod) ?? [];
  list.push(r);
  compactByPod.set(r.pod, list);
}
const nearestArm = (pod, at) => {
  let best;
  for (const c of compactByPod.get(pod) ?? []) {
    if (c.at <= at) best = c;
    else break;
  }
  return best;
};
const deadlineRecs = records.filter((r) => r.kind === "deadline").sort((a, b) => a.at.localeCompare(b.at));
const skipsWithError = records.filter((r) => r.kind === "skip" && r.error);
const pairedSkips = new Set();
const attempted = new Map();
for (const r of deadlineRecs) {
  const armed = nearestArm(r.pod, r.at);
  const skip = skipsWithError.find(
    (s) => s.pod === r.pod && !pairedSkips.has(s) && s.at >= r.at && Date.parse(s.at) - Date.parse(r.at) <= 10000,
  );
  if (skip) pairedSkips.add(skip);
  attempted.set(r.pod, (attempted.get(r.pod) ?? 0) + 1);
  console.log(
    `${r.at} ${r.pod.padEnd(26)} ${String(r.trigger).padEnd(22)} kind deadline` +
      ` elapsed ${Math.round((r.elapsedMs ?? 0) / 1000)}s of ${Math.round((r.deadlineMs ?? 0) / 1000)}s ceiling` +
      (armed ? `  armed at ${armed.tokens} tokens (${armed.percent?.toFixed?.(1) ?? "?"}%) at ${armed.at}` : "  no arm record before it") +
      (skip ? `  paired skip ${skip.at}` : ""),
  );
}
const orphanSkips = skipsWithError.filter((s) => !pairedSkips.has(s));
for (const s of orphanSkips) {
  const armed = nearestArm(s.pod, s.at);
  console.log(
    `${s.at} ${s.pod.padEnd(26)} ${String(s.trigger).padEnd(22)} kind skip (no deadline line paired within 10s)` +
      (armed ? `  armed at ${armed.tokens} tokens at ${armed.at}` : "") +
      `  error "${s.error}"`,
  );
}
const repeatPods = [...attempted.entries()].filter(([, n]) => n > 1);
console.log(
  `aborted attempts ${deadlineRecs.length + orphanSkips.length} (deadline records ${deadlineRecs.length}, ` +
    `skip lines paired to a deadline ${pairedSkips.size}, skip lines with no deadline ${orphanSkips.length})  ` +
    `gate time paid for nothing ${Math.round(deadlineRecs.reduce((n, r) => n + (r.elapsedMs ?? 0), 0) / 1000)}s` +
    (repeatPods.length ? `  pods that re-armed and aborted again: ${repeatPods.map(([p, n]) => `${p} x${n}`).join(", ")}` : ""),
);

header("how long a completion takes to pay back, per pod");
// A completion writes a new prompt prefix once (1.25x) and every later call re-reads it (0.1x), so what it frees
// comes back as 0.1 x freed on each subsequent call. The number of calls that takes is price / (0.1 x freed);
// whether that is a good trade depends entirely on how often the session is used, which the arm lines report - an
// arm is written when a turn ends with the session eligible, so arm timestamps are turn endings.
const armTimes = new Map();
for (const r of records.filter((x) => x.kind === "compact")) {
  const t = Date.parse(r.at);
  if (Number.isFinite(t)) (armTimes.get(r.pod) ?? armTimes.set(r.pod, []).get(r.pod)).push(t);
}
const podNames = new Set([...armTimes.keys(), ...completions.map((c) => c.pod)]);
const rows = [];
for (const pod of podNames) {
  const arms = (armTimes.get(pod) ?? []).sort((a, b) => a - b);
  if (arms.length < 2) continue;
  const gaps = arms.slice(1).map((t, i) => t - arms[i]).sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const done = completions.filter((c) => c.pod === pod && (c.freed ?? 0) > 0 && !String(c.trigger ?? "").startsWith("pi:"));
  if (!done.length) {
    rows.push({ pod, arms: arms.length, medianGap, calls: null, hours: null, freed: 0 });
    continue;
  }
  const freed = done.reduce((n, c) => n + c.freed, 0) / done.length;
  const price = done.reduce((n, c) => n + 0.84 * Math.max(c.tokensBefore ?? 0, c.tokensAfter ?? 0), 0) / done.length;
  const calls = price / (0.1 * Math.max(freed, 1));
  rows.push({ pod, arms: arms.length, medianGap, calls, hours: (calls * medianGap) / 3600_000, freed });
}
rows.sort((a, b) => (a.hours ?? -1) - (b.hours ?? -1));
for (const r of rows) {
  console.log(
    `${r.pod.padEnd(26)} ${String(r.arms).padStart(3)} arms in window, median ${(r.medianGap / 60000).toFixed(0).padStart(4)} min between turn endings` +
      (r.calls === null
        ? "  no completion in window to price"
        : `  freed ${Math.round(r.freed)} needs ${Math.ceil(r.calls)} calls to pay back = ${r.hours.toFixed(1)} h of this session's own use`),
  );
}
const slow = rows.filter((r) => r.hours !== null && r.hours > 8);
console.log(
  `${slow.length} pods would not see the saving inside a working day at their own rate` +
    (slow.length ? ` (${slow.map((r) => `${r.pod} ${r.hours.toFixed(1)}h`).join(", ")})` : "") +
    " - for those, an idle compaction is a payment, not an investment",
);

header("queue cost per pod (gate deferrals)");
const waits = new Map();
for (const r of records.filter((x) => x.kind === "gate")) {
  const w = waits.get(r.pod) ?? { n: 0, max: 0, first: r.at, last: r.at, sum: 0, asked: 0, piHold: 0 };
  w.n += 1;
  w.max = Math.max(w.max, r.waitMs ?? 0);
  w.sum += r.waitMs ?? 0;
  w.first = w.first < r.at ? w.first : r.at;
  w.last = w.last > r.at ? w.last : r.at;
  if (String(r.action ?? "") === "asked now") w.asked += 1;
  if (String(r.action ?? "").startsWith("Pi compacting")) w.piHold += 1;
  waits.set(r.pod, w);
}
for (const [pod, w] of [...waits.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    `${pod.padEnd(26)} deferrals ${String(w.n).padStart(3)}  max single wait ${String(w.max).padStart(6)}ms  ` +
      `queued ${Math.round(w.sum / 1000)}s total  window ${w.first.slice(11, 19)}-${w.last.slice(11, 19)}` +
      (w.asked ? `  asked-now ${w.asked}` : "") +
      (w.piHold ? `  Pi-path holds recorded ${w.piHold}` : ""),
  );
}
// Two different things a single line would blur, and slopyphus caught that I was about to blur them.
// An *escape* is a pod that compacted with no lease because the gate itself failed: the record carries `error`.
// A *concurrent run* is a summarisation that went ahead beside a peer's live lease by design - Pi's own path
// (`holdGateForPiPath` will not stomp a live lease and does not honour the spacing stamp) and a forced `/run --force`
// (`asked now`). Neither carries `error`, so counting only `error` reads as an all-clear on the exact failure mode
// the spacing/lease hazard fix targets. Three of these fired on 2026-11-27.
const ungated = records.filter((r) => r.kind === "gate" && r.error);
const CONCURRENT_ACTIONS = new Set(["Pi compacting while the gate is held elsewhere", "asked now"]);
const concurrent = records.filter((r) => r.kind === "gate" && CONCURRENT_ACTIONS.has(String(r.action ?? "")));
for (const r of ungated) console.log(`${r.at} ${r.pod.padEnd(26)} UNGATED ESCAPE error ${r.error} trigger ${r.trigger}`);
console.log(`ungated escapes (compacted with no lease held after a gate I/O error) ${ungated.length}`);
for (const r of concurrent)
  console.log(
    `${r.at} ${r.pod.padEnd(26)} CONCURRENT RUN action "${r.action}" ${r.heldBy ? `heldBy ${r.heldBy}` : ""}${r.forced ? " forced" : ""}`,
  );
console.log(
  `concurrent runs (a summarisation that went ahead beside a peer's live lease) ${concurrent.length} - ` +
    `${concurrent.filter((r) => String(r.action).startsWith("Pi compacting")).length} of them Pi's own path, ` +
    `${concurrent.filter((r) => r.action === "asked now").length} forced`,
);
const gives = records.filter((r) => r.kind === "gate" && r.gaveUp);
console.log(`gate give-ups ${gives.length} (a give-up means a session stopped waiting, which is the failure mode gateMaxWaitMs exists to bound)`);

header("arms and skips");
const skips = records.filter((r) => r.kind === "skip" && r.reason);
const byReason = new Map();
for (const r of skips) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(3)}  ${reason}`);

header("what each pod says it is running (self-reported)");
// The records themselves now answer the build question: every line carries `build`, and `start` / `compact` lines
// carry the config in force and where it came from. Until a pod writes a marker there is nothing to report here,
// which is why the fingerprint table below is kept as the fallback.
const reported = new Map();
for (const r of records) {
  if (r.build === undefined) continue;
  const e = reported.get(r.pod) ?? { builds: new Map(), cfgFrom: undefined, cfg: undefined, cfgEnv: undefined, unmarked: 0 };
  e.builds.set(r.build, (e.builds.get(r.build) ?? 0) + 1);
  if (r.cfgFrom !== undefined) e.cfgFrom = r.cfgFrom;
  if (r.cfg !== undefined) e.cfg = r.cfg;
  if (r.cfgEnv !== undefined) e.cfgEnv = r.cfgEnv;
  reported.set(r.pod, e);
}
for (const r of records) if (r.build === undefined) {
  const e = reported.get(r.pod) ?? { builds: new Map(), unmarked: 0 };
  e.unmarked += 1;
  reported.set(r.pod, e);
}
const buildsSeen = new Map();
for (const [pod, e] of [...reported.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const builds = [...e.builds.entries()].sort((a, b) => b[1] - a[1]);
  const sha = builds.map(([s, n]) => `${s} (${n} lines)`).join(", ") || "no marker in window";
  const cfg = e.cfg
    ? `soft ${e.cfg.softPercent}% deadline ${Math.round(e.cfg.deadlineMs / 1000)}s spread ${Math.round(e.cfg.spreadMs / 1000)}s gateMaxWait ${Math.round(e.cfg.gateMaxWaitMs / 1000)}s minFree ${e.cfg.minFreeTokens} cooldown ${Math.round(e.cfg.cooldownMs / 1000)}s`
    : "no config reported in window";
  console.log(`${pod.padEnd(26)} build ${sha}  from ${e.cfgFrom ?? "not reported"}  ${cfg}`);
  if (e.cfgEnv?.length) console.log(`  env overrides ${e.cfgEnv.join(", ")}`);
  if (e.unmarked) console.log(`  ${e.unmarked} records in window carry no build marker (written by a build that predates the marker)`);
  for (const [s] of builds) buildsSeen.set(s, (buildsSeen.get(s) ?? 0) + 1);
}
console.log(
  buildsSeen.size
    ? `builds seen ${[...buildsSeen.entries()].map(([s, n]) => `${s} in ${n} pod(s)`).join(", ")}`
    : "no pod in this window self-reported a build; the fingerprint table below is the only answer available",
);

header("build fingerprints");
const seen = new Map();
for (const r of records) {
  for (const f of FINGERPRINTS) {
    if (f.test(r)) {
      const set = seen.get(r.pod) ?? new Set();
      set.add(f.build);
      seen.set(r.pod, set);
    }
  }
}
for (const pod of pods) {
  const hits = seen.get(pod);
  console.log(`${pod.padEnd(26)} ${hits ? [...hits].join(", ") : "no distinguishing field seen in window"}`);
}
if (spacing && spacing.outcome !== undefined) console.log("spacing.json carries outcome/prior -> every pod that read or wrote it is on d5edf91 or later");
