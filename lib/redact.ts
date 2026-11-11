/**
 * Credential redaction, shared by every extension that puts agent-produced text somewhere durable.
 *
 * This used to live inside `extensions/memory.ts` (then parked), which was the only writer that needed it. It no longer is: cognee
 * takes free text from an agent, embeds it, and hands it to an LLM for entity extraction before storing it, so the
 * scrub has to happen before the request leaves the process rather than in whatever the store does on the way in.
 * Keeping two copies of a rule list is how the two copies drift, so there is now one, outside `extensions/` because
 * Pi discovers every `.ts` file in that directory and a helper is not an extension.
 *
 * These are credential *shapes*, not a secret manager. The point is that a DSN pasted into a transcript to debug
 * something, or a token echoed by a tool result, does not become a durable searchable fact in a graph that other
 * agents query. Each rule is named so the replacement text says which one fired rather than silently eating text.
 */

const CREDENTIAL_SHAPES: { name: string; pattern: RegExp }[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: "key-value", pattern: /\b(password|passwd|secret|api[_ -]?key|access[_ -]?token|client[_ -]?secret|token)\b["']?\s*[:=]\s*["']?[^\s"',;]{6,}/gi },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi },
  { name: "aws-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Measured, not guessed: on 2026-11-11 a probe note containing `sk-probe-<24 zeros>` was written to Graphiti by
  // hack/graphiti-live-check.mjs and came back as a retrievable fact. Every other shape here was already covered;
  // the OpenAI-compatible `sk-` family — the shape this fleet's own keys actually take — was the one that was not.
  // It is deliberately broad (`sk-ant-`, `sk-or-`, `sk-proj-`) because the cost of a false positive is a word
  // mangled in a memory note, and the cost of a miss is a live key sitting in a graph every pod in home-dev reads.
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { name: "dsn", pattern: /\bpostgres(ql)?:\/\/[^\s"'@]*:[^\s"']+@[^\s"']+/gi },
];

export type Redaction = { text: string; hits: string[] };

export function redact(input: string, extraPatterns: string[] = []): Redaction {
  let text = input;
  const hits: string[] = [];
  for (const rule of CREDENTIAL_SHAPES) {
    // One RegExp instance per rule, with lastIndex reset between the test and the replace: a /g pattern left
    // mid-scan is how a redaction pass starts missing matches.
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      hits.push(rule.name);
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, `[redacted:${rule.name}]`);
    }
  }
  for (const source of extraPatterns) {
    try {
      const pattern = new RegExp(source, "gi");
      if (pattern.test(text)) {
        hits.push(source);
        text = text.replace(new RegExp(source, "gi"), "[redacted:custom]");
      }
    } catch {
      // A bad pattern is skipped rather than crashing a write path that exists to be forgiving.
    }
  }
  return { text, hits };
}

/**
 * Scrub a value the extension is about to show or store, with the caller's own secret in the rule list.
 *
 * `redact` catches credential *shapes*. It cannot recognise a credential that is just 64 hex characters with no
 * label on it, which is exactly what a Cognee API key looks like. Anything the extension echoes back from an
 * upstream error body therefore gets one more pass with the live key as a literal pattern: the guarantee "the key
 * appears in no log line and no error message" should not depend on nobody ever pasting it into a response.
 */
export function scrub(value: string, secrets: string[]): { text: string; hits: string[] } {
  const literals = secrets.filter((secret) => secret.length >= 8);
  const extra = literals.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return redact(value, extra);
}
