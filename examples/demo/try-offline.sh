#!/usr/bin/env bash
# Try Time Machine in 2 minutes without a Copado org.
#
#   ./examples/demo/try-offline.sh          guided tour (pauses between steps; set TM_NO_PAUSE=1 to run straight through)
#
# Uses a simulated offline org (scripts/fake-agentia.mjs) seeded from scrubbed real captures. It behaves like the
# real Copado API: whole-document saves, rejected saves without a filter or record limit, lastModified bumps.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$REPO/dist/index.js" ] || { echo "Build first: npm ci && npm run build"; exit 1; }

DEMO="$(mktemp -d "${TMPDIR:-/tmp}/timemachine-demo.XXXXXX")"
export TM_AGENTIA_BIN="$REPO/scripts/fake-agentia.mjs" TM_FAKE_STATE="$DEMO/org"
tm() {
  local shown=""; for a in "$@"; do [[ "$a" == *" "* ]] && shown+=" \"$a\"" || shown+=" $a"; done
  echo -e "\n\033[1;36m\$ agentia timemachine${shown}\033[0m"; "$REPO/bin/run.js" timemachine "$@" || true
}
colleague() { echo -e "\n\033[2m# meanwhile, in Copado: $*\033[0m"; node "$REPO/scripts/fake-org.mjs" "$@"; }
step() { echo -e "\n\033[1;33m▶ $*\033[0m"; [ -n "${TM_NO_PAUSE:-}" ] || read -r -p "  (enter) " _; }

mkdir -p "$DEMO/workspace" && cd "$DEMO/workspace"
git init -q -b main && git config user.name "Demo User" && git config user.email demo@example.com

step "1. Track a data template and take a snapshot"
tm init --track "TM Demo - Accounts New"
tm snapshot --all --reason "baseline"

step "2. Someone changes the template in Copado. What changed?"
colleague deselect Fax
tm status
tm diff "TM Demo - Accounts New"

step "3. Undo it with one command (verified)"
tm restore "TM Demo - Accounts New" --to HEAD~0 --yes
tm history "TM Demo - Accounts New"

step "4. Two people edit at once: the second save is blocked"
tm edit "TM Demo - Accounts New" --start --session alice
tm edit "TM Demo - Accounts New" --start --session bob
node -e 'const f=process.argv[1];const d=JSON.parse(require("fs").readFileSync(f));d.details[0].columns.find(c=>c.name==="Description").isSelected=true;require("fs").writeFileSync(f,JSON.stringify(d,null,2))' .timemachine/.lock/tm-demo-accounts-new/alice/edit.json
node -e 'const f=process.argv[1];const d=JSON.parse(require("fs").readFileSync(f));d.details[0].batchSize=100;require("fs").writeFileSync(f,JSON.stringify(d,null,2))' .timemachine/.lock/tm-demo-accounts-new/bob/edit.json
tm edit "TM Demo - Accounts New" --apply --session alice --yes --reason "need descriptions"
tm edit "TM Demo - Accounts New" --apply --session bob --yes

step "5. Nothing overlaps, so bob can keep both changes"
tm edit "TM Demo - Accounts New" --apply --session bob --merge --yes

step "6. Review, lint, and check what Copado's data engine really uses"
tm lint "TM Demo - Accounts New"
tm verify "TM Demo - Accounts New"

step "7. The timeline page"
tm report
echo -e "  Open it: open \"$DEMO/workspace/.timemachine/report.html\""

echo -e "\nDone. Workspace: $DEMO/workspace (delete it when finished)."
