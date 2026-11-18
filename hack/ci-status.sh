#!/usr/bin/env bash
# Ask Woodpecker directly what it did with a commit.
#
# Why this exists: the public badge (`/api/badges/<repo>/status.svg?branch=master`) tells you the status of the last
# build on a branch and nothing else - not which commit, not whether the build you just pushed is the one it is
# describing. The `/api/repos/...` routes need a user token, and the only tokens here are issued through Google OAuth.
# So the answer comes from the CI database: Woodpecker's state is Postgres in the `woodpecker` namespace, and a
# read-only `SELECT` over `pipelines` gives commit, status, and timings without any credential beyond kubectl.
#
# Table and column names are Woodpecker 2.x, which renamed things out from under the docs: `pipelines` is what the
# API calls a build and `steps` is what it calls a stage, and a step's verdict is `state` while a pipeline's is
# `status`. There is no `builds` table, and `repos.name` holds only the last path segment (`pi-ed`), with the org in
# `repos.owner`. The `woodpecker` role is the database owner, so this opens a connection as it and reads; it writes
# nothing, which is the whole discipline around touching another service's database.
#
#   hack/ci-status.sh                      # last 6 pipelines for initialed85/pi-ed
#   hack/ci-status.sh initialed85/home-ops # another repo
#   hack/ci-status.sh --steps 115          # per-step timings for this repo's pipeline 115
#   hack/ci-status.sh --steps 374 initialed85/home-ops
set -euo pipefail

CTX=${WP_CONTEXT:-home-dev}
NS=${WP_NAMESPACE:-woodpecker}
DEFAULT_REPO=initialed85/pi-ed
REPO=${1:-$DEFAULT_REPO}
LIMIT=${WP_LIMIT:-6}
# `owner/name` in, the two columns out. A bare name is allowed and matches any org with that repo name.
OWNER=${REPO%/*}; [ "$OWNER" = "$REPO" ] && OWNER=''
NAME=${REPO##*/}

run() {
  kubectl --context "$CTX" -n "$NS" exec -i deploy/woodpecker-postgres -- \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -f -'
}

if [ "${1:-}" = "--steps" ]; then
  number=${2:?usage: hack/ci-status.sh --steps <pipeline-number> [repo]}
  REPO=${3:-$DEFAULT_REPO}
  OWNER=${REPO%/*}; [ "$OWNER" = "$REPO" ] && OWNER=''
  NAME=${REPO##*/}
  cat <<SQL | run
SELECT s.name, rpad(s.state, 8) AS state, coalesce(left(s.error, 40), '') AS error,
       to_char(to_timestamp(s.started), 'HH24:MI:SS') AS start,
       CASE WHEN s.finished = 0 THEN '...' ELSE to_char(to_timestamp(s.finished), 'HH24:MI:SS') END AS "end",
       s.exit_code
FROM steps s JOIN pipelines p ON p.id = s.pipeline_id JOIN repos r ON r.id = p.repo_id
WHERE p.number = $number AND r.name = '$NAME' AND ('$OWNER' = '' OR r.owner = '$OWNER') ORDER BY s.id;
SQL
  exit 0
fi

cat <<SQL | run
SELECT p.number, left(p.commit, 9) AS sha, rpad(p.status, 8) AS status, p.event,
       to_char(to_timestamp(p.started), 'HH:MI') AS start,
       CASE WHEN p.finished = 0 THEN '...' ELSE to_char(to_timestamp(p.finished), 'HH:MI') END AS "end",
       left(regexp_replace(coalesce(p.message, ''), '\s+', ' ', 'g'), 46) AS message
FROM pipelines p JOIN repos r ON r.id = p.repo_id
WHERE r.name = '$NAME' AND ('$OWNER' = '' OR r.owner = '$OWNER') ORDER BY p.id DESC LIMIT $LIMIT;
SQL
