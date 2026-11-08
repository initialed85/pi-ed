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
    // The worker count has to be a number, not `os.cpus()`. Woodpecker's kubernetes backend gives a step pod a cpu
    // quota of 1, but os.cpus() inside that pod reports the node's cores (beefcake has 4), so vitest sizes its pool
    // from a machine the step is not actually running on. Measured on a clean `npm ci` at node 22: vitest main 263 MB,
    // each fork 155 MB, the `npm run` wrapper chain 106 MB, helpers some tests spawn ~90 MB. Two workers is a known
    // ~700 MB peak, which is what the ci.yaml pod is sized for; leaving it to the host would make the peak depend on
    // whichever node the pipeline landed on. (vitest 5 flattened `poolOptions.forks.maxForks` into this top-level
    // field - writing the old name typechecks as an error, which is the only reason this was not shipped inert.)
    maxWorkers: 2,
    // Several of these tests drive a real Pi harness in a forked process, and a few wait on a real refused socket.
    // Under contention on this machine (measured: four suites at once) they failed at 10s and 15s limits, including
    // one that reported "expected 0 to be greater than 0" for a spool that simply had not arrived yet. A timeout
    // that fires because the machine is busy is a fabricated failure, and a fabricated failure trains everyone to
    // re-run until green. The budgets are generous; the assertions are not.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
