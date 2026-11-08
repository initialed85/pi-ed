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
// A second agent, planted with the same embedder, is what proves teammate recall is ranked lower rather than hidden.
const teammateAgent = `${agent}-teammate`;
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
let piExit = Promise.resolve();
let piStopping = false;
try {
  await db.connect();
  const before = await counts(agent);
  console.log(`store reachable, rows for "${agent}" before this run: ${JSON.stringify(before)}`);

  // `-ne` is not cosmetic. The fleet installs this very extension from git into ~/.pi/agent, so a check that only
  // says `-e <repo path>` loads two copies of memory.ts and Pi refuses the second one for registering tools that are
  // already registered - which reads like a bug in the extension and is really a bug in the harness.
  pi = spawn("pi", ["--mode", "rpc", "-ne", "-e", EXTENSION, "--name", agent], {
    cwd: scratch,
    env: { ...process.env, PI_MEMORY_DSN: DSN, PI_MEMORY_CONFIG: configPath, PI_MEMORY_SPOOL: path.join(scratch, "spool.jsonl") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  pi.stderr.on("data", (chunk) => process.stderr.write(`[pi] ${chunk}`));
  piExit = new Promise((resolve) => pi.on("exit", resolve));

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

  // The generous budgets below are deliberate, and they are model budgets rather than database budgets: most of
  // what this waits for is a real model deciding to call a tool, which on a loaded machine is the slowest part of
  // the run. An impatient budget manufactures the exact thing this check exists to detect - a run that looks broken
  // and was not - and a check that cries wolf gets ignored, which is how a real failure would be missed. Waits for a
  // tool to *start* are therefore generous; waits for a started tool to *finish* are not, because those are the
  // store and the embedder, and they have timeouts of their own.
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
  await waitFor((e) => e.type === "agent_settled", 240_000, "the first run to settle");
  console.log("first turn settled");

  send("Use the memory_search tool with the query 'bluehammer'. Report the top hit and its weight.");
  const search = await waitFor((e) => e.type === "tool_execution_start" && e.toolName === "memory_search", 240_000, "memory_search to be called");
  const searchResult = await waitFor((e) => e.type === "tool_execution_end" && e.toolCallId === search.toolCallId, 60_000, "memory_search to finish");
  console.log(`memory_search called, isError=${searchResult.isError}, ${String(searchResult.result?.content?.[0]?.text ?? "").split("\n")[0]}`);

  // The idle clock starts when the session settles. It is short here on purpose; see the config written above.
  let dreamStart;
  try {
    dreamStart = await waitFor((e) => e.type === "tool_execution_start" && e.toolName === "memory_dream", idleMs + 180_000, "the dream to run memory_dream");
  } catch (error) {
    // The clock fired and the hidden prompt was delivered; whether the model then reaches for the tool is its own
    // choice. This check exists to test the dream path - the gate, the span, the embedding, the refusal-to-dream-a-
    // dream - not the model's initiative, so it nudges once and says out loud that it did rather than failing in a
    // way that reads like the extension broke.
    console.log(`note: ${error.message}; nudging once and reporting it`);
    send("Call the memory_dream tool now: a summary of this session, some subjects, and how it felt to write.");
    dreamStart = await waitFor((e) => e.type === "tool_execution_start" && e.toolName === "memory_dream", 240_000, "memory_dream after one nudge");
  }
  void dreamStart;
  const dream = await waitFor((e) => e.type === "tool_execution_end" && e.toolName === "memory_dream", 90_000, "memory_dream to finish");
  console.log(`memory_dream isError=${dream.isError}, ${String(dream.result?.content?.[0]?.text ?? "").split("\n")[0]}`);

  // The extension flushes on a debounce and writes asynchronously, so give it a beat before reading back.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const after = await counts(agent);
  const memory = await db.query(
    `select summary, feel, subjects, span_first_event, span_last_event, embedding_model, embedding_dim, (embedding is not null) as has_vector, left(detail::text, 60) as detail from memory.memory where agent_id = $1 order by created_at desc limit 1`,
    [agent],
  );
  const spoolRemain = await readFile(path.join(scratch, "spool.jsonl"), "utf8").then((text) => text.split("\n").filter((line) => line.trim()).length).catch(() => 0);
  console.log(`rows after: ${JSON.stringify(after)}`);

  // The watermark is the part of this check that exists to outlive the rows it describes. A flush that rolls back
  // leaves the tables empty and the store looking healthy; only this row can say the writer was refused.
  const beat = await db.query(
    `select flushes, failures, spool_rows, last_error, last_activity_at, last_flush_at from memory.writer_heartbeat
     where agent_id = (select id from memory.agent where name = $1)`,
    [agent],
  );
  const h = beat.rows[0];
  if (!h) throw new Error("no heartbeat row: the writer never stamped the store");
  if (Number(h.flushes) < 1) throw new Error(`heartbeat says ${h.flushes} committed flush(es)`);
  if (Number(h.failures) !== 0) throw new Error(`heartbeat reports ${h.failures} refused batch(es): ${h.last_error}`);
  if (Number(h.spool_rows) !== 0) throw new Error(`heartbeat says ${h.spool_rows} row(s) are stranded on the spool`);
  const staleness = Date.now() - new Date(h.last_flush_at).getTime();
  if (staleness > 5 * 60_000) throw new Error(`heartbeat last flushed ${Math.round(staleness / 1000)}s ago`);
  console.log(`heartbeat: ${h.flushes} committed flush(es), ${h.failures} refused, spool_rows ${h.spool_rows}, activity ${new Date(h.last_activity_at).toISOString()}, commit ${new Date(h.last_flush_at).toISOString()}`);

  const plantedText = "The bluehammer drill was retired after the tabletop exercise proved the handover was unclear.";
  const queryText = "bluehammer drill retired after the tabletop exercise";
  const embed = await fetch(`${process.env.PI_MEMORY_EMBED_URL ?? "https://embeddings.dev.initialed85.cc"}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bge-base-en-v1.5", input: [plantedText] }),
    signal: AbortSignal.timeout(30_000),
  }).then((response) => response.json());
  const vector = embed?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 768) throw new Error("embedder did not return a 768-dimension vector for the planted memory");
  const planted = await db.query(
    `with a as (insert into memory.agent (id, name, notes) values ($1, $1, '{"probe": true}'::jsonb) on conflict (id) do update set notes = excluded.notes returning id),
          s as (insert into memory.session (id, agent_id, source, started_at, last_activity_at) select $2, a.id, 'probe', now(), now() from a
                on conflict (id) do update set last_activity_at = now() returning id)
     insert into memory.memory (agent_id, session_id, trigger, summary, subjects, feel, embedding, embedding_model, embedding_dim)
     select a.id, s.id, 'manual', $3, array['bluehammer', 'drill'], 'wry', $4::vector, 'bge-base-en-v1.5', 768
     from a, s
     returning id`,
    [teammateAgent, `${teammateAgent}-probe-session`, plantedText, `[${vector.join(",")}]`],
  );
  if (!planted.rows.length) throw new Error("could not plant the teammate memory the weighting check needs");

  await send("Search memory again for the bluehammer drill and report every hit with its score.");
  const secondStart = await waitFor((e) => e.type === "tool_execution_start" && e.toolName === "memory_search", 240_000, "a second memory_search call");
  const secondSearch = await waitFor((e) => e.type === "tool_execution_end" && e.toolCallId === secondStart.toolCallId, 90_000, "the second memory_search to finish");
  const search2 = String(secondSearch.result?.content?.[0]?.text ?? "");
  const lines = search2.split("\n").filter((line) => line.startsWith("- "));
  console.log(`recall, as the agent saw it:  ${lines.join("\n         ") || "nothing rendered"}`);
  if (!search2.includes("[vector similar")) throw new Error("recall produced no vector similarity score, so the hnsw path did not run");

  // The load-bearing proof is the store's own function, called directly with the vector that was planted. How a model
  // phrases a search varies from run to run, and a check that fails because the model chose a narrower query reports
  // the wrong thing about the store - which is the same mistake as an alert with an impatient budget.
  // Embed the *question*, not the planted row. Passing the planted vector would make that row a perfect match by
  // construction, which proves nothing about retrieval and once made this check report a ranking that was an artifact
  // of how it was called.
  const queryEmbed = await fetch(`${process.env.PI_MEMORY_EMBED_URL ?? "https://embeddings.dev.initialed85.cc"}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bge-base-en-v1.5", input: [queryText] }),
    signal: AbortSignal.timeout(30_000),
  }).then((response) => response.json());
  const queryVector = queryEmbed?.data?.[0]?.embedding;
  if (!Array.isArray(queryVector) || queryVector.length !== 768) throw new Error("embedder did not return a vector for the recall query");
  const direct = await db.query(
    `select agent_id, mine, round(similarity::numeric, 3) as similarity, round(weight::numeric, 2) as weight,
            round(score::numeric, 3) as score, round((score / nullif(similarity, 0))::numeric, 2) as applied_weight,
            left(summary, 60) as summary
     from memory_search($1, $2::vector, $3, $4, $5, now() - interval '1 day')`,
    [agent, `[${queryVector.join(",")}]`, 8, 1.0, 0.65],
  );
  const found = direct.rows;
  console.log(`recall, from memory_search():  ${found.map((row) => `${row.mine ? "own" : row.agent_id} similar ${row.similarity} weight ${row.weight} score ${row.score}`).join(", ") || "nothing"}`);
  if (!found.length) throw new Error("memory_search returned nothing for a vector that was just planted in the same store");
  const ownRow = found.find((row) => row.mine === true);
  const teammateRow = found.find((row) => String(row.agent_id) === teammateAgent);
  if (!ownRow) throw new Error(`memory_search did not return this agent's own dream row: ${JSON.stringify(found.map((row) => row.agent_id))}`);
  if (!teammateRow) throw new Error(`memory_search did not return the planted teammate memory (${teammateAgent})`);
  if (Number(ownRow.weight) !== 1.0 || Number(teammateRow.weight) !== 0.65) throw new Error(`weights are wrong: own ${ownRow.weight}, teammate ${teammateRow.weight}`);
  // The mechanism, measured on real rows rather than on a lucky ranking: what came back is similarity times the
  // weight the store applied. Asserting the multiplier is what this check can honestly hold fixed, because which of
  // the two rows ranks higher depends on how close each memory's text actually is to the question - and a teammate
  // row that is much nearer the query outranks an own row that only mentions it. Damping is not a veto.
  for (const row of [ownRow, teammateRow]) {
    if (Number(row.applied_weight) !== Number(row.weight)) throw new Error(`score is not similarity x weight for ${row.agent_id}: ${row.similarity} x ${row.weight} != ${row.score}`);
  }
  const order = found.map((row) => `${row.mine ? "own" : row.agent_id} ${row.score}`).join(" > ");
  console.log(`         weights applied as configured (own 1.0, other 0.65) on every row; order returned: ${order}`);

  // How the agent rendered what it was given is worth printing and not worth failing a run over. If it went narrower
  // than the store, that is a fact about the phrasing it chose, and a future reader should see it as a note rather
  // than as a broken retrieval path.
  if (lines.length < 2) console.log(`note: the agent rendered ${lines.length} hit(s) for the query it chose; memory_search returned ${found.length}. Reported, not asserted.`);
  else console.log(`         the agent rendered ${lines.length} hits`);
  console.log(`newest memory: ${JSON.stringify(memory.rows[0] ?? null)}`);
  console.log(`spool remaining: ${spoolRemain}`);

  const kinds = await db.query(`select kind, count(*)::int as n from memory.event where agent_id = $1 group by kind order by kind`, [agent]);
  console.log(`recorded kinds: ${kinds.rows.map((row) => `${row.kind}=${row.n}`).join(" ")}`);

  const problems = [];
  if (after.events < 2) problems.push(`expected recorded events, got ${after.events}`);
  if (after.memories < 1) problems.push(`expected a dreamed memory, got ${after.memories}`);
  if (spoolRemain > 0) problems.push(`${spoolRemain} row(s) left in the spool, which means a write failed and was buffered rather than written`);
  if (!memory.rows[0]) problems.push("no memory row to inspect");
  else if (!memory.rows[0].span_last_event) problems.push("the memory is not anchored to the events it summarised (span_last_event is null)");
  // Not a failure, a fact worth printing: a memory whose embedder call failed is still written, and from then on it
  // is reachable only through the keyword path. Which model answered, and how many tokens it cost, belongs on the row.
  console.log(`vector written: ${memory.rows[0]?.has_vector ?? false} via ${memory.rows[0]?.embedding_model ?? "no embedder"}; dim ${memory.rows[0]?.embedding_dim ?? "-"}`);
  if (searchResult.isError) problems.push("memory_search reported an error");

  // The prune has to come after the writer is dead. Every run before this ordering existed left a tail behind: the
  // last turn's rows flush on `agent_settled`, which happens after the tool result I waited for, so the delete ran
  // first and the insert landed after it - four events, a session row and an agent row resurrected from a check that
  // had just reported a clean store.
  await stopPi();
  if (!keep) await cleanProbeRows();
  else console.log(`--keep-rows: left the "${agent}" rows in the store`);

  if (problems.length) {
    console.error(`FAILED:\n- ${problems.join("\n- ")}`);
    console.error(`audit written to ${path.join(scratch, "audit.jsonl")}`);
    writeFileSync(path.join(scratch, "audit.jsonl"), audit.map((e) => JSON.stringify(e)).join("\n"), "utf8");
    process.exit(1);
  }
  console.log("PASS: turns recorded, read path answered, dream wrote a memory with a subject line and a feel.");
} catch (error) {
  console.error(`FAILED: ${error?.message ?? error}`);
  await stopPi().catch(() => undefined);
  // A probe that dies halfway must not leave its rows behind: a fabricated memory in a shared store is worse than a
  // failed check, and every run before this rule existed left another dozen events in there.
  if (!keep) {
    try {
      await cleanProbeRows();
    } catch (cleanupError) {
      console.error(`cleanup after failure also failed: ${cleanupError?.message ?? cleanupError}`);
    }
  }
  process.exit(1);
} finally {
  await stopPi().catch(() => undefined);
  try {
    await db.end();
  } catch {
    /* the connection may already be gone */
  }
}

async function stopPi() {
  if (!pi || piStopping) return;
  piStopping = true;
  pi.kill("SIGTERM");
  // Bounded: a writer that will not die should not turn a cleanup into a hang, and an unwaited kill is exactly the
  // race this ordering exists to remove.
  await Promise.race([piExit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function cleanProbeRows() {
  // Deleting in dependency order one statement at a time: a single statement with several DELETE CTEs would let
  // Postgres check the foreign keys in an order this script does not control.
  const deleted = {};
  // The heartbeat is deleted with the rest of it, and before the agent rows, because it is keyed by agent id and the
  // subquery below is how it finds them. Leaving one behind would put a probe agent in a table someone might alert on.
  for (const table of ["memory", "event", "session", "writer_heartbeat", "agent"]) {
    const result =
      table === "agent"
        ? await db.query(`delete from memory.agent where name = any($1::text[])`, [[agent, teammateAgent]])
        : await db.query(`delete from ${table} where agent_id in (select id from memory.agent where name = any($1::text[]))`, [[agent, teammateAgent]]);
    deleted[table] = result.rowCount;
  }
  const left = await db.query(`select (select count(*) from memory.agent) as agents, (select count(*) from memory.event) as events, (select count(*) from memory.memory) as memories, (select count(*) from memory.writer_heartbeat) as heartbeats`, []);
  console.log(`cleaned up: ${JSON.stringify(deleted)}; store now holds ${JSON.stringify(left.rows[0] ?? {})}`);
  await db.query("refresh materialized view subject_index");
}

async function counts(agentId) {
  const events = await db.query(`select count(*)::int as n from memory.event where agent_id = $1`, [agentId]);
  const memories = await db.query(`select count(*)::int as n from memory.memory where agent_id = $1`, [agentId]);
  return { events: events.rows[0].n, memories: memories.rows[0].n };
}
