// Were aborts caused by the pod being busy, or by the shared box? Measured answer: busy-pod is dead.
//
// A `kind:"deadline"` record in .pi/idle-compaction/log.jsonl is stamped when the ceiling FIRES, so the
// summarisation ran BEFORE its `at`: the attempt window is [at - elapsedMs, at]. An earlier pass measured
// forward from `at`, which samples the resumed turn after the abort and produced a false "own generation was
// in flight" reading (that error is what this probe exists to prevent being repeated).
//
// 2026-11-27T06:39Z read, 37 deadline attempts since 17:00Z: 35 of 37 attempt windows contain no user turn
// and no own model call. Only pi-bot 00:58:53->01:02:53 (1 call) and slopyphus 22:20:26->22:24:26 (3 calls)
// had own traffic in flight. The count tracks the live logs, so re-running it later finds more attempts; the
// ratio is the finding, not the tally. The signal that does support box contention is clustering: nine session_start:startup
// attempts aborted 17:11:42-17:11:50Z inside 8 seconds, all at the flat 120000 ms ceiling, all on idle pods.
//
// Reads every pod's compaction log from /workspace and each pod's session timeline over kubectl exec
// (python3 on the pod; node is not installed there).
//
//   node hack/abort-window.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = "/workspace";
const since = "2026-11-26T17:00:00";
const POD_PATTERN = /^(pi-bot|pi-ed|pi-team-room|slopyphus|home-ops|rooter|quake|camry|macker|maclet|memebrary|mcbot|longhorn-storage-gateway|macgrubernetes|darwin-vxlan|djangolang|front)-/;
const podNames = execFileSync("kubectl", ["get","pods","-o","jsonpath={.items[*].metadata.name}"],{encoding:"utf8",timeout:60000}).trim().split(/\s+/).filter(p=>POD_PATTERN.test(p));

const PY = [
 "import os,json,glob,sys",
 'roots=[os.environ.get("PI_CODING_AGENT_DIR") or "", os.path.expanduser("~/.pi/agent"), "/root/.pi/agent"]',
 "lo,hi=int(sys.argv[1]),int(sys.argv[2])",
 "files=[];seen=set()",
 "for r in roots:",
 "    if not r or r in seen: continue",
 "    seen.add(r)",
 '    files+=[f for f in glob.glob(os.path.join(r,"sessions","*","*.jsonl")) if "--tmp-" not in f and os.path.isfile(f)]',
 "out=[]",
 "for f in files:",
 '    try: data=open(f,"r",encoding="utf-8",errors="replace").read()',
 "    except Exception: continue",
 '    for line in data.split("\\n"):',
 "        if not line.strip(): continue",
 '        try: rec=json.loads(line)',
 "        except Exception: continue",
 '        m=rec.get("message") if isinstance(rec.get("message"),dict) else rec',
 "        if not isinstance(m,dict): continue",
 '        try: ts=int(m.get("timestamp") or rec.get("timestamp") or 0)',
 "        except Exception: continue",
 "        if ts<lo or ts>hi: continue",
 '        role=m.get("role")',
 '        u=m.get("usage") if isinstance(m.get("usage"),dict) else None',
 '        out.append({"t":ts,"role":role,"in":int((u or {}).get("input") or 0),"cr":int((u or {}).get("cacheRead") or 0),"cw":int((u or {}).get("cacheWrite") or 0),"out":int((u or {}).get("output") or 0)})',
 "print(json.dumps(sorted(out,key=lambda x:x['t'])))",
].join("\n");

function read(pod, lo, hi) {
  const b64 = Buffer.from(PY, "utf8").toString("base64");
  const cmd = `echo ${b64} | base64 -d > /tmp/ab.py && python3 /tmp/ab.py ${lo} ${hi}`;
  const out = execFileSync("kubectl", ["exec", pod, "--", "sh", "-lc", cmd], { encoding: "utf8", timeout: 150000, maxBuffer: 64*1024*1024 });
  return JSON.parse(out);
}

const attempts = [];
const aborts = [];
const completions = [];
for (const name of fs.readdirSync(root, { withFileTypes: true }).filter(d=>d.isDirectory()).map(d=>d.name)) {
  const log = path.join(root, name, ".pi/idle-compaction/log.jsonl");
  if (!fs.existsSync(log)) continue;
  for (const line of fs.readFileSync(log,"utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.at || r.at < since) continue;
    if (r.kind === "compact") attempts.push({ name, ...r });
    if (r.kind === "deadline") aborts.push({ name, ...r });
    if (r.kind === "compacted") completions.push({ name, ...r });
  }
}

console.log(`attempts ${attempts.length}  deadline aborts ${aborts.length}  completions ${completions.length}  (since ${since})`);

// 1. Do aborts cluster in wall-clock time, and does the same window carry completions?
const bucket = new Map();
for (const a of attempts) bucket.set(a.at.slice(0,16), (bucket.get(a.at.slice(0,16)) ?? {att:0,ab:0,done:0}), (bucket.get(a.at.slice(0,16)) ?? {att:0,ab:0,done:0}));
const bump = (iso, key) => { const k = iso.slice(0,16); const cur = bucket.get(k) ?? { att:0, ab:0, done:0 }; cur[key]+=1; bucket.set(k, cur); };
for (const a of attempts) bump(a.at,"att");
for (const a of aborts) bump(a.at,"ab");
for (const c of completions) bump(c.at,"done");
console.log("\n== 10-minute buckets (16-char key = 10 min) with more than one attempt ==");
for (const [k,v] of [...bucket.entries()].sort()) if (v.att>1) console.log(`  ${k}Z  attempts ${v.att}  aborted ${v.ab}  completed ${v.done}`);

// 2. Size vs abort, using each abort's own attempt record (matched by pod + nearest attempt at or before it)
const sized = aborts.map((a) => {
  const cand = attempts.filter((x) => x.name===a.name && x.at<=a.at && x.trigger===a.trigger).pop();
  return { ...a, tokens: cand?.tokens ?? null, deadlineMs: a.deadlineMs ?? cand?.deadlineMs ?? null };
});
const withT = sized.filter((a)=>a.tokens);
withT.sort((x,y)=>x.tokens-y.tokens);
console.log(`\n== aborted attempts, by size (${withT.length} of ${aborts.length} matched to an attempt with a token count) ==`);
for (const a of withT) console.log(`  ${a.at} ${a.name.padEnd(24)} ${String(a.tokens).padStart(6)} tok  deadline ${String(a.deadlineMs).padStart(6)}ms  ${a.trigger}`);
const doneT = completions.map(c=>c.tokensBefore).filter(Boolean).sort((a,b)=>a-b);
if (doneT.length) console.log(`  completions' tokensBefore band: ${doneT[0]}-${doneT[doneT.length-1]} median ${doneT[Math.floor(doneT.length/2)]}`);
const abT = withT.map(a=>a.tokens).sort((a,b)=>a-b);
if (abT.length) console.log(`  aborted attempts' size band: ${abT[0]}-${abT[abT.length-1]} median ${abT[Math.floor(abT.length/2)]}`);

// 3. Was the pod's own session active during the attempt?
console.log(`\n== was the session's own turn in flight while the summarisation ran? ==`);
for (const a of aborts) {
  const pod = podNames.find((p)=>p.startsWith(a.name+"-"));
  if (!pod) { console.log(`  ${a.at} ${a.name} no pod match`); continue; }
  // A `deadline` record is written when the ceiling FIRES, so the summarisation ran BEFORE its `at`:
  // attempt window = [at - elapsedMs, at]. Measuring forward from `at` measures the resumed turn, not the attempt.
  const t1 = Date.parse(a.at), t0 = t1 - Number(a.elapsedMs ?? a.deadlineMs ?? 240000);
  let recs;
  try { recs = read(pod, t0-180000, t1+180000); } catch (e) { console.log(`  ${a.at} ${a.name} timeline read failed: ${String(e.stderr||e.message).split("\n").pop()}`); continue; }
  const users = recs.filter(r=>r.role==="user");
  const calls = recs.filter(r=>r.role==="assistant" && (r.in+r.cr+r.cw+r.out)>0);
  const duringU = users.filter(r=>r.t>=t0 && r.t<=t1);
  const duringC = calls.filter(r=>r.t>=t0 && r.t<=t1);
  const before = recs.filter(r=>r.role==="assistant" && r.t<t0).pop();
  const after = calls.filter(r=>r.t>t1)[0];
  console.log(`  attempt ${new Date(t0).toISOString().slice(11,19)}-${a.at.slice(11,19)} ${a.name.padEnd(24)} ${String(a.trigger).padEnd(21)} tok ${String(a.tokens??"?").padStart(6)}  user turns IN window ${String(duringU.length).padStart(2)}  own calls IN window ${String(duringC.length).padStart(2)}  last own call before attempt ${before?`-${((t0-before.t)/1000).toFixed(0)}s`:"none"}  first own call after abort +${after?((after.t-t1)/1000).toFixed(0):"?"}s`);
}
