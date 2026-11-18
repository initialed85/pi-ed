#!/usr/bin/env bash
# Ask a real model what it is about to do, given a real plan, and see which line it names.
#
# Why this exists: `/direction` shipped looking correct in the fake UI - the block was rendered, the section was set,
# every assertion about the bytes was satisfied. What nobody had measured was whether a model *uses* the line. The
# first run of this script answered that against the 2026-11-18 build: with a direction and two open steps present,
# the model said the first open step decided its next action and never mentioned the direction. A bare
# `DIRECTION acquire paperclips` reads as a caption; `[ ] t1 file the forms` reads as assigned work. That is the
# ordering the block now states out loud (see `pointer()` in lib/plan.ts), and this script is how to check it again
# after a wording change - because wording is exactly the kind of thing that looks fine and does nothing.
#
# Each mode seeds a scratch checkout through the substrate itself (`writePlan`), so the file on disk is byte-honest,
# then runs one turn with no tools, no context files, and no extensions but this one. Nothing here is a unit test:
# the model is not pinned, and it is the *contrast between modes* that carries the signal, not any single answer.
#
#   hack/plan-influence-check.sh                      # every mode, one after another
#   MODE=conflict hack/plan-influence-check.sh        # one mode
#   MODEL=sushi Q="..." hack/plan-influence-check.sh  # different model or question
#
# Needs a provider credential, so it is run by hand, not per push - like every other live check in this directory.
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Fresh per run, like hack/plan-wording-probe.sh: the provider keys its cache on the session id, so a reused id
# returns an earlier answer verbatim and every "contrast" measured that way is fiction.
SID=$(node -e 'console.log(require("crypto").randomUUID())')
MODEL=${MODEL:-}
# A nonce in every question, because the provider here is a caching proxy and it will hand back an earlier answer
# verbatim when only the *system prompt* changed. Two modes of this script came back with the same reply about a step
# that appeared in neither plan, which is what a poisoned measurement looks like: vary the user turn, or the contrast
# you think you are measuring is a cache hit.
NONCE=$(date +%s)-$RANDOM
MODES=${MODES:-"direction goal direction+goal todos-only direction+todos conflict direction+stale-step"}

run_mode() {
  local mode=$1 dir
  dir=$(mktemp -d /tmp/pi-plan-influence-XXXXXX)
  (cd "$dir" && git init -q .)

  # The fixture is built by the substrate, not by hand: a hand-written file once carried `schema_version` instead of
  # `v`, and the plan was silently refused as a future schema, which looked like the feature doing nothing.
  node --experimental-strip-types -e "
    const m = await import('$REPO/lib/plan.ts');
    const at = '2026-11-18T13:00:00.000Z';
    let plan = { v: 1, session_id: '$SID', todos: [], updated_at: at };
    const add = (text) => { plan = m.addTodo(plan, { text }, at).plan; };
    switch ('$mode') {
      case 'direction': plan = { ...plan, direction: 'acquire paperclips', direction_at: at }; break;
      case 'goal': plan = { ...plan, goal: 'keep the desk tidy', goal_at: at }; break;
      case 'direction+goal': plan = { ...plan, goal: 'keep the desk tidy', goal_at: at, direction: 'acquire paperclips', direction_at: at }; break;
      case 'todos-only': add('file the acquisition forms'); add('buy a box of clips'); break;
      case 'direction+todos': plan = { ...plan, direction: 'acquire paperclips', direction_at: at }; add('file the acquisition forms'); add('buy a box of clips'); break;
      // The case that matters: a route and a list that do not agree. Whatever the model names here is what the
      // block's wording is actually worth.
      case 'conflict': plan = { ...plan, direction: 'acquire paperclips', direction_at: at }; add('write the changelog'); add('review the open PR'); break;
      case 'direction+stale-step': plan = { ...plan, direction: 'drop the paperclip idea, it was a joke', direction_at: at }; add('buy a box of clips'); break;
    }
    const w = m.writePlan('$dir', plan);
    console.log(w.ok ? \`seeded \${w.path}\` : \`seed FAILED \${w.error}\`);
  " >/dev/null || { echo "$mode: fixture failed"; return; }

  local out
  out=$(timeout 240 pi -ne -e "$REPO/extensions/plan.ts" -p -nt -nc --no-approve ${MODEL:+--model "$MODEL"} \
    --session-id "$SID" "$Q [ref: $NONCE]" 2>&1)
  # The block as the substrate renders it for that file. Delivery of this text into the prompt section is asserted in
  # the test suite; what is printed here is the input to the answers below, so a wording change can be read next to
  # the behaviour it produced.
  echo "=== $mode"
  node --experimental-strip-types -e "
    const m = await import('$REPO/lib/plan.ts');
    const r = m.readPlan('$dir', '$SID');
    console.log('block:', JSON.stringify(m.renderPlanBlock(r.plan)).slice(0, 400));
  " 2>/dev/null
  grep -vE '^(Warning:|\{)' <<<"$out" | tail -3
  echo
}

# Unquoted on purpose: the list is words, and quoting it turns two modes into one nonsense name.
for mode in $MODES; do run_mode "$mode"; done
