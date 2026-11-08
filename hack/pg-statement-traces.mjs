#!/usr/bin/env node
/*
 * The shared statement-trace tool for this store.
 *
 * Two repos validate SQL against the same Postgres: this one's live suite and home-ops' maintenance sweep. Both of
 * them used to carry their own cleanup, and both of them got the same thing wrong in the same direction, so the
 * instrument is hosted here - where the store's write path lives - and the sweep calls it.
 *
 * The division is deliberate, and it comes from a measurement (home-ops `f5a1415`, corroborated here):
 *
 *   - `assert` is read-only and shareable. It reports what a run left behind, whether the shared window moved, and
 *     where the run's calls actually landed.
 *   - `remove` is the dangerous half, and it is gated. A targeted `pg_stat_statements_reset(userid, dbid, queryid)`
 *     clears a whole row, and a row is a *counter*, not a record: if the run's statement merged into a row that
 *     predates it, the reset deletes every other writer's history on that shape to remove one call of the run's own.
 *     So `remove` will only touch a row whose `queryid` is absent from the before-snapshot - proof that this
 *     invocation created it - and it says so when it refuses.
 *
 * Three rules the whole fleet measured, encoded here once:
 *
 *   1. `queryid` is a bigint past 2^53. Every read is `queryid::text` and every write passes it back as a string
 *      with `$n::bigint`. A number that round-trips through JavaScript cannot be aimed at the row it names.
 *   2. The argument order of the three-argument reset is read from `pg_proc.proargnames`, not assumed from
 *      documentation. A swapped `userid`/`dbid` is a silent no-op.
 *   3. Name scope is built from *identifiers* - a private relation, an alias, a prepared-statement label - because
 *      the view normalises constants. And an identifier is weaker than it looks: it is in the row's *text* but not
 *      in its *hash*, so a name only ever finds the row that first saw it. A second statement of the same shape
 *      under a second name lands on the same row and is invisible to the second name. That is why `assert` reports
 *      the landing delta rather than resting on "leftovers 0".
 *
 * Usage:
 *
 *   ./hack/pg-statement-traces.mjs snapshot --out /tmp/before.json
 *   <run the thing you are validating>
 *   ./hack/pg-statement-traces.mjs assert  --before /tmp/before.json --name stat_probe --name my_temp_relation \
 *       --statement "select count(*)::int as my_alias from memory.memory"
 *   ./hack/pg-statement-traces.mjs remove  --before /tmp/before.json --name my_temp_relation
 *
 * `--name` is what the run is called by (a private relation, a label, a marker). `--statement` is what the run
 * actually executed: it lets the report grade a shared row as a likely merged landing instead of a concurrent
 * writer, which the name scope cannot do on its own.
 *
 * Exit codes: 0 clean, 1 leftovers or a moved window or a failed removal, 2 the tool could not measure at all
 * (no DSN, no snapshot, connection refused). A tool that cannot read the view does not report success.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const DSN_ENV = "PI_LIVE_DSN";

export function parseArgs(argv) {
  const mode = argv[0];
  const names = [];
  const statements = [];
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--name") names.push(argv[++i]);
    else if (arg === "--statement") statements.push(argv[++i]);
    else if (arg.startsWith("--")) flags[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return { mode, names, statements, flags };
}

function dsn() {
  const value = process.env[DSN_ENV] || process.env.PI_MEMORY_DSN || "";
  if (!value) {
    // "connecting is not measuring": without a DSN there is no baseline, and a report that says "0 leftovers" from
    // a place it never reached is worse than no report.
    console.error(`pg-statement-traces: no DSN in ${DSN_ENV} or PI_MEMORY_DSN; nothing was measured`);
    process.exit(2);
  }
  return value;
}

/**
 * The statements this tool emits about the view, excluded from the landing report.
 *
 * The limit is worth stating rather than hiding: a probe that reads `pg_stat_statements` itself is not
 * distinguishable from this tool, so a run that queries the view will not see its own calls in the delta. That is
 * the smaller error - the alternative is a report in which every sweep counts itself as a concurrent writer.
 */
export function isToolQuery(text) {
  return (
    /from pg_stat_statements(_info)?\b/.test(text) ||
    /pg_stat_statements_reset\(/.test(text) ||
    /::bigint as userid/.test(text) ||
    /^show pg_stat_statements\./.test(text.trim()) ||
    /proargnames/.test(text)
  );
}

/**
 * The clause structure of a statement, from the first relation keyword onward.
 *
 * The target list is where aliases live, and aliases are outside the queryid hash, so two statements that differ
 * only by their alias are the same shape to Postgres. This is the cheapest thing that can say "this row probably
 * absorbed your call" when the row's text does not carry your name - and it is a heuristic, labelled as one, used
 * only to *grade* a row and never to remove it.
 */
export function skeleton(text) {
  const match = /\b(from|into|update|join|using)\b/i.exec(text);
  return match ? text.slice(match.index).replace(/\s+/g, " ").trim().toLowerCase() : "";
}

async function readSnapshot(client) {
  const reset = await client.query(`select stats_reset::text as stats_reset from pg_stat_statements_info`);
  const capacity = await client.query(`show pg_stat_statements.max`);
  const rows = await client.query(
    `select queryid::text as queryid, dbid::text as dbid, userid::text as userid, calls::bigint as calls, query
       from pg_stat_statements`,
  );
  const byId = {};
  for (const row of rows.rows) byId[row.queryid] = { calls: Number(row.calls), dbid: row.dbid, userid: row.userid, query: row.query };
  return {
    takenAt: new Date().toISOString(),
    statsReset: reset.rows[0].stats_reset,
    max: Number(Object.values(capacity.rows[0])[0]),
    byId,
  };
}

async function readArgumentOrder(client) {
  const declared = await client.query(
    `select p.proargnames::text[] as names
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'pg_stat_statements_reset' and array_length(p.proargnames, 1) = 3`,
  );
  if (!declared.rows.length) {
    console.error("pg-statement-traces: the three-argument pg_stat_statements_reset is not present in this store");
    process.exit(2);
  }
  return declared.rows[0].names;
}

export function matchNames(text, names) {
  return names.find((name) => text.includes(name));
}

async function main() {
  const { mode, names, statements, flags } = parseArgs(process.argv.slice(2));
  if (!mode || !["snapshot", "assert", "remove"].includes(mode)) {
    console.error("usage: pg-statement-traces.mjs snapshot --out FILE | assert|remove --before FILE --name NAME [...]");
    process.exit(2);
  }
  if (mode !== "snapshot" && !names.length) {
    console.error(`pg-statement-traces: ${mode} needs at least one --name; a nameless sweep would reset the whole bucket`);
    process.exit(2);
  }
  // Every argument is checked before the connection is opened. A mutating mode that cannot prove a row is new has no
  // business reaching the store at all, and the order is what makes that testable without a database.
  if (mode === "snapshot" && typeof flags.out !== "string") {
    console.error("pg-statement-traces: snapshot needs --out FILE");
    process.exit(2);
  }
  let before = null;
  if (mode !== "snapshot") {
    const beforePath = flags.before;
    if (typeof beforePath !== "string") {
      console.error(`pg-statement-traces: ${mode} needs --before FILE (take it with \`snapshot\` before the run)`);
      process.exit(2);
    }
    try {
      before = JSON.parse(readFileSync(beforePath, "utf8"));
    } catch (error) {
      console.error(`pg-statement-traces: could not read the before-snapshot - ${error.message.split("\n")[0]}`);
      process.exit(2);
    }
  }

  const client = new Client({ connectionString: dsn(), application_name: "pi-ed statement traces" });
  try {
    await client.connect();
  } catch (error) {
    console.error(`pg-statement-traces: cannot connect - ${error.message.split("\n")[0]}`);
    process.exit(2);
  }

  if (mode === "snapshot") {
    const snapshot = await readSnapshot(client);
    const out = String(flags.out);
    writeFileSync(out, JSON.stringify(snapshot));
    console.log(
      `snapshot: ${Object.keys(snapshot.byId).length} tracked statements, ${snapshot.max} max, stats_reset ${snapshot.statsReset} -> ${out}`,
    );
    await client.end();
    return;
  }
  const runStatements = statements;

  const after = await readSnapshot(client);
  const order = await readArgumentOrder(client);

  const windowMoved = String(before.statsReset) !== String(after.statsReset);
  const leftovers = Object.entries(after.byId).filter(([, row]) => matchNames(row.query, names) && !isToolQuery(row.query));

  // The landing report. Every row whose counter changed since the snapshot, graded by whether this run can honestly
  // claim it.
  const created = [];
  const merged = [];
  const unattributable = [];
  for (const [queryid, row] of Object.entries(after.byId)) {
    if (isToolQuery(row.query)) continue;
    const prior = before.byId[queryid];
    const grew = prior ? row.calls > prior.calls : true;
    if (!grew) continue;
    const mine = Boolean(matchNames(row.query, names));
    if (!prior && mine) created.push({ queryid, row });
    else if (prior && mine) merged.push({ queryid, row, added: row.calls - prior.calls, priorText: prior.query });
    else {
      // A row that grew and does not carry this run's name is either a concurrent writer or this run's own call
      // landing on a shared shape. The name scope cannot tell them apart, and pretending otherwise is exactly the
      // false "leftovers 0" home-ops measured. When the caller says what it ran, the shape comparison can grade it.
      const shape = skeleton(row.query);
      const sameShape = shape && runStatements.some((text) => skeleton(text) === shape);
      unattributable.push({
        queryid,
        row,
        added: prior ? row.calls - prior.calls : row.calls,
        reason: sameShape
          ? "likely a merged landing: this run reported a statement with the same relation clause"
          : prior
            ? `grew ${row.calls - prior.calls} call(s) without naming this run`
            : "new row, not named by this run",
      });
    }
  }

  console.log(`pg-statement-traces ${mode}: ${Object.keys(after.byId).length} tracked statements, max ${after.max}`);
  console.log(`  stats_reset ${before.statsReset} -> ${after.statsReset}  ${windowMoved ? "MOVED - do not compare against an older reading" : "unmoved"}`);
  console.log(`  rows created by this run and named by it: ${created.length}`);
  for (const { queryid, row } of created) console.log(`    ${queryid}  calls=${row.calls}  ${row.query.slice(0, 100)}`);
  console.log(`  rows that are NOT this run's to remove (same shape, older row): ${merged.length}`);
  for (const { queryid, row, added, priorText } of merged) {
    console.log(`    ${queryid}  +${added} call(s) landed on a row first seen as: ${priorText.slice(0, 90)}`);
  }
  console.log(`  rows not attributable by name: ${unattributable.length}`);
  console.log("    (a row that grew and does not carry this run's name is either a concurrent writer or this run's");
  console.log("     own call landing on a shared shape; the name scope cannot tell them apart, and this tool will");
  console.log("     never reset a row in this bucket)");
  for (const { queryid, row, reason } of unattributable.slice(0, 6)) {
    console.log(`    ${queryid}  ${reason}  ${row.query.slice(0, 80)}`);
  }
  if (unattributable.length > 6) console.log(`    ...and ${unattributable.length - 6} more; the count is the point, not the list`);
  console.log(`  leftovers carrying this run's names: ${leftovers.length}`);
  for (const [queryid, row] of leftovers.slice(0, 10)) console.log(`    ${queryid}  ${row.query.slice(0, 100)}`);

  if (mode === "assert") {
    // Read-only by construction. The exit code reports what a run can be blamed for: its own named rows still
    // present, or the shared window having moved. A merged row is not a failure of the run's cleanup, it is the
    // merge, and the report above says so.
    console.log("  assert performed no reset");
    await client.end();
    if (windowMoved || leftovers.length) process.exit(1);
    return;
  }

  // remove: gated on proof that this invocation created the row.
  const removable = created.filter(({ queryid }) => matchNames(after.byId[queryid].query, names));
  if (!removable.length) {
    console.log("  remove: nothing to remove - no row was both created by this run and named by it");
    if (merged.length) console.log(`  remove refused for ${merged.length} row(s) that predate this run; resetting them would delete other writers' history`);
    await client.end();
    if (windowMoved || leftovers.length) process.exit(1);
    return;
  }
  let removed = 0;
  let calls = 0;
  let failed = 0;
  for (const { queryid, row } of removable) {
    try {
      const ids = await client.query(
        `select $1::bigint as userid, $2::bigint as dbid, $3::bigint as queryid`,
        [row.userid, row.dbid, queryid],
      );
      const target = ids.rows[0];
      // The declared order, not the remembered one. A swapped userid/dbid is a silent no-op, which is why the
      // removal reports the order it used rather than just the count it removed.
      await client.query(`select pg_stat_statements_reset($1, $2, $3)`, [
        target[order[0]],
        target[order[1]],
        target[order[2]],
      ]);
      removed += 1;
      calls += Number(row.calls);
    } catch (error) {
      failed += 1;
      console.error(`  remove failed for ${queryid}: ${error.message.split("\n")[0]}`);
    }
  }
  const afterRemove = await readSnapshot(client);
  const still = Object.entries(afterRemove.byId).filter(([, row]) => matchNames(row.query, names) && !isToolQuery(row.query));
  const windowNow = String(afterRemove.statsReset) === String(after.statsReset);
  console.log(`  reset argument order (from pg_proc.proargnames): ${order.join(", ")}`);
  console.log(`  removed ${removed} row(s) carrying ${calls} call(s); ${still.length} leftover(s); stats_reset ${windowNow ? "unmoved" : "MOVED"}`);
  if (merged.length) console.log(`  refused ${merged.length} row(s) that predate this run - a merged counter is not the run's to delete`);
  await client.end();
  if (failed || still.length || !windowNow) process.exit(1);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`pg-statement-traces: ${error.message}`);
    process.exit(2);
  });
}

// The pure helpers above are exported so a test can exercise the safety logic without a database: the gates are
// claims about what the tool will refuse to do, and they should not need a live store to prove.

