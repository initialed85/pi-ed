#!/usr/bin/env node
// Two questions that decide one proposed feature, measured from the same timeline.
//
// The proposal: after a compaction, run one deliberately trivial completion against the new prefix so the expensive
// uncached re-read happens in the idle path instead of on the human's next turn. It can only be judged against two
// numbers, and neither was on paper before this script:
//
//   1. how soon is there a next call at all, and is it a human turn? (a warming call that arrives after the real
//      one did its job too late; a warming call on a session nobody returns to pays for a re-read that would never
//      have happened)
//   2. what actually makes a call cold? A gap, or a rewrite? If the provider's cache survives long gaps and only a
//      prefix rewrite makes a call cold, then the warming window is wide and the feature is a latency shifter; if
//      cold reads cluster at long gaps, the window is narrow and the feature is a coin toss.
//
// Pi records enough to answer both without provider access: every assistant call carries usage (input, cacheRead,
// cacheWrite), and every prefix rewrite is a system-role record carrying `sections` and/or `toolsAdded` /
// `toolsRemoved`. The tool list is part of the cached prefix, so a tool appearing or disappearing mid-session is a
// rewrite too - which is why this prints it rather than trusting the prompt text alone.
//
//   node hack/post-compaction-return.mjs [--since 2026-11-27T02:16:00] [--pods pi-bot,slopyphus] [--cold 50]
//
// Session transcripts live in each pod's own ~/.pi/agent/sessions, not in the shared /workspace, so the timeline is
// reduced inside the pod and only the reduced timeline crosses the boundary. Compaction events come from the shared
// /workspace/<pod>/.pi/idle-compaction/log.jsonl, which is what makes the join work without any pod-side code
// knowing the gate exists.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : argv[i + 1];
};
const since = String(flag("since", "2026-11-27T02:16:00"));
const only = String(flag("pods", "")).split(",").filter(Boolean);
const root = String(flag("root", "/workspace"));
const coldShare = Number(flag("cold", "50")); // a call below this cached share is a full prefix re-send

const POD_PATTERN =
  /^(pi-bot|pi-ed|pi-team-room|slopyphus|home-ops|rooter|quake|camry|macker|maclet|memebrary|mcbot|longhorn-storage-gateway|macgrubernetes|darwin-vxlan|djangolang|front)-/;

const podNames = execFileSync("kubectl", ["get", "pods", "-o", "jsonpath={.items[*].metadata.name}"], {
  encoding: "utf8",
  timeout: 60000,
})
  .trim()
  .split(/\s+/)
  .filter((p) => POD_PATTERN.test(p));

// Reduced inside the pod into a record timeline: u = user turn, a = model call with usage, s = prefix rewrite
// (system-role record, naming which prompt sections and which tools changed). Python because `node` is not on PATH
// in these images (it lives under /root/.nvm) and python3 is.
const REMOTE_PY = [
  "import os,json,glob,sys,time",
  'roots=[os.environ.get("PI_CODING_AGENT_DIR") or "", os.path.expanduser("~/.pi/agent"), "/root/.pi/agent"]',
  "since=int(sys.argv[1])",
  "files=[];seen=set()",
  "for r in roots:",
  "    if not r or r in seen: continue",
  "    seen.add(r)",
  '    files+=[f for f in glob.glob(os.path.join(r,"sessions","*","*.jsonl")) if "--tmp-" not in f and os.path.isfile(f)]',
  "files=[f for f in files if os.path.getmtime(f)*1000>=since-3600000]",
  "files.sort(key=lambda f:os.path.getmtime(f),reverse=True)",
  "out=[]",
  "for f in files[:8]:",
  '    try: data=open(f,"r",encoding="utf-8",errors="replace").read()',
  "    except Exception: continue",
  '    for line in data.split("\\n"):',
  "        if not line.strip(): continue",
  "        try: rec=json.loads(line)",
  "        except Exception: continue",
  '        m=rec.get("message") if isinstance(rec.get("message"),dict) else rec',
  "        if not isinstance(m,dict): continue",
  '        try: ts=int(m.get("timestamp") or rec.get("timestamp") or 0)',
  "        except Exception: continue",
  "        if not ts or ts<since: continue",
  '        role=m.get("role")',
  '        if role=="user":',
  '            c=m.get("content")',
  '            head=" ".join((p.get("text") or "") for p in c if isinstance(p,dict))[:60] if isinstance(c,list) else str(c)[:60]',
  '            out.append({"t":ts,"k":"u","head":" ".join(head.split())})',
  '        elif role=="assistant" and isinstance(m.get("usage"),dict):',
  '            u=m["usage"]',
  '            out.append({"t":ts,"k":"a","i":int(u.get("input") or 0),"cr":int(u.get("cacheRead") or 0),"cw":int(u.get("cacheWrite") or 0)})',
  '        elif role=="system":',
  '            d={"t":ts,"k":"s","sec":1 if m.get("sections") else 0,"ta":[],"tr":[]}',
  '            for tool in (m.get("toolsAdded") or [])[:12]: d["ta"].append(tool.get("name") or "?")',
  '            for tool in (m.get("toolsRemoved") or [])[:12]: d["tr"].append(tool.get("name") or "?")',
  '            out.append(d)',
  "out.sort(key=lambda x:x['t'])",
  "print(json.dumps(out))",
].join("\n");

function timelineFor(name) {
  const pod = podNames.find((p) => p.startsWith(name + "-"));
  if (!pod) return null;
  const from = Date.parse(since) - 4 * 3600 * 1000; // start outside the window so a gap can begin before it
  const b64 = Buffer.from(REMOTE_PY, "utf8").toString("base64");
  const cmd = `echo ${b64} | base64 -d > /tmp/pcr.py && python3 /tmp/pcr.py ${from}`;
  const out = execFileSync("kubectl", ["exec", pod, "--", "sh", "-lc", cmd], {
    encoding: "utf8",
    timeout: 150000,
    maxBuffer: 96 * 1024 * 1024,
  });
  return { pod, events: JSON.parse(out).filter((e) => e.t >= Date.parse(since)) };
}

const pctv = (v) => `${(v * 100).toFixed(0)}%`;
const perPod = [];
const decay = [];
const failures = [];
const cold = [];

for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const name = dir.name;
  if (only.length && !only.includes(name)) continue;
  const log = path.join(root, name, ".pi/idle-compaction/log.jsonl");
  if (!fs.existsSync(log)) continue;
  const records = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((r) => String(r.at ?? "") >= since && r.kind === "compacted");
  if (!records.length) continue;
  let got;
  try {
    got = timelineFor(name);
  } catch (e) {
    failures.push(`${name}: ${String(e.stderr || e.message).split("\n").pop()}`);
    continue;
  }
  if (!got) continue;
  const events = got.events;
  const users = events.filter((e) => e.k === "u");
  const calls = events.filter((e) => e.k === "a");

  for (const c of records) {
    const at = Date.parse(c.at);
    // Pi compacts in prepareNextTurn, so the call that pays for the new prefix can carry the completion's own
    // timestamp - it is the request that triggered the compaction, re-issued against the compacted prefix. Skipping
    // every call within two seconds of the completion, as an earlier version of this script did, hid that payer on
    // the Pi path and made the following (already warm) call look like the one being charged.
    const paying = calls.find((a) => a.t >= at - 3000 && a.t <= at + 3000) ?? null;
    const nextCall = calls.find((a) => a.t > (paying ? paying.t : at) + 2000);
    const nextUser = users.find((u) => u.t > at + 2000);
    const charged = paying ?? nextCall ?? null;
    const row = {
      name,
      at: c.at,
      trigger: String(c.trigger ?? "?"),
      freed: Number(c.freed ?? 0),
      immediate: paying ? 1 : 0,
      chargedUncached: charged ? charged.i + charged.cw : 0,
      chargedCached: charged ? charged.cr : 0,
      chargedGap: charged ? Math.round((charged.t - at) / 1000) : null,
      callGap: nextCall ? Math.round((nextCall.t - at) / 1000) : null,
      nextCached: nextCall ? nextCall.cr : 0,
      nextUncached: nextCall ? nextCall.i + nextCall.cw : 0,
      userGap: nextUser ? Math.round((nextUser.t - at) / 1000) : null,
      head: nextUser ? nextUser.head : "",
    };
    perPod.push(row);
  }

  // What makes a call cold: walk the timeline and tag each call by the gap since the previous call and by whether a
  // prefix rewrite (prompt sections or tool set) landed between them.
  // The decay curve itself: every call bucketed by the gap since the previous call, with its cached share. This is
  // the number a warming completion has to beat, and it is not a TTL constant - it is measured per gap band.
  let prevAny = null;
  for (const e of events) {
    if (e.k === "a") {
      const total = e.i + e.cw + e.cr;
      if (total > 0) {
        const gap = prevAny ? Math.round((e.t - prevAny.t) / 1000) : null;
        if (gap !== null) decay.push({ gap, share: e.cr / total, total, name });
      }
      prevAny = e;
      continue;
    }
    if (e.k === "u") prevAny = e;
  }

  let prevCall = null;
  let rewriteSince = null;
  for (const e of events) {
    if (e.k === "s") {
      rewriteSince = e;
      continue;
    }
    if (e.k !== "a") continue;
    const total = e.i + e.cw + e.cr;
    if (total > 0 && (e.cr / total) * 100 < coldShare) {
      const gap = prevCall ? Math.round((e.t - prevCall.t) / 1000) : null;
      cold.push({
        name,
        at: e.t,
        uncached: e.i + e.cw,
        cached: e.cr,
        gap,
        rewrite: rewriteSince
          ? { sec: rewriteSince.sec, ta: rewriteSince.ta, tr: rewriteSince.tr }
          : null,
      });
    }
    prevCall = e;
    rewriteSince = null;
  }
}

const withCall = perPod.filter((r) => r.callGap !== null);
console.log(`window since ${since}  completions ${perPod.length}  paid at the completion itself ${perPod.filter((r) => r.immediate).length}  deferred to a later call ${perPod.filter((r) => !r.immediate && r.chargedUncached > 0).length}  no later call inside the window ${perPod.filter((r) => !r.immediate && !r.chargedUncached).length}  (that last group has its cost on the record and its benefit outside the window, in both directions - not a win)`);
for (const f of failures) console.log(`  timeline read failed: ${f}`);

console.log(`\n== who pays the re-read after a compaction ==`);
for (const r of perPod.sort((a, b) => (a.chargedGap ?? 1e9) - (b.chargedGap ?? 1e9))) {
  const share = r.chargedCached + r.chargedUncached > 0 ? pctv(r.chargedCached / (r.chargedCached + r.chargedUncached)) : "n/a";
  const warm = r.nextCached + r.nextUncached > 0 ? `${pctv(r.nextCached / (r.nextCached + r.nextUncached))} cached` : "none";
  console.log(
    `${r.at} ${r.name.padEnd(26)} ${r.trigger.padEnd(21)} freed ${String(r.freed).padStart(6)}  ` +
      `payer ${r.immediate ? "same call (prepareNextTurn)" : `next call ${String(r.chargedGap ?? -1).padStart(5)}s` + " (deferred)"}  ` +
      `charged ${String(r.chargedUncached).padStart(6)} uncached / ${String(r.chargedCached).padStart(6)} cached (${share})  call after that ${warm.padStart(6)}  next user turn ${String(r.userGap ?? -1).padStart(6)}s`,
  );
}

const gaps = withCall.map((r) => r.callGap).sort((a, b) => a - b);
const med = gaps[Math.floor(gaps.length / 2)];
console.log(
  `\nnext-call gap: median ${med}s  under 30s ${gaps.filter((g) => g < 30).length}  30-300s ${gaps.filter((g) => g >= 30 && g <= 300).length}  over 300s ${gaps.filter((g) => g > 300).length}`,
);
console.log(`sessions that never came back in this window: ${perPod.filter((r) => r.callGap === null).map((r) => r.name).join(", ")}`);

console.log(`\n== calls that re-read the whole prefix (cached share < ${coldShare}%) ==`);
const byGap = { "<30s": 0, "30-300s": 0, ">300s": 0, none: 0 };
const byCause = { "prompt sections": 0, "tool set": 0, "prompt+tools": 0, "no rewrite recorded": 0 };
for (const c of cold) {
  const g = c.gap === null ? "none" : c.gap < 30 ? "<30s" : c.gap <= 300 ? "30-300s" : ">300s";
  byGap[g]++;
  if (!c.rewrite) byCause["no rewrite recorded"]++;
  else if (c.rewrite.sec && (c.rewrite.ta.length || c.rewrite.tr.length)) byCause["prompt+tools"]++;
  else if (c.rewrite.sec) byCause["prompt sections"]++;
  else byCause["tool set"]++;
  const w = new Date(c.at).toISOString().slice(11, 19);
  const cause = c.rewrite
    ? `rewrite: ${c.rewrite.sec ? "sections" : "-"}${c.rewrite.ta.length ? ` +tools(${c.rewrite.ta.join(",")})` : ""}${c.rewrite.tr.length ? ` -tools(${c.rewrite.tr.join(",")})` : ""}`
    : "no rewrite record between the previous call and this one";
  console.log(
    `${c.name.padEnd(24)} ${w} ${String(c.uncached).padStart(7)} uncached / ${String(c.cached).padStart(6)} cached  gap since previous call ${String(c.gap ?? -1).padStart(6)}s  ${cause}`,
  );
}
console.log(`\n== cached share by gap since the previous call (every call, all pods) ==`);
const bands = [[1, 30], [30, 60], [60, 120], [120, 300], [300, 900], [900, 3600], [3600, 1e9]];
for (const [lo, hi] of bands) {
  const inB = decay.filter((d) => d.gap >= lo && d.gap < hi);
  if (!inB.length) continue;
  const shares = inB.map((d) => d.share).sort((a, b) => a - b);
  const q = (p) => shares[Math.min(shares.length - 1, Math.floor(shares.length * p))];
  const warm = inB.filter((d) => d.share > 0.5).length;
  console.log(
    `  gap ${String(lo).padStart(4)}-${hi === 1e9 ? "inf" : String(hi).padEnd(4)}s  calls ${String(inB.length).padStart(4)}  ` +
      `median share ${pctv(q(0.5)).padStart(4)}  25th pct ${pctv(q(0.25)).padStart(4)}  warm(>50%) ${warm}`,
  );
}

console.log(`\ncold calls by gap: ${Object.entries(byGap).map(([k, v]) => `${k} ${v}`).join("  ")}`);
console.log(`cold calls by what changed in between: ${Object.entries(byCause).map(([k, v]) => `${k} ${v}`).join("  ")}`);
