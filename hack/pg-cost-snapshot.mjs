#!/usr/bin/env node
// Measure what a run cost, without resetting anybody else's window.
//
// `select pg_stat_statements_reset()` is the obvious way to get per-run numbers and the wrong tool: the view is
// cumulative since the last reset, the reset is shared state in a database other agents are reading, and a restart
// resets it on its own anyway - `pg_stat_statements_info.stats_reset` in this store reads 2026-11-07 19:27:33Z,
// sixteen seconds after the container started, nobody having announced a thing.
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
  select queryid, calls, total_exec_time, mean_exec_time, max_exec_time, rows, left(query, 70) as query
  from pg_stat_statements
  where queryid is not null
`;

const RESET = `select stats_reset from pg_stat_statements_info`;

// This script measures the command it runs, not itself. Both queries above are tracked by the view like anything
// else, and the after-snapshot would otherwise hand back its own cost as part of the run's.
const SELF = [SNAPSHOT, RESET].map((sql) => sql.replace(/\s+/g, " ").trim());
const isSelf = (text) => SELF.some((sql) => text.startsWith(sql.slice(0, 40)));

async function snapshot(db) {
  const [statements, info] = await Promise.all([db.query(SNAPSHOT), db.query(RESET).catch(() => ({ rows: [] }))]);
  const byId = new Map();
  for (const row of statements.rows) byId.set(String(row.queryid), row);
  return { byId, statsReset: info.rows[0]?.stats_reset ?? null };
}

const client = new pg.Client({ connectionString: dsn, application_name: "pi-ed pg-cost-snapshot" });
await client.connect();
const db = { query: async (sql) => ({ rows: (await client.query(sql)).rows }) };

const before = await snapshot(db);
console.log(`before: ${before.byId.size} tracked statements, window since stats_reset ${before.statsReset ?? "unknown"}`);

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
  console.log(`note: stats_reset moved during the run (${before.statsReset} -> ${after.statsReset}). A restart reset the view; do not compare this against an older reading.`);
}

const includeDdl = flags["includeDdl"] === true;
const rows = [];
for (const [queryid, row] of after.byId) {
  const was = before.byId.get(queryid);
  const calls = Number(row.calls) - Number(was?.calls ?? 0);
  const totalMs = Number(row.total_exec_time) - Number(was?.total_exec_time ?? 0);
  const rowsOut = Number(row.rows) - Number(was?.rows ?? 0);
  if (calls <= 0) continue;
  const text = String(row.query).replace(/\s+/g, " ").trim();
  // One-off init and DDL dominate total time without recurring at all: in this store a single
  // `CREATE EXTENSION pg_stat_statements` logged 143.89 ms, more than any real query here. Ranking by total time is
  // how a threshold argument gets built out of the wrong row, so DDL is excluded unless asked for.
  // `refresh materialized view subject_index` is deliberately NOT excluded: it recurs on every writer run and it is
  // the priciest thing this store does on purpose, which is the number the 250 ms threshold is argued from.
  if (isSelf(text)) continue;
  if (!includeDdl && /^(create|alter|drop|comment|grant|begin|commit|with a as|insert into agent)/i.test(text)) continue;
  rows.push({ queryid, calls, totalMs, perCall: totalMs / calls, rowsOut, text });
}

rows.sort((a, b) => b.totalMs - a.totalMs);
const top = Number(flags.top) || 6;
console.log(`\nduring the run (${rows.length} distinct statements, deltas not totals):`);
for (const row of rows.slice(0, top)) {
  console.log(`  ${row.totalMs.toFixed(2)} ms total | ${row.perCall.toFixed(2)} ms per call | ${row.calls} call(s) | ${row.rowsOut} row(s) | ${row.text}`);
}
if (!rows.length) console.log("  nothing attributable to the run");

await client.end();
