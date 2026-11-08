/**
 * The generation-grouping contract, validated offline against a committed snapshot.
 *
 * This file exists because home-ops measured that their sibling report over-grouped, concluded that
 * "identity-normalised matching (aliases and qualification stripped, i.e. what the hash does) recovers the seven",
 * and shipped it. That claim is the one thing the trade-off forbids, and the proof is a fixture rather than an
 * argument: `test/fixtures/home-ops-baseline-2026-11-08.json` is their own 370-row whole-store snapshot, committed
 * in their `13aef71` and copied here verbatim (grepped for `password`/`secret`/`token`/`dsn`/`user:pass@host` and
 * for host literals: 0 matches in each). No database is needed to read it, which is the point - a report change
 * that can only be validated against a live store gets validated by writing into someone's counters.
 *
 * The "seven" are the seven generations of the heartbeat insert that home-ops listed: 214 accumulated calls across
 * seven `queryid`s, split because a column was added to the target list. They are seven BECAUSE they are
 * structurally different, and the hash is that structure, so normalising toward the hash walks toward the split,
 * not toward the family.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { siblings, skeleton } from "../hack/pg-statement-traces.mjs";

type SnapshotRow = { calls: number; dbid: string; userid: string; query: string };
type Snapshot = { takenAt: string; statsReset: string; max: number; byId: Record<string, SnapshotRow> };

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/home-ops-baseline-2026-11-08.json", import.meta.url)), "utf8"),
) as Snapshot;

/** The seven generations home-ops named in `13aef71`, with the total they reported. */
const SEVEN = [
  "-1145287545449884560",
  "-2652082790079830672",
  "6074742072938485486",
  "-1469800367307607456",
  "4866678333865794175",
  "-5708253160502215209",
  "3585119699517569627",
];
const seven = new Set(SEVEN);
const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The probe is a real member of the family, not an invented statement - an invented one measures the wrong thing. */
const PROBE_ID = "-1145287545449884560";
const probe = fixture.byId[PROBE_ID].query;

/**
 * The keys, from strictest to loosest. Each is a function from stored text to a grouping value; two rows are in one
 * group when the values are equal.
 */
const keys: Record<string, (text: string) => string> = {
  "exact text (what the hash sees)": (t) => norm(t),
  "aliases + qualification stripped": (t) =>
    norm(t).replace(/\bas\s+[a-z_][a-z0-9_]*\b/g, "").replace(/\b(memory|public)\./g, ""),
  "  + column list stripped": (t) =>
    norm(t).replace(/\bas\s+[a-z_][a-z0-9_]*\b/g, "").replace(/\b(memory|public)\./g, "").replace(/\(([^()]*)\)/, "(<cols>)"),
  "  + values list stripped": (t) =>
    norm(t).replace(/\bas\s+[a-z_][a-z0-9_]*\b/g, "").replace(/\b(memory|public)\./g, "").replace(/\(([^()]*)\)/g, "(<list>)"),
  "table name only": (t) => (norm(t).includes("writer_heartbeat") ? "TABLE" : "OTHER"),
};

const group = (fn: (text: string) => string) => {
  const target = fn(probe);
  return new Set(Object.entries(fixture.byId).filter(([, row]) => fn(row.query) === target).map(([id]) => id));
};
const score = (ids: Set<string>) => ({
  recovered: [...ids].filter((id) => seven.has(id)).length,
  false: [...ids].filter((id) => !seven.has(id)).length,
  total: ids.size,
});

describe("generation grouping, replayed against a committed snapshot", () => {
  it("loads the fixture and finds the family it claims to contain", () => {
    expect(Object.keys(fixture.byId)).toHaveLength(370);
    expect(fixture.statsReset).toBe("2026-11-07 19:27:33.116214+00");
    expect(fixture.max).toBe(5000);
    // Every generation is present, and the total they reported is the total here.
    for (const id of SEVEN) expect(fixture.byId[id]).toBeDefined();
    expect(SEVEN.reduce((sum, id) => sum + fixture.byId[id].calls, 0)).toBe(214);
  });

  it("no identity-normalised key recovers the family, because the hash is the split", () => {
    // This is the correction to home-ops' `13aef71` conclusion. Their claim was that signature matching recovers
    // the seven; every key that stays faithful to the statement's identity recovers exactly ONE, and the reason is
    // not a defect in the normalisation - the seven are seven because they differ structurally.
    for (const [name, fn] of Object.entries(keys)) {
      if (name === "table name only") continue;
      const got = score(group(fn));
      expect(got.recovered, `${name} must not recover the family`).toBe(1);
      expect(got.false, `${name} must be precise`).toBe(0);
    }
  });

  it("only a key that discards the statement recovers all seven, and it is 57/64 wrong", () => {
    const got = score(group(keys["table name only"]!));
    expect(got.recovered).toBe(7);
    // 57 false positives against 64 rows that merely mention the table: the family is recovered by asserting
    // nothing about the statement. This is the far end of the curve, and it is why the tiers are reported.
    expect(got.false).toBe(57);
    expect(got.total).toBe(64);
  });

  it("the two heuristic keys disagree, in opposite directions, exactly as measured", () => {
    const hits = siblings(fixture.byId, probe);
    const asSet = (filter: (hit: (typeof hits)[number]) => boolean) => new Set(hits.filter(filter).map((hit) => hit.queryid));
    const clause = score(asSet((hit) => hit.byClause));
    const head = score(asSet((hit) => hit.byHead));
    const union = score(asSet(() => true));
    // The relation clause is too narrow: it recovers the one generation that shares the clause, and nothing else.
    expect(clause.recovered).toBe(1);
    expect(clause.false).toBe(0);
    // The leading text is too wide: it recovers five of the seven and drags 13 neighbours with it.
    expect(head.recovered).toBe(5);
    expect(head.false).toBe(13);
    // The union cannot be read as a verdict: it is neither the family nor the identity.
    expect(union.recovered).toBe(5);
    expect(union.total).toBe(18);
  });

  it("reports membership as a tier, so a reader can tell the row it is from the rows it resembles", () => {
    // The useful half of home-ops' finding, adopted: label `exact` separately from the two candidate keys. Without
    // it, a report of "18 rows" reads as though the statement has 18 identities.
    const hits = siblings(fixture.byId, probe);
    const exact = hits.filter((hit) => hit.exact);
    expect(exact).toHaveLength(1);
    expect(exact[0]!.queryid).toBe(PROBE_ID);
    // The candidates are still candidates, and the exact row is not counted as one of them being wrong.
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.some((hit) => hit.exact && hit.byClause && hit.byHead)).toBe(true);
  });

  it("the clause key is the relation clause, and it survives an alias change", () => {
    // Skeleton is the clause from the first relation keyword onward. The target list is where aliases live, and
    // aliases are outside the hash, so two statements that differ only by alias must share a clause.
    expect(skeleton(`select 1 as pi_ed_alpha from writer_heartbeat where agent_id = $1`)).toBe(
      skeleton(`select 2 as pi_ed_beta from writer_heartbeat where agent_id = $1`),
    );
    expect(skeleton(`select 1 as pi_ed_gamma from writer_heartbeat`)).not.toBe(
      skeleton(`select 1 as pi_ed_gamma from memory.writer_heartbeat`),
    );
  });
});
