/** Per-turn undo for standard write/edit and DSH pwsh tools.
 * Snapshots are exact UTF-8 bytes, captured at the filesystem intent seam, not
 * the LF-normalized tool diff. PowerShell uses bounded workspace images;
 * binary/non-UTF-8 files remain unsupported.
 */
import { promises as disk } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { sessionEvents } from './host-compat.js'
import { pluginDataHome } from './platform/session-paths.js'
import { runningSessions, sessionRunningState } from './close-guard.js'
import { planTextUndo, resolveTextUndo } from './edit-undo-merge.js'
import { createPowerShellCapture } from './edit-undo-pwsh.js'

const MAX_FILE = 1024 * 1024
const MAX_JOURNAL = 16 * 1024 * 1024
const MAX_TURNS = 50
const hash = (value) => createHash('sha256').update(value).digest('hex')
const normalize = (text) => text?.replace(/\r\n/g, '\n') ?? null
const fail = (code, message) => Object.assign(new Error(message), { code })
const textOf = (bytes) => {
  const buffer = Buffer.from(bytes)
  const text = buffer.toString('utf8')
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(buffer)) throw fail('unsupported', 'binary-or-encoding')
  return text
}

/** Private journal writes are serialized, atomic and fsynced. No workspace I/O. */
export function createEditUndoStore(root) {
  const tails = new Map()
  const pathOf = (id) => join(root, `${hash(id)}.json`)
  async function read(id) {
    try {
      const bytes = await disk.readFile(pathOf(id))
      if (bytes.length > MAX_JOURNAL) throw fail('journal-invalid', 'Undo journal exceeds its limit')
      const data = JSON.parse(bytes.toString('utf8'))
      if (data.schema !== 1 || data.sessionId !== id || !Array.isArray(data.turns)) throw fail('journal-invalid', 'Invalid undo journal')
      return data
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, sessionId: id, turns: [] }
      throw error
    }
  }
  async function update(id, change) {
    const run = (tails.get(id) ?? Promise.resolve()).then(async () => {
      const data = await read(id)
      const result = await change(data)
      while (data.turns.length > MAX_TURNS) data.turns.shift()
      let json = JSON.stringify(data)
      while (Buffer.byteLength(json) > MAX_JOURNAL && data.turns.length > 1) {
        data.turns.shift()
        json = JSON.stringify(data)
      }
      if (Buffer.byteLength(json) > MAX_JOURNAL) throw fail('journal-full', 'Undo journal is full for this turn')
      await disk.mkdir(root, { recursive: true, mode: 0o700 })
      const temp = join(root, `${hash(id)}.${randomUUID()}.tmp`)
      try {
        const handle = await disk.open(temp, 'wx', 0o600)
        try { await handle.writeFile(json); await handle.sync() } finally { await handle.close() }
        await disk.rename(temp, pathOf(id))
        // Directory fsync is unsupported on some Windows filesystems.
        try {
          const dir = await disk.open(root, 'r')
          try { await dir.sync() } finally { await dir.close() }
        } catch { /* file fsync + atomic publication remain in effect */ }
      } finally { await disk.unlink(temp).catch((e) => { if (e.code !== 'ENOENT') throw e }) }
      return result
    })
    const tail = run.then(() => {}, () => {})
    tails.set(id, tail)
    try { return await run } finally { if (tails.get(id) === tail) tails.delete(id) }
  }
  return { read, update }
}

export function createEditUndo(ctx, { root = join(pluginDataHome(), 'dsh-retrace', 'edit-undo'), log = () => {}, conversation, powerShellLimits } = {}) {
  const store = createEditUndoStore(root)
  const pending = new WeakMap()
  const tickets = new Map()
  const operations = new Map()
  let disposed = false
  const supported = (exec) => exec && ['write', 'edit'].includes(exec.name) && exec.agent?.session
  const powerShell = createPowerShellCapture(ctx, {
    snapshot, journalRoot: root, log, limits: powerShellLimits,
    identify: (session) => ({ turn: turnOf(session), seq: sessionEvents(session).at(-1)?.seq }),
    save: (entry, changes, warnings) => store.update(entry.sessionId, (data) => {
      const group = groupOf(data, entry)
      group.warnings = [...new Set([...(group.warnings ?? []), ...warnings])]
      for (const change of changes) {
        // JSON escaping and existing edits count toward the journal cap too.
        if (Buffer.byteLength(JSON.stringify(group)) + Buffer.byteLength(JSON.stringify({ before: change.before, after: change.after })) > MAX_JOURNAL - 65536) {
          change.reason = 'capture-budget'; change.before = null; change.after = null
          group.warnings = [...new Set([...group.warnings, 'capture-budget'])]
        }
        recordEntry(group, change)
      }
    }),
  })
  const sessionOf = (id) => {
    const session = ctx.sessions?.get?.(id)
    if (!session?.header?.cwd) throw fail('session-not-found', 'Session workspace is unavailable')
    return session
  }
  function turnOf(session, args = {}) {
    if (Number.isSafeInteger(args.turn) && args.turn >= 0) return args.turn
    const events = sessionEvents(session)
    let seq = Number.isSafeInteger(args.seq) ? args.seq : null
    if (args.messageId) {
      const event = events.find((e) => e.data?.message?.id === args.messageId || e.data?.id === args.messageId)
      if (!event) throw fail('message-not-found', 'Message is not in the session log')
      seq = event.seq
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (seq !== null && event.seq > seq) continue
      if (Number.isSafeInteger(event.data?.turn)) return event.data.turn
    }
    throw fail('turn-not-found', 'No recorded turn for this message')
  }
  async function targetOf(session, path, expectedKey) {
    const cwd = session.header.cwd
    const target = await ctx.fs.resolve(path, { cwd })
    const workspace = await ctx.fs.resolve(cwd, { cwd })
    if (!ctx.fs.contains(workspace, target) || target.targetKey === workspace.targetKey) throw fail('outside-workspace', 'File is outside the session workspace')
    if (expectedKey !== undefined && target.targetKey !== expectedKey) throw fail('path-changed', 'File target changed since capture')
    return target
  }
  async function snapshot(target, signal) {
    const stat = await ctx.fs.stat(target, signal)
    if (!stat) return { text: null, version: null }
    if (stat.type !== 'file' || stat.size > MAX_FILE) throw fail('unsupported', 'not-text-or-too-large')
    if (!['string', 'number'].includes(typeof stat.version)) throw fail('unsupported', 'no-version-guard')
    const text = textOf(await ctx.fs.readBytes(target, signal, MAX_FILE))
    if ((await ctx.fs.stat(target, signal))?.version !== stat.version) throw fail('conflict', 'File changed while reading')
    return { text, version: stat.version }
  }
  async function captureIntent(target, exec, intent) {
    if (!supported(exec) || disposed) return
    const session = exec.agent.session
    const entry = { sessionId: session.id, turn: turnOf(session), seq: sessionEvents(session).at(-1)?.seq, cwd: session.header.cwd, path: target.displayPath, key: target.targetKey }
    pending.set(exec, entry)
    try {
      await targetOf(session, entry.path, entry.key)
      const before = await snapshot(target)
      const expected = exec.name === 'edit'
        ? (intent !== null && typeof intent === 'object' ? intent.version : intent)
        : intent?.kind === 'replaceIfVersion' ? intent.version : undefined
      if ((expected !== undefined && before.version !== expected) || (intent?.kind === 'createIfAbsent' && before.text !== null)) throw fail('conflict', 'stale-before-image')
      entry.before = before.text
      entry.guarded = expected !== undefined || intent?.kind === 'createIfAbsent'
    } catch (error) { entry.reason = error.message }
  }
  async function record(exec, result) {
    const entry = pending.get(exec)
    pending.delete(exec)
    if (!entry || disposed || (result?.isError && entry.afterVersion === undefined)) return
    let value = result?.value
    try {
      if (!entry.reason) {
        const session = sessionOf(entry.sessionId)
        if (session.header.cwd !== entry.cwd) throw fail('conflict', 'workspace-changed')
        const target = await targetOf(session, value?.path ?? entry.path, entry.key)
        const after = await snapshot(target)
        // rc.2 discards the result value if cancellation arrives after commit.
        // The fs/observed version still proves publication. Only a guarded
        // before-image can stand in for the absent normalized result basis.
        if (!value && entry.afterVersion !== undefined) {
          if (!entry.guarded) throw fail('conflict', 'cancelled-without-guard')
          value = { path: entry.path, before: normalize(entry.before)?.replace(/^\uFEFF/, '') ?? null, after: normalize(after.text), operation: entry.before === null ? 'create' : 'update' }
        }
        if (typeof value?.path !== 'string' || typeof value?.after !== 'string') throw fail('unsupported', 'missing-tool-result')
        // A null diff on an update means the host omitted the diff basis; it
        // never means that the file did not exist. Refuse unverifiable bases.
        const hostBefore = normalize(entry.before)?.replace(/^\uFEFF/, '') ?? null
        if (hostBefore !== value.before || (exec.name === 'write' && (value.operation === 'create') !== (entry.before === null)) || normalize(after.text) !== value.after || (entry.afterVersion !== undefined && entry.afterVersion !== after.version)) throw fail('conflict', 'capture-raced')
        entry.after = after.text
      }
    } catch (error) { entry.reason = error.message }
    entry.created = value?.operation === 'create'
    await store.update(entry.sessionId, (data) => recordEntry(groupOf(data, entry), entry))
  }
  function groupOf(data, entry) {
    let group = data.turns.find((g) => g.turn === entry.turn)
    if (!group) { group = { turn: entry.turn, firstSeq: entry.seq, cwd: entry.cwd, files: [], updatedAt: Date.now() }; data.turns.push(group) }
    return group
  }
  function recordEntry(group, entry) {
    let file = group.files.find((f) => f.path === entry.path || f.key === entry.key)
    if (!file) {
      file = { id: randomUUID(), path: entry.path, key: entry.key, before: entry.before ?? null, after: entry.after ?? null, created: entry.created }
      group.files.push(file)
    } else if (!file.reason && !entry.reason && file.after !== entry.before) {
      file.reason = 'intervening-change'
    }
    if (entry.reason) file.reason = entry.reason
    file.after = entry.after ?? null
    file.restored = false
    group.updatedAt = Date.now()
  }
  function assertIdle(session) {
    if (powerShell.pending().some((entry) => entry.sessionId === session.id || entry.cwd === session.header.cwd)) throw fail('agent-busy', 'PowerShell file capture is still pending')
    if (sessionRunningState(ctx, session.id).running) throw fail('agent-busy', 'Stop this session before undoing file edits')
    for (const state of runningSessions(ctx)) {
      if (state.sessionId === session.id) continue
      const other = ctx.sessions.get(state.sessionId)
      // Overlapping workspaces may contain aliases; compare canonical targets
      // in the async preflight as well. Exact cwd covers the usual sibling case.
      if (other?.header?.cwd === session.header.cwd) throw fail('agent-busy', 'Another session in this workspace is running')
    }
  }
  async function assertWorkspaceIdle(session) {
    assertIdle(session)
    const workspace = await ctx.fs.resolve(session.header.cwd)
    for (const entry of powerShell.pending()) if (!entry.workspace || ctx.fs.contains(workspace, entry.workspace) || ctx.fs.contains(entry.workspace, workspace)) throw fail('agent-busy', 'PowerShell file capture is still pending in this workspace')
    for (const state of runningSessions(ctx)) {
      const cwd = ctx.sessions.get(state.sessionId)?.header?.cwd
      if (!cwd) throw fail('agent-busy', 'A running session has no verifiable workspace')
      const other = await ctx.fs.resolve(cwd)
      if (ctx.fs.contains(workspace, other) || ctx.fs.contains(other, workspace)) throw fail('agent-busy', 'A session in this workspace is running')
    }
  }
  const revision = (group) => hash(JSON.stringify(group))
  const excerpt = (text) => text === null ? null : text.slice(0, 4000)
  const contentHash = (text) => hash(text === null ? 'absent' : `text:${text}`)
  function selection(data, session, plan) {
    const groups = data.turns.filter((group) => Number.isSafeInteger(group.firstSeq) ? group.firstSeq >= plan.targetSeq : plan.turns.includes(group.turn)).sort((a, b) => a.turn - b.turn)
    if (groups.some((group) => group.cwd !== session.header.cwd)) throw fail('workspace-changed', 'Session workspace changed')
    const files = new Map()
    for (const group of groups) for (const source of group.files) {
      if (source.restored) continue
      let file = files.get(source.key)
      if (!file) { file = { ...source, refs: [] }; files.set(source.key, file) }
      else if (file.after !== source.before) {
        if (file.before === null && file.created) file.requiresChoice = true
        else if (file.before !== null && file.after !== null && source.before !== null) {
          try {
            const gap = planTextUndo(file.before, file.after, source.before)
            if (gap.conflicts.length) file.reason = 'intervening-change'
            else file.before = resolveTextUndo(gap)
          } catch { file.reason = 'intervening-change' }
        } else file.reason = 'intervening-change'
      }
      file.after = source.after
      if (source.reason) file.reason = source.reason
      file.refs.push({ turn: group.turn, id: source.id })
    }
    return { turn: null, cwd: session.header.cwd, files: [...files.values()], warnings: [...new Set(groups.flatMap((group) => group.warnings ?? []))], revision: hash(JSON.stringify(groups)), turns: groups.map((group) => group.turn) }
  }
  function deletionSupported() {
    // rc.2 exposes no remove method. Local backends expose their target lock
    // and process path; deletion must share that lock with write/edit and pass
    // the sandbox backend's own identity/policy check. Other backends refuse.
    return typeof ctx.fs.withLock === 'function' && typeof ctx.fs.processPath === 'function' && typeof ctx.fs.checkedTarget === 'function'
  }
  async function inspect(session, file) {
    const row = { id: file.id, path: file.path, action: file.before === null && file.created ? 'delete' : 'restore', before: excerpt(file.before), after: excerpt(file.after), truncated: (file.before?.length ?? 0) > 4000 || (file.after?.length ?? 0) > 4000 }
    if (file.reason) return { ...row, status: 'unsupported', reason: file.reason }
    try {
      const target = await targetOf(session, file.path, file.key)
      const current = await snapshot(target)
      const state = { current: excerpt(current.text), version: current.version, currentHash: contentHash(current.text), truncated: row.truncated || (current.text?.length ?? 0) > 4000 }
      if (file.restored) return { ...row, ...state, status: file.kept ? 'kept' : 'restored' }
      if (current.text === file.before || file.before === file.after) return { ...row, ...state, status: 'restored' }
      if (file.before === null && !deletionSupported()) return { ...row, status: 'unsupported', reason: 'no-safe-delete' }
      let plan
      if (file.before === null || file.after === null || current.text === null) {
        const conflict = { id: 'file-state', kind: 'file-state', current: current.text, undo: file.before }
        plan = { kind: 'file-state', current: current.text, undo: file.before, conflicts: current.text === file.after && !file.requiresChoice ? [] : [conflict] }
      } else plan = planTextUndo(file.before, file.after, current.text)
      const conflicts = plan.conflicts.map((conflict) => ({ ...conflict, current: excerpt(conflict.current), undo: excerpt(conflict.undo), truncated: (conflict.current?.length ?? 0) > 4000 || (conflict.undo?.length ?? 0) > 4000 }))
      return { ...row, ...state, status: conflicts.length ? 'needs-choice' : 'ready', conflicts, plan }
    } catch (error) { return { ...row, status: error.code === 'merge-limit' ? 'unsupported' : 'conflict', reason: error.code ?? 'unreadable' } }
  }
  async function preview(args) {
    await powerShell.flush()
    const sessionId = String(args?.sessionId ?? '')
    const session = sessionOf(sessionId)
    const both = args?.mode === 'both'
    if (args?.mode && !['files', 'both'].includes(args.mode)) throw fail('bad-request', 'Unknown undo mode')
    if (both && !conversation) throw fail('unsupported', 'Conversation rewind is unavailable')
    const plan = both ? await conversation.preview(session, args.messageId) : null
    const turn = both ? null : turnOf(session, args)
    const data = await store.read(sessionId)
    const group = both ? selection(data, session, plan) : data.turns.find((g) => g.turn === turn)
    const busy = (() => { try { assertIdle(session); return false } catch { return true } })()
    if (!group) return { turn, files: [], busy, ticket: null, warnings: [], incomplete: false }
    if (group.cwd !== session.header.cwd) throw fail('workspace-changed', 'Session workspace changed')
    const files = await Promise.all(group.files.map((file) => inspect(session, file)))
    for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key)
    while (tickets.size >= 64) tickets.delete(tickets.keys().next().value)
    const ticket = randomUUID()
    tickets.set(ticket, { sessionId, turn, mode: both ? 'both' : 'files', conversation: plan, revision: both ? group.revision : revision(group), files: files.map(({ plan: _plan, ...file }) => file), expires: Date.now() + 300000 })
    return { turn, files: files.map(({ version: _version, currentHash: _hash, plan: _plan, ...file }) => file), busy, ticket, warnings: group.warnings ?? [], incomplete: !!group.warnings?.length, ...(both ? { mode: 'both', turns: group.turns, shadowed: plan.span.shadowedSeqs.length } : {}) }
  }
  async function removeCreated(session, file, target, version, expectedHash, policy) {
    if (!deletionSupported()) throw fail('unsupported', 'Safe deletion is unavailable on this filesystem')
    await ctx.fs.withLock(target.targetKey, async () => {
      await assertWorkspaceIdle(session)
      const checked = await ctx.fs.checkedTarget(target, policy)
      if (checked.targetKey !== file.key) throw fail('path-changed', 'File target changed')
      const fresh = await targetOf(session, file.path, file.key)
      const current = await snapshot(fresh)
      if (current.version !== version || contentHash(current.text) !== expectedHash) throw fail('conflict', 'File changed since preview')
      const path = ctx.fs.processPath(checked)
      if (!isAbsolute(path) || path !== String(checked.targetKey) || !(await disk.lstat(path)).isFile()) throw fail('unsupported', 'Cannot safely delete this target')
      await disk.unlink(path)
    })
  }
  async function applyUndo(args) {
    const sessionId = String(args?.sessionId ?? '')
    if (operations.has(sessionId)) throw fail('agent-busy', 'An undo operation is already running')
    operations.set(sessionId, true)
    try {
      const ticket = tickets.get(args?.ticket)
      tickets.delete(args?.ticket)
      if (!ticket || ticket.sessionId !== sessionId || ticket.expires < Date.now()) throw fail('preview-expired', 'Refresh the file preview before undoing')
      const session = sessionOf(sessionId)
      if ((args.mode ?? 'files') !== ticket.mode || (ticket.mode === 'both' && args.fileId)) throw fail('bad-request', 'Combined rewind must apply the entire preview')
      await assertWorkspaceIdle(session)
      const applyFiles = () => store.update(sessionId, async (data) => {
        const both = ticket.mode === 'both'
        const group = both ? selection(data, session, ticket.conversation) : data.turns.find((g) => g.turn === ticket.turn)
        if (!group || group.cwd !== session.header.cwd || (both ? group.revision : revision(group)) !== ticket.revision) throw fail('preview-expired', 'Edits changed; refresh the preview')
        if (!args.fileId && group.warnings?.length) throw fail('capture-incomplete', 'PowerShell capture is incomplete; undo only individually verified files or recall the conversation separately')
        const ids = args.fileId ? [args.fileId] : group.files.map((f) => f.id)
        const selected = ids.map((id) => group.files.find((f) => f.id === id))
        if ((!selected.length && !both) || selected.some((f) => !f)) throw fail('bad-request', 'Unknown file selection')
        const resolutions = args.resolutions ?? {}
        if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions) || Object.keys(resolutions).some((id) => !group.files.some((file) => file.id === id))) throw fail('bad-request', 'Invalid conflict choices')
        const plans = []
        // Validate EVERY selected file before the first mutation. Execution
        // remains per-file CAS guarded; failures report partial completion.
        for (const file of selected) {
          const old = ticket.files.find((f) => f.id === file.id)
          const fresh = await inspect(session, file)
          if (file.restored || (['restored', 'kept'].includes(old?.status) && fresh.status === old.status)) continue
          if (!['ready', 'needs-choice'].includes(fresh.status) || fresh.status !== old?.status || fresh.version !== old.version || fresh.currentHash !== old.currentHash) throw fail('conflict', 'A selected file changed; refresh the preview and choose again')
          const choices = resolutions[file.id] ?? {}
          if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw fail('bad-request', 'Invalid conflict choices')
          let text
          if (fresh.plan.kind === 'file-state') {
            if (Object.keys(choices).some((id) => id !== 'file-state') || (fresh.plan.conflicts.length && !['current', 'undo'].includes(choices['file-state'])) || (!fresh.plan.conflicts.length && Object.keys(choices).length)) throw fail('resolution-required', 'Choose whether to keep the current file state or undo it')
            text = choices['file-state'] === 'current' ? fresh.plan.current : fresh.plan.undo
          } else text = resolveTextUndo(fresh.plan, choices)
          if (text !== null && Buffer.byteLength(text) > MAX_FILE) throw fail('unsupported', 'Merged content exceeds the file size limit')
          plans.push({ file, version: fresh.version, currentHash: fresh.currentHash, text })
        }
        const results = []
        for (const { file, version, currentHash, text } of plans) {
          try {
            await assertWorkspaceIdle(session)
            const target = await targetOf(session, file.path, file.key)
            const current = await snapshot(target)
            if (current.version !== version || contentHash(current.text) !== currentHash) throw fail('conflict', 'File changed since preview')
            if (current.text !== text) {
              const policy = ctx.sandboxPolicy.resolve({ session })
              if (text === null) await removeCreated(session, file, target, version, currentHash, policy)
              else await ctx.fs.writeText(target, text, version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version }, undefined, policy)
            }
            file.restored = true
            file.kept = current.text === text
            file.resolutions = resolutions[file.id] ?? {}
            for (const ref of file.refs ?? []) {
              const recorded = data.turns.find((group) => group.turn === ref.turn)?.files.find((source) => source.id === ref.id)
              if (recorded) { recorded.restored = true; recorded.kept = file.kept; recorded.resolutions = file.resolutions }
            }
            results.push({ id: file.id, path: file.path, status: file.kept ? 'kept' : 'restored' })
          } catch (error) {
            results.push({ id: file.id, path: file.path, status: 'failed', reason: error.code ?? 'write-failed' })
            break
          }
        }
        return { turn: group.turn, results, complete: results.every((r) => r.status === 'restored' || r.status === 'kept') }
      })
      return ticket.mode === 'both' ? await conversation.run(session, ticket.conversation, applyFiles) : await applyFiles()
    } finally { operations.delete(sessionId) }
  }
  function register() {
    const disposers = []
    const on = (event, callback, options = {}) => disposers.push(ctx.on(event, callback, { global: true, ...options }))
    // The host observation policy is a terminal waterfall listener. Capture
    // must wrap it, retaining its returned guard and its rejection behavior.
    on('fs/write-intent', async (target, exec, next) => {
      const intent = await next()
      try { await captureIntent(target, exec, intent) } catch (error) { log(`retrace: edit undo capture failed: ${error}`) }
      return intent
    }, { prepend: true })
    on('fs/edit-intent', async (target, exec, next) => {
      const intent = await next()
      try { await captureIntent(target, exec, intent) } catch (error) { log(`retrace: edit undo capture failed: ${error}`) }
      return intent
    }, { prepend: true })
    on('fs/observed', (target, observation, exec) => {
      const entry = pending.get(exec)
      if (entry && entry.key === target.targetKey && observation.kind === 'present') entry.afterVersion = observation.version
    })
    on('tools/execute', async (exec, next) => {
      let capture, result
      try {
        try { capture = await powerShell.begin(exec) } catch (error) { log(`retrace: PowerShell before-image failed: ${error}`) }
        result = await next()
        try { await record(exec, result) } catch (error) { log(`retrace: edit undo journal failed: ${error}`) }
        return result
      } finally {
        pending.delete(exec)
        try { powerShell.end(capture, result); await powerShell.flush() }
        catch (error) { log(`retrace: PowerShell capture finalization failed: ${error}`) }
      }
    })
    log('retrace: per-turn file undo active (write/edit + PowerShell workspace capture, UTF-8 files up to 1 MiB)')
    return () => { disposed = true; powerShell.dispose(); tickets.clear(); disposers.forEach((dispose) => dispose?.()) }
  }
  const envelope = (fn) => async (args) => {
    try { return { ok: true, value: await fn(args) } }
    catch (error) { return { ok: false, error: { ...error.details, code: error.code ?? 'internal', message: error.message } } }
  }
  return { register, preview: envelope(preview), apply: envelope(applyUndo) }
}
