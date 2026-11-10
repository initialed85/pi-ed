#!/usr/bin/env node
/**
 * One-off: resummarize the subject index.
 *
 * The store had 105 distinct subject labels across 23 memories (108 uses). Two separate problems were stacked in that
 * number, and it is worth keeping them apart because only one of them is a data fix:
 *
 *   1. 33 labels were parse fragments - `["agent memory and recall"`, `"backup and replication decisions"` - produced
 *      when a model passed a JSON array as a string and the write path split it on commas. That is fixed in
 *      parked/memory.ts (parseSubjects) and this script repairs what it already wrote.
 *   2. The rest were near-synonyms invented per dream: 1.0 uses per label on average. Nothing joined an existing
 *      subject, so the index was a list of one-off phrases instead of something a future self can scan.
 *
 * This pass does the repair and the merge. It is deliberately explainable rather than clever: a label is merged into
 * an existing canonical label only by naming the target and the similarity, every merge is written to
 * memory.subject_merge, and each row keeps its previous array in `detail -> subjects_before` so the whole operation is
 * reversible with SQL and no backups.
 *
 * Dry run by default. Reading the proposed merges is the point; writing them is a separate, explicit decision.
 *
 *   node ./hack/resummarize-subjects.mjs                        # what would change
 *   node ./hack/resummarize-subjects.mjs --apply                # change it
 *   node ./hack/resummarize-subjects.mjs --threshold=0.92       # only merge near-identical phrasings
 *   node ./hack/resummarize-subjects.mjs --rollback             # restore subjects_before
 */
import process from "node:process";

const dsn = process.env.PI_MEMORY_DSN ?? process.argv[2];
const args = new Set(process.argv.slice(2));
const threshold = Number(argValue("--threshold") ?? 0.88);
const embedUrl = (argValue("--url") ?? "https://embeddings.dev.initialed85.cc").replace(/\/$/, "");
const embedModel = argValue("--model") ?? "bge-base-en-v1.5";
const batchSize = 32;

function argValue(name) {
  const found = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : undefined;
}

if (!dsn) {
  console.error("PI_MEMORY_DSN (or --dsn) is required: this script only ever talks to the live store it is repairing.");
  process.exit(2);
}

const { default: pg } = await import("pg");
// One set of rules for how a subject label is read. Duplicating them here would give the write path and the repair
// path two different ideas about what a label is, which is how the store acquired 33 fragments in the first place.
const { parseSubjects } = await import("../parked/memory.ts");
const client = new pg.Client({ connectionString: dsn });

async function embed(texts) {
  const response = await fetch(`${embedUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: embedModel, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`embeddings ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const payload = await response.json();
  return payload.data.map((row) => row.embedding);
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

await client.connect();

if (args.has("--rollback")) {
  const result = await client.query(
    `update memory.memory
        set subjects = coalesce((select array_agg(s) from jsonb_array_elements_text(detail -> 'subjects_before') s), subjects),
            detail = detail - 'subjects_before' - 'subjects_resummarized_at'
      where detail ? 'subjects_before'`,
  );
  console.log(`rolled back ${result.rowCount} row(s) to the subject arrays they were rewritten from.`);
  await client.end();
  process.exit(0);
}

const rows = (await client.query(`select id, agent_id, subjects, created_at, embedding is not null as embedded from memory.memory order by created_at`)).rows;
const original = new Map(rows.map((row) => [row.id, row.subjects ?? []]));

// Rule one: read the labels the way the extension now reads them.
const cleaned = rows.map((row) => ({ id: row.id, before: original.get(row.id) ?? [], after: parseSubjects(row.subjects ?? []) }));
const uses = new Map();
for (const row of cleaned) for (const label of row.after) uses.set(label, (uses.get(label) ?? 0) + 1);

const labels = [...uses.keys()];
// Canonical ordering: most used first, then the shortest phrasing. The label a fleet actually reaches for is the one
// that appears most, and a tie goes to the plainer wording rather than the more specific one.
labels.sort((a, b) => uses.get(b) - uses.get(a) || a.length - b.length || a.localeCompare(b));

const vectors = [];
for (let i = 0; i < labels.length; i += batchSize) vectors.push(...(await embed(labels.slice(i, i + batchSize))));
const vectorOf = new Map(labels.map((label, index) => [label, vectors[index]]));

const clusters = [];
const merges = [];
const nearMisses = [];
for (const label of labels) {
  let best;
  for (const cluster of clusters) {
    const similarity = cosine(vectorOf.get(label), vectorOf.get(cluster.canonical));
    if (similarity > (best?.similarity ?? 0)) best = { canonical: cluster.canonical, similarity };
  }
  if (best && best.similarity >= threshold) {
    merges.push({ label, canonical: best.canonical, similarity: best.similarity });
    clusters.find((cluster) => cluster.canonical === best.canonical).members.push(label);
  } else {
    clusters.push({ canonical: label, members: [label] });
    if (best) nearMisses.push({ label, canonical: best.canonical, similarity: best.similarity });
  }
}

const canonicalOf = new Map();
for (const cluster of clusters) for (const member of cluster.members) canonicalOf.set(member, cluster.canonical);

const changes = cleaned.filter((row) => {
  const target = [...new Set(row.after.map((label) => canonicalOf.get(label) ?? label))];
  return JSON.stringify(target) !== JSON.stringify(row.before);
}).map((row) => ({ id: row.id, before: row.before, after: [...new Set(row.after.map((label) => canonicalOf.get(label) ?? label))] }));

console.log(`memories ${rows.length}  labels before ${labels.length}  labels after ${clusters.length}  rows rewritten ${changes.length}`);
const totalUses = [...uses.values()].reduce((sum, count) => sum + count, 0);
console.log(`threshold ${threshold}  embedder ${embedModel}  label reuse ${totalUses}/${labels.length} = ${(totalUses / labels.length).toFixed(2)} before, ${totalUses}/${clusters.length} = ${(totalUses / clusters.length).toFixed(2)} after`);

if (merges.length) {
  console.log(`\nmerged into an existing label (${merges.length}):`);
  for (const merge of merges.sort((a, b) => a.canonical.localeCompare(b.canonical))) {
    console.log(`  ${merge.similarity.toFixed(3)}  ${merge.label}  ->  ${merge.canonical}`);
  }
}

if (nearMisses.length) {
  console.log(`\nnot merged, closest existing label was below the threshold (the interesting part of any similarity cut):`);
  for (const miss of nearMisses.sort((a, b) => b.similarity - a.similarity).slice(0, 12)) {
    console.log(`  ${miss.similarity.toFixed(3)}  ${miss.label}  ~  ${miss.canonical}`);
  }
}

const empty = cleaned.filter((row) => row.after.length === 0);
if (empty.length) console.log(`\nrows that end up with no subjects at all (${empty.length}) - these are the {none} dreams, which are honest memories with nothing to index`);

console.log(`\nsubject index after the pass:`);
for (const cluster of clusters.sort((a, b) => uses.get(b.canonical) - uses.get(a.canonical) || a.canonical.localeCompare(b.canonical))) {
  console.log(`  ${String(uses.get(cluster.canonical)).padStart(2)}  ${cluster.canonical}${cluster.members.length > 1 ? `  <- ${cluster.members.filter((m) => m !== cluster.canonical).join(" | ")}` : ""}`);
}

if (!args.has("--apply")) {
  console.log(`\ndry run: nothing was written. --apply to rewrite ${changes.length} row(s) and record ${merges.length} merge(s) in memory.subject_merge.`);
  await client.end();
  process.exit(0);
}

const runId = `resummarize-${new Date().toISOString().replace(/[:.]/g, "-")}`;
try {
  await client.query("begin");
  await client.query(`create table if not exists memory.subject_merge (
    run_id text not null,
    label text not null,
    canonical text not null,
    similarity numeric not null,
    embed_model text not null,
    applied_at timestamptz not null default now(),
    primary key (run_id, label)
  )`);
  for (const merge of merges) {
    await client.query(`insert into memory.subject_merge (run_id, label, canonical, similarity, embed_model) values ($1,$2,$3,$4,$5)`, [runId, merge.label, merge.canonical, merge.similarity.toFixed(6), embedModel]);
  }
  for (const change of changes) {
    await client.query(
      `update memory.memory
          set subjects = $2::text[],
              detail = detail || jsonb_build_object('subjects_before', $3::jsonb, 'subjects_resummarized_at', now(), 'subjects_run', $4::text)
        where id = $1`,
      [change.id, change.after, JSON.stringify(change.before), runId],
    );
  }
  await client.query("commit");
  console.log(`\napplied ${changes.length} row(s), ${merges.length} merge(s), run ${runId}. Roll back with --rollback.`);
} catch (error) {
  await client.query("rollback");
  console.error(`nothing written: ${error.message}`);
  await client.end();
  process.exit(1);
}

await client.end();
