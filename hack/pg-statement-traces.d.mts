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
