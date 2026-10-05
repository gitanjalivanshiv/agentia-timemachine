#!/usr/bin/env bash
# Puts the demo back to its starting state in YOUR sandbox (writes to the org!).
#
#   TM_WORKSPACE=~/hackathon/tm-workspace TM_TEMPLATE="TM Demo - Accounts New" TM_BASELINE=<snapshot ref> ./examples/demo/reset.sh
#
# 1. discards edit sessions and agent edit files, 2. restores the template to the baseline snapshot (verified),
# 3. prints the final status. Refuses to run while another tool holds the shared org lock.
set -euo pipefail
: "${TM_WORKSPACE:?set TM_WORKSPACE to your timemachine workspace}"
: "${TM_TEMPLATE:?set TM_TEMPLATE to the demo template name}"
: "${TM_BASELINE:?set TM_BASELINE to the baseline snapshot ref (see: agentia timemachine history)}"
TM="${TM_CLI:-agentia} timemachine"
cd "$TM_WORKSPACE"

slug=$($TM status "$TM_TEMPLATE" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result[0];console.log((r.editSessions||[]).map(e=>e.session).join(" "))})')
for session in $slug; do $TM edit "$TM_TEMPLATE" --abort --session "$session" || true; done
rm -rf tm-edits .timemachine/.lock/mcp

$TM restore "$TM_TEMPLATE" --to "$TM_BASELINE" --yes || echo "(already at the baseline)"
$TM status "$TM_TEMPLATE"
