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
 *   4. The three ids are validated before the call, and the removal is confirmed after it. The function is declared
 *      `userid oid DEFAULT 0, dbid oid DEFAULT 0, queryid bigint DEFAULT 0` and 0 means *all*: home-ops measured
 *      `reset(0, 17680, 0)` against a scratch database taking 31 rows to 1 with `stats_reset` byte-identical, so a
 *      zero in the queryid slot is an entire database's history erased with no witness. The function is also
 *      `STRICT` (`proisstrict = true`), so a missing id arrives as NULL, the call returns success, and nothing is
 *      removed - which is why `remove` prints how many rows are *gone from the view* rather than how many calls
 *      succeeded, and exits nonzero when the two disagree.
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
 * writer, which the name scope cannot do on its own, and it drives the sibling report - the shapes that exist as
 * more than one queryid, which is what a column added in another repository does to a baseline.
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

/**
 * The three arguments of a targeted reset, in the order this build declares them, or a refusal.
 *
 * Two failure modes live in the same three numbers, and they point in opposite directions.
 *
 * `pg_stat_statements_reset` is declared `userid oid DEFAULT 0, dbid oid DEFAULT 0, queryid bigint DEFAULT 0`, and
 * `0` means *all*: home-ops measured `reset(0, 17680, 0)` on a scratch database taking 31 rows to 1 while
 * `stats_reset` stayed byte-identical. A scoped reset with a zero in the queryid slot therefore erases an entire
 * database's statement history with no witness, and the window that would have told you is unmoved. Nothing in the
 * view has a zero id (measured: 0 rows with `userid = 0 or dbid = 0 or queryid = 0 or is null`), so a zero here can
 * only come from a snapshot file that was edited, truncated, or written by a different tool - which is exactly when
 * a program should refuse rather than trust its own input.
 *
 * The other direction is subtler, because the function is `STRICT` (`proisstrict = true` on this build): a NULL
 * argument makes it return NULL and do *nothing*. The driver sends a missing id as NULL, the call succeeds, and a
 * counter that increments on a successful call would report rows removed that are all still there. So the ids are
 * validated on the way in, and the removal is confirmed on the way out.
 */
export function resetArguments(order, row, queryid) {
  const source = { userid: row.userid, dbid: row.dbid, queryid };
  const values = order.map((name) => {
    const raw = source[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      throw new Error(`refusing to reset: the ${name} of this row is missing, and a NULL argument to a STRICT function is a silent no-op`);
    }
    const text = String(raw).trim();
    if (!/^-?\d+$/.test(text)) {
      throw new Error(`refusing to reset: the ${name} of this row is not an integer (${JSON.stringify(text)})`);
    }
    if (BigInt(text) === 0n) {
      throw new Error(`refusing to reset: the ${name} of this row is 0, and 0 means every ${name} - measured on a scratch database as 31 rows to 1, with stats_reset unmoved`);
    }
    return text;
  });
  return values;
}

/**
 * The rows that are the same statement to a reader, and different rows to Postgres.
 *
 * The counterpart of the merge. A *column* in the target list is part of the hash; only its *alias* is not. So
 * adding one expression to a select list - which is what pi-ed `79b0202` did to the heartbeat sweep - creates a new
 * queryid and restarts the counter at 1, while the old generation keeps accumulating whatever else shares its shape.
 * The reader sees five rows whose first 70 characters are identical, and the change that caused it is in a different
 * repository's diff.
 *
 * Two keys are used, because a generation can move either side of the statement: the relation clause catches a
 * select-list change, and the leading text catches a `where`-clause change. A match on either is a candidate
 * sibling, not a verdict, and the report says which key fired.
 */
export function siblings(rows, statement) {
  const norm = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const clause = skeleton(statement);
  const head = norm(statement).slice(0, 40);
  const hits = [];
  for (const [queryid, row] of Object.entries(rows)) {
    const text = norm(row.query);
    const byClause = clause.length > 0 && skeleton(row.query) === clause;
    const byHead = head.length > 0 && text.startsWith(head);
    if (byClause || byHead) hits.push({ queryid, row, byClause, byHead });
  }
  return hits;
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
  if (!leftovers.length && names.length) {
    // "0 rows carry my name" is a claim about the protocol before it is a claim about cleanliness. home-ops measured
    // it: a `prepare` label reaches the stored text only under the simple protocol (node-pg `client.query(sql)` with
    // no values, `psql -c`), and an extended-protocol or Parse-preparing client - psycopg3, and anything that binds
    // parameters - never stores it. Their sweep prepares through named labels and the name search returned 0 rows
    // while 10 shared counters each grew by one of their calls.
    console.log(`  note: a name matching nothing is also what a name that was never stored looks like. Under the extended protocol a prepare label is not in the row text at all, so this line is not proof of cleanliness for a client that binds parameters.`);
  }
  for (const [queryid, row] of leftovers.slice(0, 10)) console.log(`    ${queryid}  ${row.query.slice(0, 100)}`);

  // The sibling report: the merge's counterpart. A statement the caller named may be spread over several rows,
  // because the target list is in the hash and only the alias is not, so a column added in another repository
  // re-baselines the counter with nothing in this repository's diff to warn about it.
  //
  // Two keys are reported as two signals rather than merged into one verdict, because dogfooding on this store
  // showed both of them lying in opposite directions. The relation clause catches a target-list change that
  // diverges in the first 40 characters (the heartbeat sweep's five generations, whose subquery is part of the
  // clause), but it also catches genuinely different statements that read the same relation. The leading text
  // catches those generations, and catches a `where`-clause change the clause key cannot, but it cannot tell a
  // re-baselined statement from a neighbour that happens to start the same way. Neither key is a statement
  // identity; the only thing that is certain is that the row count is not one.
  if (runStatements.length) {
    console.log(`  sibling shapes: ${runStatements.length} statement(s) asked about, reported as two signals`);
    for (const statement of runStatements) {
      const hits = siblings(after.byId, statement);
      const head = statement.replace(/\s+/g, " ").trim().slice(0, 60);
      const byClause = hits.filter((hit) => hit.byClause);
      const byHead = hits.filter((hit) => hit.byHead);
      console.log(`    ${head}`);
      console.log(`      ${byClause.length} row(s) share its relation clause; ${byHead.length} row(s) share its leading 40 characters`);
      for (const hit of [...hits].sort((a, b) => Number(b.row.calls) - Number(a.row.calls)).slice(0, 8)) {
        const key = hit.byClause && hit.byHead ? "clause+head" : hit.byClause ? "clause" : "head";
        console.log(`        ${hit.queryid}  calls=${hit.row.calls}  ${key}  ${hit.row.query.replace(/\s+/g, " ").slice(0, 88)}`);
      }
      if (hits.length > 1) {
        console.log(`      ${hits.length} rows in the group, ${hits.reduce((sum, hit) => sum + Number(hit.row.calls), 0)} calls summed across them`);
        console.log("      rows matched by clause alone may be different statements on the same relation; the group is a signal, not a verdict");
        console.log("      a baseline keyed on this view is per-generation, not per-statement: sum the rows or drop the count");
      }
    }
  }

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
      // Validated before it is sent, because the two ways a bad id can arrive fail in opposite directions: 0 means
      // "every query in that database" (measured: 31 rows to 1, stats_reset unmoved), and a missing id becomes NULL
      // in a STRICT function, which does nothing and returns success.
      const values = resetArguments(order, row, queryid);
      // The declared order, not the remembered one. A swapped userid/dbid is a silent no-op, which is why the
      // removal reports the order it used rather than just the count it removed.
      await client.query(`select pg_stat_statements_reset($1, $2, $3)`, values);
      removed += 1;
      calls += Number(row.calls);
    } catch (error) {
      failed += 1;
      console.error(`  remove refused for ${queryid}: ${error.message.split("\n")[0]}`);
    }
  }
  const afterRemove = await readSnapshot(client);
  const still = Object.entries(afterRemove.byId).filter(([, row]) => matchNames(row.query, names) && !isToolQuery(row.query));
  const windowNow = String(afterRemove.statsReset) === String(after.statsReset);
  // A call that succeeds is not a row that is gone. The re-read is the only thing that distinguishes the two, so
  // the count that gets printed is the one that was measured.
  const vanished = removable.filter(({ queryid }) => !afterRemove.byId[queryid]).length;
  console.log(`  reset argument order (from pg_proc.proargnames): ${order.join(", ")}`);
  console.log(`  called reset on ${removed} row(s) carrying ${calls} call(s); ${vanished} of them are gone from the view; ${still.length} leftover(s); stats_reset ${windowNow ? "unmoved" : "MOVED"}`);
  if (removed && vanished < removed) {
    console.log("  a reset that returns success without removing the row is a NULL argument in a STRICT function: the ids are validated on the way in, so this is the view disagreeing, not the call failing");
  }
  if (merged.length) console.log(`  refused ${merged.length} row(s) that predate this run - a merged counter is not the run's to delete`);
  await client.end();
  if (failed || still.length || !windowNow || vanished < removed) process.exit(1);
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

