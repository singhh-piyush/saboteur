#!/usr/bin/env bash
# Thin entrypoint for the Saboteur resilience composite action.
#
#   entrypoint.sh gate              — run `saboteur run --ci` in the container,
#                                     capture the exit code + this run's id
#                                     (does NOT fail; the action's last step does)
#   entrypoint.sh compare <pr_id>   — (PRs) download the base branch's last
#                                     scorecard, run `saboteur compare`, and
#                                     upsert a PR comment with the metric deltas
#
# Everything heavy runs inside the saboteur:ci image; this script only wires
# docker, gh, and the GitHub step plumbing.

set -uo pipefail  # NOT -e: the gate's docker run is allowed to exit non-zero.

WORKSPACE="${GITHUB_WORKSPACE:-$PWD}"
RUNS="$WORKSPACE/runs"
IMAGE="${SABOTEUR_IMAGE:-saboteur:ci}"
MARKER="<!-- saboteur-resilience -->"

# Run the saboteur CLI inside the image with runs/ mounted; forward the model
# endpoint env only when not using the bundled mock.
docker_run() {
  local envs=()
  if [ "${INPUT_MOCK:-true}" != "true" ]; then
    [ -n "${INPUT_OPENAI_BASE_URL:-}" ] && envs+=(-e "OPENAI_BASE_URL=${INPUT_OPENAI_BASE_URL}")
    [ -n "${INPUT_OPENAI_API_KEY:-}" ] && envs+=(-e "OPENAI_API_KEY=${INPUT_OPENAI_API_KEY}")
    [ -n "${INPUT_MODEL_ID:-}" ] && envs+=(-e "MODEL_ID=${INPUT_MODEL_ID}")
  fi
  docker run --rm -v "$RUNS:/app/runs" "${envs[@]}" "$IMAGE" "$@"
}

cmd_gate() {
  mkdir -p "$RUNS"
  # Start clean so the single scorecard left behind is unambiguously THIS run.
  rm -f "$RUNS"/*.scorecard.json "$RUNS"/*.jsonl 2>/dev/null || true

  local mockflag=()
  [ "${INPUT_MOCK:-true}" = "true" ] && mockflag=(--mock)

  docker_run run \
    --target "$INPUT_TARGET" --profile "$INPUT_PROFILE" --n "$INPUT_N" \
    --ci --metric "$INPUT_METRIC" --threshold "$INPUT_THRESHOLD" "${mockflag[@]}"
  local code=$?

  local sc rid=""
  sc=$(ls "$RUNS"/*.scorecard.json 2>/dev/null | head -1)
  [ -n "$sc" ] && rid=$(basename "$sc" .scorecard.json)

  {
    echo "gate_exit=$code"
    echo "pr_run_id=$rid"
  } >> "$GITHUB_OUTPUT"
  echo "Gate exit=$code  run_id=$rid"
}

# The base run_id is the only scorecard in runs/ that is NOT the PR run.
_base_run_id() {
  local pr="$1" f id
  for f in "$RUNS"/*.scorecard.json; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .scorecard.json)
    if [ "$id" != "$pr" ]; then echo "$id"; return; fi
  done
}

# Upsert (create or edit) a single marker-tagged PR comment.
_post_comment() {
  local body_file tmp
  tmp=$(mktemp)
  printf '%s\n\n%s\n' "$MARKER" "$1" > "$tmp"
  local cid
  cid=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
        --jq ".[] | select(.body | contains(\"$MARKER\")) | .id" 2>/dev/null | head -1)
  if [ -n "${cid:-}" ]; then
    gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${cid}" -F body=@"$tmp" >/dev/null \
      && echo "Updated PR comment $cid"
  else
    gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" -F body=@"$tmp" >/dev/null \
      && echo "Posted PR comment"
  fi
  rm -f "$tmp"
}

cmd_compare() {
  local pr_run_id="${1:-}"
  if [ -z "$pr_run_id" ]; then
    _post_comment "_Saboteur produced no scorecard for this run — see the job log._"
    return 0
  fi

  # The base branch's most recent successful run of this workflow on a push.
  local base_run
  base_run=$(gh run list --branch "${GITHUB_BASE_REF}" --workflow "${GITHUB_WORKFLOW}" \
      --event push --status success --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
  if [ -z "${base_run:-}" ] || [ "$base_run" = "null" ]; then
    _post_comment "_No baseline on \`${GITHUB_BASE_REF}\` yet — the next push there records one. (This run: \`${pr_run_id}\`.)_"
    return 0
  fi

  if ! gh run download "$base_run" -n saboteur-scorecard -D "$RUNS" 2>/dev/null; then
    _post_comment "_Could not download the base scorecard artifact (run ${base_run})._"
    return 0
  fi

  local base_id; base_id=$(_base_run_id "$pr_run_id")
  if [ -z "${base_id:-}" ]; then
    _post_comment "_The base artifact had no comparable scorecard._"
    return 0
  fi

  local body
  if ! body=$(docker_run compare "$base_id" "$pr_run_id" --markdown); then
    _post_comment "_Comparison failed — see the job log._"
    return 0
  fi
  _post_comment "$body"
}

case "${1:-}" in
  gate) cmd_gate ;;
  compare) shift; cmd_compare "$@" ;;
  *) echo "usage: entrypoint.sh {gate|compare <pr_run_id>}" >&2; exit 2 ;;
esac
