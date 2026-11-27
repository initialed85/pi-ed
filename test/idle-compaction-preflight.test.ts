import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createContext, createFakePi, runCommand, type FakeContext, type FakePi, type FakeUi } from "./harness.ts";

/**
 * The box pre-flight: do not issue a summarisation into a fleet whose boxes are all at their slots.
 *
 * This file exists because of rooter's measurements on 2026-11-27, which moved the abort story off the deadline and
 * onto the box:
 *
 *   - placement. Cold summarisation-shaped prompts prefill at 2,512 / 2,481 / 2,486 tok/s on strata (46,857 /
 *     83,335 / 114,772 tokens) and 470 / 466 / 463 tok/s on sushi, decoding at 47-63 tok/s against sushi's 8.5.
 *     An 82.7k summarisation is therefore ~214 s on one box and ~45 s on the other.
 *   - queueing. Three cold prompts on one box held per-call prefill at ~2,475 tok/s while ttft went 18.9 -> 52.7 ->
 *     161.5 s, and rooter's `wait_ms` reported 0.000 throughout, because the queue forms after the proxy hands off.
 *     That is what pi-bot's three aborts at 45,455 / 55,077 / 76,954 tokens on provably idle sessions were: 45k
 *     costs ~132 s, but it consumed the whole 240 s waiting.
 *
 * `GET /rooter/backends` is the one signal a pi pod can read (803 bytes, 1-3 ms, the provider key it already holds),
 * and it is a go/no-go rather than a reservation. The claims worth asserting are therefore:
 *
 * 1. **A saturated fleet defers** and says so with the snapshot it saw, and does not claim the lease first.
 * 2. **Headroom starts the attempt**, and the attempt carries the snapshot so an abort can be judged against it.
 * 3. **The check fails open.** rooter being unreachable is not a reason to stop summarising.
 * 4. **A person asking now skips the read**, and a session on a non-rooter provider never makes the call at all.
 * 5. **Deferring is bounded**: boxes that stay full end in one skip with a reason, not a session parked forever.
 */

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/idle-compaction.ts");

const QUIET_MS = 120000;
const BOX_RETRY_MS = 15000;

let dirs: string[] = [];
let fetchCalls: Array<{ url: string; headers: Record<string, string> }>;
let fetchImpl: (url: string, init?: any) => Promise<any>;

interface Session {
  name: string;
  cwd: string;
  pi: FakePi;
  context: FakeContext;
  ui: FakeUi;
  compacts: Array<{ options: any }>;
}

function backends(rows: Array<Partial<{ name: string; busy: number; concurrency: number; healthy: boolean; slotsFree?: number }>>) {
  return {
    ok: true,
    json: async () =>
      rows.map((row) => ({
        name: row.name ?? "strata",
        busy: row.busy ?? 0,
        concurrency: row.concurrency ?? 4,
        healthy: row.healthy ?? true,
        ...(row.slotsFree !== undefined ? { slotsFree: row.slotsFree } : {}),
      })),
  };
}

async function pod(
  name: string,
  options: { provider?: string; baseUrl?: string | null; apiKey?: string | null; apiKeyResult?: any } = {},
): Promise<Session> {
  const parent = mkdtempSync(path.join(tmpdir(), "pi-ed-preflight-"));
  dirs.push(parent);
  const cwd = path.join(parent, name);
  mkdirSync(cwd, { recursive: true });
  const pi = createFakePi();
  const record = createContext({
    cwd,
    sessionId: `session-${name}`,
    idle: true,
    contextUsage: { percent: 60, tokens: 82700, contextWindow: 131072 },
    model: {
      provider: options.provider ?? "rooter",
      id: "auto",
      baseUrl: options.baseUrl === null ? undefined : options.baseUrl ?? "http://rooter.test:8089/v1",
      // `null` means the model carries no key, which is what a real pi model object looks like: the key comes from
      // the registry, and the production path is that one, not the field above.
      apiKey: options.apiKey === null ? undefined : options.apiKey ?? "k-test",
      maxTokens: 32000,
    },
    apiKeyResult: options.apiKeyResult,
  });
  const mod = await import(MODULE);
  (mod as { default: (api: unknown) => void }).default(pi as any);
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, record.context);
  return { name, cwd, pi, context: record.context, ui: record.ui, compacts: record.compacts };
}

function log(cwd: string): Array<Record<string, any>> {
  const file = path.join(cwd, ".pi", "idle-compaction", "log.jsonl");
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  } catch {
    return [];
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchCalls = [];
  // A rate high enough that the flat `deadlineMs` governs: these tests are about who issues, not about the ceiling.
  process.env.IDLE_COMPACTION_RATE_TOKENS_PER_SECOND = "100000";
  process.env.IDLE_COMPACTION_BOX_RETRY_MS = String(BOX_RETRY_MS);
  vi.stubGlobal("fetch", async (url: string, init?: any) => {
    fetchCalls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return fetchImpl(String(url), init);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.IDLE_COMPACTION_RATE_TOKENS_PER_SECOND;
  delete process.env.IDLE_COMPACTION_BOX_RETRY_MS;
  delete process.env.IDLE_COMPACTION_BOX_CHECK_MS;
  delete process.env.IDLE_COMPACTION_BOX_MAX_DEFERS;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("the box pre-flight", () => {
  it("defers a summarisation when every healthy box is at its slots, and does not take the lease to do it", async () => {
    fetchImpl = async () => backends([{ name: "strata", busy: 4, concurrency: 4 }, { name: "sushi", busy: 4, concurrency: 4 }]);
    const s = await pod("pi-bot");

    vi.advanceTimersByTime(QUIET_MS);
    // The read is a promise, so the decision lands on the microtask queue rather than inside the timer.
    await vi.advanceTimersByTimeAsync(0);

    expect(s.compacts).toHaveLength(0);
    const skip = log(s.cwd).find((entry) => entry.stage === "preflight");
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain("at its slots");
    expect(skip!.boxes).toEqual(["strata=4/4", "sushi=4/4"]);
    // The lease belongs to the fleet, and a session that is not going to summarise must not be holding it.
    expect(log(s.cwd).some((entry) => entry.kind === "gate" && entry.heldBy === undefined)).toBe(false);
    expect(fetchCalls[0]!.url).toBe("http://rooter.test:8089/rooter/backends");
    expect(fetchCalls[0]!.headers["x-api-key"]).toBe("k-test");
  });

  it("starts when a box has headroom, and puts the snapshot on the line that ran under it", async () => {
    fetchImpl = async () => backends([{ name: "strata", busy: 1, concurrency: 4 }, { name: "sushi", busy: 4, concurrency: 4 }]);
    const s = await pod("rooter");

    vi.advanceTimersByTime(QUIET_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(s.compacts).toHaveLength(1);
    const compact = log(s.cwd).find((entry) => entry.kind === "compact");
    expect(compact!.boxes).toEqual(["strata=1/4", "sushi=4/4"]);
    // The rate is pinned high in these tests, so the flat floor governs: what is being asserted is that a snapshot
    // with headroom produces an attempt, not what the ceiling scales to.
    expect(compact!.deadlineMs).toBe(240000);
  });

  it("retries a deferral on its own timer, and takes the first box that frees", async () => {
    let saturated = true;
    fetchImpl = async () =>
      saturated
        ? backends([{ name: "strata", busy: 4, concurrency: 4 }, { name: "sushi", busy: 4, concurrency: 4 }])
        : backends([{ name: "strata", busy: 0, concurrency: 4 }]);
    const s = await pod("macker");

    vi.advanceTimersByTime(QUIET_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.compacts).toHaveLength(0);

    saturated = false;
    await vi.advanceTimersByTimeAsync(BOX_RETRY_MS);
    expect(s.compacts).toHaveLength(1);
    expect(log(s.cwd).filter((entry) => entry.stage === "preflight" && entry.defer === 1)).toHaveLength(1);
  });

  it("believes the box over the arithmetic: `slotsFree` decides when rooter publishes it", async () => {
    // strata looks free at 2/4 by subtraction but says it has no slot; sushi says it has one while looking full.
    // The second is the case that matters, because a box that has restored a conversation is serviceable while its
    // slot counters still show it busy.
    fetchImpl = async () =>
      backends([
        { name: "strata", busy: 2, concurrency: 4, slotsFree: 0 },
        { name: "sushi", busy: 4, concurrency: 4, slotsFree: 1 },
      ]);
    const s = await pod("memebrary");

    vi.advanceTimersByTime(QUIET_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.compacts).toHaveLength(1);

    // And the reverse: every box looks like it has room by subtraction, and neither has any.
    fetchImpl = async () =>
      backends([
        { name: "strata", busy: 1, concurrency: 4, slotsFree: 0 },
        { name: "sushi", busy: 0, concurrency: 4, slotsFree: 0 },
      ]);
    const deferred = await pod("asteroids");
    vi.advanceTimersByTime(QUIET_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(deferred.compacts).toHaveLength(0);
    expect(log(deferred.cwd).find((entry) => entry.stage === "preflight")).toBeDefined();
  });

  it("gives up with a reason instead of parking a session behind boxes that stay full", async () => {
    process.env.IDLE_COMPACTION_BOX_MAX_DEFERS = "3";
    fetchImpl = async () => backends([{ name: "sushi", busy: 4, concurrency: 4 }]);
    const s = await pod("maclet");

    vi.advanceTimersByTime(QUIET_MS);
    for (let look = 0; look < 5; look += 1) await vi.advanceTimersByTimeAsync(BOX_RETRY_MS);

    expect(s.compacts).toHaveLength(0);
    const givenUp = log(s.cwd).find((entry) => typeof entry.reason === "string" && entry.reason.includes("gave up after"));
    expect(givenUp).toBeDefined();
    expect(givenUp!.reason).toContain("3 looks");
    expect(fetchCalls.length).toBeLessThanOrEqual(4);
  });

  it("fails open when rooter cannot answer, and says it once", async () => {
    fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const s = await pod("camry");

    vi.advanceTimersByTime(QUIET_MS);
    await vi.advanceTimersByTimeAsync(0);

    // An unreachable proxy is not a saturated one; the attempt runs and the deadline is what handles the rest.
    expect(s.compacts).toHaveLength(1);
    const announced = log(s.cwd).filter((entry) => typeof entry.reason === "string" && entry.reason.includes("running ungated"));
    expect(announced).toHaveLength(1);
    expect(announced[0]!.reason).toContain("ECONNREFUSED");
    expect(log(s.cwd).find((entry) => entry.kind === "compact")!.boxes).toBeUndefined();
  });

  it("resolves the key through the model registry, which is the shape a real pi model has", async () => {
    fetchImpl = async () => backends([{ name: "strata", busy: 0, concurrency: 4 }]);
    const s = await pod("pi-team-room", {
      apiKey: null,
      apiKeyResult: { ok: true, apiKey: "k-registry" },
    });

    vi.advanceTimersByTime(QUIET_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchCalls[0]!.headers["x-api-key"]).toBe("k-registry");
    expect(s.compacts).toHaveLength(1);
  });

  it("never asks a non-rooter provider, and never asks a person who asked now", async () => {
    fetchImpl = async () => backends([{ name: "strata", busy: 4, concurrency: 4 }]);
    const foreign = await pod("quake", { provider: "openrouter" });
    vi.advanceTimersByTime(QUIET_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(foreign.compacts).toHaveLength(1);
    expect(fetchCalls).toHaveLength(0);

    // A command is a person, and a person is not queued behind a read.
    const asked = await pod("home-ops");
    fetchCalls = [];
    await runCommand(asked.pi, "idle-compact", "run --force", asked.context);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toHaveLength(0);
    expect(asked.compacts.length).toBeGreaterThan(0);
  });

  it("stays silent about the boxes when the check is switched off", async () => {
    process.env.IDLE_COMPACTION_BOX_CHECK_MS = "0";
    fetchImpl = async () => backends([{ name: "strata", busy: 4, concurrency: 4 }]);
    const s = await pod("slopyphus");

    vi.advanceTimersByTime(QUIET_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchCalls).toHaveLength(0);
    expect(s.compacts).toHaveLength(1);
  });
});
