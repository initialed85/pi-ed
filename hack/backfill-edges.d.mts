/**
 * Types for the edge backfill, so the derivation it runs can be asserted rather than re-typed by the test that checks
 * it.
 *
 * The script is the implementation; this file exists because the suite type-checks and a `.mjs` with no declaration is
 * an unresolved import. Keep the two in sync by reading the script, not this file.
 */

/** A minimal stand-in for a pg client, declared rather than imported so this file does not depend on pg's typings. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/**
 * One derivation per kind. `select` is the whole rule, in the column order `memory.edge` needs; the room derivation
 * emits four kinds from one statement, which is why `kind` is `room` rather than the four names and why
 * `kindExpressionFor` exists.
 */
export interface Derivation {
  kind: "memory_about" | "dreamed_from" | "shares_subject" | "room" | "wakes";
  note: string;
  select: string;
}

export const DERIVATIONS: Derivation[];

/** The kind a derivation writes, in the form the table's CHECK accepts. */
export function kindExpressionFor(derivation: Derivation): string;

/** Runs one derivation through the shipped insert path and returns how many rows landed. */
export function insertDerivation(client: Queryable, derivation: Derivation): Promise<number | null>;

/** The CLI: derives and reports with `--check`, writes with `--apply`, and reads `PI_MEMORY_DSN`. */
export function run(): Promise<void>;
