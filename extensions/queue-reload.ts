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
 *
 * **A queued reload lands at a settle boundary, and the gap can be enormous.** Pi delivers queued input only when a
 * run settles, so a reload asked for inside a long-running turn does not fire until that turn ends. Measured in the
 * field: slopyphus typed `/queue-reload` at 2026-11-26T21:39:38Z and Pi reloaded at 21:55:23Z - 15 m 45 s later -
 * because their turn ran continuously the whole time. The tool path inherits the same property: it asks on the next
 * settle, and if the agent is mid-turn that settle is however far away the work is. In the common case that calls for
 * it (`pi update --extensions` from bash inside a long turn), tens of minutes between the update and the reload is
 * Pi behaving correctly, not a dispatch that failed.
 *
 * **What proves it in this fleet's logs.** Builds up to `403cae1` wrote no `session_shutdown` line anywhere - the
 * marker this file used to point at existed only in a probe's own output, and slopyphus checked all three reload-
 * armed sessions on their pod and found none. From this commit `idle-compaction.ts` records
 * `kind:"session-shutdown"` with its `reason`, so a reload is visible at the end of the old session as well as at
 * the start of the new one. Until every pod is running that build, the observable is the pair slopyphus captured on
 * 2026-11-27: a `kind:"prune-report"` at the new session start followed by `kind:"compact" trigger:"session_start:
 * reload"`, with no reload command typed in between (22:03:35Z and 22:05:42Z, nothing typed since 21:39:38Z).
 * Elapsed time since the ask proves nothing either way.
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
