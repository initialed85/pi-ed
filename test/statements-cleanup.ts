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
 *  - **A name is not a novelty fence, and the marker is only visible under one protocol.** home-ops measured
 *    both halves. A comment, an alias and a label are all outside the hash, so a marker-carrying probe whose
 *    shape already exists lands on a row somebody else created first: their marker search returned 0 rows
 *    while 10 shared counters each grew by one of their calls. The construction that makes a shape novel is
 *    a private wrapper, `select * from (<statement>) as <run_token>`. And a `prepare` label reaches the stored
 *    text only under the *simple* protocol (`client.query(sql)` with no values, `psql -c`); an
 *    extended-protocol or Parse-preparing client never stores it, so "0 rows carry my label" is a claim
 *    about the protocol, not about cleanliness.
 *  - **`like` is not a substring test.** `_` is a single-character wildcard and every probe name here is
 *    full of them; `select count%from memory%` matches 14 rows carrying 395 calls that neither repo named.
 *    Read markers with `position($1 in query) > 0`, and reset only what the before-snapshot says you created.
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
 *
 * The three ids are refused before they are sent, and the two reasons point in opposite directions. The function is
 * declared `userid oid DEFAULT 0, dbid oid DEFAULT 0, queryid bigint DEFAULT 0` and **0 means all**: home-ops
 * measured `reset(0, 17680, 0)` on a scratch database taking 31 rows to 1 with `stats_reset` byte-identical, so a
 * zero is an entire database's history erased with no witness. It is also `STRICT` (`proisstrict = true` on this
 * build), so a NULL argument returns success and removes nothing - which is why a missing key is an error here
 * rather than something the driver gets to turn into NULL.
 */
export async function targetedReset(client: StatementClient, row: Record<string, unknown>, order: string[] = ["userid", "dbid", "queryid"]): Promise<void> {
  const placeholders = order.map((_, index) => `$${index + 1}`).join(", ");
  const values = order.map((name) => {
    if (name !== "queryid" && name !== "dbid" && name !== "userid") {
      throw new Error(`statements-cleanup: pg_stat_statements_reset has an argument this helper does not know: ${name}`);
    }
    const raw = row[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      throw new Error(`statements-cleanup: refusing to reset, the ${name} of this row is missing (a NULL argument to a STRICT function is a silent no-op)`);
    }
    const text = String(raw).trim();
    if (!/^-?\d+$/.test(text)) {
      throw new Error(`statements-cleanup: refusing to reset, the ${name} of this row is not an integer: ${JSON.stringify(text)}`);
    }
    if (BigInt(text) === 0n) {
      throw new Error(`statements-cleanup: refusing to reset, the ${name} of this row is 0 and 0 means every ${name} (measured as 31 rows to 1, stats_reset unmoved)`);
    }
    return text;
  });
  await client.query(`select pg_stat_statements_reset(${placeholders})`, values);
}

/**
 * The ids present in the view right now. Cheap (a few hundred rows) and it is the only thing that turns a cleanup
 * into a *gated* one: a row whose id is absent from this set was created by the invocation that takes the snapshot,
 * and a row whose id is in it predates the run and belongs to whoever saw the shape first.
 */
export async function snapshotQueryIds(client: StatementClient): Promise<Set<string>> {
  const result = await client.query(`select queryid::text as queryid from pg_stat_statements`);
  return new Set(result.rows.map((row) => String(row.queryid)));
}

/**
 * Rows whose stored text carries `marker`, read with `position($1 in query) > 0` and never with `like`.
 *
 * The change is not cosmetic. `LIKE` treats `_` as a single-character wildcard, and every probe name in this repo is
 * full of underscores: `%heartbeat-probe%` is narrow only by luck, and `%pi_ed_probe_1%` also matches
 * `piXedprobeY1`. Patterns shaped like statements are worse still - home-ops measured
 * `select count%from memory%` on this store against **14 rows carrying 395 accumulated calls** that neither repo
 * named, and a caller that passed such a pattern would reset all of them.
 */
export async function findStatementTraces(
  client: StatementClient,
  marker: string,
): Promise<Array<{ queryid: string; dbid: string; userid: string; calls: number; query: string }>> {
  const found = await client.query(
    `select queryid::text as queryid, dbid::text as dbid, userid::text as userid, calls, query
       from pg_stat_statements where position($1 in query) > 0`,
    [marker],
  );
  return found.rows.map((row) => ({
    queryid: String(row.queryid),
    dbid: String(row.dbid),
    userid: String(row.userid),
    calls: Number(row.calls),
    query: String(row.query),
  }));
}

/**
 * Collects the litter of a run that never reached its cleanup.
 *
 * The gate makes a run refuse rows that predate it, which is right for other people's counters and wrong for mine: a
 * cancelled test leaves its probes in the view forever, because the next run sees them as predating itself. This is
 * the one reset that runs without a before-snapshot, and it is legitimate for a specific reason - a row whose stored
 * text carries my marker was created by a submission that carried my marker, because the text is the first statement
 * that ever saw the shape. Had my submission merged into an older row, the older row would name somebody else's
 * statement and this would find nothing.
 *
 * The corollary is a namespace rule, not a technical one: the marker must be a name only this file writes. Passing a
 * broad prefix here deletes a peer's history on the same reasoning, which is why the fleet's markers are
 * `stat_probe`/`probe_*` here, `sweep_probe`/`zz_homeops` there, and never a shared word like `pi_ed`.
 */
export async function preCleanOwnLitter(
  client: StatementClient,
  marker: string,
  extraMarkers: string[] = [],
): Promise<{ rows: number; calls: number }> {
  const order = await resetArgumentOrder(client);
  const found = await findStatementTraces(client, marker).then(async (rows) => {
    const rest = await Promise.all(extraMarkers.map((m) => findStatementTraces(client, m)));
    return [...rows, ...rest.flat()];
  });
  let calls = 0;
  for (const row of found) {
    calls += row.calls;
    await targetedReset(client, row, order);
  }
  return { rows: found.length, calls };
}

/**
 * Removes the tracked statements this invocation created, and refuses the rest.
 *
 * `before` is the gate. Without it the function does nothing at all: an ungated name-scoped cleanup is a different
 * tool from the one `hack/pg-statement-traces.mjs` permits, and keeping both was the second answer to one question.
 * A row that carries the marker but predates the run is somebody else's counter that this run's shape merged into -
 * resetting it erases their history to remove one call of ours.
 */
export async function cleanStatementTraces(
  client: StatementClient,
  marker: string,
  before?: Set<string>,
): Promise<{ rows: number; calls: number; refused: number; leftovers: number }> {
  const found = await findStatementTraces(client, marker);
  if (!before) {
    const calls = found.reduce((sum, row) => sum + row.calls, 0);
    throw new Error(
      `statements-cleanup: refusing an ungated cleanup of ${JSON.stringify(marker)}. ` +
        `It matches ${found.length} row(s) carrying ${calls} call(s), and without a before-snapshot nothing distinguishes ` +
        `a row this run created from a row it merged into. Take snapshotQueryIds() before the run and pass it here.`,
    );
  }
  const order = await resetArgumentOrder(client);
  let calls = 0;
  let removed = 0;
  let refused = 0;
  for (const row of found) {
    if (before.has(row.queryid)) {
      refused += 1;
      continue;
    }
    calls += row.calls;
    await targetedReset(client, row, order);
    removed += 1;
  }
  // Count what is *left* by the same substring test, and do not let the counting query speak for itself: the read
  // excludes rows whose text is a pg_stat_statements reader, which is the shape of this very query.
  const leftovers = await client.query(
    `select count(*)::int as n from pg_stat_statements
       where position($1 in query) > 0 and query not like '%from pg_stat_statements%'`,
    [marker],
  );
  return { rows: removed, calls, refused, leftovers: leftovers.rows[0]?.n ?? 0 };
}
