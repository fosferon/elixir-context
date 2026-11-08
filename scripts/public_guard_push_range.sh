#!/usr/bin/env bash
# Scan exactly the commits a push or pull request would publish.
#
# Usage:
#   scripts/public_guard_push_range.sh <remote> <base> <head>
#
# <base> is the remote ref's previous SHA (the all-zero SHA for a new branch);
# <head> is the tip being published. A missing or unknown base falls back to
# the new-branch rule: commits reachable from <head> but not from any ref the
# remote already has. The pre-push hook and CI both call this, so a new branch
# cannot trip over commits that are already public.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: public_guard_push_range.sh <remote> <base> <head>" >&2
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
  bash "$scanner" "$head" --not --remotes="$remote"
else
  bash "$scanner" "$base..$head"
fi
