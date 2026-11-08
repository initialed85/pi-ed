import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every statement this extension exports has to be something Postgres accepts, and the way to check that without
 * writing rows is `PREPARE`.
 *
 * Why this file exists. In one bulk edit this file's subject introduced
 * `insert into memory.session (id, agent_id), repo, cwd, source, started_at, last_activity_at)` - a single stray
 * parenthesis inside a template literal. Three layers of defence each let it through, and the reasons are worth
 * recording because they are not obvious:
 *
 *   - TypeScript accepted it, because SQL in this codebase is a string and the compiler has no opinion about strings.
 *   - The unit suite accepted it, because the unit assertions compare SQL text to expected SQL text, and an expected
 *     string copied from the same buggy source agrees with the bug instead of catching it.
 *   - The LIVE suite accepted it, which is the uncomfortable one: a failed flush is deliberately caught, spooled to
 *     disk, and reported on the heartbeat, because a memory system must survive the store being unreachable. That is
 *     the right behaviour for the product and makes it a poor test harness - the statement on the main write path of
 *     every session this extension records was failing, and the suite stayed green.
 *
 * `PREPARE` closes that gap without executing anything. It parses the SQL, resolves every table and column name
 * against the real schema in the real database - which is also what makes schema qualification testable rather than
 * a matter of taste - and checks parameter numbers against the actual columns. It writes nothing.
 *
 * A parenthesis-balance check runs in the unit half of this file for the same reason CI has no live store: it is the
 * cheapest thing that would have caught the typo, and it is not a joke - SQL is mostly parentheses, and a statement
 * whose parentheses do not balance is a statement that cannot be right.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "extensions", "memory.ts");
const liveDsn = process.env.PI_LIVE_DSN ?? "";

type Statement = { sql: string; values: unknown[] };

/** The argument shapes the exported builders accept, tried in order until one produces a statement. */
const argShapes: unknown[][] = [
  [],
  ["agent-id", "repo"],
  ["agent-id"],
  ["agent-id", 12],
  ["agent-id", "a rolled-back flush", 3],
  [{ sessionId: "s1", agentId: "a", cwd: "/w", repo: "r", firstAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-01T00:00:00Z" }],
  [{ agentLike: "a%" }],
  ["how do I roll this back", "agent-id"],
  ["agent-id", [0.1, 0.2]],
];

async function loadModule(): Promise<Record<string, unknown>> {
  return (await import(source)) as Record<string, unknown>;
}

/**
 * Where this file's sweeps are allowed to write.
 *
 * Set before the source is imported for the first time, because the extension reads `PI_MEMORY_SPOOL` once, at module
 * load. Left unset, the sweep below writes to `~/.pi/agent/memory-spool.jsonl` - the real fallback queue of whoever is
 * running the tests - which is what happened on 2026-11-08: the file ended up with 1,014 lines of one-character JSON
 * strings, none of them a row, in place of whatever backlog had been there.
 */
const scratch = path.join(os.tmpdir(), `pi-ed-statements-prepare-${process.pid}`);
const scratchSpool = path.join(scratch, "spool.jsonl");
process.env.PI_MEMORY_SPOOL = scratchSpool;
process.env.PI_MEMORY_CONFIG = path.join(scratch, "memory.json");

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Not statement builders, and not safe to call with a fixture argument.
 *
 * `writeSpool` and `rewriteSpool` iterate their argument. Handed a string - which is what `argShapes[7]` is - a string
 * iterates one character at a time, and each character is a valid JSON value, so the call succeeds and appends
 * `"a"\n"g"\n"e"\n...` to the spool. Measured on the pre-fix source: `writeSpool("agent-id")` produced 8 junk lines and
 * `readSpool` replayed 0 rows. A sweep over every export wants the SQL factories, not the ones with a file handle.
 */
const NON_SQL_EXPORTS = new Set(["readSpool", "writeSpool", "rewriteSpool"]);

function collect(mod: Record<string, unknown>): Array<{ name: string; spec: Statement }> {
  const out: Array<{ name: string; spec: Statement }> = [];
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    if (NON_SQL_EXPORTS.has(name)) continue;
    if ((value as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") continue;
    for (const args of argShapes) {
      let result: unknown;
      try {
        result = (value as (...a: unknown[]) => unknown)(...args);
      } catch {
        continue;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        break;
      }
      const spec = result as Statement | undefined;
      if (spec && typeof spec.sql === "string" && Array.isArray(spec.values)) {
        out.push({ name, spec });
        break;
      }
    }
  }
  return out;
}

/**
 * Parens outside single-quoted literals. A statement whose parentheses do not balance cannot be executed, and this
 * check needs no database, no network and no permissions, which makes it the only guard in this file that CI runs.
 */
function parenBalance(sql: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inLiteral = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      // '' inside a literal is an escaped quote, not the end of one.
      if (inLiteral && sql[i + 1] === "'") {
        i += 1;
        continue;
      }
      inLiteral = !inLiteral;
      continue;
    }
    if (inLiteral) continue;
    if (ch === "(") open += 1;
    if (ch === ")") close += 1;
  }
  return { open, close };
}

function highestParam(sql: string): number {
  return [...sql.matchAll(/\$(\d+)/g)].reduce((max, m) => Math.max(max, Number(m[1])), 0);
}

describe("every exported statement", () => {
  it("has balanced parentheses and a parameter list that matches its values", async () => {
    const specs = collect(await loadModule());
    // The count is asserted so a builder that stops being callable with these shapes cannot quietly leave the set.
    expect(specs.length).toBeGreaterThanOrEqual(18);
    expect(specs.map((s) => s.name)).toContain("sessionStatement");

    const unbalanced = specs
      .map(({ name, spec }) => ({ name, ...parenBalance(spec.sql) }))
      .filter((row) => row.open !== row.close);
    expect(unbalanced).toEqual([]);

    const mismatched = specs
      .map(({ name, spec }) => ({ name, params: highestParam(spec.sql), values: spec.values.length }))
      .filter((row) => row.params !== row.values);
    expect(mismatched).toEqual([]);
  });

  it("leaves the spool it was handed alone", async () => {
    // A sweep that calls every export with fixture arguments is a sweep that can reach a file handle. Run the sweep,
    // then look at the file it would have written to.
    collect(await loadModule());
    // Built eagerly on purpose: the point of the assertion is the content, and "absent" and "empty" are the same claim.
    const written = existsSync(scratchSpool) ? readFileSync(scratchSpool, "utf8") : "";
    expect(written).toBe("");
  });
});

describe.skipIf(!liveDsn)("every exported statement, prepared against the real store", () => {
  let pg: typeof import("pg");
  let Client: new (dsn: string) => import("pg").Client;

  beforeAll(async () => {
    pg = await import("pg");
    Client = pg.Client;
  });

  it("is accepted by Postgres without executing anything", async () => {
    const specs = collect(await loadModule());
    const client = new Client(liveDsn);
    await client.connect();

    const rejected: Array<{ name: string; message: string }> = [];
    let prepared = 0;
    try {
      for (const { name, spec } of specs) {
        const label = `pi_ed_prepare_probe_${prepared}_${name.replace(/[^a-z0-9_]/gi, "")}`;
        try {
          await client.query(`prepare ${label} as ${spec.sql}`);
          await client.query(`deallocate ${label}`);
          prepared += 1;
        } catch (error) {
          rejected.push({ name, message: (error as Error).message.split("\n")[0] ?? String(error) });
          // Leave no half-prepared statement behind if one of them is rejected.
          try {
            await client.query(`deallocate ${label}`);
          } catch {
            // nothing to deallocate
          }
        }
      }
    } finally {
      await client.end();
    }

    // PREPARE resolves names against the real schema, so an unqualified table that happens to be reachable through
    // `search_path` today and a table that is not there at all produce the same class of failure here. Both halves of
    // the store's qualification contract - this extension's own writes and the readers it exports - are covered by the
    // same statement list.
    expect(rejected).toEqual([]);
    expect(prepared).toBeGreaterThanOrEqual(18);
  });
});
