/**
 * Checks the two things that decide whether this repository is loadable by Pi at all, and which fail
 * silently rather than loudly:
 *
 * 1. `package.json` must carry a `pi.extensions` field pointing at one directory holding the extensions. Pi discovers a subdirectory package through exactly that field
 *    (docs/extensions.md, "Extension discovery"); without it the install succeeds and loads nothing, and
 *    the only symptom is that the extensions appear to be broken.
 *
 * 2. The packages Pi hands to extensions must not be bundled. A physical copy of `pi-coding-agent` under
 *    node_modules reaches the extension as a second module root, which means duplicate class registries
 *    and two copies of every global (docs/packages.md, "Declare dependencies"). Pi reports it as an
 *    extension warning, so it is easy to miss; here it is an error.
 *
 * Exit code is the verdict: 0 is fine, 1 is not.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * The extensions Pi should find after an install, pinned by name. A count would pass when a file
 * disappears and another appears; these names fail when either happens. test/packaging.test.ts holds
 * the same list next to each file's registered surface, so the two agree by being read together.
 */
const EXPECTED_EXTENSIONS = [
  "auto-resume.ts",
  "autopilot.ts",
  "compaction-summary-guard.ts",
  "loop-guard.ts",
  "queue-reload.ts",
  "schedule.ts",
  "searxng.ts",
  "session-commands.ts",
  "session-markers.ts",
  "tags.ts",
  "turn-stats.ts",
];
const HOST_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`FATAL ${message}`);
};

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

// 1. The discovery manifest.
const dirs = pkg.pi?.extensions;
if (!Array.isArray(dirs) || dirs.length !== 1) {
  fail(`package.json pi.extensions must list exactly one directory, got ${JSON.stringify(dirs)}`);
} else {
  const dir = dirs[0].replace(/^\.\//, "");
  const files = readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".ts")).sort();
  console.log(`${dir}: ${files.join(" ")}`);
  const missing = EXPECTED_EXTENSIONS.filter((name) => !files.includes(name));
  const extra = files.filter((name) => !EXPECTED_EXTENSIONS.includes(name));
  if (missing.length || extra.length) {
    fail(`expected ${EXPECTED_EXTENSIONS.join(", ")} in ${dir}, missing ${missing.join(", ") || "nothing"}, unexpected ${extra.join(", ") || "nothing"}`);
  }
}

// 2. Host packages are peers, never dependencies.
const dependencies = Object.keys(pkg.dependencies ?? {});
const peers = Object.keys(pkg.peerDependencies ?? {});
const bundled = HOST_PACKAGES.filter((name) => dependencies.includes(name));
if (bundled.length) fail(`host packages must not be in dependencies: ${bundled.join(", ")}`);
const missingPeers = HOST_PACKAGES.filter((name) => !peers.includes(name));
if (missingPeers.length) fail(`host packages not declared as peerDependencies: ${missingPeers.join(", ")}`);

// The test suite imports them too, and a fresh clone has to be able to resolve them for tsc and vitest.
const devDeps = Object.keys(pkg.devDependencies ?? {});
const unresolvable = HOST_PACKAGES.filter((name) => !devDeps.includes(name));
if (unresolvable.length) fail(`host packages missing from devDependencies, so a clone cannot typecheck: ${unresolvable.join(", ")}`);

if (!failed) console.log(`ok: ${EXPECTED_EXTENSIONS} extensions discovered through pi.extensions, host packages are peers`);
process.exit(failed ? 1 : 0);
