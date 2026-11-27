#!/usr/bin/env node
// Measure how much of each model call was served from the prompt cache, and what broke the prefix when it was not.
//
// A provider bill splits into cacheRead / cacheWrite / input. cached_share is what the cache served, so a session
// that drops it is re-sending its prefix: an expired cache TTL, a compaction (which rewrites the prefix by design),
// or something the harness writing a new value into the early context every turn. The last one is the expensive and
// invisible kind, because the cost lands on every pod that loads the extension doing it, not just the one asking.
//
// Pi records one line per event in a session file, so the audit needs no provider access: the usage line per
// assistant message is the measurement, and the compaction / context-edit lines beside it are the attribution.
//
//   node hack/cache-prefix-audit.mjs                       # this session, last 40 calls
//   node hack/cache-prefix-audit.mjs --n 200 --miss 2000   # wider window, cheaper calls counted as hits
//   node hack/cache-prefix-audit.mjs --all                 # newest session in every workspace on this pod
//   node hack/cache-prefix-audit.mjs --session <jsonl>     # one file, named
//
// What it will not do: tell you WHICH string entered the prefix. It proves a prefix rewrite happened and when;
// attributing it to a prompt block is a code question, and the tool prints the events that sit next to the miss.

import fs from "node:fs";
import path from "node:path";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const sessionsRoot =
  typeof arg("root") === "string" ? String(arg("root")) : path.join(process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`, "sessions");
const n = Number(arg("n", "40"));
const missInputFloor = Number(arg("miss", "2000"));
const backToBackSec = Number(arg("back-to-back", "300"));

function sessionFiles() {
  if (typeof arg("session") === "string") return [String(arg("session"))];
  if (!fs.existsSync(sessionsRoot)) return [];
  const dirs = fs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((d) => (arg("all") ? !d.startsWith("--tmp-") : d === `--${process.cwd().replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "")}--`));
  const out = [];
  for (const dir of dirs) {
    const files = fs
      .readdirSync(path.join(sessionsRoot, dir))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(sessionsRoot, dir, f))
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files[0]) out.push(files[0].p);
  }
  return out.sort();
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const med = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

function audit(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const calls = [];
  const events = []; // compaction / context edits, for attribution next to a miss
  for (const l of lines) {
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    const t = Date.parse(r.timestamp ?? "");
    if (r.type === "message" && r.message?.role === "assistant" && r.message.usage) {
      const u = r.message.usage;
      const gross = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.input ?? 0);
      calls.push({
        at: Number.isNaN(t) ? null : t,
        input: u.input ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        out: u.output ?? 0,
        share: gross > 0 ? (u.cacheRead ?? 0) / gross : 0,
        model: r.message.model ?? "?",
      });
    } else if (r.type === "compaction" || r.type === "context_edit" || r.type === "session_info" || r.type === "model_change") {
      events.push({ kind: r.type, at: Number.isNaN(t) ? null : t });
    }
  }
  const win = calls.slice(-n);
  const shares = win.map((c) => c.share);
  const misses = [];
  let prior = null;
  for (const c of win) {
    const gap = prior === null || c.at === null || prior === null ? null : (c.at - prior) / 1000;
    if (c.cacheRead === 0 && c.input >= missInputFloor) misses.push({ ...c, gap });
    prior = c.at ?? prior;
  }
  const quietMisses = misses.filter((m) => m.gap !== null && m.gap <= backToBackSec);
  const ttlMisses = misses.filter((m) => !(m.gap !== null && m.gap <= backToBackSec));
  const nearMisses = win.filter((c) => c.cacheRead > 0 && c.share < 0.5 && c.input >= missInputFloor);
  const writes = win.filter((c) => c.cacheWrite > 0);
  const writeTotal = writes.reduce((s, c) => s + c.cacheWrite, 0);
  const near = (at) => events.filter((e) => at !== null && e.at !== null && Math.abs(e.at - at) < 120000).map((e) => e.kind);
  const compactions = events.filter((e) => e.kind === "compaction");

  console.log(`\n${file.replace(`${sessionsRoot}/`, "")}`);
  console.log(`  assistant calls ${calls.length} (window ${win.length}) · cached share min ${pct(Math.min(...shares))} median ${pct(med(shares))} max ${pct(Math.max(...shares))}`);
  console.log(
    `  calls back to back (gap <= ${backToBackSec}s): ${win.filter((c) => true).length ? "" : ""}${pct(
      med(win.filter((c) => c.share > 0).map((c) => c.share)),
    )} median share · full misses in window ${misses.length} (${quietMisses.length} while back to back, ${ttlMisses.length} after an idle gap)`,
  );
  console.log(
    `  cacheWrite > 0 on ${writes.length} calls, ${writeTotal} tokens written · partial misses (share < 50%, input >= ${missInputFloor}) ${nearMisses.length}`,
  );
  console.log(`  compactions in this session file ${compactions.length}`);
  if (misses.length > 0) {
    console.log("  full misses, oldest first (gap = seconds since the previous call):");
    for (const m of misses) {
      const when = m.at === null ? "?" : new Date(m.at).toISOString().slice(11, 19);
      console.log(
        `    ${when} input ${m.input} out ${m.out} gap ${m.gap === null ? "?" : `${m.gap.toFixed(0)}s`} ${
          m.gap !== null && m.gap <= backToBackSec ? "← while back to back, so not a TTL expiry" : "← after an idle gap"
        } ${near(m.at).length > 0 ? `events within 120s: ${near(m.at).join(", ")}` : ""}`,
      );
    }
  }
  if (quietMisses.length > 0) {
    console.log(`  !! ${quietMisses.length} call(s) in this window re-sent the prefix while turns were back to back: a prefix rewrite, not an expired cache`);
  }
  return { file, shares, misses, quietMisses, writeTotal };
}

const files = sessionFiles();
if (files.length === 0) {
  console.error(`no session file found under ${sessionsRoot} (try --all, or --session <path>, or run this from the workspace you want audited)`);
  process.exit(1);
}
const results = files.map((f) => audit(f));
if (results.length > 1) {
  const worst = [...results].sort((a, b) => a.quietMisses.length - b.quietMisses.length);
  console.log(`\n${results.length} sessions read; fewest prefix rewrites while back to back: ${worst[0].file.replace(`${sessionsRoot}/`, "")} (${worst[0].quietMisses.length})`);
}
