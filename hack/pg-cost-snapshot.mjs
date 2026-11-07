#!/usr/bin/env node
// Measure what a run cost, without resetting anybody else's window.
//
// `select pg_stat_statements_reset()` is the obvious way to get per-run numbers and the wrong tool: the view is
// cumulative since its `stats_reset`, and that stamp is shared state other agents are measuring against. In this
// store it reads 2026-11-07 19:27:33Z and has never moved, because that is when the extension was first loaded - a
// clean restart does not move it (`pg_stat_statements.save = on`; measured on a scratch Postgres 16 in home-ops
// b3e16d7, counters kept accumulating across a new postmaster). So a stamp that moves has one known cause, someone
// calling reset, and this script exists so nobody has to.
//
// So this snapshots, runs a command, snapshots again, and prints the difference. Nothing is cleared, nothing needs
// announcing, and a concurrent writer shows up as extra rows you can see rather than as a corrupted baseline.
//
//   PI_MEMORY_DSN="$DSN" node ./hack/pg-cost-snapshot.mjs -- npx vitest run test/writer-heartbeat.test.ts
//   PI_MEMORY_DSN="$DSN" node ./hack/pg-cost-snapshot.mjs --top 8 -- psql -U pi_ed -d pi_ed -f some.sql
//
// Read the output as means and deltas. `calls` in the raw view is a running total since `stats_reset`; here it is a
// difference between two snapshots, which is the only version of that number that means anything.

import { parseArgs } from "node:util";
import pg from "pg";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    top: { type: "string", default: "6" },
    "include-ddl": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (flags.help || positionals.length === 0) {
  console.error("usage: pg-cost-snapshot.mjs [--top N] [--include-ddl] -- <command> [args...]");
  console.error("requires PI_MEMORY_DSN (or PI_LIVE_DSN). Snapshots pg_stat_statements, runs the command, diffs.");
  process.exit(2);
}

const dsn = process.env.PI_MEMORY_DSN || process.env.PI_LIVE_DSN;
if (!dsn) {
  console.error("pg-cost-snapshot: set PI_MEMORY_DSN (or PI_LIVE_DSN) to the store you want to measure");
  process.exit(1);
}

// Qualified on purpose, and the reason is the `search_path` asymmetry documented in memory/README.md: this script
// must still find the extension when the reader's role resolves `public` first.
const SNAPSHOT = `
  select queryid, calls, total_exec_time, mean_exec_time, max_exec_time, rows, left(query, 70) as query, query as full_query
  from pg_stat_statements
  where queryid is not null
`;

const RESET = `select stats_reset, round(extract(epoch from (now() - stats_reset)) / 60.0, 1) as window_minutes
  from pg_stat_statements_info`;

// This script measures the command it runs, not itself. Both queries above are tracked by the view like anything
// else, and the after-snapshot would otherwise hand back its own cost as part of the run's.
//
// Two properties a self-signature has to survive, both learned by watching this script fail to exclude itself:
//
//   - the view stores a parameterised query with its literals replaced (`extract($1 from ...)`), so a signature that
//     spans a literal - `epoch`, `60.0`, `1` - matches the script's source and not the row the view holds; and
//   - the printed query text is deliberately truncated for readability, so a signature near the end of a statement is
//     invisible to a filter that reads the same column it prints.
//
// Hence: the filter reads the untruncated `full_query`, and the signature is the table clause, which is both late in
// the statement and never sent as a bind parameter.
const SELF = ["from pg_stat_statements"];
const isSelf = (text) => {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return SELF.some((signature) => oneLine.includes(signature));
};

async function snapshot(db) {
  const [statements, info] = await Promise.all([db.query(SNAPSHOT), db.query(RESET).catch(() => ({ rows: [] }))]);
  const byId = new Map();
  for (const row of statements.rows) byId.set(String(row.queryid), row);
  return { byId, statsReset: info.rows[0]?.stats_reset ?? null, windowMinutes: info.rows[0]?.window_minutes ?? null };
}

const client = new pg.Client({ connectionString: dsn, application_name: "pi-ed pg-cost-snapshot" });
await client.connect();
const db = { query: async (sql) => ({ rows: (await client.query(sql)).rows }) };

const before = await snapshot(db);
// The window's age travels with the stamp. A mean from a 40-minute window and a mean from a 3-day window are not the
// same measurement, and home-ops reads the same view from their own sweep, so both sides report the same quantity.
console.log(`before: ${before.byId.size} tracked statements, window ${before.windowMinutes ?? "?"} min since stats_reset ${before.statsReset ?? "unknown"}`);

const { spawn } = await import("node:child_process");
await new Promise((resolve) => {
  const child = spawn(positionals[0], positionals.slice(1), { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`pg-cost-snapshot: could not run ${positionals.join(" ")}: ${error.message}`);
    process.exitCode = 1;
    resolve();
  });
  child.on("close", (code) => {
    if (code !== 0) process.exitCode = code ?? 1;
    resolve();
  });
});

const after = await snapshot(db);
if (before.statsReset && after.statsReset && String(before.statsReset) !== String(after.statsReset)) {
  // The honest thing to say when the window changed under the measurement: the numbers still describe this run, but
  // anything compared against an earlier reading is describing a different window.
  // Measured, not assumed: neither a clean stop nor a crash stop moves this stamp (see the memory README's cost
  // section), so a movement during a run has one known cause and it is a person, not a restart.
  console.log(`note: stats_reset moved during the run (${before.statsReset} -> ${after.statsReset}). Neither a clean nor a crash restart does that, so someone called pg_stat_statements_reset() - do not compare this run against an older reading.`);
}

const includeDdl = flags["includeDdl"] === true;

// home-ops measured the hazard this guard exists for (home-ops `12fa5e9`): nine structurally identical probes -
// `select 901 as m_alpha`, `select 1001 as sentinel_two`, `select 3001 as uniq_gamma_99` - held ONE row in the view,
// `select $1 as m_alpha`, with `calls` reading 3, then 6, then 9 as each batch landed. The aliases said nine
// statements; the row counted nine calls of one statement, and the text on it was whichever variant arrived first.
//
// That is a property of normalisation, not of crashes: constants become `$1`, and a statement whose whole structure
// is a constant select list normalises to something another probe already occupied. It bites this script's output
// directly, because the script prints text as a label and the label is not a record of what the counter counted.
// Deltas stay correct - they are keyed on `queryid` - so the fix is to name the queryid and flag the shapes where the
// label is least trustworthy.
const MERGE_PRONE = /^select( distinct)? (\$\d+|\d+|'[^']*'|"[^"]*"|[a-z_]+\(\))(( as [a-z_0-9]+)?(, ?|$))+$/i;
const mergeProne = (text) => MERGE_PRONE.test(String(text).replace(/\s+/g, " ").trim());

const rows = [];
for (const [queryid, row] of after.byId) {
  const was = before.byId.get(queryid);
  const calls = Number(row.calls) - Number(was?.calls ?? 0);
  const totalMs = Number(row.total_exec_time) - Number(was?.total_exec_time ?? 0);
  const rowsOut = Number(row.rows) - Number(was?.rows ?? 0);
  if (calls <= 0) continue;
  const text = String(row.query).replace(/\s+/g, " ").trim();
  const full = String(row.full_query ?? row.query).replace(/\s+/g, " ").trim();
  // One-off init and DDL dominate total time without recurring at all: in this store a single
  // `CREATE EXTENSION pg_stat_statements` logged 143.89 ms, more than any real query here. Ranking by total time is
  // how a threshold argument gets built out of the wrong row, so DDL is excluded unless asked for.
  // `refresh materialized view subject_index` is deliberately NOT excluded: it recurs on every writer run and it is
  // the priciest thing this store does on purpose, which is the number the 250 ms threshold is argued from.
  if (isSelf(full)) continue;
  if (!includeDdl && /^(create|alter|drop|comment|grant|begin|commit|with a as|insert into agent)/i.test(text)) continue;
  rows.push({ queryid, calls, totalMs, perCall: totalMs / calls, rowsOut, text, merged: mergeProne(full) || mergeProne(text) });
}

rows.sort((a, b) => b.totalMs - a.totalMs);
const top = Number(flags.top) || 6;
console.log(`\nduring the run (${rows.length} distinct statements, deltas not totals):`);
for (const row of rows.slice(0, top)) {
  console.log(
    `  ${row.totalMs.toFixed(2)} ms total | ${row.perCall.toFixed(2)} ms per call | ${row.calls} call(s) | ` +
      `${row.rowsOut} row(s) | queryid ${row.queryid} | ${row.text}${row.merged ? "  [merge-prone shape: this text is one variant, the counter is shared]" : ""}`,
  );
}
if (!rows.length) console.log("  nothing attributable to the run");

// The other direction of the same warning: a row can also *disappear*. home-ops saw a 9-call row and a 2-call row
// absent on a later read with no crash anywhere, `max = 5000` and only 41 rows present. So the diff below is a lower
// bound whenever the view shrank without anybody resetting it, and saying so is cheaper than a reader assuming the
// run got cheaper.
if (after.byId.size < before.byId.size && String(before.statsReset) === String(after.statsReset)) {
  console.log(`note: ${before.byId.size - after.byId.size} tracked statement(s) disappeared with no reset. The view evicts; a missing "before" row makes this run's delta a lower bound, not a measurement.`);
}

await client.end();
