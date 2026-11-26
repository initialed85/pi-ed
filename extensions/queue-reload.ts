/**
 * Queue a Pi reload for when the current agent run becomes idle.
 *
 * Two halves, because Pi hands the two entry points different contexts: a command handler gets
 * `ExtensionCommandContext` (it carries `waitForIdle()` and `reload()`), a tool `execute()` gets
 * `ExtensionToolContext` (it carries neither), and Pi cannot reload while an agent is streaming anyway. So the tool
 * records the request and `agent_settled` dispatches this extension's own command, which does have the methods -
 * the shape Pi documents in docs/extensions.md ("ctx.reload()") and `examples/extensions/reload-runtime.ts`.
 *
 * Measured, not inferred. On 2026-11-27 a scratch session loaded this file with `pi --mode rpc -e /tmp/qr/probe.ts`,
 * the model called `queue_reload`, and the probe's own log came back:
 *
 *   load 21:11:13Z / session_start reason=startup / agent_settled
 *   session_shutdown reason=reload / load 21:11:17Z / session_start reason=reload
 *
 * The reload fired 4.4 s after the settle and a new extension runtime loaded. The version before this one cast its
 * context to the command context (`ctx as unknown as ReloadContext`), threw `ctx.waitForIdle is not a function` on
 * the first call, and still returned "Reload queued for idle." - which is how pi-bot and slopyphus spent hours
 * waiting for reloads that had already died (slopyphus' tmux capture, 2026-11-26T20:43:39Z).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  /**
   * Both flags describe one runtime, which is the right scope: a reload replaces the runtime, so the instance that
   * comes back starts with both clear and a queued reload cannot fire twice.
   */
  let waitingForIdle = false; // a command handler is inside waitForIdle() right now
  let requestedByTool = false; // a tool asked for a reload; the next settle runs the command

  const reloadWhenIdle = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (waitingForIdle) {
      if (ctx.hasUI) ctx.ui.notify("A reload is already queued; it will run when Pi is idle.", "info");
      return;
    }

    waitingForIdle = true;
    if (ctx.hasUI) ctx.ui.notify("Reload queued; waiting for Pi to become idle.", "info");

    try {
      await ctx.waitForIdle();
    } catch (error) {
      waitingForIdle = false;
      const reason = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Queued reload cancelled: ${reason}`, "error");
      return;
    }

    if (ctx.hasUI) ctx.ui.notify("Pi is idle; reloading now.", "info");
    try {
      // Reload replaces this extension runtime; do not use its state after this call.
      await ctx.reload();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Reload failed: ${reason}`, "error");
    }
  };

  pi.registerCommand("queue-reload", {
    description: "Reload Pi automatically when the current run becomes idle",
    handler: async (_args, ctx) => {
      await reloadWhenIdle(ctx);
      return;
    },
  });

  pi.registerTool({
    name: "queue_reload",
    label: "queue-reload",
    description:
      "Queue a Pi reload for when the current agent run becomes idle. Reloads extensions, skills, prompts, " +
      "themes and context files - use it after `pi update --extensions`. The reload cannot happen while the " +
      "run is streaming, so it fires once the run settles.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate) => {
      const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

      // Deliberately no `terminate: true`, which Pi's example sets: the point of queueing is to reload *after*
      // this turn's work, and ending the run early would throw that work away.
      if (waitingForIdle) return say("A reload is already queued by /queue-reload; it fires when Pi becomes idle.");
      if (requestedByTool) return say("A reload is already requested; it fires when this run settles.");

      requestedByTool = true;
      return say("Reload queued. Pi reloads its extensions when this run settles.");
    },
  });

  pi.on("agent_settled", () => {
    if (!requestedByTool) return;
    requestedByTool = false;
    // `expandPromptTemplates` is what dispatches the text as a command instead of handing it to the model as a
    // prompt. Sent from a settled handler, so the command runs after every settled handler finishes, while Pi is
    // idle, where waitForIdle() and reload() exist.
    pi.sendUserMessage("/queue-reload", { expandPromptTemplates: true });
  });
}
