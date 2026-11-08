/**
 * Types for the shared statement-trace tool, so the safety logic is testable without a database.
 *
 * The script itself is the implementation; this file exists because the test suite type-checks and a `.mjs` with no
 * declaration is an unresolved import. Keep the two in sync by reading the script, not this file.
 */

export interface ParsedArgs {
  mode: string | undefined;
  /** What the run is called by: a private relation, a prepared-statement label, a marker. */
  names: string[];
  /** What the run actually executed, used to grade a shared row as a likely merged landing. */
  statements: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs;
/** Statements this tool emits about the view, which must not be counted as a run's landings. */
export function isToolQuery(text: string): boolean;
/** The relation clause of a statement: the part that is inside the queryid hash. */
export function skeleton(text: string): string;
/** The first of the run's names that appears in a row's stored text. */
export function matchNames(text: string, names: string[]): string | undefined;
export interface SiblingHit {
  queryid: string;
  row: { calls: number; dbid: string; userid: string; query: string };
  byClause: boolean;
  byHead: boolean;
}
/** Rows that are the same statement to a reader and different rows to Postgres. */
export function siblings(rows: Record<string, { calls: number; dbid: string; userid: string; query: string }>, statement: string): SiblingHit[];
export interface ResetRow {
  userid?: string | number | null;
  dbid?: string | number | null;
  query?: string;
  calls?: number;
}
/** The three reset arguments in declared order, or a refusal that names the reason. */
export function resetArguments(order: string[], row: ResetRow, queryid: string): string[];
