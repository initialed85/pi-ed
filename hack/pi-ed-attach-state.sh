#!/usr/bin/env bash
# Read-only capture of what a volume attachment actually says, for the one thing this store can be blocked on:
# a restarted `pi-ed-postgres` pod sitting in `ContainerCreating` while a Longhorn volume will not stage
# (`MountVolume.MountDevice failed … mount failed: exit status 32`).
#
# It exists in two halves on purpose, because the two halves are easy to read as one object and the mistake is
# silent. In `volumeattachments.longhorn.io`:
#
#   spec.attachmentTickets.<id>.nodeID                                the REQUEST - who is being asked to mount it
#   status.attachmentTicketStatuses.<id>.satisfied                    the ANSWER - whether that mount happened
#   status.attachmentTicketStatuses.<id>.conditions[].lastTransitionTime  when the answer last changed
#
# `nodeID` does NOT exist in the status half. Reading it there succeeds and prints nothing, which a shell turns
# into "attached to no node, but satisfied" on a perfectly healthy volume - a wrong answer that points at a
# node-side fix nobody needed. home-ops found that bug in their own runbook (home-ops `51e4a4`); it is the same
# class as querying a Deployment's name where a Service resolves.
#
# Run this BEFORE reaching for any lever. Force-detaching, restarting `longhorn-csi-plugin` or an
# instance-manager destroys the evidence, and those are Ed's calls in any case.
#
# Two more things it prints, because both have been misread in the field:
#
#   - a detached volume's `robustness: unknown` and empty `spec.nodeID` are the ORDINARY reading of a volume that is
#     simply not attached, not a fault (home-ops `19599d1`). The verdict line says which case it is looking at.
#   - recurring backup coverage, read off the volume's `status.lastBackupAt`. With
#     `allow-recurring-job-while-volume-detached: false` (measured on this cluster), a volume that is detached at the
#     cron minute is skipped with no Backup object and no error, so "no failed backups" and "never attempted" are
#     byte-for-byte the same output.
#
# The rule all of the above is an instance of, and the reason this script reads `-o json` and asks the object for
# its keys instead of guessing paths: an empty string from a jsonpath is a fact about the PATH, not the cluster.
# Five instances in one afternoon across two clusters, every one of them silent and every one of them looking like
# a finding - `nodeID` read in the status half; `robustness: unknown` on a volume that is simply detached; absent
# `spec.value` and `status.value` on the recurring-job Setting (the value is top-level `.value`); absent
# `spec.volumeName` on a Backup (it is `status.volumeName`); and a runbook column literally named `CREATED` reading
# `status.startTimestamp`, a key that does not exist on a Backup at all, which printed `<none>` for every object
# since the day it was written (home-ops `384862b`). Before trusting a new path, read it on an object whose value
# you already know independently, or list the keys once.
#
#   ./hack/pi-ed-attach-state.sh
#   PVC=pi-ed-postgres NAMESPACE=pi-ed ./hack/pi-ed-attach-state.sh
#
# The stuck shape has never been recorded in these fields - finding 17's stranded staging was diagnosed from
# kubelet events and plugin logs - so if a stuck attach ever happens for real, this script's whole purpose is to
# be run at that moment, before anything is touched.

set -euo pipefail

CTX="${KUBECONTEXT:-home-dev}"
NS="${NAMESPACE:-pi-ed}"
LHNS="${LONGHORN_NAMESPACE:-longhorn-system}"
PVC="${PVC:-pi-ed-postgres}"

pv="$(kubectl --context "$CTX" -n "$NS" get pvc "$PVC" -o jsonpath='{.spec.volumeName}')"
if [ -z "$pv" ]; then
  echo "no PersistentVolume bound to ${NS}/${PVC}; nothing to read" >&2
  exit 1
fi

echo "pvc ${NS}/${PVC} -> pv ${pv}"
echo

echo "== pod holding it =="
kubectl --context "$CTX" -n "$NS" get pods -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp' 2>/dev/null | grep -E "NAME|${PVC}" || echo "  (no pod for this pvc in ${NS})"
echo

echo "== kubernetes volumeattachment (who asked, and whether the driver says it attached) =="
kubectl --context "$CTX" get volumeattachment -o json | python3 -c '
import json, sys
pv = sys.argv[1]
items = [i for i in json.load(sys.stdin)["items"] if i.get("spec", {}).get("source", {}).get("persistentVolumeName") == pv]
if not items:
    print("  no volumeattachment object for this volume - nothing is currently asking for it")
for a in items:
    spec = a.get("spec", {})
    status = a.get("status", {})
    print("  attacher %s  node %s  attached %s  created %s" % (
        spec.get("attacher"), spec.get("nodeName"), status.get("attached"), a["metadata"].get("creationTimestamp")))
' "$pv"
echo

echo "== longhorn volumeattachment: request half (spec.attachmentTickets) =="
kubectl --context "$CTX" -n "$LHNS" get volumeattachments.longhorn.io -o json | python3 -c '
import json, sys
name = sys.argv[1]
items = [i for i in json.load(sys.stdin)["items"] if i["metadata"]["name"] == name]
if not items:
    print("  no longhorn volumeattachment object - Longhorn has not been asked to attach this volume")
for o in items:
    tickets = o.get("spec", {}).get("attachmentTickets", {}) or {}
    print(f"  {len(tickets)} ticket(s)")
    for tid, t in tickets.items():
        p = t.get("parameters", {}) or {}
        print("  request %s…  nodeID %s  type %s  lastAttachedBy %r" % (
            tid[:18], t.get("nodeID"), t.get("type"), p.get("lastAttachedBy", "")))
' "$pv"
echo

echo "== longhorn volumeattachment: answer half (status.attachmentTicketStatuses) =="
kubectl --context "$CTX" -n "$LHNS" get volumeattachments.longhorn.io -o json | python3 -c '
import json, sys
name = sys.argv[1]
for o in [i for i in json.load(sys.stdin)["items"] if i["metadata"]["name"] == name]:
    statuses = o.get("status", {}).get("attachmentTicketStatuses", {}) or {}
    tickets = o.get("spec", {}).get("attachmentTickets", {}) or {}
    print(f"  {len(statuses)} answer(s) for {len(tickets)} request(s)")
    for tid, st in statuses.items():
        asked = tickets.get(tid, {}).get("nodeID", "<no ticket>")
        print("  answer %s…  asked of %s  satisfied %s" % (tid[:18], asked, st.get("satisfied")))
        for c in st.get("conditions", []) or []:
            print("    %s=%s since %s %s" % (c.get("type"), c.get("status"), c.get("lastTransitionTime", ""), c.get("message", "")))
    unanswered = [tid for tid in tickets if tid not in statuses]
    if unanswered:
        print("  %d request(s) with NO answer entry - this is the shape to look at first" % len(unanswered))
    # Recorded so that nobody re-derives it: nodeID is not a field here.
    print("  (no nodeID field exists in this half; a nodeID read from here printing nothing is not a finding)")
' "$pv"
echo

echo "== longhorn volume =="
kubectl --context "$CTX" -n "$LHNS" get "volume/$pv" -o json 2>/dev/null | python3 -c '
import json, sys
o = json.load(sys.stdin)
if not o.get("kind"):
    print("  (no volume object)")
    raise SystemExit
spec, status = o.get("spec", {}), o.get("status", {})
conds = {c.get("type"): c.get("status") for c in status.get("conditions", []) or []}
state = status.get("state")
blockers = [t for t, v in conds.items() if str(v).lower() == "true" and t in ("WaitForBackingImage", "TooManySnapshots", "Restore", "OfflineRebuilding")]
print("  state %s  robustness %s  spec.nodeID %r  replicas %s" % (state, status.get("robustness"), spec.get("nodeID"), spec.get("numberOfReplicas")))
print("  engine image %s  created %s" % (status.get("currentImage"), o["metadata"].get("creationTimestamp")))
for c in status.get("conditions", []) or []:
    print("  %s=%s since %s %s" % (c.get("type"), c.get("status"), c.get("lastTransitionTime", ""), c.get("message", "")))
# Recorded so that nobody reads an ordinary detached volume as a fault. `robustness: unknown` with an empty
# `spec.nodeID` is what Longhorn reports for a volume that is simply not attached - a dump scratch volume between
# CronJob runs, for instance (home-ops `19599d1`, and the same class as reading `nodeID` from the answer half).
# The fields that separate "detached" from "stuck" are `status.state: detached` together with `Scheduled=True` and
# every blocker condition False.
if state == "detached" and not blockers:
    print("  verdict: detached and nothing is blocking it. This is NOT a stuck mount and NOT a fault -")
    print("           `robustness: unknown` and an empty nodeID are the ordinary reading of a detached volume.")
    print("           Do not restart the plugin, force-detach, or delete anything on the strength of this output.")
elif state == "detached" and blockers:
    print("  verdict: detached AND blocked (%s) - this is the shape to investigate." % ", ".join(blockers))
elif blockers:
    print("  verdict: attached with a blocking condition (%s) - capture the events below before touching anything." % ", ".join(blockers))
else:
    print("  verdict: attached and no condition is blocking it. If the pod is still in ContainerCreating, the")
    print("           answer is in the kubelet events and the csi-plugin logs, not in these fields.")
' || echo "  (no volume object)"
echo

echo "== recurring backup coverage of this volume =="
# The mechanism, measured on this cluster (home-ops `19599d1`, corroborated here): the setting
# `allow-recurring-job-while-volume-detached` is `false`, so a recurring backup fires only if the volume is attached
# at the cron minute, and a skip leaves NO Backup object and NO error. "No failed backups" is therefore byte-for-byte
# the output of "nothing was attempted", and coverage cannot be inferred from the absence of errors. Only the
# volume's own `status.lastBackupAt` is coverage. A job's `executionCount` is per object lifetime, and its
# `status.history` CANNOT answer "did it run every night" at any retention: the settings
# `recurring-successful-jobs-history-limit` and `recurring-failed-jobs-history-limit` are both `1`, and home-ops
# measured that in dev and prod alike, so a job object physically holds one success and one failure of evidence and
# no more. A skip leaves no object either, so coverage is per-volume `lastBackupAt` plus attach state at the cron
# minute, or nothing.
kubectl --context "$CTX" -n "$LHNS" get "volume/$pv" -o json 2>/dev/null | python3 -c '
import json, subprocess, sys
o = json.load(sys.stdin)
labels = {k.split("/")[-1]: v for k, v in (o["metadata"]["labels"].items() if o.get("metadata") else []) if "recurring" in k}
status = o.get("status", {})
state = status.get("state")
last = status.get("lastBackupAt") or "(never)"
print("  volume recurring labels: %s" % (json.dumps(labels) if labels else "(none)"))
print("  status.lastBackupAt: %s   (the only per-volume coverage there is)" % last)
print("  state at the moment of reading: %s" % state)
if state == "detached":
    print("  note: while detached, a recurring backup on this volume is SKIPPED silently with this cluster setting")
    print("        (see the setting line below). A scratch volume that only attaches for a few minutes is never")
    print("        covered by a schedule, and nothing in the cluster will say so.")
setting = subprocess.run(["kubectl", "--context", sys.argv[1], "-n", sys.argv[2], "get", "setting",
                          "allow-recurring-job-while-volume-detached", "-o", "json"],
                         capture_output=True, text=True)
try:
    value = json.loads(setting.stdout).get("value")
    # The value is top-level `.value` on this CRD; `spec.value` and `status.value` are both absent, and reading
    # either of those prints nothing and looks like "unset".
    print("  setting allow-recurring-job-while-volume-detached = %r" % value)
except Exception:
    print("  setting allow-recurring-job-while-volume-detached: could not read (%s)" % setting.stderr.strip().splitlines()[-1:])
backups = subprocess.run(["kubectl", "--context", sys.argv[1], "-n", sys.argv[2], "get", "backup.longhorn.io", "-o", "json"],
                         capture_output=True, text=True)
try:
    items = json.loads(backups.stdout).get("items", [])
    # The volume name is in the ANSWER half (`status.volumeName`); `spec.volumeName` does not exist. This is the
    # same request/answer asymmetry as the attachment tickets.
    mine = [i for i in items if (i.get("status") or {}).get("volumeName") == o["metadata"]["name"]]
    print("  Backup objects for this volume: %d of %d in the cluster" % (len(mine), len(items)))
    # Attribution has two halves, and the spec half alone loses real backups. home-ops found prod
    # `backup-e04d35e3ff0d4347`: Completed, a real `backupCreatedAt`, this volume, and no
    # `spec.labels.RecurringJob` at all - it is identified only by `metadata.labels`. A count that reads the job
    # label therefore undercounts backups the volume itself started, and a bare `job=None` on the line invites the
    # same misreading. The absent case gets named, and the number of them gets printed.
    unattributed = [i for i in mine if not ((i.get("spec") or {}).get("labels") or {}).get("RecurringJob")]
    for i in mine:
        job = (i.get("spec", {}).get("labels") or {}).get("RecurringJob") or "(volume-started, no RecurringJob label)"
        status = i.get("status") or {}
        # The incremental evidence, which is the whole argument for a single NAS being affordable. The denominator
        # matters: `size` is the backup payload itself and `volumeSize` is the volume, so reading the ratio against
        # `volumeSize` understates it by 20x (this volume: 11,626,797 newly of 247,463,936 backup bytes = 4.7%, of
        # 5,368,709,120 volume = 0.2%). And a Backup has no `status.startTimestamp` - that key does not exist on the
        # object at all - so `created` below reads `backupCreatedAt`, the key that is actually there.
        size, newly = status.get("size"), status.get("newlyUploadDataSize")
        incremental = ""
        if size and newly is not None:
            try:
                pct = 100.0 * int(newly) / int(size)
                incremental = "  uploaded %s newly of %s backup bytes (%.1f%%; volumeSize %s)" % (newly, size, pct, status.get("volumeSize"))
            except (TypeError, ValueError):
                pass
        print("    %s  job=%s  state=%s  snapshot=%s  created=%s%s" % (
            i["metadata"]["name"], job, status.get("state") or "(no state)",
            status.get("snapshotName") or "(none)", status.get("backupCreatedAt") or "(no backupCreatedAt)", incremental))
    if unattributed:
        print("    %d of %d carry no RecurringJob label: a job-attributed reading of this cluster undercounts them"
              % (len(unattributed), len(mine)))
    if not mine:
        print("    (none, and a silent skip also produces none - do not read this list as \"no failures\")")
except Exception:
    print("  could not list Backup objects")
' "$CTX" "$LHNS" || echo "  (no volume object to describe)"
echo

echo "== mount and attach events in ${NS} (the part kubelet hides behind exit status 32) =="
kubectl --context "$CTX" -n "$NS" get events --sort-by=.lastTimestamp 2>/dev/null | grep -iE "mount|attach|volume" | tail -8 || echo "  (no mount or attach events in the last window)"
