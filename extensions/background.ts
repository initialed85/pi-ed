/**
 * Background shell jobs: start a slow command, keep using Pi, and get a user-message wake-up when it exits.
 *
 * Jobs are deliberately session-local and durable under `.pi/background/<session-id>/`. The child is not part of the
 * prompt, so starting/completing jobs cannot churn the provider prefix cache. Completion output is capped before it is
 * persisted or injected into the next turn.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Type } from "typebox";
import { Text, Box } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = ".pi/background";
const MAX_OUTPUT = 12000;
const MAX_COMMAND = 4000;
type JobState = "running" | "succeeded" | "failed" | "cancelled";
type Job = { id: string; command: string; state: JobState; started_at: string; finished_at?: string; exit_code?: number | null; signal?: string; output?: string };
const children = new Map<string, ChildProcess>();
const WIDGET = "background-jobs";
let expanded = false;

function dir(cwd: string, sid: string) { return join(cwd, ROOT, sid); }
function file(cwd: string, sid: string, id: string) { return join(dir(cwd, sid), `${id}.json`); }
function save(cwd: string, sid: string, job: Job) { mkdirSync(dir(cwd, sid), { recursive: true }); writeFileSync(file(cwd, sid, job.id), `${JSON.stringify(job, null, 2)}\n`); }
function load(cwd: string, sid: string): Job[] {
  try { return readdirSync(dir(cwd, sid)).filter((x) => x.endsWith(".json")).map((x) => JSON.parse(readFileSync(join(dir(cwd, sid), x), "utf8")) as Job); }
  catch { return []; }
}
function sid(ctx: any): string { return ctx.sessionManager.getSessionId(); }
function wake(api: ExtensionAPI, job: Job) {
  const result = `Background job ${job.id} ${job.state}: ${job.command}\n${job.output || "(no output)"}`;
  api.sendUserMessage(`[background job complete]\n${result}`, { deliverAs: "followUp" });
}
function paint(ctx: any) {
  if (!ctx.hasUI) return;
  const jobs = load(ctx.cwd, sid(ctx));
  const compact = `Jobs · ${jobs.filter((j) => j.state === "running").length} running · ${jobs.length} total (shift+left)`;
  const lines = expanded
    ? (jobs.length ? jobs.map((j) => `${j.state === "succeeded" ? "✓" : j.state === "failed" ? "✗" : j.state === "running" ? "…" : "×"} ${j.id} · ${j.command}`) : ["No background jobs."])
    : [compact];
  if (ctx.mode !== "tui") { ctx.ui.setWidget(WIDGET, lines, { placement: "aboveEditor" }); return; }
  ctx.ui.setWidget(WIDGET, (tui: any, theme: any) => {
    const box = new Box(1, 0, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return { render: (width: number) => box.render(width), invalidate: () => tui.requestRender?.() };
  }, { placement: "aboveEditor" });
}

export default function activate(api: ExtensionAPI): void {
  api.registerShortcut("shift+left", { description: "Expand or collapse background jobs", handler: async (ctx) => { expanded = !expanded; paint(ctx); } });
  api.on("session_start", (_event, ctx) => paint(ctx));
  api.registerTool({
    name: "background",
    label: "background",
    description: "Start, inspect, or cancel a durable background shell job. Start returns immediately; completion wakes the session with capped output.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("cancel")]),
      command: Type.Optional(Type.String({ description: "Shell command for start" })),
      jobId: Type.Optional(Type.String({ description: "Job id for cancel" })),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
    async execute(_callId, params, _signal, _update, ctx) {
      const session = sid(ctx);
      if (params.action === "list") { const jobs = load(ctx.cwd, session); paint(ctx); return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }], details: { jobs } }; }
      if (params.action === "cancel") {
        const id = String(params.jobId ?? ""); const child = children.get(id);
        if (!child) return { content: [{ type: "text", text: `No running background job ${id}.` }], details: { error: "not running" } };
        child.kill("SIGTERM"); paint(ctx); return { content: [{ type: "text", text: `Cancellation requested for ${id}.` }], details: { id } };
      }
      const command = String(params.command ?? "").trim();
      if (!command) return { content: [{ type: "text", text: "background start needs a command." }], details: { error: "empty command" } };
      if (command.length > MAX_COMMAND) return { content: [{ type: "text", text: `Command is limited to ${MAX_COMMAND} characters.` }], details: { error: "command too long" } };
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const job: Job = { id, command, state: "running", started_at: new Date().toISOString() }; save(ctx.cwd, session, job); paint(ctx);
      const child = spawn("sh", ["-lc", command], { cwd: ctx.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.set(id, child);
      let output = ""; const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-MAX_OUTPUT); };
      child.stdout?.on("data", collect); child.stderr?.on("data", collect);
      child.on("close", (code, signal) => {
        children.delete(id); job.state = signal ? "cancelled" : code === 0 ? "succeeded" : "failed"; job.exit_code = code; job.signal = signal ?? undefined; job.finished_at = new Date().toISOString(); job.output = output; save(ctx.cwd, session, job); paint(ctx); wake(api, job);
      });
      child.unref();
      return { content: [{ type: "text", text: `Started background job ${id}. It will wake this session when complete.` }], details: { id, command } };
    },
  });

  api.registerCommand("jobs", { description: "List background jobs for this session", handler: async (_args, ctx) => { paint(ctx); if (ctx.hasUI) ctx.ui.notify(load(ctx.cwd, sid(ctx)).map((j) => `${j.id} ${j.state} ${j.command}`).join("\n") || "No background jobs.", "info"); } });
}
