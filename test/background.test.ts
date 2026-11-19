import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, createFakePi, type FakePi } from "./harness.ts";

const MODULE = path.resolve("extensions/background.ts");
const SID = "01a1b2c3-4d5e-6f70-8a9b-0c1d2e3f4a5b";
let dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; });

async function setup() {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-ed-background-")); dirs.push(cwd);
  const pi = createFakePi(); const { context, ui } = createContext({ cwd, sessionId: SID, hasUI: true });
  const mod = await import(MODULE); (mod as { default: (api: unknown) => void }).default(pi as any);
  return { pi, context, ui, cwd };
}

async function waitFor<T>(read: () => T | undefined, timeout = 3000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = read(); if (value !== undefined) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("timed out waiting for background job");
}

describe("background jobs", () => {
  it("returns immediately, persists completion, and wakes the same session", async () => {
    const { pi, context, cwd } = await setup();
    const tool = pi.tools.get("background")!; const execute = tool.execute!;
    const started = Date.now();
    const result = await execute("call-1", { action: "start", command: "printf 'migration complete'" }, undefined, undefined, context as any);
    expect(Date.now() - started).toBeLessThan(500);
    const id = (result.details as { id: string }).id;
    const job = await waitFor(() => {
      const files = (() => { try { return readdirSync(path.join(cwd, ".pi/background", SID)); } catch { return []; } })();
      const file = files.find((name: string) => name === `${id}.json`); if (!file) return undefined; const job = JSON.parse(readFileSync(path.join(cwd, ".pi/background", SID, file), "utf8")); return job.state === "running" ? undefined : job;
    });
    expect(job.state).toBe("succeeded"); expect(job.output).toContain("migration complete");
    await waitFor(() => pi.sentUserMessages.find((message) => String((message as { content?: unknown }).content).includes("Background job")));
  });

  it("lists jobs and rejects an empty command without spawning", async () => {
    const { pi, context } = await setup(); const tool = pi.tools.get("background")!; const execute = tool.execute!;
    const empty = await execute("call-1", { action: "start", command: "   " }, undefined, undefined, context as any);
    expect(empty.details).toMatchObject({ error: "empty command" });
    const listed = await execute("call-2", { action: "list" }, undefined, undefined, context as any);
    expect(listed.details).toEqual({ jobs: [] });
  });
});
