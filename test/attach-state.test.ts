import { spawnSync } from "node:child_process";
import { mkdtempSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The attach-state reader, run against a stub cluster.
 *
 * This script is the thing that gets run during an incident, when the pod is already in `ContainerCreating` and a
 * broken path is the worst possible failure - and it is entirely made of field paths, which is the class of bug that
 * prints nothing instead of failing. Five of those landed in one afternoon across two clusters (home-ops
 * `384862b`), including a runbook column named `CREATED` reading `status.startTimestamp`, a key that does not exist
 * on a Backup at all.
 *
 * So the test is not a screenshot of the output. It is a stub `kubectl` that answers with the shapes measured on
 * the real fleet, and it asserts three things: every embedded Python block parses (a shell single-quote closed by
 * an apostrophe in a comment is how this script actually broke on the day this file was written, and it produced a
 * traceback nobody would have seen until the incident), the answer half of the attachment objects is read from the
 * `status` fields that exist, and the backup list names the two ways a count can lie.
 */

const script = fileURLToPath(new URL("../hack/pi-ed-attach-state.sh", import.meta.url));

const volume = {
  kind: "Volume",
  metadata: { name: "pvc-stub-volume", labels: { "recurring-job.longhorn.io/backup-daily": "enabled" }, creationTimestamp: "2026-11-07T16:09:12Z" },
  spec: { nodeID: "k3s-bee-2", numberOfReplicas: 2 },
  status: {
    state: "attached",
    robustness: "healthy",
    currentImage: "docker.io/longhornio/longhorn-engine:v1.12.0",
    lastBackupAt: "2026-11-07T18:00:34Z",
    conditions: [{ type: "Scheduled", status: "True", lastTransitionTime: "2026-11-07T16:09:13Z" }],
  },
};

// One backup with the job label, one without. The second is the shape home-ops found in prod
// (`backup-e04d35e3ff0d4347`): Completed, a real `backupCreatedAt`, the right volume, and no
// `spec.labels.RecurringJob` anywhere - identified only by `metadata.labels`. A reading that attributes backups by
// the job label alone undercounts the ones the volume started.
const backups = {
  items: [
    {
      metadata: { name: "backup-with-job", labels: { "backup-volume": "pvc-stub-volume" } },
      spec: { labels: { RecurringJob: "backup-daily" }, volumeName: "does-not-exist-in-spec" },
      status: {
        volumeName: "pvc-stub-volume",
        state: "Completed",
        snapshotName: "backup-d-aaa",
        backupCreatedAt: "2026-11-07T18:00:37Z",
        size: "247463936",
        newlyUploadDataSize: "11626797",
        volumeSize: "5368709120",
      },
    },
    {
      metadata: { name: "backup-volume-started", labels: { "backup-volume": "pvc-stub-volume", "backup-target": "nfs-target" } },
      spec: {},
      status: { volumeName: "pvc-stub-volume", state: "Completed", backupCreatedAt: "2026-11-06T18:32:24Z" },
    },
  ],
};

const attachments = {
  items: [
    {
      metadata: { name: "pvc-stub-volume" },
      spec: { attachmentTickets: { "csi-aae4": { nodeID: "k3s-bee-2", type: "csi-attacher", lastAttachedBy: "" } } },
      status: {
        attachmentTicketStatuses: {
          "csi-aae4": { satisfied: true, nodeID: "absent-in-this-half", conditions: [{ type: "Satisfied", status: "True", lastTransitionTime: "2026-11-07T19:27:25Z" }] },
        },
      },
    },
  ],
};

function stubKubectl(dir: string): void {
  const path = `${dir}/kubectl`;
  writeFileSync(
    path,
    `#!/usr/bin/env bash
args="$*"
case "$args" in
  *jsonpath*) echo "pvc-stub-volume" ;;
  *"volume/pvc-stub-volume"*) printf '%s' '${JSON.stringify(volume)}' ;;
  *backup.longhorn.io*) printf '%s' '${JSON.stringify(backups)}' ;;
  *volumeattachments.longhorn.io*) printf '%s' '${JSON.stringify(attachments)}' ;;
  *"setting allow-recurring-job-while-volume-detached"*) printf '{"value":"false"}' ;;
  *get\\ pods*) echo "NAME   NODE   STATUS   RESTARTS   AGE" ;;
  *) printf '{"items":[]}' ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

function run(): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(`${tmpdir()}/attach-stub-`);
  stubKubectl(dir);
  const result = spawnSync("/bin/bash", [script], {
    encoding: "utf8",
    // The stub directory comes first, and the context is a name the stub answers regardless, so nothing here can
    // reach a real cluster.
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONTEXT: "stub-cluster", CTX: "stub-cluster" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the attach-state reader", () => {
  it("parses every embedded Python block, which is how it silently broke once", () => {
    // A Python comment containing an apostrophe inside a `python3 -c '...'` block closes the shell quote and
    // truncates the source. bash -n does not see it, the script exits 0 for the parts that ran, and the traceback
    // only appears on the machine that is reading the output.
    const { stdout, stderr, status } = run();
    expect(status, stderr).toBe(0);
    expect(stderr).not.toMatch(/SyntaxError|Traceback|unexpected EOF|error: /);
    expect(stdout).not.toMatch(/Traceback|SyntaxError/);
  });

  it("reads the volume from the fields that exist and prints a verdict, not a field dump", () => {
    const { stdout } = run();
    expect(stdout).toContain("state attached  robustness healthy  spec.nodeID 'k3s-bee-2'  replicas 2");
    expect(stdout).toContain("status.lastBackupAt: 2026-11-07T18:00:34Z");
    expect(stdout).toContain("verdict:");
  });

  it("says the answer half has no nodeID field, so a blank there is not a finding", () => {
    const { stdout } = run();
    expect(stdout).toContain("answer csi-aae4\u2026  asked of k3s-bee-2  satisfied True");
    expect(stdout).toContain("no nodeID field exists in this half");
  });

  it("names the backup that no job label can see, and counts the undercount", () => {
    const { stdout } = run();
    expect(stdout).toContain("Backup objects for this volume: 2 of 2 in the cluster");
    expect(stdout).toContain("job=backup-daily");
    expect(stdout).toContain("job=(volume-started, no RecurringJob label)");
    expect(stdout).toContain("1 of 2 carry no RecurringJob label: a job-attributed reading of this cluster undercounts them");
    // And an absent key is named rather than printed as a Python `None`, because the reader of this output is a
    // person standing in front of a pod that will not start.
    expect(stdout).toContain("snapshot=(none)  created=2026-11-06T18:32:24Z");
    expect(stdout).not.toMatch(/=None/);
  });

  it("reports the incremental upload against the backup payload, not the volume", () => {
    // 11,626,797 newly of 247,463,936 backup bytes is 4.7%; against the 5,368,709,120-byte volume it is 0.2%, and
    // the difference is the difference between "a single NAS is affordable" and a number that understates it 20x.
    const { stdout } = run();
    expect(stdout).toContain("uploaded 11626797 newly of 247463936 backup bytes (4.7%; volumeSize 5368709120)");
  });

  it("reads the recurring-job setting from the top-level value, because spec.value and status.value are both absent", () => {
    const { stdout } = run();
    expect(stdout).toContain("setting allow-recurring-job-while-volume-detached = 'false'");
  });
});
