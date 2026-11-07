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
print("  spec.nodeID %s  status.robustness %s  numberOfReplicas %s" % (spec.get("nodeID"), status.get("robustness"), spec.get("numberOfReplicas")))
print("  engine image %s  created %s" % (status.get("currentImage"), o["metadata"].get("creationTimestamp")))
for c in status.get("conditions", []) or []:
    print("  %s=%s since %s %s" % (c.get("type"), c.get("status"), c.get("lastTransitionTime", ""), c.get("message", "")))
' || echo "  (no volume object)"
echo

echo "== mount and attach events in ${NS} (the part kubelet hides behind exit status 32) =="
kubectl --context "$CTX" -n "$NS" get events --sort-by=.lastTimestamp 2>/dev/null | grep -iE "mount|attach|volume" | tail -8 || echo "  (no mount or attach events in the last window)"
