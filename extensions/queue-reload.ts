import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  let reloadQueued = false;

  type ReloadContext = ExtensionContext & { waitForIdle(): Promise<void>; reload(): Promise<void> };
  const queue = async (ctx: ReloadContext): Promise<void> => {
      if (reloadQueued) {
        if (ctx.hasUI) ctx.ui.notify("A reload is already queued; it will run when Pi is idle.", "info");
        return;
      }

      reloadQueued = true;
      if (ctx.hasUI) ctx.ui.notify("Reload queued; waiting for Pi to become idle.", "info");

      try {
        await ctx.waitForIdle();
      } catch (error) {
        reloadQueued = false;
        const reason = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Queued reload cancelled: ${reason}`, "error");
        return;
      }

      if (ctx.hasUI) ctx.ui.notify("Pi is idle; reloading now.", "info");
      // Reload replaces this extension runtime; do not use its state after this call.
      await ctx.reload();
  };

  pi.registerCommand("queue-reload", {
    description: "Reload Pi automatically when the current run becomes idle",
    handler: async (_args, ctx) => { await queue(ctx); },
  });

  pi.registerTool({
    name: "queue_reload",
    label: "queue-reload",
    description: "Queue a Pi reload for when the current agent run becomes idle.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      await queue(ctx as unknown as ReloadContext);
      return { content: [{ type: "text", text: "Reload queued for idle." }], details: {} };
    },
  });
}
