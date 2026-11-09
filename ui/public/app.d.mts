/// <reference lib="dom" />
/**
 * Types for the reading room's client, by hand.
 *
 * `ui/public/app.mjs` is a browser module: it is loaded by `<script type="module">` and is never emitted, so it is
 * not type-checked itself (the tsconfig checks extensions and tests, not the UI's client). This declaration exists so
 * the client test can import it and so a change to a helper's signature shows up as a type error in the test rather
 * than as a table that renders `[object HTMLTableRowElement]` on someone's screen.
 *
 * The DOM lib is referenced here rather than added to tsconfig: this project's `lib` is ES2022 plus @types/node, and
 * pulling the whole DOM lib into every file would collide with node's own fetch/Response declarations for no benefit.
 */

export type Child = string | number | Node | Array<Child> | null | undefined;

export declare function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number | null | undefined>,
  ...children: Child[]
): HTMLElementTagNameMap[K];

export declare function head(columns: string[]): HTMLTableSectionElement;
export declare function body(rows: Node[]): HTMLTableSectionElement;
export declare function chips(items?: string[] | null): HTMLDivElement;
export declare function kv(pairs: Array<[string, unknown]>): HTMLDivElement;
export declare function renderDetail(...nodes: Child[]): void;
export declare function truncate(text: unknown, max: number): string;

/** Wire the page's controls and fetch the first view. The page calls this; a test may call it too. */
export declare function boot(): void;
