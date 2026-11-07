#!/usr/bin/env node
// Live check for extensions/memory.ts: drives a real Pi session against a real store and reports what landed.
//
// This is not CI. It needs a reachable Postgres with the schema applied, and it spends model tokens. Run it by hand
// after changing the write path, the dream instruction, or the schema:
//
//   kubectl port-forward -n pi-ed svc/memory 15432:5432 &
//   PI_MEMORY_DSN="$(kubectl get secret -n pi-ed pi-ed-postgres -o jsonpath='{.data.DATABASE_URL}' \
//     | base64 -d | sed 's#//pi_ed:[^@]*@#//pi_ed:REDACTED@#' | sed 's#memory:5432#127.0.0.1:15432#')" \
//     node ./hack/memory-live-check.mjs
//
// The DSN is read from the environment and never printed. The check writes under a throwaway agent key
// (--agent, default "memory-live-check") and deletes what it wrote, so a run does not leave a fake memory that a
// real agent later retrieves.
//
// Exit code 0 means: turns recorded, read path returned, dream ran and wrote a memory. Non-zero says which one did
// not, and leaves the rows in place so the run can be inspected.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(HERE, "../extensions/memory.ts");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const DSN = process.env.PI_MEMORY_DSN;
if (!DSN) {
  console.error("PI_MEMORY_DSN is required. See the header of this file for how to build one without printing it.");
  process.exit(2);
}
const agent = arg("agent", "memory-live-check");
const idleMs = Number(arg("idle-seconds", "20")) * 1000;
const keep = argv.includes("--keep-rows");

const scratch = mkdtempSync(path.join(tmpdir(), "pi-ed-memory-live-"));
const configPath = path.join(scratch, "memory.json");
writeFileSync(
  configPath,
  JSON.stringify({
    // The production clocks are ten minutes; a live check that waits twenty minutes for each trigger is a live check
    // nobody runs. The triggers themselves are the thing being tested, not the length of the wait.
    idleDreamMinutes: idleMs / 60000,
    resumeDreamMinutes: 0.25,
    flushMs: 250,
    maxTextChars: 600,
    neverStore: ["hunter2livetest"],
  }),
  "utf8",
);

const audit = [];
const db = new pg.Client({ connectionString: DSN, connectTimeoutMs: 5000 });

let pi;
try {
  await db.connect();
  const before = await counts(agent);
  console.log(`store reachable, rows for "${agent}" before this run: ${JSON.stringify(before)}`);

  pi = spawn("pi", ["--mode", "rpc", "-e", EXTENSION, "--name", agent], {
    cwd: scratch,
    env: { ...process.env, PI_MEMORY_DSN: DSN, PI_MEMORY_CONFIG: configPath, PI_MEMORY_SPOOL: path.join(scratch, "spool.jsonl") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  pi.stderr.on("data", (chunk) => process.stderr.write(`[pi] ${chunk}`));

  // Extension notifications travel as RPC ui records. Without printing them, a failed write is invisible until a
  // later statement trips a foreign key - which is exactly how the first run of this check misled me.
  const note = (event) => {
    if (event.type !== "extension_ui_request") return;
    // Only notifications: a status or a widget is the TUI's rendering request, and printing every one of them buries
    // the messages that actually report what the extension did.
    if (event.method === "notify") console.log(`[notify:${event.notifyType ?? event.level ?? "info"}] ${event.message ?? JSON.stringify(event)}`);
  };

  // Strict JSONL framing: readline would also split on U+2028/U+2029, which are legal inside JSON strings.
  let buffer = "";
  const waiters = [];
  pi.stdout.on("data", (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut).replace(/\r$/, "");
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      audit.push(event);
      note(event);
      for (const waiter of [...waiters]) if (waiter.matches(event)) waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event);
    }
  });

  const waitFor = (matches, timeoutMs, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      const waiter = {
        matches,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      };
      waiters.push(waiter);
    });

  const send = (message) => pi.stdin.write(`${JSON.stringify({ id: `req-${audit.length}`, type: "prompt", message })}\n`);

  send("Say the word bluehammer and nothing else.");
  await waitFor((e) => e.type === "agent_settled", 120_000, "the first run to settle");
  console.log("first turn settled");

  send("Use the memory_search tool with the query 'bluehammer'. Report the top hit and its weight.");
  const search = await waitFor((e) => e.type === "tool_execution_start" && e.toolName === "memory_search", 120_000, "memory_search to be called");
  const searchResult = await waitFor((e) => e.type === "tool_execution_end" && e.toolCallId === search.toolCallId, 60_000, "memory_search to finish");
  console.log(`memory_search called, isError=${searchResult.isError}, ${String(searchResult.result?.content?.[0]?.text ?? "").split("\n")[0]}`);

  // The idle clock starts when the session settles. It is short here on purpose; see the config written above.
  await waitFor((e) => e.type === "tool_execution_start" && e.toolName === "memory_dream", idleMs + 90_000, "the dream to run memory_dream");
  const dream = await waitFor((e) => e.type === "tool_execution_end" && e.toolName === "memory_dream", 60_000, "memory_dream to finish");
  console.log(`memory_dream isError=${dream.isError}, ${String(dream.result?.content?.[0]?.text ?? "").split("\n")[0]}`);

  // The extension flushes on a debounce and writes asynchronously, so give it a beat before reading back.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const after = await counts(agent);
  const memory = await db.query(
    `select summary, feel, subjects, span_first_event, span_last_event, embedding_model, (embedding is not null) as has_vector, left(detail::text, 60) as detail from memory where agent_id = $1 order by created_at desc limit 1`,
    [agent],
  );
  const spoolRemain = await readFile(path.join(scratch, "spool.jsonl"), "utf8").then((text) => text.split("\n").filter((line) => line.trim()).length).catch(() => 0);
  console.log(`rows after: ${JSON.stringify(after)}`);
  console.log(`newest memory: ${JSON.stringify(memory.rows[0] ?? null)}`);
  console.log(`spool remaining: ${spoolRemain}`);

  const kinds = await db.query(`select kind, count(*)::int as n from event where agent_id = $1 group by kind order by kind`, [agent]);
  console.log(`recorded kinds: ${kinds.rows.map((row) => `${row.kind}=${row.n}`).join(" ")}`);

  const problems = [];
  if (after.events < 2) problems.push(`expected recorded events, got ${after.events}`);
  if (after.memories < 1) problems.push(`expected a dreamed memory, got ${after.memories}`);
  if (spoolRemain > 0) problems.push(`${spoolRemain} row(s) left in the spool, which means a write failed and was buffered rather than written`);
  if (!memory.rows[0]) problems.push("no memory row to inspect");
  else if (!memory.rows[0].span_last_event) problems.push("the memory is not anchored to the events it summarised (span_last_event is null)");
  // Not a failure, a fact worth printing while the decision is live: the vector column is still empty until the
  // embedder is wired, and a memory without a vector is only reachable through the keyword path.
  console.log(`vector written: ${memory.rows[0]?.has_vector ?? false} (empty until the embedder is wired; keyword recall still finds the row)`);
  if (searchResult.isError) problems.push("memory_search reported an error");

  if (!keep) {
    // One statement with several DELETE CTEs would let Postgres check the foreign keys in an order this script does
    // not control; deleting in dependency order one statement at a time does.
    const deleted = {};
    for (const table of ["memory", "event", "session", "agent"]) {
      const where = table === "agent" ? "id" : "agent_id";
      const result = await db.query(`delete from ${table} where ${where} = $1`, [agent]);
      deleted[table] = result.rowCount;
    }
    console.log(`cleaned up: ${JSON.stringify(deleted)}`);
    await db.query("refresh materialized view subject_index");
  } else {
    console.log(`--keep-rows: left the "${agent}" rows in the store`);
  }

  if (problems.length) {
    console.error(`FAILED:\n- ${problems.join("\n- ")}`);
    console.error(`audit written to ${path.join(scratch, "audit.jsonl")}`);
    writeFileSync(path.join(scratch, "audit.jsonl"), audit.map((e) => JSON.stringify(e)).join("\n"), "utf8");
    process.exit(1);
  }
  console.log("PASS: turns recorded, read path answered, dream wrote a memory with a subject line and a feel.");
} catch (error) {
  console.error(`FAILED: ${error?.message ?? error}`);
  process.exit(1);
} finally {
  if (pi && !pi.killed) pi.kill("SIGTERM");
  try {
    await db.end();
  } catch {
    /* the connection may already be gone */
  }
}

async function counts(agentId) {
  const events = await db.query(`select count(*)::int as n from event where agent_id = $1`, [agentId]);
  const memories = await db.query(`select count(*)::int as n from memory where agent_id = $1`, [agentId]);
  return { events: events.rows[0].n, memories: memories.rows[0].n };
}
