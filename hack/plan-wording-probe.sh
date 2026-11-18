#!/usr/bin/env bash
# Compare candidate `<plan>` block wordings against a real model, without touching lib/plan.ts.
#
# Why a throwaway extension rather than the feature: the thing under test is the *sentence*. Running each candidate
# through the shipped renderer would mean editing lib/plan.ts per try, so this writes a two-line extension that sets
# the section to exactly the block given in $BLOCK, and the model sees what the feature would show it and nothing
# else.
#
#   BLOCK='# Plan
#   DIRECTION acquire paperclips
#   TODO      1 open
#     [ ] t1 write the changelog' hack/plan-wording-probe.sh
#
# Needs a provider credential. It is a measurement instrument, not a test: the model is not pinned, so the signal is
# in the answers side by side, not in any single one.
set -uo pipefail
# A fresh session id per run, and a nonce per run. Both turned out to be necessary: with a fixed id the provider
# returned the same sentence for three different plans, including one that named a step present in none of them. If
# you are measuring wording, you are measuring whatever the model was actually sent - so nothing may be reused.
SID=$(node -e 'console.log(require("crypto").randomUUID())')
# A nonce in every question, because the provider here is a caching proxy and it will hand back an earlier answer
# verbatim when only the *system prompt* changed. Two modes of this script came back with the same reply about a step
# that appeared in neither plan, which is what a poisoned measurement looks like: vary the user turn, or the contrast
# you think you are measuring is a cache hit.
NONCE=$(date +%s)-$RANDOM
Q=${Q:-"Name the single next action you will take, in twelve words or fewer. If a plan line conflicts with another plan line, say which."}
DIR=$(mktemp -d /tmp/pi-plan-wording-XXXXXX)
EXT="$DIR/wording.ts"
export EXT BLOCK # the node heredoc below reads both out of the environment

node -e '
  const fs = require("fs");
  fs.writeFileSync(process.env.EXT,
    "export default function (pi) {\n" +
    "  pi.on(\"before_agent_start\", (event) => {\n" +
    `    event.systemPromptOptions.sections.plan = ${JSON.stringify(process.env.BLOCK)};\n` +
    "  });\n" +
    "}\n");
'
(cd "$DIR" && git init -q .)
out=$(timeout 240 pi -ne -e "$EXT" -p -nt -nc --no-approve --session-id "$SID" "$Q [ref: $NONCE]" 2>&1)
printf '%s\n' "--- $(head -1 <<<"$BLOCK" | cut -c1-60)"
# The whole answer, not the last two lines: an earlier version of this script trimmed here, and the trim cut the
# sentence the measurement was about, leaving a quote of the block that read like a hallucination.
grep -vE '^(Warning:)' <<<"$out"
echo
