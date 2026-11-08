#!/usr/bin/env bash
# Fixture test for public_guard.sh: every pattern class must still trip, and a
# clean tree must pass, so that editing a pattern cannot silently disable it.
set -uo pipefail
guard="$(cd "$(dirname "$0")" && pwd)/public_guard.sh"
commits="$(cd "$(dirname "$0")" && pwd)/public_guard_commits.sh"
range="$(cd "$(dirname "$0")" && pwd)/public_guard_push_range.sh"
hook="$(cd "$(dirname "$0")/.." && pwd)/.githooks/pre-push"
work=$(mktemp -d); homes=$(mktemp -d); trap 'rm -rf "$work" "$homes"' EXIT
mkdir -p "$homes/empty"
cd "$work" && git init -q . && git config user.email t@t && git config user.name t
mkdir scripts && cp "$guard" scripts/public_guard.sh && cp "$commits" scripts/public_guard_commits.sh && cp "$range" scripts/public_guard_push_range.sh

expect() { # expect <0|1> <description>
  PUBLIC_GUARD_EXTRA="${EXTRA:-}" PUBLIC_GUARD_REQUIRE_EXTRA="${REQUIRE:-}" PUBLIC_GUARD_EXTRA_FILE="${XFILE:-}" \
    HOME="${THOME:-$homes/empty}" \
    bash scripts/public_guard.sh >/dev/null 2>&1; got=$?
  if [[ $got -ne $1 ]]; then echo "FAIL: $2 (exit $got, expected $1)"; exit 1; fi
  echo "ok: $2"
}
reset() { git rm -rq --cached . >/dev/null 2>&1; find . -mindepth 1 -maxdepth 1 ! -name .git ! -name scripts -exec rm -rf {} +; git add scripts; }
add() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; git add "$1"; }

reset; add lib/a.ex 'defmodule A, do: nil';                         expect 0 "clean tree passes"
reset; add lib/a.ex "path = \"/Us""ers/someone/x\"";                  expect 1 "personal macOS path"
reset; add lib/a.ex "mail = \"x@gm""ail.com\"";                       expect 1 "personal email"
reset; add lib/a.ex "url = \"http://192.""168.1.5:80\"";               expect 1 "LAN address"
reset; add lib/a.ex "path = \"/ho""me/someone/x\"";                 expect 1 "personal Linux path"
reset; add lib/a.ex "host = \"10.""0.0.7\"";                          expect 1 "private 10.x address"
reset; add lib/a.ex "# fixed in G""C-1234";                            expect 1 "internal issue reference"
reset; add lib/a.ex "# see g""c2727 run";                               expect 1 "internal issue reference without hyphen"
reset; add lib/a.ex "branch g""c/6835-x";                               expect 1 "internal branch name"
for a in CLAUDE.md AGENTS.md .claude/x .serena/x .devman/x .planning/x .cursor/x .swarm/x; do
  reset; add "$a" 'x';                                                 expect 1 "AI-tool artefact $a"
done
reset; add _bmad-output/x.md 'x';                                      expect 1 "planning artefact"
reset; add PARITY_AUDIT.md 'x';                                        expect 1 "root working paper"
reset; add lib/a.ex 'client = "Acmecorp"'; EXTRA='acmecorp'            expect 1 "extra (secret) pattern"
reset; add lib/a.ex 'client = "Acmecorp"'; EXTRA=$' acmecorp \r'      expect 1 "extra pattern with CR and padding still matches"
EXTRA=''
reset; add "lib/odd \"näme\".ex" "path = \"/Us""ers/someone/x\"";        expect 1 "file with special characters in its name"
reset; add lib/a.ex "defmodule A, do: nil"; EXTRA="("                    expect 1 "invalid pattern fails closed"
reset; add lib/a.ex "ip = \"192.""168.1.1\" # public-guard: allow (fixture)";   expect 0 "allow marker exempts its own line"
lan="192.""168.1.1"
reset; add lib/a.ex "# public-guard: allow (fixture)"$'\n'"ip = \"$lan\"";                 expect 0 "allow marker on the line above exempts"
reset; add lib/a.ex "# public-guard: allow (fixture)"$'\n\n'"ip = \"$lan\"";             expect 1 "allow marker two lines above does not exempt"
reset; add lib/a.ex "host = \"172.""16.4.2\"";                        expect 1 "private 172.16/12 address"
reset; add lib/a.ex "host = \"172.""32.4.2\"";                        expect 0 "public 172.32.x is not private"
reset; add lib/a.ex "a = \"$lan\" # public-guard: allow (fixture)"$'\n'"b = \"$lan\"";   expect 1 "trailing marker does not exempt the next line"
reset; add lib/a.ex "# public-guard: allow"$'\n'"ip = \"$lan\"";                            expect 1 "marker without a reason does not exempt"
reset; add lib/a.ex "# public-guard: allow"; add lib/b.ex "ip = \"192.""168.1.1\""; expect 1 "allow marker does not exempt other lines"
reset; add lib/a.ex 'c = "Acmecorp" # public-guard: allow (fixture)'; EXTRA='acmecorp' expect 1 "allow marker never exempts an extra pattern"
EXTRA=''
reset; add lib/a.ex 'defmodule A, do: nil'; REQUIRE=1                     expect 1 "required extras missing fails"
reset; add lib/a.ex 'defmodule A, do: nil'; EXTRA='acmecorp'             expect 0 "required extras present passes"
REQUIRE=''; EXTRA=''
reset; add lib/a.ex 'defmodule A, do: nil'; XFILE="$work/missing.txt"    expect 1 "unreadable extras file fails"
XFILE=''
reset; add READINESS.md "x"; add DEVELOPMENT.md "y";                    expect 0 "READINESS and DEVELOPMENT are standard files"
EXTRA=""

# The default extras path is used only when neither extras variable is set; all
# other fixture runs point HOME at an empty directory, so they never load it.
mkdir -p "$homes/default/.config/fosferon"
printf 'acmecorp\r\n' > "$homes/default/.config/fosferon/public-guard-extra.txt"
reset; add lib/a.ex 'client = "Acmecorp"'; THOME="$homes/default"       expect 1 "default extras file is picked up"
reset; add lib/a.ex 'defmodule A, do: nil'; THOME="$homes/default" REQUIRE=1 expect 0 "required extras load from the default file"
THOME=''; REQUIRE=''

# Fail closed: no work tree, or nothing tracked, must never report clean.
rm -f scripts/public_guard_commits.sh scripts/public_guard_push_range.sh   # leave the guard as the only tracked file
reset;                                                                  expect 1 "tree with only the guard tracked fails closed"
reset; git rm -rq --cached .;                                           expect 1 "zero tracked files fails closed"
nonrepo=$(mktemp -d)
outside=$(cd "$nonrepo" && PUBLIC_GUARD_EXTRA='' PUBLIC_GUARD_REQUIRE_EXTRA='' PUBLIC_GUARD_EXTRA_FILE='' HOME="$homes/empty" \
  bash "$guard" 2>&1); got=$?
rm -rf "$nonrepo"
if [[ $got -eq 0 || "$outside" != *"not inside a git work tree"* ]]; then
  echo "FAIL: guard outside a git work tree (exit $got; output: $outside)"; exit 1
fi
echo "ok: guard refuses to run outside a git work tree"

# A failing `git ls-files` must abort the scan, not be mistaken for an empty tree.
reset; add lib/a.ex 'defmodule A, do: nil'
real_git=$(command -v git)
mkdir -p "$work/bin"
cat > "$work/bin/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [[ "\$a" == ls-files ]]; then
    echo "fatal: public-guard fixture: simulated ls-files failure" >&2
    exit 128
  fi
done
exec "$real_git" "\$@"
EOF
chmod +x "$work/bin/git"
out=$(PATH="$work/bin:$PATH" PUBLIC_GUARD_EXTRA='' PUBLIC_GUARD_REQUIRE_EXTRA='' PUBLIC_GUARD_EXTRA_FILE='' HOME="$homes/empty" \
  bash scripts/public_guard.sh 2>&1); got=$?
if [[ $got -eq 0 || "$out" != *"public-guard fixture: simulated ls-files failure"* || "$out" == *"public_guard: clean"* || "$out" == *"no scannable tracked files"* ]]; then
  echo "FAIL: failing git ls-files must fail closed (exit $got; output: $out)"; exit 1
fi
echo "ok: failing git ls-files fails closed"
rm -rf "$work/bin"

# pre-push hook: every pushed commit is scanned, not only the tip.
reset; add lib/a.ex 'defmodule A, do: nil'; git commit -qm base; base=$(git rev-parse HEAD)
add lib/a.ex "host = \"$lan\""; git commit -qm leak
add lib/a.ex 'defmodule A, do: nil'; git commit -qm fix
cp "$hook" scripts/pre-push
cp "$commits" scripts/public_guard_commits.sh
cp "$range" scripts/public_guard_push_range.sh
hookrun() { echo "refs/heads/main $(git rev-parse HEAD) refs/heads/main $1" | \
  PUBLIC_GUARD_EXTRA_FILE="$work/x.txt" bash scripts/pre-push origin >/dev/null 2>&1; }
# No extras configured and no default file: the hook must still scan built-ins and
# say that extras were not checked.
hookrun_noextras() {
  echo "refs/heads/main $(git rev-parse HEAD) refs/heads/main $1" | \
    env -u PUBLIC_GUARD_EXTRA -u PUBLIC_GUARD_REQUIRE_EXTRA -u PUBLIC_GUARD_EXTRA_FILE \
    HOME="$homes/no-home" bash scripts/pre-push origin 2>&1
}
printf 'acmecorp\r\n' > "$work/x.txt"   # CRLF extras file must still load
hookrun "$base"; got=$?; [[ $got -eq 1 ]] || { echo "FAIL: hook misses a leak in an intermediate commit (exit $got)"; exit 1; }; echo "ok: hook scans intermediate commits"
hookrun deadbeefdeadbeefdeadbeefdeadbeefdeadbeef; got=$?; [[ $got -eq 1 ]] || { echo "FAIL: hook skips a range whose remote sha is unknown (exit $got)"; exit 1; }; echo "ok: hook scans when the remote sha is unknown"
hookrun "$(git rev-parse HEAD~1)"; got=$?; [[ $got -eq 0 ]] || { echo "FAIL: hook rejects a clean range (exit $got)"; exit 1; }; echo "ok: hook passes a clean range"
: > "$work/x.txt"   # readable but empty
hookrun "$(git rev-parse HEAD~1)"; got=$?; [[ $got -eq 1 ]] || { echo "FAIL: hook accepts an empty extras file (exit $got)"; exit 1; }; echo "ok: hook requires a configured extras file to be non-empty"
out=$(hookrun_noextras "$(git rev-parse HEAD~1)"); got=$?
[[ $got -eq 0 && "$out" == *"extras were not checked"* ]] || { echo "FAIL: hook without extras should pass clean and say extras were not checked (exit $got; output: $out)"; exit 1; }; echo "ok: hook without extras checks built-ins and reports extras were not checked"
out=$(hookrun_noextras "$base"); got=$?
[[ $got -eq 1 ]] || { echo "FAIL: hook without extras misses a built-in leak (exit $got)"; exit 1; }; echo "ok: hook without extras still catches built-in leaks"
rm -f "$work/x.txt"

# New-branch push: hook and CI must judge only commits not already on the remote.
# The old public commit deliberately contains a built-in hit, so a whole-history
# scan fails; the branch's own commits are clean until one plants a term.
nbrepo="$work/newbranch"
git init -q "$nbrepo"
git -C "$nbrepo" config user.email t@t
git -C "$nbrepo" config user.name t
mkdir -p "$nbrepo/scripts"
cp "$guard" "$nbrepo/scripts/public_guard.sh"
cp "$commits" "$nbrepo/scripts/public_guard_commits.sh"
cp "$range" "$nbrepo/scripts/public_guard_push_range.sh"
cp "$hook" "$nbrepo/scripts/pre-push"
addnb() { mkdir -p "$(dirname "$nbrepo/$1")"; printf '%s\n' "$2" > "$nbrepo/$1"; git -C "$nbrepo" add "$1"; }
addnb lib/old.ex "path = \"/Us""ers/someone/old\""
git -C "$nbrepo" commit -qm "already-public history"
git -C "$nbrepo" update-ref refs/remotes/origin/main "$(git -C "$nbrepo" rev-parse HEAD)"
git -C "$nbrepo" checkout -qb feature
addnb lib/old.ex 'defmodule Old, do: nil'
addnb lib/new.ex 'defmodule New, do: nil'
git -C "$nbrepo" commit -qm "clean branch commit"
nb_head=$(git -C "$nbrepo" rev-parse HEAD)
nb_zero=0000000000000000000000000000000000000000
nb_ci() { (cd "$nbrepo" && bash scripts/public_guard_push_range.sh origin "$1" "$nb_head" >/dev/null 2>&1); }
nb_hook() {
  (cd "$nbrepo" && printf 'refs/heads/feature %s refs/heads/feature %s\n' "$nb_head" "$1" | \
    env -u PUBLIC_GUARD_EXTRA -u PUBLIC_GUARD_REQUIRE_EXTRA -u PUBLIC_GUARD_EXTRA_FILE \
    HOME="$work/no-home" bash scripts/pre-push origin >/dev/null 2>&1)
}
(cd "$nbrepo" && bash scripts/public_guard_commits.sh "$nb_head" >/dev/null 2>&1); got=$?
[[ $got -eq 1 ]] || { echo "FAIL: whole-history scan should fail on already-public material (exit $got)"; exit 1; }; echo "ok: already-public history trips a whole-history scan"
nb_hook "$nb_zero"; got=$?; [[ $got -eq 0 ]] || { echo "FAIL: hook rejects a clean new branch with already-public history (exit $got)"; exit 1; }; echo "ok: hook ignores already-public history on a new branch"
nb_ci "$nb_zero"; got=$?; [[ $got -eq 0 ]] || { echo "FAIL: CI range rejects a clean new branch with already-public history (exit $got)"; exit 1; }; echo "ok: CI range ignores already-public history on a new branch"
addnb lib/new.ex "host = \"$lan\""
git -C "$nbrepo" commit -qm "planted branch leak"
addnb lib/new.ex 'defmodule New, do: nil'
git -C "$nbrepo" commit -qm "fix planted branch leak"
nb_head=$(git -C "$nbrepo" rev-parse HEAD)
nb_hook "$nb_zero"; got=$?; [[ $got -eq 1 ]] || { echo "FAIL: hook misses a planted term in a new branch commit (exit $got)"; exit 1; }; echo "ok: hook catches a planted term in a new branch commit"
nb_ci "$nb_zero"; got=$?; [[ $got -eq 1 ]] || { echo "FAIL: CI range misses a planted term in a new branch commit (exit $got)"; exit 1; }; echo "ok: CI range catches a planted term in a new branch commit"

echo "public_guard_test: all passed"
