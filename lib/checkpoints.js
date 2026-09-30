/** Checkpoints always mean the state BEFORE an operation, including restore. */
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstat, unlink } from 'node:fs/promises'
import { sessionEvents } from './host-compat.js'
import { editorError } from './host-core.js'
import { createCheckpointStore } from './checkpoint-store.js'
import { scanPowerShellWorkspace } from './edit-undo-pwsh.js'
import { touchedFilesFromEvent, classifyBoundaryKind } from './version-index.js'
import { isCarrierMarkerEvent } from './marker-carrier.js'
import { runningSessions } from './close-guard.js'
import { surfaceEntries, surfaceKey, planCheckpointReplay, appendCheckpointReplay } from './checkpoint-replay.js'

const scopes = new Set(['context', 'artifacts', 'both'])
const textOf = (bytes) => {
  const buffer = Buffer.from(bytes), text = buffer.toString('utf8')
  if (text.includes('\0') || !Buffer.from(text).equals(buffer)) throw editorError('unsupported', 'binary-or-encoding')
  return text
}

export function createCheckpoints(ctx, { seam, root = join(seam.storeRoot(), 'checkpoints'), log = () => {}, fileHistory = () => null } = {}) {
  const store = createCheckpointStore(root), locks = new Map(), tickets = new Map()
  const projections = () => ctx.sessions.messageProjections ?? []
  const enabled = (id) => seam.configFor(id).versioning !== false
  const locked = async (id, fn) => {
    const run = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
    const tail = run.catch(() => {})
    locks.set(id, tail)
    try { return await run } finally { if (locks.get(id) === tail) locks.delete(id) }
  }
  const requireSession = (id) => {
    const session = ctx.sessions.get(id)
    if (!session) throw editorError('session-not-found', 'Session not found')
    return session
  }
  const idle = (session, allowAgent = false) => {
    if ((!allowAgent && ctx.agents.get(session.id)?.status === 'running') || (ctx.jobs?.list?.(session.id) ?? []).some((job) => ['running', 'stopping'].includes(job.status))) {
      throw editorError('agent-busy', '请先停止当前回复和后台任务，再恢复存档。')
    }
  }
  async function filesIdle(session, allowAgent = false) {
    idle(session, allowAgent)
    const workspace = await ctx.fs.resolve(session.header.cwd)
    for (const state of runningSessions(ctx)) {
      if (state.sessionId === session.id) continue
      const cwd = ctx.sessions.get(state.sessionId)?.header.cwd
      if (!cwd) throw editorError('agent-busy', 'A running session has no verifiable workspace')
      const other = await ctx.fs.resolve(cwd)
      if (ctx.fs.contains(workspace, other) || ctx.fs.contains(other, workspace)) throw editorError('agent-busy', 'A session in this workspace is running')
    }
  }
  async function snapshotFile(target, signal) {
    const stat = await ctx.fs.stat(target, signal)
    if (!stat) return { text: null, version: null }
    if (stat.type !== 'file' || stat.size > 1024 * 1024 || !['number', 'string'].includes(typeof stat.version)) throw editorError('unsupported', 'not-text-or-too-large')
    const text = textOf(await ctx.fs.readBytes(target, signal, 1024 * 1024))
    if ((await ctx.fs.stat(target, signal))?.version !== stat.version) throw editorError('file-conflict', 'capture-raced')
    return { text, version: stat.version }
  }
  async function scan(session) {
    if (!session.header.cwd) return { files: new Map(), complete: false, warnings: ['no-workspace'] }
    try {
      await filesIdle(session, true)
      return await scanPowerShellWorkspace(ctx.fs, session.header.cwd, snapshotFile, { journalRoot: seam.storeRoot() })
    }
    catch (error) { log(`retrace: checkpoint file capture: ${error.message}`); return { files: new Map(), complete: false, warnings: ['capture-unavailable'] } }
  }
  async function capture(session, kind, extra = {}) {
    const cutSeq = sessionEvents(session).length - 1
    const entries = surfaceEntries(sessionEvents(session), projections())
    const image = await scan(session)
    if (sessionEvents(session).length - 1 !== cutSeq) throw editorError('checkpoint-raced', 'Conversation changed while saving checkpoint; retry')
    const files = []
    for (const file of image.files.values()) {
      if (file.type === 'directory') continue
      const saved = file.text === undefined ? null : await store.objectsFor(session.id).save(Buffer.from(file.text))
      files.push({ path: file.path, key: file.key, ...(saved ? { sha: saved.sha256 } : { reason: file.reason ?? 'unsupported' }) })
    }
    const excerpt = entries.slice().reverse().find(({ message }) => message.role === 'user' && message.source.kind === 'user')?.message.content
      ?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? ''
    const record = { versionId: `cp-${randomUUID()}`, cutSeq, boundarySeq: cutSeq + 1, createdAt: Date.now(), kind,
      messageCount: entries.length, markerText: excerpt.slice(0, 160), files, filesComplete: image.complete, warnings: image.warnings,
      cwd: session.header.cwd ?? null, pending: true, ...extra }
    await store.update(session.id, (records) => {
      // Finished/rejected turns with no admitted input are not checkpoints.
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i]
        if (r.pending && r.triggerIds && !committed(r, sessionEvents(session)) && sessionEvents(session).slice(r.cutSeq + 1).some((e) => e.type === 'turn/end')) records.splice(i, 1)
      }
      records.push(record)
    })
    await store.collect(session.id)
    return record
  }
  const committed = (record, events) => !record.pending || record.triggerIds?.some((id) => events
    .some((event) => event.seq > record.cutSeq && event.type === 'user/message' && event.data.id === id && event.surfaceOp === 'append'))
  async function retain(session) {
    const events = sessionEvents(session), records = await store.read(session.id)
    const done = records.filter((r) => committed(r, events))
    const fileLimit = Math.max(1, Math.min(200, seam.configFor(session.id).retentionLimit ?? 50))
    const dropped = new Set(done.filter((_r, i) => i < done.length - 200).map((r) => r.versionId))
    const expired = new Set(done.filter((r, i) => i < done.length - fileLimit && !r.filesUnavailable).map((r) => r.versionId))
    const canceled = new Set(records.filter((r) => r.pending && r.triggerIds && !committed(r, events) && events.some((e) => e.seq > r.cutSeq && e.type === 'turn/end')).map((r) => r.versionId))
    if (!dropped.size && !expired.size && !canceled.size) return
    await store.update(session.id, (saved) => {
      for (let i = saved.length - 1; i >= 0; i--) {
        if (dropped.has(saved[i].versionId) || canceled.has(saved[i].versionId)) saved.splice(i, 1)
        else if (expired.has(saved[i].versionId)) saved[i].filesUnavailable = true
      }
    })
    await store.collect(session.id)
  }
  async function recordsOf(session) {
    await retain(session)
    const events = sessionEvents(session), records = (await store.read(session.id)).filter((r) => r.cutSeq < events.length && committed(r, events))
    // Older versions can recover the conversation PREIMAGE from immutable logs.
    // Their old after-operation file captures cannot be relabeled as preimages.
    const covered = new Set(records.map((r) => r.operationSeq).filter(Number.isSafeInteger))
    const legacy = events.filter((event) => isCarrierMarkerEvent(event) && !covered.has(event.seq)).map((event) => ({
      versionId: `cp-legacy-${event.seq}`, cutSeq: event.seq - 1, boundarySeq: event.seq, createdAt: event.time,
      kind: classifyBoundaryKind(event), legacy: true, files: [], filesComplete: false, warnings: ['legacy-files-unavailable'], cwd: session.header.cwd ?? null,
      messageCount: surfaceEntries(events.slice(0, event.seq), projections()).length,
    }))
    return [...legacy, ...records].sort((a, b) => a.createdAt - b.createdAt || a.cutSeq - b.cutSeq).slice(-200)
  }
  const snapshot = (id) => locked(id, async () => {
    if (!enabled(id)) return { enabled: false, versions: [] }
    const records = await recordsOf(requireSession(id))
    return { enabled: true, semantics: 'before-operation', versions: records.map(({ files, pending, triggerIds, paths, cwd, operationSeq, ...record }) => ({ ...record, beforeOperation: true, fileCount: files.length })) }
  })
  async function performCheckpoint(session, kind, action, extra = {}) {
    if (!enabled(session.id)) return action()
    const record = await capture(session, kind, extra)
    const before = surfaceKey(surfaceEntries(sessionEvents(session).slice(0, record.cutSeq + 1), projections()))
    try { return await action() }
    finally {
      const now = sessionEvents(session)
      let changed = surfaceKey(surfaceEntries(now, projections())) !== before
      // File-only undo may have no surface event. Compare the requested files
      // with their saved bytes, including partial writes followed by rejection.
      for (const path of new Set([...(extra.paths ?? []), ...await managedPaths(session, record)])) {
        try {
          const target = await ctx.fs.resolve(path, { cwd: session.header.cwd })
          const old = record.files.find((file) => file.key === target.targetKey)
          const current = await snapshotFile(target)
          const previous = old?.sha ? textOf(await store.objectsFor(session.id).read(old.sha)) : null
          if ((old?.sha || record.filesComplete) && current.text !== previous) changed = true
        } catch { /* failed reads do not invent a successful mutation */ }
      }
      await store.update(session.id, (records) => {
        const saved = records.find((r) => r.versionId === record.versionId)
        if (!saved) return
        if (changed) {
          saved.pending = false
          saved.operationSeq = now.slice(record.cutSeq + 1).find(isCarrierMarkerEvent)?.seq
        } else records.splice(records.indexOf(saved), 1)
      })
      await retain(session)
      await store.collect(session.id)
    }
  }
  const withCheckpoint = (session, kind, action, extra) => locked(session.id, () => performCheckpoint(session, kind, action, extra))
  async function managedPaths(session, record) {
    const paths = new Set(record.paths ?? [])
    for (const event of sessionEvents(session)) for (const file of touchedFilesFromEvent(event)) paths.add(file.path)
    let history
    try { history = await fileHistory(session.id) }
    catch (error) { log(`retrace: checkpoint file history unavailable: ${error.message}`) }
    for (const turn of history?.turns ?? []) for (const file of turn.files ?? []) paths.add(file.path)
    for (const item of await store.read(session.id)) for (const path of item.paths ?? []) paths.add(path)
    return [...paths]
  }
  async function targetOf(session, path, key) {
    const cwd = session.header.cwd
    if (!cwd) throw editorError('no-workspace', 'Workspace unavailable')
    const lexical = resolve(cwd, path), rel = relative(cwd, lexical)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(/[\\/]/).some((part) => ['.git', 'node_modules'].includes(part.toLowerCase()))) throw editorError('unsafe-path', 'excluded-path')
    for (let part = lexical; part !== resolve(cwd); part = dirname(part)) {
      if ((await ctx.fs.lstat(part, { cwd }))?.type === 'symlink') throw editorError('unsafe-path', 'symlink')
    }
    const target = await ctx.fs.resolve(path, { cwd }), workspace = await ctx.fs.resolve('.', { cwd })
    const journal = await ctx.fs.resolve(seam.storeRoot(), { cwd })
    if (!ctx.fs.contains(workspace, target) || ctx.fs.contains(journal, target) || target.targetKey === workspace.targetKey || (key !== undefined && target.targetKey !== key)) throw editorError('unsafe-path', 'outside-workspace-or-path-changed')
    return target
  }
  async function filePlan(session, record) {
    const rows = [], seen = new Set()
    for (const path of await managedPaths(session, record)) {
      try {
        const target = await targetOf(session, path)
        if (seen.has(target.targetKey)) continue
        seen.add(target.targetKey)
        const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
        const old = record.files.find((file) => samePath(resolve(session.header.cwd, file.path), resolve(session.header.cwd, path)))
        if (old && old.key !== target.targetKey) throw editorError('unsafe-path', 'path-changed')
        if (record.filesUnavailable || record.cwd !== (session.header.cwd ?? null) || old?.reason || (!old && !record.filesComplete)) {
          rows.push({ path, action: 'skip', reason: record.filesUnavailable ? 'snapshot-expired' : old?.reason ?? record.warnings?.[0] ?? 'no-before-snapshot' }); continue
        }
        const current = await snapshotFile(target)
        const text = old?.sha ? textOf(await store.objectsFor(session.id).read(old.sha)) : null
        if (text !== current.text) rows.push({ path, key: target.targetKey, action: text === null ? 'delete' : 'restore', version: current.version, text })
      } catch (error) { rows.push({ path, action: 'skip', reason: error.code ?? 'unreadable' }) }
    }
    return rows
  }
  async function prepare(args, allFiles = false) {
    const session = requireSession(String(args?.sessionId ?? '')), scope = args.scope ?? 'both'
    if (!scopes.has(scope)) throw editorError('bad-scope', 'Invalid restore scope')
    const record = (await recordsOf(session)).find((r) => r.versionId === args.versionId)
    if (!record) throw editorError('version-not-found', 'Checkpoint not found')
    const target = surfaceEntries(sessionEvents(session).slice(0, record.cutSeq + 1), projections())
    const current = surfaceEntries(sessionEvents(session), projections())
    const changed = surfaceKey(target) !== surfaceKey(current)
    const files = scope === 'context' && (!allFiles || record.legacy) ? [] : await filePlan(session, record)
    return { session, scope, record, target, changed, files }
  }
  const preview = (args) => locked(args?.sessionId, async () => {
    const plan = await prepare(args, true)
    for (const [id, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(id)
    const previewToken = randomUUID()
    tickets.set(previewToken, { sessionId: plan.session.id, versionId: plan.record.versionId, cut: sessionEvents(plan.session).length,
      files: plan.files.map(({ text, ...file }) => file), expires: Date.now() + 120000 })
    return { versionId: plan.record.versionId, kind: plan.record.kind, boundarySeq: plan.record.boundarySeq, scope: plan.scope,
      previewToken,
      semantics: 'before-operation', context: { messages: plan.changed ? plan.target.length : 0, changed: plan.changed, targetMessages: plan.target.length },
      artifacts: { rows: plan.files.map(({ text, key, version, ...row }) => row) },
      applicable: (plan.scope !== 'artifacts' && plan.changed) || plan.files.some((row) => row.action !== 'skip') }
  })
  async function restoreFile(session, file) {
    const target = await targetOf(session, file.path, file.key), current = await snapshotFile(target)
    if (current.version !== file.version) throw editorError('file-conflict', 'File changed; refresh preview')
    const policy = ctx.sandboxPolicy.resolve({ session })
    if (file.action === 'delete') {
      if (![ctx.fs.withLock, ctx.fs.checkedTarget, ctx.fs.processPath].every((fn) => typeof fn === 'function')) throw editorError('delete-unavailable', 'Safe deletion unavailable')
      await ctx.fs.withLock(target.targetKey, async () => {
        idle(session)
        const checked = await ctx.fs.checkedTarget(target, policy), fresh = await targetOf(session, file.path, file.key)
        const path = ctx.fs.processPath(checked)
        if (checked.targetKey !== fresh.targetKey || !isAbsolute(path) || path !== String(checked.targetKey) || !(await lstat(path)).isFile()) throw editorError('unsafe-path', 'File target changed')
        if ((await snapshotFile(fresh)).version !== file.version) throw editorError('file-conflict', 'File changed')
        await unlink(path)
      })
    } else await ctx.fs.writeText(target, file.text, file.version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: file.version }, undefined, policy)
    return { path: file.path, status: file.action === 'delete' ? 'deleted' : 'restored' }
  }
  const execute = (args) => locked(args?.sessionId, async () => {
    const session = requireSession(String(args?.sessionId ?? ''))
    idle(session)
    const run = async () => {
      const plan = await prepare(args)
      if (typeof args.previewToken !== 'string') throw editorError('preview-required', '请先预览，再确认恢复。')
      {
        const ticket = tickets.get(args.previewToken)
        tickets.delete(args.previewToken)
        if (!ticket || ticket.expires < Date.now() || ticket.sessionId !== session.id || ticket.versionId !== plan.record.versionId || ticket.cut !== sessionEvents(session).length
          || plan.files.some((file) => file.action !== 'skip' && !ticket.files.some((old) => old.key === file.key && old.version === file.version && old.action === file.action))
          || (plan.scope !== 'context' && ticket.files.some((old) => old.action !== 'skip' && !plan.files.some((file) => old.key === file.key && old.version === file.version && old.action === file.action)))) {
          throw editorError('preview-expired', '内容已变化，请刷新预览后再恢复。')
        }
      }
      const contextChanged = plan.scope !== 'artifacts' && plan.changed
      const actionable = plan.files.filter((file) => file.action !== 'skip')
      if (!contextChanged && !actionable.length) return { complete: plan.files.length === 0, context: { messages: 0 }, artifacts: plan.files.map((file) => ({ path: file.path, status: 'skipped', reason: file.reason })) }
      if (actionable.length) await filesIdle(session)
      const replay = contextChanged ? planCheckpointReplay(session, plan.target, { projections: projections(), meter: ctx.get?.('tokenMeter') ?? ctx.tokenMeter }) : null
      return performCheckpoint(session, 'restore', async () => {
        // Capture can await filesystem reads: recheck the log before appending.
        if (replay) appendCheckpointReplay(session, replay)
        if (replay) await ctx.sessions.flush?.(session)
        const artifacts = []
        for (const file of plan.files) {
          if (file.action === 'skip') artifacts.push({ path: file.path, status: 'skipped', reason: file.reason })
          else try { await filesIdle(session); artifacts.push(await restoreFile(session, file)) }
          catch (error) { artifacts.push({ path: file.path, status: 'failed', reason: error.code ?? 'write-failed' }); break }
        }
        return { complete: artifacts.every((file) => ['deleted', 'restored'].includes(file.status)), context: { messages: contextChanged ? plan.target.length : 0 }, artifacts }
      }, { paths: actionable.map((file) => file.path) })
    }
    const agent = ctx.agents.get(session.id)
    return typeof agent?.runMaintenance === 'function' ? agent.runMaintenance(run) : run()
  })
  let dispose = null
  function register() {
    dispose = ctx.on('agent/pre-step', async (input, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || input.signal.aborted || !enabled(input.agent.id)) return decision
      const ids = decision.messages.filter((m) => m.source?.kind === 'user' && !m.id.startsWith('retrace-resend-')).map((m) => m.id)
      if (ids.length) await locked(input.agent.id, () => capture(input.agent.session, 'input', { triggerIds: ids }))
      return decision
    }, { prepend: true })
  }
  return { snapshot, preview, execute, withCheckpoint, register, dispose: () => dispose?.() }
}
