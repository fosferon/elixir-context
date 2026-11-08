#!/usr/bin/env bash
# Scan exactly the commits a push or pull request would publish.
#
# Usage:
#   scripts/public_guard_push_range.sh <remote> <base> <head>
#   scripts/public_guard_push_range.sh --ci <remote> <base> <head>
#
# <base> is the remote ref's previous SHA (the all-zero SHA for a new branch);
# <head> is the tip being published. A known base scans <base>..<head>.
#
# Without --ci (the pre-push hook), a zero or unknown base falls back to
# commits reachable from <head> but not from any ref the remote already has.
# The hook runs before the branch exists on the remote, so that is the right
# negative set.
#
# With --ci, the workflow runs after the push, so every branch the remote has
# (including the one just pushed) already contains <head>; the hook rule would
# scan zero commits on a new-branch push. Instead, when there is no usable base
# (all-zero `before`, or a `before` commit not present locally, e.g. after a
# force-push), CI scans the whole history of <head>. That is the gate that
# re-checks every intermediate commit when the rewritten history is published.
# A known base still scans <base>..<head>, which is also the pull-request path.
set -euo pipefail

ci=0
if [[ $# -gt 0 && "$1" == "--ci" ]]; then
  ci=1
  shift
fi

if [[ $# -ne 3 ]]; then
  echo "usage: public_guard_push_range.sh [--ci] <remote> <base> <head>" >&2
  exit 2
fi

remote=$1
base=$2
head=$3
zero=0000000000000000000000000000000000000000
top=$(git rev-parse --show-toplevel)
scanner="$top/scripts/public_guard_commits.sh"

if [[ -z "$remote" ]]; then
  echo "public_guard_push_range: no remote name given" >&2
  exit 2
fi
if [[ -z "$head" || "$head" == "$zero" ]]; then
  echo "public_guard_push_range: no head commit to scan" >&2
  exit 1
fi

if [[ -z "$base" || "$base" == "$zero" ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  if (( ci )); then
    bash "$scanner" "$head"
  else
    bash "$scanner" "$head" --not --remotes="$remote"
  fi
else
  bash "$scanner" "$base..$head"
fi
