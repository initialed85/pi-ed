/**
 * Shared cleanup for the live tests that leave statements in `pg_stat_statements`.
 *
 * The suite runs against a real store that other agents read, so a test that measures something has
 * to give the counters back. Three rules this encodes, each from a failure rather than from the
 * manual:
 *
 *  - **The argument order is whatever THIS build declares.** `pg_stat_statements_reset` takes
 *    `(dbid, userid, queryid)` in the documentation and `(userid, dbid, queryid)` in this build
 *    (`pg_proc.proargnames`). Calling it in the documented order is a silent no-op: no error, no
 *    change, nothing in the response says so. Measured on this store.
 *  - **Ids travel as text.** `queryid` is `bigint`, and this store's ids are around 1e19 - past
 *    2^53, the largest integer a JS number holds exactly. An id that passes through a number is a
 *    different id, the reset removes nothing, and the absence check aimed at that number reports
 *    success about an id that never existed (home-ops `0baf3ec`, measured here). Hence `queryid::text`
 *    on the way out and a string parameter on the way in.
 *  - **Only the rows the view labels with your run name are yours to remove.** Structure, not text,
 *    decides the counter: a probe whose shape already exists lands on somebody else's row and
 *    leaves no name-scoped trace. Resetting that row would erase another writer's history along with
 *    yours, so cleanup covers the rows carrying your name and reports the rest rather than deleting
 *    them.
 *  - **A name that appears only in a value is not a name.** The view normalises constants - an `insert`
 *    whose agent id was the literal `'heartbeat-probe-demo'` is stored as `values ($1, $2, ...)`, and
 *    `query like '%heartbeat-probe-demo%'` finds nothing. Name scopes are built from identifiers:
 *    relation names, aliases, prepared-statement labels.
 *  - **And an identifier is weaker than that list suggests.** It is in the row's *text* but not in its
 *    *hash*, so a name only ever finds the row that first saw the shape - `prepare X as Q` is keyed by
 *    `Q`, and the second writer to run `Q` is invisible to their own name and present in the first
 *    writer's counter. The relation is the only identifier that reliably creates a row, which is why
 *    live probes fence themselves with a private relation and the shared `hack/pg-statement-traces.mjs`
 *    reports a landing delta instead of trusting "leftovers 0".
 */
/**
 * The narrowest thing these helpers need: something that can run a query and hand rows back. Typed
 * structurally rather than as `pg.Client` so a test file that models its own client double - and a
 * future `hack/` script that uses a pooled client - can both pass it in.
 */
export interface StatementClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
}

/** The argument names this build declares, in declared order. */
export async function resetArgumentOrder(client: StatementClient): Promise<string[]> {
  const result = await client.query(`select proargnames from pg_proc where proname = 'pg_stat_statements_reset'`);
  const names = (result.rows[0]?.proargnames ?? []) as string[];
  if (!names.length) throw new Error("statements-cleanup: pg_stat_statements_reset was not found in pg_proc");
  return names;
}

/**
 * Removes one tracked statement. `row` must come from a `queryid::text, dbid, userid` select: text on
 * the way out, because a number is a different identity.
 */
export async function targetedReset(client: StatementClient, row: Record<string, unknown>, order: string[] = ["userid", "dbid", "queryid"]): Promise<void> {
  const placeholders = order.map((_, index) => `$${index + 1}`).join(", ");
  const values = order.map((name) => {
    if (name === "queryid" || name === "dbid" || name === "userid") return String(row[name]);
    throw new Error(`statements-cleanup: pg_stat_statements_reset has an argument this helper does not know: ${name}`);
  });
  await client.query(`select pg_stat_statements_reset(${placeholders})`, values);
}

/**
 * Removes every tracked statement whose stored text carries `pattern`, and returns how many rows and
 * how many calls that was. `merged` counts nothing: it is the number of rows found, which is by
 * construction the number the view was willing to attribute to this run's name.
 */
export async function cleanStatementTraces(
  client: StatementClient,
  pattern: string,
): Promise<{ rows: number; calls: number; leftovers: number }> {
  const order = await resetArgumentOrder(client);
  const found = await client.query(
    `select queryid::text as queryid, dbid::text as dbid, userid::text as userid, calls from pg_stat_statements where query like $1`,
    [pattern],
  );
  let calls = 0;
  for (const row of found.rows) {
    calls += Number(row.calls);
    await targetedReset(client, row, order);
  }
  const leftovers = await client.query(`select count(*)::int as n from pg_stat_statements where query like $1`, [pattern]);
  return { rows: found.rowCount ?? 0, calls, leftovers: leftovers.rows[0].n };
}
