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
    testTimeout: 15000,
  },
});
