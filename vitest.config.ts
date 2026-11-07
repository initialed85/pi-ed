import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The extensions are singletons with module-level state (loop-guard's history, autopilot's arm
    // flags). Tests get a fresh copy by re-importing after vi.resetModules(), which only works if
    // vitest does not reuse the module graph across files.
    isolate: true,
    pool: "forks",
    // Several of these tests drive a real Pi harness in a forked process, and a few wait on a real refused socket.
    // Under contention on this machine (measured: four suites at once) they failed at 10s and 15s limits, including
    // one that reported "expected 0 to be greater than 0" for a spool that simply had not arrived yet. A timeout
    // that fires because the machine is busy is a fabricated failure, and a fabricated failure trains everyone to
    // re-run until green. The budgets are generous; the assertions are not.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
