/**
 * dsh-retrace — Rollback executor (PLAN.md §4.5).
 *
 * Rolls a session (and optionally its artifacts) back to a recorded version:
 *
 *   scope 'context'   — append an invisible replacement marker shadowing every
 *                       surface node added AFTER the version boundary, so the
 *                       model-visible history rewinds to that point (git-checkout
 *                       semantics: the rewound content stays in the durable log
 *                       as a later version — non-destructive, auditable).
 *   scope 'artifacts' — restore the files the version's window touched to their
 *                       content at that version: git checkout when the workspace
 *                       is a repository and the version recorded a HEAD, else
 *                       content-addressed snapshot read-back through `ctx.fs`
 *                       (CAS-guarded), with version-checked local deletion for
 *                       files absent at that version.
 *   scope 'both'      — context first, then artifacts.
 *
 * Every execution is dry-run-previewable first and records the restore as a new
 * version (kind='restore') in the projection feed, so a rollback is itself a
 * version and can be rolled back again (idempotent per-session lock included).
 */
import { isAbsolute } from 'node:path'
import { lstat, unlink } from 'node:fs/promises'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { editorError } from './host-core.js'
import { sessionEvents } from './host-compat.js'

const VALID_SCOPES = ['context', 'artifacts', 'both']

/**
 * Create the rollback executor.
 * @param {object} deps
 * @param {object} deps.ctx            — host context (ctx.fs / ctx.sandboxPolicy).
 * @param {object} deps.sessions       — session registry (sessions.get / sessions.flush).
 * @param {object} deps.seam           — versioning seam (snapshot / resolveSnapshot /
 *                                       readSnapshot / gitStatus / gitHeadFor).
 * @param {object} [deps.agents]       — agent registry (agents.get) 用于轮次间 marker 的
 *                                       turn 信封推进 agent-loop 计数器（writeMarker 情形③）。
 * @param {Function} [deps.writeMarker] — 遮蔽写入器（adapter 注入；业务层只表达遮蔽意图）。
 * @param {(line: string) => void} [deps.log]
 */
export function createRollbackExecutor({ ctx, sessions, agents, seam, validateMarker, writeMarker, log = () => {} }) {
  /** One in-flight rollback per session; later ops wait for the earlier one. */
  const locks = new Map()

  function locked(sessionId, fn) {
    const previous = locks.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    locks.set(sessionId, next)
    void next.finally(() => {
      if (locks.get(sessionId) === next) locks.delete(sessionId)
    }).catch(() => {})
    return next
  }

  function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw editorError('bad-request', 'sessionId must be a non-empty string')
    }
    const session = sessions.get(sessionId)
    if (!session) throw editorError('session-not-found', `session "${sessionId}" not found`)
    return session
  }

  function requireIdle(sessionId) {
    const agent = seam.agentOf?.(sessionId)
    if (agent && typeof agent.status === 'string' && agent.status === 'running') {
      throw editorError('agent-busy', 'The agent is still responding; stop the current reply before rolling back.')
    }
  }

  function versionOf(sessionId, versionId) {
    const snap = seam.snapshot(sessionId)
    const record = (snap.versions ?? []).find((v) => v.versionId === versionId)
    if (!record) throw editorError('version-not-found', `version "${versionId}" not found in session "${sessionId}"`)
    return record
  }

  function cwdOf(session) {
    return typeof session.header?.cwd === 'string' ? session.header.cwd : null
  }

  /**
   * The surface diff of "now" vs the version boundary: every current surface
   * node absent from the version's folded surface. An empty diff means the
   * session is already at (or before) that version.
   */
  function contextDiff(session, record) {
    const events = sessionEvents(session)
    // 0.2.0:官方 foldSurface 拒绝"有主但没带解释器"的投影事件(如 image/offload),
    // 不带定义折叠会抛错。定义借自 sessions 服务的活注册(老宿主没有该成员 →
    // [] 即官方默认值,行为不变)。
    const projections = Array.isArray(sessions?.messageProjections)
      ? sessions.messageProjections
      : (Array.isArray(ctx?.sessions?.messageProjections) ? ctx.sessions.messageProjections : [])
    const target = foldSurface(events.slice(0, record.boundarySeq + 1), projections)
    const targetNodes = new Set(target.nodes)
    const current = session.surface.nodes
    const diff = current.filter((seq) => !targetNodes.has(seq))
    return {
      messages: diff.length,
      diff,
      firstSeq: diff.length > 0 ? diff[0] : null,
      lastSeq: diff.length > 0 ? diff[diff.length - 1] : null,
    }
  }

  /** Realpath must stay inside the workspace and match a manifest path. */
  async function workspaceRealpath(session, relPath) {
    const cwd = cwdOf(session)
    if (!cwd) return null
    const target = await ctx.fs.resolve(relPath, { cwd })
    const root = await ctx.fs.resolve('.', { cwd })
    if (!ctx.fs.contains(root, target) || target.targetKey === root.targetKey) return null
    return target
  }

  function guardedVersion(stat) {
    if (stat.type !== 'file') throw editorError('not-a-file', 'Rollback only supports regular files')
    if (typeof stat.version !== 'string' && typeof stat.version !== 'number') {
      throw editorError('version-unavailable', 'Filesystem cannot provide a guarded file version')
    }
    return stat.version
  }

  function deletionSupported() {
    return typeof ctx.fs.withLock === 'function'
      && typeof ctx.fs.checkedTarget === 'function'
      && typeof ctx.fs.processPath === 'function'
  }

  /** Artifact plan for one version: per file the action and the method. */
  async function artifactPlan(session, record, git) {
    const rows = []
    const cwd = cwdOf(session)
    const headHash = git?.headHash
    for (const file of record.touchedFiles) {
      if (file.mode === 'deleted') {
        const target = cwd ? await workspaceRealpath(session, file.path) : null
        rows.push({
          path: file.path,
          action: 'delete',
          method: 'filesystem',
          safe: target !== null && deletionSupported(),
        })
        continue
      }
      if (git && headHash) {
        rows.push({ path: file.path, action: 'restore', method: 'git', safe: true })
        continue
      }
      const sha = await seam.resolveSnapshot(record.versionId, file.path)
      if (sha) {
        rows.push({ path: file.path, action: 'restore', method: 'snapshot', safe: true })
      } else {
        rows.push({ path: file.path, action: 'skip', reason: 'no-snapshot' })
      }
    }
    return { rows, git: git ? { enabled: true, headHash: git.headHash } : { enabled: false } }
  }

  /** Dry-run preview: what a rollback would remove / touch (no side effects). */
  async function preview(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    const session = requireSession(sessionId)
    const record = versionOf(sessionId, versionId)
    const context = contextDiff(session, record)
    const git = seam.configFor(sessionId).git ? await seam.gitStatus(sessionId) : null
    const artifacts = await artifactPlan(session, record, git)
    return {
      versionId,
      kind: record.kind,
      boundarySeq: record.boundarySeq,
      scope,
      context,
      artifacts,
      applicable: scope === 'context' ? context.messages > 0 : scope === 'artifacts' ? artifacts.rows.length > 0 : context.messages > 0 || artifacts.rows.length > 0,
    }
  }

  /** Delete one manifest file using the host's lock and sandbox identity check.
   * rc.2 has no fs.remove API. Only its local sandbox backend exposes the
   * checked canonical process path needed for a single-file native unlink.
   */
  async function removeOne(session, file) {
    const target = await workspaceRealpath(session, file.path)
    if (!target) return { path: file.path, status: 'skipped', reason: 'outside-workspace' }
    const stat = await ctx.fs.stat(target)
    if (!stat) return { path: file.path, status: 'unchanged' }
    const version = guardedVersion(stat)
    if (!deletionSupported()) throw editorError('delete-unavailable', 'Safe deletion is unavailable on this filesystem')
    const policy = ctx.sandboxPolicy?.resolve?.({ session })
    await ctx.fs.withLock(target.targetKey, async () => {
      requireIdle(session.id)
      const checked = await ctx.fs.checkedTarget(target, policy)
      const fresh = await workspaceRealpath(session, file.path)
      if (!fresh || fresh.targetKey !== target.targetKey || checked.targetKey !== target.targetKey) {
        throw editorError('path-changed', 'File target changed before deletion')
      }
      const path = ctx.fs.processPath(checked)
      if (!isAbsolute(path) || path !== String(checked.targetKey) || !(await lstat(path)).isFile()) {
        throw editorError('not-a-file', 'Cannot safely delete this target')
      }
      const current = await ctx.fs.stat(fresh)
      if (!current || guardedVersion(current) !== version) {
        throw editorError('file-conflict', 'File changed before deletion')
      }
      await unlink(path)
    })
    return { path: file.path, status: 'deleted' }
  }

  /** Restore one snapshot file through the sandboxed fs (CAS-guarded write). */
  async function restoreSnapshot(session, file, sha) {
    const cwd = cwdOf(session)
    if (!cwd) return { path: file.path, status: 'skipped', reason: 'no-cwd' }
    const bytes = await seam.readSnapshot(sha)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const target = await workspaceRealpath(session, file.path)
    if (!target) return { path: file.path, status: 'skipped', reason: 'outside-workspace' }
    const stat = await ctx.fs.stat(target)
    const expected = stat
      ? { kind: 'replaceIfVersion', version: guardedVersion(stat) }
      : { kind: 'createIfAbsent' }
    // Use the standing policy; a restore must not widen read-only mode.
    const policy = ctx.sandboxPolicy?.resolve?.({ session })
    await ctx.fs.writeText(target, text, expected, undefined, policy)
    return { path: file.path, status: 'restored' }
  }

  /** Execute artifact rollback for one version (git first, snapshot fallback). */
  async function rollbackArtifacts(session, record, git) {
    const results = []
    const cwd = cwdOf(session)
    const gitPaths = []
    const snapshotJobs = []
    const deletes = []
    const headHash = git?.headHash
    for (const file of record.touchedFiles) {
      if (file.mode === 'deleted') {
        deletes.push(file)
        continue
      }
      if (git && headHash) {
        gitPaths.push(file.path)
        continue
      }
      const sha = await seam.resolveSnapshot(record.versionId, file.path)
      if (sha) snapshotJobs.push({ file, sha })
      else results.push({ path: file.path, status: 'skipped', reason: 'no-snapshot' })
    }
    if (gitPaths.length > 0 && cwd && headHash) {
      const outcome = await seam.gitCheckout(cwd, headHash, gitPaths)
      for (const path of gitPaths) {
        results.push({
          path,
          status: outcome.ok && outcome.checked.includes(path) ? 'restored' : outcome.ok ? 'unchanged' : 'failed',
        })
      }
    }
    for (const { file, sha } of snapshotJobs) {
      try {
        results.push(await restoreSnapshot(session, file, sha))
      } catch (error) {
        results.push({ path: file.path, status: 'failed', reason: String(error) })
      }
    }
    for (const file of deletes) {
      try {
        results.push(await removeOne(session, file))
      } catch (error) {
        results.push({ path: file.path, status: 'failed', reason: String(error) })
      }
    }
    return results
  }

  /** Execute a rollback (callers must preview first; the host enforces confirm). */
  async function execute(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    return locked(sessionId, async () => {
      const session = requireSession(sessionId)
      requireIdle(sessionId)
      const record = versionOf(sessionId, versionId)
      const git = seam.configFor(sessionId).git ? await seam.gitStatus(sessionId) : null
      const outcome = { op: 'restore', versionId, scope, markerSeq: null, artifacts: [], context: { messages: 0 } }

      if (scope === 'context' || scope === 'both') {
        const { diff } = contextDiff(session, record)
        if (diff.length > 0) {
          const span = { start: diff[0], end: diff[diff.length - 1], shadowedSeqs: diff.slice() }
          if (typeof writeMarker !== 'function') {
            throw editorError('writer-unavailable', 'No marker writer (adapter) is wired; cannot restore context.')
          }
          const markerEvent = await writeMarker(session, span, { op: 'restore', targetSeq: record.boundarySeq, originalText: '' })
          await flushSafely(session)
          outcome.markerSeq = markerEvent.seq
          outcome.context = { messages: diff.length }
        }
      }

      if (scope === 'artifacts' || scope === 'both') {
        outcome.artifacts = await rollbackArtifacts(session, record, git)
      }
      outcome.complete = outcome.artifacts.every((file) => ['restored', 'deleted', 'unchanged'].includes(file.status))
      return outcome
    })
  }

  async function flushSafely(session) {
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(session)
    } catch (error) {
      log(`retrace: flush failed: ${String(error)}`)
    }
  }

  return { preview, execute }
}
