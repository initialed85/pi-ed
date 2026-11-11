/**
 * A real Pi session, a real Graphiti door, and one round trip between them.
 *
 * `hack/graphiti-live-check.mjs` proves the API contract from a script. It cannot prove the thing that matters to an
 * agent: that a session offers `memory_remember` and `memory_recall`, that the model actually calls them, and that a
 * write made by a session reaches the graph. That needs a session, so this script drives one over Pi's RPC mode with
 * stdin held open — closing it early ends the process mid-turn and looks exactly like a failure with exit 0, measured.
 *
 *   node hack/graphiti-session-check.mjs          # scratch HOME, this checkout as the package
 *   node hack/graphiti-session-check.mjs --keep   # leave the probe group in place for inspection
 *
 * What it asserts, and what it deliberately does not. Hard assertions: the session registered and called both tools,
 * the write was accepted, and the episode the service stored carries the marker verbatim (that is `/episodes`, which
 * is the text as handed). Soft reporting: what `memory_recall` brought back. This door returns extracted facts
 * reworded by an LLM, so a correct fact can paraphrase the marker away — asserting the marker inside a composed fact
 * would fail a healthy door, and a check that fails a healthy door gets ignored, which is worse than no check. Read
 * correctness is asserted hard in the live check, where the query is issued by the script rather than by a model.
 *
 * It needs a model, so it copies the host's auth and model configuration into the scratch HOME. Nothing from those
 * files is printed. The door itself has no credential: it is cluster-internal and unauthenticated, which is why the
 * redaction guarantee is asserted in `test/graphiti.test.ts` rather than here.
 *
 * Exit 0 means the hard assertions held. Anything less exits 1 and prints the events it saw, leaving the probe group
 * in place rather than deleting the evidence.
 */

import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const argv = process.argv.slice(2);
const GROUP = process.env.PI_ED_SESSION_PROBE_GROUP ?? "pi-ed-session-probe";
const MARK = `zorbax-${Date.now()}`;
const URL = (process.env.MEMORY_GRAPH_URL ?? "http://memory-graph.memory.svc.cluster.local:9999").replace(/\/+$/, "");

const call = async (path, init = {}, timeout = 20_000) => {
  try {
    const r = await fetch(`${URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
    const raw = await r.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    return { ok: r.ok, status: r.status, body, raw };
  } catch (error) {
    return { ok: false, status: "transport", body: null, raw: `${error.name}: ${String(error.cause?.code ?? error.message)}` };
  }
};

const home = mkdtempSync(join(tmpdir(), "pi-ed-session-home-"));
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
// The scratch HOME installs *this checkout* as the package, so what is being tested is the extension in the working
// tree, not whatever was last installed into the real ~/.pi.
writeFileSync(join(home, ".pi", "agent", "settings.json"), `${JSON.stringify({ packages: [ROOT] }, null, 2)}\n`);
for (const file of ["auth.json", "models.json", "models-store.json"]) {
  try {
    copyFileSync(join(homedir(), ".pi", "agent", file), join(home, ".pi", "agent", file));
  } catch {
    // A machine with no saved auth cannot run a model-backed check, and says so below rather than pretending.
  }
}

const child = spawn("pi", ["--mode", "rpc"], {
  cwd: ROOT,
  // NAME becomes MEMORY_AGENT, which is the group a session writes to by default. Naming it the probe group is what
  // keeps a session probe out of the corpus a real agent reads from.
  env: { ...process.env, HOME: home, MEMORY_GRAPH_URL: URL, MEMORY_AGENT: GROUP, NAME: GROUP },
});

let sawRememberToolCall = false;
let sawRecallToolCall = false;
let writeAccepted = false;
let recallReports = [];
let extensionCommands = [];
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "response" && event.command === "get_commands") {
      // `source: "extension"` is the proof this checkout's extension loaded, as opposed to a command someone
      // registered in a global ~/.pi. The absence of `cognee` is asserted for the same reason its presence would be
      // a bug: Pi loads everything in extensions/, so a leftover cognee.ts is a door a session can still call.
      extensionCommands = (event.data?.commands ?? []).filter((c) => c.source === "extension").map((c) => c.name);
      console.log(`extension commands offered: ${extensionCommands.join(", ") || "none"}`);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      for (const part of event.message.content ?? []) {
        if (part.type === "toolCall") {
          if (part.name === "memory_remember") sawRememberToolCall = true;
          if (part.name === "memory_recall") sawRecallToolCall = true;
          console.log(`tool call      ${part.name} ${JSON.stringify(part.arguments).slice(0, 180)}`);
        }
      }
    }
    if (event.type === "tool_execution_end") {
      const text = JSON.stringify(event.result ?? event.content ?? "");
      if (text.includes("Accepted into group")) writeAccepted = true;
      const hits = /(\d+) fact\(s\)/.exec(text);
      if (hits) recallReports.push(Number(hits[1]));
      console.log(`tool result    ${text.slice(0, 400)}`);
    }
    if (event.type === "agent_end") void finish();
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

async function verifyStored() {
  // `/episodes/{group}` is the text the service was handed, so the marker has to be in it. This is the assertion
  // that survives extraction rewording, and it is polled because extraction is asynchronous by design.
  for (const wait of [5, 10, 15, 25, 40]) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    const e = await call(`/episodes/${encodeURIComponent(GROUP)}?last_n=10`);
    const items = Array.isArray(e.body) ? e.body : (e.body?.items ?? e.body?.episodes ?? []);
    const texts = items.map((i) => String(i?.content ?? i?.text ?? JSON.stringify(i)));
    console.log(`episodes +${wait}s: HTTP ${e.status}, ${items.length} item(s)`);
    if (texts.some((t) => t.includes(MARK))) return { ok: true, items: items.length };
  }
  return { ok: false, items: 0 };
}

async function cleanup() {
  if (argv.includes("--keep")) return;
  const del = await call(`/group/${encodeURIComponent(GROUP)}`, { method: "DELETE" });
  console.log(`cleanup: DELETE /group/${GROUP} → ${del.status}`);
}

async function finish() {
  const stored = await verifyStored();
  const doorLoaded = extensionCommands.includes("graphiti");
  const doorGone = !extensionCommands.includes("cognee");
  const recalls = recallReports.length ? recallReports.join(", ") : "none";
  // A tool cannot be called unless it was registered, so the calls above are the registration proof for the tools.
  // The command has to be read from get_commands because nothing else calls it in this run.
  const ok = doorLoaded && doorGone && sawRememberToolCall && sawRecallToolCall && writeAccepted && stored.ok;
  console.log(`\nextension door loaded from this checkout: /graphiti=${doorLoaded} · /cognee absent=${doorGone}`);
  console.log(`model called them: remember=${sawRememberToolCall} recall=${sawRecallToolCall} (recall returned ${recalls} fact(s) — reported, not asserted; extraction reworded)`);
  console.log(`write accepted by the door: ${writeAccepted} · episode stored with the marker verbatim: ${stored.ok} (${stored.items} episode(s))`);
  console.log(`\n${ok ? "PASS" : "FAIL"} session round trip against ${URL} (group ${GROUP}, host ${hostname()})`);
  if (!ok) console.log(`the probe group was left in place. Clear it with: curl -sX DELETE ${URL}/group/${GROUP}`);
  child.kill();
  if (ok) await cleanup();
  process.exit(ok ? 0 : 1);
}

child.stdin.write(`${JSON.stringify({ id: "cmds-1", type: "get_commands" })}\n`);
child.stdin.write(`${JSON.stringify({
  id: "probe",
  type: "prompt",
  message: `Call memory_remember with text "${MARK} is the session probe marker written by the pi-ed graphiti extension on ${hostname()}". Then call memory_recall with query "what is ${MARK}". Then reply with both tool outputs verbatim.`,
})}\n`);

setTimeout(() => {
  console.log("timed out waiting for the session to settle");
  child.kill();
  process.exit(1);
}, 300_000);
