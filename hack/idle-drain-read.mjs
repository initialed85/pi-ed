#!/usr/bin/env node
/**
 * Read the fleet's idle-compaction drain and answer the four questions the rollout actually turns on:
 *
 *   1. did completions land in the band, and what did each one free (a completion that frees almost nothing
 *      still held the gate for its whole duration, so yield per held second is the number that matters);
 *   2. how many attempts hit the ceiling, and what they paid for nothing;
 *   3. how long peers queued behind a holder, which is the cost side of the gate;
 *   4. which build each pod is really running, since the records carry no build marker and the answer has to be
 *      inferred from which fields exist.
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
  minFreeTokens: 20000,
  keptFloorTokens: 24000,
  deadlineMs: 240000,
  spreadMs: 90000,
  gateMaxWaitMs: 5400000,
  cooldownMs: 600000,
};
/** Landing band measured across the idle-path completions of 2026-11-26 (25667-31480) plus the widest one seen. */
const BAND = [25667, 32374];

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
  { build: "36492fb+ (softPercent 25)", test: (r) => String(r.reason ?? "").includes("under the 25% floor") },
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
  const ms = r.ms ?? 0;
  const landing = r.tokensAfter ?? 0;
  const total = r.tokensBefore ?? 0;
  const estimated = total - DEFAULTS.keptFloorTokens;
  const tags = [];
  // Pi's own path reports no tokensAfter/freed, so judging its yield from zeros is a reading error, not a finding.
  const piPath = String(r.trigger ?? "").startsWith("pi:");
  if (piPath) {
    tags.push("Pi path: no tokensAfter recorded, ms is a tail span not a duration");
  } else {
    if (landing && (landing < BAND[0] || landing > BAND[1])) tags.push(`landing outside band ${BAND[0]}-${BAND[1]}`);
    if (freed < DEFAULTS.minFreeTokens) tags.push(`LOW YIELD: freed ${freed} < ${DEFAULTS.minFreeTokens}`);
    if (estimated - freed > 5000) tags.push(`arm estimate over-predicted by ${estimated - freed}`);
  }
  // A rate on a Pi-path line is meaningless: its ms is a tail span, so the division produces numbers like 1.3M tok/s.
  const rate = !piPath && ms > 0 && total > 0 ? Math.round(total / (ms / 1000)) : 0;
  if (rate) lineRate.push(rate);
  totalFreed += freed;
  totalHeldMs += ms;
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
const gives = records.filter((r) => r.kind === "gate" && r.gaveUp);
console.log(`gate give-ups ${gives.length} (a give-up means a session stopped waiting, which is the failure mode gateMaxWaitMs exists to bound)`);

header("arms and skips");
const skips = records.filter((r) => r.kind === "skip" && r.reason);
const byReason = new Map();
for (const r of skips) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(3)}  ${reason}`);

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
