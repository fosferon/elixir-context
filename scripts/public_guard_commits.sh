#!/usr/bin/env bash
# Scan every commit selected by `git rev-list "$@"` with public_guard.sh.
# One detached worktree per commit, so a leak that was later fixed is still seen.
#
# Usage:
#   scripts/public_guard_commits.sh <rev-list args>...
#
# Examples:
#   scripts/public_guard_commits.sh 583ce2a..HEAD
#   scripts/public_guard_commits.sh HEAD                 # full history of HEAD
#   scripts/public_guard_commits.sh HEAD --not --remotes=origin
set -euo pipefail

top=$(git rev-parse --show-toplevel)
guard="$top/scripts/public_guard.sh"
status=0
wt=""
cleanup() {
  if [[ -n "$wt" ]]; then
    git worktree remove -f "$wt" 2>/dev/null || true
    rm -rf "$wt" "$wt.log"
    wt=""
  fi
}
finish() {
  local code=${1:-$?}
  trap - EXIT INT TERM
  cleanup
  exit "$code"
}
trap finish EXIT
trap 'finish 130' INT
trap 'finish 143' TERM

# Drop registrations left by a run that was killed before its EXIT trap could
# remove them, before adding another worktree.
git worktree prune 2>/dev/null || true

if [[ $# -eq 0 ]]; then
  echo "usage: public_guard_commits.sh <rev-list args>..." >&2
  exit 2
fi

commits=$(git rev-list "$@")
for c in $commits; do
  wt=$(mktemp -d)
  if ! git worktree add -q --detach -f "$wt" "$c"; then
    echo "public_guard_commits: cannot check out commit ${c:0:12}" >&2
    status=1
    cleanup; wt=""
    continue
  fi
  if ! (cd "$wt" && bash "$guard") >"$wt.log" 2>&1; then
    echo "public_guard_commits: public guard failed on commit ${c:0:12}:"
    sed 's/^/  /' "$wt.log"
    status=1
  fi
  cleanup; wt=""
done
exit $status
