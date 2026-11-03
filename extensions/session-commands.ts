import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_PROMPT = `Continue the unfinished task in this session from the latest verified state. Do not simply repeat the previous answer or retry a cancelled/failed action unchanged. Identify what remains, choose a materially different next step when the last attempt failed, and either finish the task or state the specific blocker.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("continue", {
    description: "Continue the unfinished task from the current session",
    handler: async (args, ctx) => {
      const extraDirection = args.trim();
      const prompt = extraDirection
        ? `${CONTINUE_PROMPT}\n\nAdditional direction: ${extraDirection}`
        : CONTINUE_PROMPT;

      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        if (ctx.hasUI) ctx.ui.notify("Continuation queued behind the current run.", "info");
      }
    },
  });

  pi.registerCommand("clear", {
    description: "Start a fresh named session while preserving this session for later resume",
    handler: async (_args, ctx) => {
      const sessionName = ctx.sessionManager.getSessionName() ?? pi.getSessionName();
      const parentSession = ctx.sessionManager.getSessionFile();
      if (ctx.hasUI) ctx.ui.notify("Starting a fresh session; the current session will remain available to resume.", "info");

      await ctx.newSession({
        ...(parentSession ? { parentSession } : {}),
        ...(sessionName ? {
          setup: async (sessionManager) => {
            sessionManager.appendSessionInfo(sessionName);
          },
        } : {}),
        withSession: async (freshContext) => {
          if (freshContext.hasUI) freshContext.ui.notify("Fresh session started.", "info");
        },
      });
    },
  });
}
