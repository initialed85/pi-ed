/**
 * Types for the reading room's server, so its query builders are testable without a database or a listener.
 *
 * The script is the implementation; this file exists because the suite type-checks and a `.mjs` with no declaration is
 * an unresolved import. Keep the two in sync by reading the script, not this file.
 */

/** A statement about to be sent to a connection that is read-only at the session level. */
export interface QuerySpec {
  sql: string;
  values: unknown[];
}

/** Declared structurally rather than as pg's `Pool`, so this file does not depend on pg's typings. */
export interface ConnectedClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  release(): void;
}

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  connect(): Promise<ConnectedClient>;
  end(): Promise<void>;
}

/** The two methods `handle` calls on the response, and the two fields it reads off the request. */
export interface MinimalRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface MinimalResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}

/** The pair Traefik's forwardAuth copies onto the request, or null when nothing vouched for it. */
export function identity(headers: Record<string, string | string[] | undefined>): { email: string | null; user: string | null } | null;

/**
 * The builders. Every caller-supplied value is a `$n` placeholder and appears in `values` in the order the SQL names
 * it, because a value that can only be reached by position is a value that was not concatenated into the statement.
 */
export function memoriesQuery(filter: { agent?: unknown; match?: unknown; limit?: unknown; offset?: unknown }): QuerySpec;
export function eventsQuery(filter: { agent?: unknown; kind?: unknown; tool?: unknown; match?: unknown; limit?: unknown }): QuerySpec;
export function edgesQuery(filter: { agent?: unknown; kind?: unknown; memory?: unknown; event?: unknown; limit?: unknown }): QuerySpec;
/** `values` is [vector, agent-or-null, limit]: a vector is a bind parameter like any other value. */
export function vectorSearchQuery(input: { vector: number[]; agent?: unknown; limit?: unknown }): QuerySpec;

/** The three queries one memory's detail pane needs: the row, the events its span is made of, and its edges. */
export function memoryDetailQueries(id: string): { memory: QuerySpec; span: QuerySpec; edges: QuerySpec };

/** The lists the filters and the graph legend are built from, so the UI does not hard-code a vocabulary. */
export function facetQueries(): {
  agents: QuerySpec;
  edgeKinds: QuerySpec;
  eventKinds: QuerySpec;
  tools: QuerySpec;
  triggers: QuerySpec;
};

export const summaryQuery: QuerySpec;

/** Asks the embedder for a query vector. Rejects on an unreachable service or a dimension that is not 768 - the
 *  caller falls back to text search and says why, rather than searching a space the stored vectors are not in. */
export function embedQuery(text: string): Promise<number[]>;

export function handle(request: MinimalRequest, response: MinimalResponse): Promise<void>;

export const pool: Queryable;
/** The only directory the static handler may serve from. */
export const PUBLIC: string;
/** The ceiling every row limit is clamped to. Exported so the test asserts against the same number the server uses. */
export const MAX_ROWS: number;
