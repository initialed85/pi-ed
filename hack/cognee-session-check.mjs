/**
 * A real Pi session, a real cognee, and one round trip between them.
 *
 * `hack/cognee-live-check.mjs` proves the API contract from a script. It cannot prove the thing that actually matters
 * to an agent: that a session offers `memory_remember` and `memory_recall`, that the model calls them, and that what
 * came back is what was written. That needs a session, so this script drives one over Pi's RPC mode with stdin held
 * open (closing it early ends the process mid-turn and looks exactly like a failure with exit 0 — measured).
 *
 *   node hack/cognee-session-check.mjs            # scratch HOME, this checkout as the package
 *   node hack/cognee-session-check.mjs --keep     # leave the probe note in the dataset
 *
 * It writes to `pi-ed-session-probe`, never to the fleet's dataset, and deletes the probe row afterwards. It needs a
 * model, so it copies the host's auth and model configuration into the scratch HOME; nothing is printed from those
 * files, and the cognee key never appears in the script's own output.
 *
 * Exit 0 means: the session registered both tools, the model called both, the write reported `status completed`, and
 * the read returned the marker string that was written. Anything less is exit 1 with the events it saw.
 */

import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const argv = process.argv.slice(2);
const agentName = "pi-ed-session-probe";
const DATASET = process.env.PI_ED_SESSION_PROBE_DATASET ?? "pi-ed-session-probe";
const MARK = `zorbax-${Date.now()}`;
// Inherited from the pod where available (home-ops sets COGNEE_BASE_URL and mounts /run/secrets/cognee); the
// fallbacks are only for running this by hand on a laptop. Overriding them unconditionally would test the script
// rather than the pod.
const BASE = (process.env.COGNEE_URL ?? process.env.COGNEE_BASE_URL ?? "http://cognee.cognee.svc.cluster.local:8000").replace(/\/+$/, "");
const KEY_FILE = process.env.COGNEE_API_KEY_FILE ?? "/run/secrets/cognee/api-key";
const key = (process.env.COGNEE_API_KEY ?? readFileSync(KEY_FILE, "utf8")).trim();
if (!key) {
  console.error(`no cognee key: expected ${KEY_FILE} or COGNEE_API_KEY`);
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "pi-ed-session-home-"));
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
// The scratch HOME installs *this checkout* as the package, so the extension being tested is the one in the working
// tree rather than whatever was last installed into the real ~/.pi.
writeFileSync(join(home, ".pi", "agent", "settings.json"), `${JSON.stringify({ packages: [ROOT] }, null, 2)}\n`);
for (const file of ["auth.json", "models.json", "models-store.json"]) {
  try {
    copyFileSync(join(homedir(), ".pi", "agent", file), join(home, ".pi", "agent", file));
  } catch {
    // A machine with no saved auth simply cannot run a model-backed check, and says so below rather than pretending.
  }
}
writeFileSync(join(home, "dataset"), `${DATASET}\n`);

const child = spawn("pi", ["--mode", "rpc"], {
  cwd: ROOT,
  env: { ...process.env, HOME: home, COGNEE_API_KEY_FILE: KEY_FILE, COGNEE_DATASET_FILE: join(home, "dataset"), COGNEE_URL: BASE, NAME: agentName },
});

const wrote = [];
const reads = [];
let sawRememberToolCall = false;
let sawRecallToolCall = false;
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
    if (event.type === "message_end" && event.message?.role === "assistant") {
      for (const part of event.message.content ?? []) {
        if (part.type === "toolCall") {
          if (part.name === "memory_remember") sawRememberToolCall = true;
          if (part.name === "memory_recall") sawRecallToolCall = true;
          console.log(`tool call ${part.name} ${JSON.stringify(part.arguments).slice(0, 160)}`);
        }
        if (part.type === "text" && (part.text.includes(MARK) || part.text.includes("remembered"))) console.log(`assistant: ${part.text.slice(0, 400)}`);
      }
    }
    if (event.type === "tool_execution_end") {
      const text = JSON.stringify(event.result ?? event.content ?? "");
      if (text.includes("remembered")) wrote.push(text);
      if (text.includes(MARK)) reads.push(text);
      console.log(`tool result: ${text.slice(0, 400)}`);
    }
    if (event.type === "agent_end") finish();
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

function verdict() {
  const wroteIt = wrote.some((text) => text.includes("status completed"));
  const readIt = reads.some((text) => text.includes(MARK));
  const ok = sawRememberToolCall && sawRecallToolCall && wroteIt && readIt;
  console.log(`\n${ok ? "PASS" : "FAIL"} session round trip: tool calls remember=${sawRememberToolCall} recall=${sawRecallToolCall}; write completed=${wroteIt}; marker read back=${readIt}`);
  return ok;
}

async function cleanup() {
  if (argv.includes("--keep")) return;
  const headers = { "X-Api-Key": key };
  const withTimeout = (url, init = {}) => fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) }).catch(() => ({ json: async () => ({}), text: async () => "", ok: false }));
  const datasets = await (await withTimeout(`${BASE}/api/v1/datasets`)).json();
  const list = Array.isArray(datasets) ? datasets : datasets?.datasets ?? [];
  const target = list.find((dataset) => dataset.name === DATASET);
  if (!target) return;
  const rows = await (await withTimeout(`${BASE}/api/v1/datasets/${target.id}/data`)).json();
  const items = Array.isArray(rows) ? rows : rows?.data ?? rows?.items ?? [];
  let removed = 0;
  for (const row of items) {
    const raw = await (await withTimeout(`${BASE}/api/v1/datasets/${target.id}/data/${row.id}/raw`)).text();
    // Sweep any probe row, not only this run's: a run that timed out mid-write still lands
      // server-side, and its marker is a different zorbax-<timestamp> than the one being asserted now.
      if (!raw.includes("zorbax-")) continue;
    const res = await withTimeout(`${BASE}/api/v1/datasets/${target.id}/data/${row.id}`, { method: "DELETE" });
    if (res.ok) removed += 1;
  }
  console.log(`cleanup: removed ${removed} probe row(s) from ${DATASET}`);
}

async function finish() {
  const ok = verdict();
  child.kill();
  await cleanup();
  console.log(`checked against ${BASE} (dataset ${DATASET}, agent label ${agentName}, key from ${KEY_FILE} — value not shown, host ${hostname()})`);
  process.exit(ok ? 0 : 1);
}

child.stdin.write(`${JSON.stringify({ id: "probe", type: "prompt", message: `Call memory_remember with text "${MARK} is the session probe marker written by the pi-ed cognee extension on ${hostname()}". Then call memory_recall with query "what is ${MARK}" and mode chunks. Then reply with both tool outputs verbatim.` })}\n`);

setTimeout(() => {
  console.log("timed out waiting for the session to settle");
  child.kill();
  process.exit(1);
}, 300_000);
