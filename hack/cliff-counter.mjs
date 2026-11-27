#!/usr/bin/env node
/**
 * The acceptance test for the raised arm bar (`softPercent` 65, rolled 2026-11-27).
 *
 * The bar only earns its keep if the idle path claims the 65-87.5% band *before* Pi's own auto-compaction fires at
 * 87.5%. A Pi-path completion inside that band is a cliff: the session ran out of room on Pi's schedule rather than
 * ours, and the summarisation landed inside a live turn. So this counts, per pod and fleet-wide:
 *
 *   - `CLIFF`        Pi-path (`pi:threshold`) completions, which are the cliff by definition: Pi reached 87.5% of its
 *                    own denominator before the idle path got there. Zero is the goal.
 *   - `claimable`    of those, the ones at or above the bar, i.e. sessions the idle path was eligible to claim.
 *   - `claimed`      idle-path completions inside the bar -> threshold band: the idle path got there first.
 *   - `missed`       idle attempts in the band that never landed (deadline aborts, Pi-side refusals, gate give-ups).
 *   - `underBar`     idle completions below the bar, which survive the raise because the token bars are the real gate.
 *   - `arm refusals` how many sessions the raised bar is now turning away at arm time.
 *
 * Read-only: it never writes to a pod. It reads `<root>/<pod>/.pi/idle-compaction/log.jsonl` and nothing else.
 *
 * Why the cliff is not banded: the measured Pi-path inputs on 2026-11-26 and 2026-11-27 ran 114803-119360 tokens,
 * which is just *above* 87.5% of the declared 131072 (114688), so filtering cliffs by the 65-87.5% band discarded
 * every one of them and printed a clean fleet. The band is applied to the idle side, where it is meaningful.
 *
 * Usage:
 *   node hack/cliff-counter.mjs --since 2026-11-27T09:00:00
 *   node hack/cliff-counter.mjs --since 2026-11-26T17:00:00 --until 2026-11-27T09:00:00
 *
 * Judge it as a rate per hour, this window against a comparable window before the roll. `percent` in a pod's own log
 * is computed from whatever `contextWindow` Pi carries for that pod's alias, so the band here is derived from
 * `tokensBefore` against `--window` (131072) and labelled as such rather than passed off as the pod's own percent.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : argv[i + 1];
};

const root = flag("root", "/workspace");
const since = flag("since", "2000-01-01T00:00:00");
const until = flag("until", new Date().toISOString().slice(0, 19));
const bar = Number(flag("bar", 65));
const threshold = Number(flag("threshold", 87.5));
const declaredWindow = Number(flag("window", 131072));

const barTokens = Math.round((bar / 100) * declaredWindow);
const thresholdTokens = Math.round((threshold / 100) * declaredWindow);

function pods() {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(root, name, ".pi/idle-compaction/log.jsonl")))
    .sort();
}

function readLog(pod) {
  const rows = [];
  try {
    for (const line of readFileSync(join(root, pod, ".pi/idle-compaction/log.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const at = String(row.at ?? "");
      if (at && (at < since || at > until)) continue;
      rows.push(row);
    }
  } catch {
    /* no log for this pod */
  }
  return rows;
}

const isPiPath = (row) => String(row.trigger ?? "").startsWith("pi:");
const inBand = (tokens) => typeof tokens === "number" && tokens >= barTokens && tokens < thresholdTokens;
const sum = (rows, key) => rows.reduce((n, r) => n + (typeof r[key] === "number" ? r[key] : 0), 0);

const report = [];
for (const pod of pods()) {
  const rows = readLog(pod);
  if (!rows.length) continue;

  const cfgRow = [...rows].reverse().find((r) => r.cfg && typeof r.cfg.softPercent === "number");
  const build = [...rows].reverse().find((r) => typeof r.build === "string")?.build ?? "unreported";

  const idleAttempts = rows.filter((r) => r.kind === "compact" && !isPiPath(r));
  const idleDone = rows.filter((r) => r.kind === "compacted" && !isPiPath(r));
  const piThreshold = rows.filter((r) => r.kind === "compacted" && String(r.trigger ?? "").includes("pi:threshold"));
  const deadline = rows.filter((r) => r.kind === "deadline");
  const preflight = rows.filter((r) => r.kind === "skip" && String(r.stage ?? "") === "preflight");
  const armRefuse = rows.filter((r) => r.kind === "skip" && /floor|not armed/.test(String(r.reason ?? "")));
  const gate = rows.filter((r) => r.kind === "gate");

  const bandAttempts = idleAttempts.filter((r) => inBand(r.tokens));
  const claimed = idleDone.filter((r) => inBand(r.tokensBefore));
  // A Pi-threshold completion is a cliff whatever its size: by definition Pi reached 87.5% of its own denominator
  // before the idle path got there. The band filters the idle side only; on the Pi side it says whether the idle path
  // could have claimed that session at all. Measured Pi-path inputs ran 114803-119360 tokens, i.e. just *above* 87.5%
  // of 131072 = 114688, so banding the cliff itself would have hidden every single one of them.
  const cliff = piThreshold;
  const claimable = piThreshold.filter((r) => typeof r.tokensBefore === "number" && r.tokensBefore >= barTokens);
  // Pi-path `compacted` records carry a landing size only on builds that estimated one, so a freed total of zero here
  // means "this build recorded none", not "nothing was freed".
  const cliffFreedRows = cliff.filter((r) => typeof r.freed === "number");
  // An idle attempt in the band is a miss unless a completion for the same session landed at that size.
  const missed = bandAttempts.filter((r) => !claimed.some((c) => c.tokensBefore === r.tokens));

  report.push({
    pod,
    build,
    softPercent: cfgRow?.cfg?.softPercent,
    idleAttempts: idleAttempts.length,
    idleCompleted: idleDone.length,
    freedIdle: sum(idleDone, "freed"),
    claimed: claimed.length,
    cliff: cliff.length,
    cliffDetail: cliff.map((r) => `${String(r.at ?? "").slice(11, 19)} ${r.tokensBefore ?? "?"}tok -> ${r.tokensAfter ?? "?"}`),
    cliffClaimable: claimable.length,
    freedPiPath: sum(cliff, "freed"),
    cliffFreedRows: cliffFreedRows.length,
    missed: missed.length,
    deadlineAborts: deadline.length,
    preflightDefers: preflight.length,
    armRefusals: armRefuse.length,
    gateEvents: gate.length,
    underBar: idleDone.filter((r) => typeof r.tokensBefore === "number" && r.tokensBefore < barTokens).length,
  });
}

const total = (key) => report.reduce((n, r) => n + (r[key] ?? 0), 0);
const freedText = () =>
  total("cliffFreedRows")
    ? `${total("freedPiPath")} tokens across ${total("cliffFreedRows")}/${total("cliff")} rows`
    : `n/a: ${total("cliff")} cliff rows and not one of them carried a landing size`;

console.log(`cliff counter · window ${since} .. ${until} · root ${root}`);
console.log(
  `band: ${bar}% -> ${threshold}% of a declared ${declaredWindow}-token window = ${barTokens} .. ${thresholdTokens} tokens`,
);
console.log("");

for (const r of report) {
  console.log(
    `${r.pod.padEnd(12)} build ${r.build} soft ${r.softPercent ?? "unset"}% | idle attempts ${r.idleAttempts} ` +
      `completed ${r.idleCompleted} (freed ${r.freedIdle}) | claimed in band ${r.claimed} | CLIFF ${r.cliff}` +
      `${r.cliffDetail.length ? ` [${r.cliffDetail.join(", ")}] freed ${r.freedPiPath}` : ""} | of those claimable by ` +
      `the idle path ${r.cliffClaimable} | band attempts that did not land ${r.missed} | deadline aborts ` +
      `${r.deadlineAborts} | pre-flight defers ${r.preflightDefers} | ` +
      `arm refusals naming the floor ${r.armRefusals} | gate events ${r.gateEvents} | completed under the bar ${r.underBar}`,
  );
}

console.log("");
console.log(
  `fleet: pods reporting ${report.length} | idle completions ${total("idleCompleted")} (freed ${total("freedIdle")}) | ` +
    `idle completions in band ${total("claimed")} | CLIFF events ${total("cliff")}, ${total("cliffClaimable")} of them ` +
    `at or above the bar so the idle path could have claimed them (freed ${freedText()}) | ` +
    `band attempts that did not land ${total("missed")} | deadline aborts ${total("deadlineAborts")} | pre-flight ` +
    `defers ${total("preflightDefers")} | arm refusals ${total("armRefusals")}`,
);
console.log(
  `verdict: a cliff is a Pi-threshold compaction - Pi reached 87.5% of its own denominator before the idle path got ` +
    `there. ${total("cliff")} in this window across ${report.length} pods, ${total("cliffClaimable")} of them on ` +
    `sessions the raised bar could have claimed. Compare the rate per hour against a window of the same length before ` +
    `the roll; a cliff count that fell only because nobody was active is not a win.`,
);
