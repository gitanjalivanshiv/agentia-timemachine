/**
 * The one way timemachine writes a template: used by `restore`, `edit` and `apply`.
 *
 *   0. refuse documents Copado would reject (empty required fields), before touching anything
 *   1. take the optional org lock (config.orgBusyFile)
 *   2. re-read live and compare with the hash the user reviewed → ConcurrencyError if someone saved meanwhile
 *   3. snapshot the current live state ("undo the undo")
 *   4. save-detail
 *   5. read back and verify the hash → VerifyError if Copado stored something else
 *   6. snapshot the new state
 */
import type {AgentiaClient} from '../agentia/client.js'
import {ConcurrencyError, SaveBlockedError, VerifyError} from '../agentia/errors.js'
import type {TemplateDetail, TemplateListItem} from '../agentia/schemas.js'
import type {Store} from '../store/store.js'
import {hashDocument} from './canonical.js'
import {findSaveBlockers} from './inspect.js'
import {resolveLockPath, withOrgLock} from './org-lock.js'
import {fetchLive, recordSnapshot, type SnapshotResult} from './snapshot.js'
import {keyMap} from '../store/config.js'

export interface ApplyInput {
  client: AgentiaClient
  store: Store
  template: TemplateListItem
  /** The complete document to save. */
  target: TemplateDetail
  /** Hash of the live document the user reviewed. Saving is refused if live no longer matches. */
  expectedLiveHash: string
  action: 'restore' | 'edit' | 'apply'
  /** Commit reasons for the snapshots before and after the write. */
  reasonBefore: string
  reasonAfter: string
  ignoreBusy?: boolean
  agentiaVersion?: string
}

export interface ApplyResult {
  /** Snapshot of the state that was replaced: the undo target. */
  before: {hash: string; commit: string}
  after: {hash: string; commit?: string; snapshot: SnapshotResult}
  verified: true
}

export async function applyDetail(input: ApplyInput): Promise<ApplyResult> {
  const {client, store, template, target} = input
  const blockers = findSaveBlockers(target)
  if (blockers.length > 0)
    throw new SaveBlockedError(
      template.name,
      blockers.map((b) => b.fix),
    )

  const config = store.loadConfig()
  const keys = keyMap(config)
  const targetHash = hashDocument(target, keys)

  return withOrgLock(
    resolveLockPath(config.orgBusyFile),
    `${input.action} ${template.name}`,
    async () => {
      const live = await fetchLive(client, template, config)
      if (live.hash !== input.expectedLiveHash) {
        throw new ConcurrencyError(template.name, input.expectedLiveHash, live.hash)
      }

      const pre = await recordSnapshot(store, store.loadConfig(), live, {reason: input.reasonBefore, agentiaVersion: input.agentiaVersion})
      const preCommit = pre.commit ?? (await lastSnapshotCommit(store, pre.slug))

      await client.saveDetail(template.id, target)

      const after = await fetchLive(client, template, store.loadConfig())
      const post = await recordSnapshot(store, store.loadConfig(), after, {reason: input.reasonAfter, agentiaVersion: input.agentiaVersion})
      if (after.hash !== targetHash) throw new VerifyError(template.name, targetHash, after.hash)

      return {before: {hash: live.hash, commit: preCommit}, after: {hash: after.hash, commit: post.commit, snapshot: post}, verified: true}
    },
    input.ignoreBusy,
  )
}

async function lastSnapshotCommit(store: Store, slug: string): Promise<string> {
  const [last] = await store.history(slug, 1)
  return last.commit
}
