#!/usr/bin/env node
// Measure what the prompt cache actually served, and what rewrote the prefix when it did not.
//
// Why this exists as a script rather than a code reading: whether a prompt block is expensive is not a property of
// the block, it is a property of the provider's cache. The code can say what gets injected and how often; only the
// usage line on each assistant message says what it cost. Pi records both, so the audit needs no provider access.
//
// Two things are measured, because they answer different questions:
//
//   cached_share  = cacheRead / (cacheRead + cacheWrite + input)  per assistant call
//   a system-role record with `sections`                          = a rewrite of the system prompt, with its text
//
// A dynamic prompt block is only a problem if a rewrite shows up as a dropped share on the call after it. This
// prints that comparison directly, and names which section changed, so a per-turn prompt write that costs nothing
// stops being argued about and one that costs the whole prefix cannot be missed.
//
//   node hack/cache-prefix-audit.mjs                    # newest session for this workspace, last 40 calls
//   node hack/cache-prefix-audit.mjs --n 200            # wider usage window
//   node hack/cache-prefix-audit.mjs --all              # newest session in every workspace on this pod
//   node hack/cache-prefix-audit.mjs --session <jsonl>  # one named file
//
// Read the regime, not just the mean: a share that is high while turns are back to back and collapses only after a
// long idle gap is an expired cache TTL. A share that collapses while turns are back to back is a prefix rewrite.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const root = typeof arg("root") === "string" ? String(arg("root")) : path.join(process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`, "sessions");
const n = Number(arg("n", "40"));
const missFloor = Number(arg("miss", "2000")); // an input below this is new content, not a prefix re-send
const backToBackSec = Number(arg("back-to-back", "300"));

function sessions() {
  if (typeof arg("session") === "string") return [String(arg("session"))];
  if (!fs.existsSync(root)) return [];
  const want = `--${process.cwd().replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "")}--`;
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (!arg("all") && d.name !== want) continue;
    if (arg("all") && d.name.startsWith("--tmp-")) continue; // scratch harness sessions are not live sessions
    const newest = fs
      .readdirSync(path.join(root, d.name))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(root, d.name, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (newest) out.push(newest);
  }
  return out.sort();
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

function audit(file) {
  const entries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // A flat event sequence, so "what sits immediately in front of this call" is answerable per call.
  const seq = [];
  for (const r of entries) {
    const at = Date.parse(r.timestamp ?? "");
    if (Number.isNaN(at)) continue;
    const m = r.message;
    if (r.type === "message" && m?.role === "assistant" && m.usage) {
      const u = m.usage;
      const gross = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.input ?? 0);
      const calls = (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => (c.name === "todos" ? `todos:${c.arguments?.action ?? "?"}` : c.name));
      seq.push({ kind: "call", at, input: u.input ?? 0, read: u.cacheRead ?? 0, write: u.cacheWrite ?? 0, out: u.output ?? 0, share: gross > 0 ? (u.cacheRead ?? 0) / gross : 0, model: `${m.provider}/${m.model}`, calls });
    } else if (r.type === "message" && m?.role === "system") {
      // Pi writes this record when the system prompt changes, and it carries the sections, so the rewrite is named.
      const sections = Object.entries(m.sections ?? {}).map(([k, v]) => `${k}:${hash(String(v ?? ""))}`);
      seq.push({ kind: "prompt", at, sections });
    } else if (r.type === "compaction" || r.type === "context_edit" || r.type === "model_change" || r.type === "custom_message") {
      seq.push({ kind: r.type === "custom_message" ? `inject:${r.customType ?? r.message?.customType ?? "?"}` : r.type, at });
    }
  }

  const calls = seq.filter((s) => s.kind === "call");
  const prompts = seq.filter((s) => s.kind === "prompt");
  const win = calls.slice(-n);
  const shares = win.map((c) => c.share);
  const misses = [];
  let priorAt = null;
  for (const c of win) {
    const gap = priorAt === null ? null : (c.at - priorAt) / 1000;
    if (c.read === 0 && c.input >= missFloor) misses.push({ ...c, gap });
    priorAt = c.at;
  }
  const quiet = misses.filter((m) => m.gap !== null && m.gap <= backToBackSec);

  console.log(`\n${file.replace(`${root}/`, "")}`);
  console.log(`  providers ${[...new Set(calls.map((c) => c.model))].join(" · ")}`);
  console.log(`  assistant calls ${calls.length} (window ${win.length}) · cached share min ${pct(Math.min(...shares))} median ${pct(med(shares))} max ${pct(Math.max(...shares))}`);
  console.log(`  full misses in window ${misses.length} (${quiet.length} while back to back, ${misses.length - quiet.length} after an idle gap over ${backToBackSec}s)`);
  console.log(`  calls that wrote new cache content ${calls.filter((c) => c.write > 0).length} (${calls.reduce((s, c) => s + c.write, 0)} tokens written) · compactions in file ${seq.filter((s) => s.kind === "compaction").length}`);
  for (const m of misses) {
    console.log(`    miss ${new Date(m.at).toISOString().slice(5, 19)} re-sent ${m.input} uncached · gap ${m.gap === null ? "?" : `${m.gap.toFixed(0)}s`}${m.gap !== null && m.gap <= backToBackSec ? "  ← while back to back: a rewrite, not a TTL expiry" : "  ← after an idle gap"}`);
  }

  // What a compaction costs in cache terms: it rewrites the prefix by design, so the first call after one re-sends
  // whatever the summarisation kept. That is the price side of a completion, and it belongs beside the tokens freed
  // rather than being assumed free.
  const afterCompaction = [];
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].kind !== "compaction") continue;
    const next = seq.slice(i + 1).find((x) => x.kind === "call");
    if (next) afterCompaction.push(next);
  }
  if (afterCompaction.length > 0) {
    console.log(
      `  first call after each of ${afterCompaction.length} compactions: median ${med(afterCompaction.map((c) => c.input))} uncached tokens, max ${Math.max(...afterCompaction.map((c) => c.input))}, ${afterCompaction.reduce((s, c) => s + c.input, 0)} in total · median share ${pct(med(afterCompaction.map((c) => c.share)))}`,
    );
  }

  // Which sections actually change, and how often the prompt is rewritten at all.
  const sectionChange = new Map();
  let prev = null;
  for (const p of prompts) {
    const cur = new Map(p.sections.map((s) => [s.split(":")[0], s]));
    if (prev) for (const [k, v] of cur) if (prev.get(k) !== v) sectionChange.set(k, (sectionChange.get(k) ?? 0) + 1);
    prev = cur;
  }
  console.log(`  system-prompt rewrite records ${prompts.length} for ${calls.length} calls (${((prompts.length / Math.max(1, calls.length)) * 100).toFixed(2)}% of calls)`);
  if (sectionChange.size > 0) {
    console.log(`  sections that changed between rewrites: ${[...sectionChange].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(", ")}`);
  }

  // Does a rewrite cost the next call its cache? Compare both populations.
  const afterPrompt = [];
  const plain = [];
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    if (s.kind !== "call") continue;
    const prevEvent = seq[i - 1];
    if (!prevEvent) continue;
    if ((s.at - prevEvent.at) / 1000 > backToBackSec) continue; // not back to back: TTL noise
    (seq.slice(Math.max(0, i - 3), i).some((x) => x.kind === "prompt") ? afterPrompt : plain).push(s);
  }
  const stat = (xs) => `n ${String(xs.length).padStart(5)} median share ${xs.length ? pct(med(xs.map((c) => c.share))) : "-"} median uncached ${xs.length ? med(xs.map((c) => c.input)) : "-"} calls below 90% ${xs.filter((c) => c.share < 0.9).length}`;
  console.log(`  back-to-back calls preceded by a prompt rewrite: ${stat(afterPrompt)}`);
  console.log(`  back-to-back calls not preceded by one:          ${stat(plain)}`);
  if (afterPrompt.length >= 5 && plain.length >= 5) {
    const d = med(plain.map((c) => c.input)) - med(afterPrompt.map((c) => c.input));
    console.log(`  → a rewrite re-sent ${Math.abs(d).toFixed(0)} tokens more than a plain call ${d > 0 ? "(the rewrite is cheaper than a plain call here, so it is not costing the prefix)" : "(the rewrite costs the prefix beyond the new content itself)"}, against a median prefix of ${pct(med(plain.map((c) => c.share)))} cached`);
  }
  return { file, misses, quiet };
}

const files = sessions();
if (files.length === 0) {
  console.error(`no session file under ${root} for ${process.cwd()} (try --all, or --session <path>)`);
  process.exit(1);
}
for (const f of files) audit(f);
if (files.length > 1) console.log(`\n${files.length} sessions read on this pod.`);
