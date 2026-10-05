# Demo kit

| File                               | What it does                                                       | Org access |
| ---------------------------------- | ------------------------------------------------------------------ | ---------- |
| [`try-offline.sh`](try-offline.sh) | Guided tour against the simulated offline org                      | none       |
| [`seed.mjs`](seed.mjs)             | Creates a ready-to-version demo template in your sandbox           | **writes** |
| [`reset.sh`](reset.sh)             | Puts the demo template back to its baseline snapshot               | **writes** |
| [`record.mjs`](record.mjs)         | Records the offline tour as an asciinema cast (for the README GIF) | none       |

## The 5-minute video

Set-up: a private workspace tracking **TM Demo - Accounts New** (snapshot `baseline`), two terminals side by side,
Claude Code with the skill and the MCP server, and a pull request branch ready. Reset between takes with
`reset.sh`.

**1. The pain (30 s).** Two terminals, raw Agentia commands. A and B both `get-detail`, A adds a field and
`save-detail`, B changes the batch size and `save-detail`. A's field is gone; nobody was warned.

> "A data template decides which records move between orgs, and one save can silently erase a colleague's work."

**2. Snapshot and diff (45 s).** `agentia timemachine init --track …`, `snapshot --all`. Someone changes the template
→ `status` says _drifted_ → `diff` prints `+ field … added`, `~ filter on Account: … → …`.

**3. Safe edit (60 s).** Both terminals: `edit --start --session alice|bob`. Alice applies. Bob applies and gets
**✋ Blocked**: their changes, his changes, no overlap. Bob re-runs with `--merge`: both changes kept, verified.

**4. Undo (45 s).** A bad change slips in. `history` shows who, when and why. `restore --to <ref>` previews, saves,
reads back and prints _verified_ plus the undo command. `status`: in sync.

**5. Agents and pull requests (60 s).** In Claude Code: _"Add the Website field to the TM Demo - Accounts New data
template."_ The agent loads the skill on its own, snapshots, previews `+ field Website added to Account` via
`tm_edit_preview` and **asks before saving**. Then a pull request: CI posts the `plan` comment, merge → `apply`.

**6. Close (20 s).** `lint` catches an unquoted filter value. _"Release data templates, now with the safety net code
has had for twenty years."_

## Real sandbox

```bash
# once: create the demo template (needs a sandbox credential Id: agentia cicd credential list --environmentid <id>)
node examples/demo/seed.mjs --credential-id <credential Id> --name "TM Demo - Accounts New"

# workspace
mkdir ~/tm-workspace && cd ~/tm-workspace && git init
agentia timemachine init --track "TM Demo - Accounts New" --skill claude
agentia timemachine snapshot --all --reason baseline

# between takes
TM_WORKSPACE=~/tm-workspace TM_TEMPLATE="TM Demo - Accounts New" TM_BASELINE=<baseline ref> ./examples/demo/reset.sh
```
