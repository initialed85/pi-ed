import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let reloadQueued = false;

  pi.registerCommand("queue-reload", {
    description: "Reload Pi automatically when the current run becomes idle",
    handler: async (_args, ctx) => {
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
    },
  });
}
