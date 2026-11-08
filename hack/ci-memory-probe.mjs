#!/usr/bin/env node
/**
 * The CI step reading its own memory ceiling out of the cgroup.
 *
 * Why this exists as a script rather than a line in ci.yaml: pi-ed's pipelines failed four times with exit 134 and
 * `Ineffective mark-compacts near heap limit`, which from a badge is indistinguishable from a broken test. The cause
 * was a memory limit set by Woodpecker's kubernetes backend (512 Mi) meeting a vitest worker pool sized from
 * os.cpus(), which reports the host node's cores rather than the pod's quota. Diagnosing that needed three numbers
 * that nothing in CI was printing: the cgroup limit, the heap cap Node actually settled on, and how many cores the
 * container *thinks* it has versus how many it is allowed to use.
 *
 * It is also a guard: if a future change asks for a bigger pod and the backend ignores the request, this prints the
 * lie instead of someone inferring it from a crash.
 */
import { readFileSync } from "node:fs";
import { cpus, availableParallelism } from "node:os";
import { getHeapStatistics } from "node:v8";

function cgroupLimit() {
  const paths = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"];
  for (const path of paths) {
    let raw;
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (raw === "max") return { path, unlimited: true, mi: null };
    const value = Number(raw);
    // cgroup v1 reports "no limit" as a huge sentinel rather than a string.
    if (!Number.isFinite(value) || value > 1 << 60) return { path, unlimited: true, mi: null };
    return { path, unlimited: false, mi: Math.round(value / 1048576) };
  }
  return { path: null, unlimited: true, mi: null };
}

const limit = cgroupLimit();
const heap = Math.round(getHeapStatistics().heap_size_limit / 1048576);
const nodeOptions = process.env.NODE_OPTIONS ?? "(unset)";

// `availableParallelism()` is cgroup-aware on modern Node; `cpus().length` is not. The gap between them is the whole
// reason a test runner in a limited pod oversubscribes itself.
const reported = cpus().length;
const allowed = availableParallelism();

console.log(`cgroup memory limit ${limit.path ?? "unknown"} = ${limit.unlimited ? "unlimited" : `${limit.mi}Mi`}`);
console.log(`node heap cap ${heap}MB (NODE_OPTIONS ${nodeOptions})`);
console.log(`cores os.cpus() ${reported} vs availableParallelism() ${allowed}`);

if (!limit.unlimited && heap > limit.mi) {
  console.log(`note: the heap cap exceeds the pod's memory, so an allocation failure arrives as OOM rather than as a V8 message about the cgroup`);
}
if (reported > allowed) {
  console.log(`note: os.cpus() overstates this container. Anything that sizes a worker pool from it will oversubscribe the pod.`);
}
