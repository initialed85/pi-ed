#!/usr/bin/env node
/**
 * Does the top hit be the RIGHT memory?
 *
 * Everything else in this repository measures whether the store is *alive* - writers, spool, coverage, failures. None
 * of it measures retrieval quality, so recall could regress the way the dream floor of one did: quietly, with nothing
 * failing. This is the missing number.
 *
 * It runs the production path, not a simulation: `embedText` against the deployed embedder, then `vectorSearch`, which
 * is the same `memory_search` SQL function the `memory_search` tool calls. Fabricated vectors would prove the index
 * works and nothing else, and the failure that motivated this probe was a *phrasing* failure.
 *
 * Why this exists, in one measured sentence: ocr asked "consciousness memory conversation pedestal transcript" and got
 * ZERO own results, while unrelated queries returned weights of 0.723 / 0.720 / 0.566 / 0.558. The memories were in the
 * store. The words could not reach them.
 *
 * Two modes, because they answer different questions:
 *
 *   --fixture (default)  a corpus this script plants and then removes, with real embeddings and deliberate vocabulary
 *                        gaps. Deterministic, so a regression here means the code or the model moved. Exit 1 if mean
 *                        reciprocal rank falls under --mrr. This is the gate.
 *   --live               named real rows from the fleet's own memories, asked about the way a teammate would. Never
 *                        fails on a miss - a corpus that changes hourly would go red for reasons unrelated to
 *                        retrieval - but it reports rank *and* whether the row still exists, because "nobody wrote
 *                        that down" and "it is there and nothing can reach it" are different findings.
 *
 *   PI_LIVE_DSN="$DSN" node hack/recall-probe.mjs                 # fixture gate
 *   PI_LIVE_DSN="$DSN" node hack/recall-probe.mjs --live          # known-good rows in the real corpus
 *   PI_LIVE_DSN="$DSN" node hack/recall-probe.mjs --jsonl f.jsonl # append one record per run
 *
 * The floor is the baseline that was measured when this was written, not an aspiration. Five of six fixture questions
 * come back, three of those first, giving MRR 0.667; one is a documented vocabulary miss. Raising it later is the
 * actual win condition.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "extensions", "memory.ts");
const liveDsn = process.env.PI_LIVE_DSN ?? process.env.PI_MEMORY_DSN ?? "";
const flags = new Set(process.argv.slice(2));
const live = flags.has("--live");
const jsonl = process.argv.find((a) => a === "--jsonl") ? process.argv[process.argv.indexOf("--jsonl") + 1] : "";
const mrrFloor = Number(process.argv.find((a) => a.startsWith("--mrr="))?.split("=")[1] ?? 0.6);

/**
 * The fixture corpus. Written so that reaching the right row requires meaning rather than keyword overlap: the question
 * and the memory share few of the same words, which is the shape that broke for ocr.
 */
const FIXTURES = [
  { id: "rollout-window", text: "The fleet restart was done in two waves so the ingress kept serving while the agents were still holding sessions.", expects: "deployment order" },
  { id: "budget-tradeoff", text: "Embedding every turn would cost more than the value of remembering it, so only closed stretches are summarised.", expects: "why dreaming is not free" },
  { id: "ui-lifetime", text: "A context object taken from an earlier event throws when its getter is touched after the panel is gone.", expects: "stale context crash" },
  { id: "test-oom", text: "Six parallel workers in a pod with a small memory ceiling made the suite die in a way that looked like a hang.", expects: "CI ran out of memory" },
  { id: "identity-drift", text: "The pod renames itself on every restart, so the key built from its hostname no longer matches the one it wrote before.", expects: "orphaned memories" },
  { id: "index-fragmentation", text: "Ninety-odd labels across two dozen rows meant a scan of the index found nothing twice, and the third time it invented a new one.", expects: "subject index cleanup" },
];

/**
 * Deliberate near-neighbours from a different agent, so the own/teammate weighting has something to do. Without these
 * a probe could pass on a search that ignores scope entirely.
 */
const DISTRACTORS = [
  { id: "other-rollout", text: "A blue-green swap of the cache tier left warm connections pointing at the retired nodes." },
  { id: "other-cost", text: "The inference bill doubled when the summariser was moved to the larger model." },
  { id: "other-panel", text: "The widget stayed on screen after its owner had been garbage collected." },
];

/**
 * The fixed question set. `for` names the fixture row that should come back first.
 *
 * Question 1 is a KNOWN MISS as first measured: "what limits how often an agent reflects" does not reach
 * "Embedding every turn would cost more than the value of remembering it, so only closed stretches are summarised"
 * inside the top 8. That is the ocr failure in miniature - a real row, a reasonable question, no overlap in vocabulary
 * - and it is kept in the set rather than deleted, because a gate that quietly drops its hard cases stops being a
 * gate. The floor below is set to the measured baseline so the number can only go down without going red.
 */
const QUESTIONS = [
  { q: "why was the restart staged rather than done all at once", for: "rollout-window" },
  { q: "what limits how often an agent reflects", for: "budget-tradeoff" },
  { q: "the crash when an old context is used after the panel closes", for: "ui-lifetime" },
  { q: "why does the test suite die on a small pod", for: "test-oom" },
  { q: "memories becoming unreachable after a redeploy", for: "identity-drift" },
  { q: "too many labels making the index useless", for: "index-fragmentation" },
];

/**
 * Known-good rows in the fleet's real corpus, named by primary key.
 *
 * Live mode used to match a phrase I invented, and that measured the phrase rather than the retrieval: against ocr's
 * memories it reported MRR 0.135 when the actual cause was that only two of its rows contain words like "stale" or
 * "two waves" at all. An id cannot lie about whether the row exists, so the target is the id and the question is
 * written to be answerable from the summary the row already holds.
 *
 * These are maintained by hand, which is the point: a human decides what should be findable, and the machine checks
 * whether it still is. A row that is deleted upstream should be reported as absent, not as a recall failure, so the
 * probe says which of the two it is.
 */
const LIVE_CASES = [
  { agent: "pi-ed", id: "f64fe8d5-1fe2-4a97-8f86-65544544c508", q: "the test suite kept dying with no failing test" },
  { agent: "pi-ed", id: "33c48863-3ac2-4f86-b410-6800fecc940c", q: "the index of topics had far too many distinct labels" },
  { agent: "pi-ed", id: "4e2d8ef5-7c6c-45e6-836e-0d3b90f437f2", q: "a restarted session dreaming about its whole past" },
  { agent: "pi-ed", id: "af790666-2527-436d-a39f-9a53f8fb58b6", q: "why an agent kept reflecting when it had done nothing" },
  { agent: "ocr", id: "714fa2b7-1767-4d3d-85bd-503351e6dc0e", q: "a long conversation about whether the model could be sure it was conscious" },
  { agent: "ocr", id: "b49e7755-5eaa-412b-b54b-8255dd9b7da1", q: "the trigger firing over and over with no user turn in between" },
];

if (!liveDsn) {
  console.error("recall-probe: needs PI_LIVE_DSN (or PI_MEMORY_DSN). It queries the real embedder and the real index.");
  process.exit(2);
}

const pg = await import("pg");
const mod = await import(source);
const AGENT = "recall-probe-self";
const OTHER = "recall-probe-other";
const DIM = mod.EMBEDDING_DIMENSIONS;
const client = new pg.Client({ connectionString: liveDsn });
await client.connect();

async function q(sql, values = []) {
  return client.query(sql, values);
}

async function plant(agentId, rows) {
  await q(`insert into memory.agent (id, name, notes) values ($1, $1, '{"probe": true}'::jsonb)
         on conflict (id) do update set notes = excluded.notes`, [agentId]);
  await q(`insert into memory.session (id, agent_id, source, started_at, last_activity_at)
         values ($2, $1, 'probe', now(), now()) on conflict (id) do update set last_activity_at = now()`,
    [agentId, `${agentId}-session`]);
  for (const row of rows) {
    const embedded = await mod.embedText(row.text, {});
    if (!embedded.ok) throw new Error(`embedder unavailable (${embedded.error}); the probe measures real retrieval, so fabricated vectors would be a lie`);
    await q(`insert into memory.memory (agent_id, session_id, trigger, summary, subjects, feel, embedding, embedding_model, embedding_dim)
           values ($1, $2, 'manual', $3, array['recall-probe'], 'deliberate', $4::vector, $5, $6::int)`,
      [agentId, `${agentId}-session`, row.text, `[${embedded.vector.join(",")}]`, embedded.model, embedded.vector.length]);
  }
  return DIM;
}

async function clean() {
  await q(`delete from memory.memory where agent_id in ($1, $2)`, [AGENT, OTHER]);
  await q(`delete from memory.session where agent_id in ($1, $2)`, [AGENT, OTHER]);
  await q(`delete from memory.agent where id in ($1, $2)`, [AGENT, OTHER]);
}

const runId = new Date().toISOString();
const results = [];
const fixtureText = Object.fromEntries(FIXTURES.map((row) => [row.id, row.text]));

try {
  if (!live) {
    await clean();
    await plant(AGENT, FIXTURES);
    await plant(OTHER, DISTRACTORS);
  }

  for (const item of (live ? LIVE_CASES : QUESTIONS)) {
    const embedded = await mod.embedText(item.q, {});
    if (!embedded.ok) throw new Error(`question could not be embedded: ${embedded.error}`);
    const statement = mod.vectorSearch(live ? item.agent : AGENT, embedded.vector, { limit: 8 });
    const rows = (await q(statement.sql, statement.values)).rows;
    // Fixture mode matches the whole planted sentence, which is exact and cannot false-positive. Live mode matches the
    // row's primary key, and separately reports whether that row is still in the store, because "the agent forgot to
    // say that" and "the agent said it and nothing can find it" are different findings that a rank alone conflates.
    let exists = true;
    if (live) {
      exists = (await q(`select 1 from memory.memory where id = $1`, [item.id])).rowCount > 0;
    }
    const wanted = fixtureText[item.for];
    const rank = rows.findIndex((row) => {
      const summary = String(row.summary ?? "");
      return live ? String(row.id) === item.id : summary === wanted;
    });
    results.push({
      question: item.q,
      expected: live ? item.id.slice(0, 8) : item.for,
      rank: rank + 1,
      found: rank >= 0,
      row_in_store: live ? exists : true,
      top_weight: rows.length ? Number(Number(rows[0].weight).toFixed(3)) : null,
      hit_weight: rank >= 0 ? Number(Number(rows[rank].weight).toFixed(3)) : null,
      candidates: rows.length,
    });
  }

  const found = results.filter((r) => r.found);
  const mrr = results.reduce((sum, r) => sum + (r.found ? 1 / r.rank : 0), 0) / results.length;
  const firstHit = results.filter((r) => r.found && r.rank === 1).length;

  console.log(`\nrecall probe - ${live ? "LIVE corpus" : "fixture"} - ${runId}`);
  console.table(results);
  console.log(`mean reciprocal rank: ${mrr.toFixed(3)} (floor ${mrrFloor})   first-hit: ${firstHit}/${results.length}   retrieved: ${found.length}/${results.length}`);

  if (jsonl) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(jsonl, `${JSON.stringify({ run: runId, mode: live ? "live" : "fixture", mrr, firstHit, results })}\n`);
    console.log(`appended to ${jsonl}`);
  }

  if (!live && mrr < mrrFloor) {
    console.error(`\nFAIL: mean reciprocal rank ${mrr.toFixed(3)} is under ${mrrFloor}. Recall has regressed - look at which question lost its row.`);
    process.exitCode = 1;
  }
} finally {
  if (!live) await clean();
  await client.end();
}
