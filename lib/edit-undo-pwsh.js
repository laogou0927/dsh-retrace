/** Workspace before/after images for DSH's pwsh tool, including managed jobs.
 * Commands remain untouched. Only provider-backed, contained regular files are
 * read; directory links, dependencies and the private journal are excluded.
 */
import { runningSessions } from './close-guard.js'
export const PWSH_CAPTURE_LIMITS = Object.freeze({ entries: 5000, bytes: 8 * 1024 * 1024, milliseconds: 5000, depth: 64 })
const excluded = new Set(['.git', 'node_modules'])

export async function scanPowerShellWorkspace(fs, cwd, snapshot, { journalRoot, limits = PWSH_CAPTURE_LIMITS } = {}) {
  const workspace = await fs.resolve(cwd, { cwd })
  const journal = journalRoot ? await fs.resolve(journalRoot, { cwd }) : null
  const files = new Map(), warnings = new Set(), seen = new Set()
  const queue = [{ target: workspace, depth: 0 }]
  let entries = 0, bytes = 0, complete = true
  const started = Date.now()
  const signal = AbortSignal.timeout(limits.milliseconds)
  while (queue.length) {
    const { target, depth } = queue.shift()
    if (seen.has(target.targetKey)) continue
    seen.add(target.targetKey)
    if (Date.now() - started > limits.milliseconds || depth > limits.depth) { complete = false; warnings.add('capture-limit'); break }
    let children
    try { children = await fs.listDir(target, signal) }
    catch { complete = false; warnings.add(signal.aborted ? 'capture-limit' : 'capture-unreadable'); continue }
    for (const child of children) {
      if (++entries > limits.entries || Date.now() - started > limits.milliseconds) { complete = false; warnings.add('capture-limit'); break }
      if (excluded.has(child.name.toLowerCase())) continue
      const path = child.target.displayPath
      try {
        // listDir follows links on rc.2. lstat the lexical entry before any
        // descent/read, then check the provider's canonical containment.
        const local = await fs.lstat(path, { cwd }, signal)
        const resolved = await fs.resolve(path, { cwd, signal })
        if (local?.type === 'symlink' || !fs.contains(workspace, resolved) || (journal && fs.contains(journal, resolved))) {
          files.set(path, { path, key: resolved.targetKey, type: 'symlink', version: local?.version, reason: 'symlink' })
          continue
        }
        const stat = await fs.stat(resolved, signal)
        if (!stat) { complete = false; warnings.add('capture-raced'); continue }
        const entry = { path, key: resolved.targetKey, type: stat.type, version: stat.version }
        files.set(path, entry)
        if (stat.type === 'directory') { queue.push({ target: resolved, depth: depth + 1 }); continue }
        if (stat.type !== 'file' || stat.size > 1024 * 1024) { entry.reason = 'not-text-or-too-large'; continue }
        if (bytes + stat.size > limits.bytes) { entry.reason = 'capture-budget'; warnings.add('capture-budget'); continue }
        bytes += stat.size
        try {
          const value = await snapshot(resolved, signal)
          if (value.version !== stat.version) throw new Error('capture-raced')
          entry.text = value.text
        } catch (error) { entry.reason = error.message }
      } catch { complete = false; warnings.add(signal.aborted ? 'capture-limit' : 'capture-unreadable') }
    }
    if (!complete && warnings.has('capture-limit')) break
  }
  return { workspace, files, complete, warnings: [...warnings] }
}

/** One middleware instance owns pending images until the actual managed job
 * settles. Overlapping file tools never acquire trustworthy undo attribution.
 */
export function createPowerShellCapture(ctx, { snapshot, journalRoot, identify, save, log, limits } = {}) {
  const active = new Set(), finishing = new Set()
  let disposed = false
  const overlaps = (a, b) => ctx.fs.contains(a, b) || ctx.fs.contains(b, a)
  const scan = (entry) => scanPowerShellWorkspace(ctx.fs, entry.cwd, snapshot, { journalRoot, limits })
  async function begin(exec) {
    if (disposed || !['pwsh', 'write', 'edit'].includes(exec?.name) || !exec.agent?.session) return null
    const session = exec.agent.session
    const entry = { ...identify(session), cwd: session.header.cwd, sessionId: session.id, shell: exec.name === 'pwsh', jobs: new Map(), waiting: false }
    try { entry.workspace = await ctx.fs.resolve(entry.cwd, { cwd: entry.cwd }) }
    catch (error) {
      if (!entry.shell) return null
      entry.problem = 'capture-provider'; active.add(entry); return entry
    }
    for (const other of active) if (!other.workspace || overlaps(entry.workspace, other.workspace)) {
      if (entry.shell) entry.concurrent = true
      if (other.shell) other.concurrent = true
    }
    active.add(entry)
    if (!entry.shell) return entry
    try {
      // This also catches jobs started before plugin activation, whose original
      // tools/execute call could not enter our middleware.
      if ((ctx.jobs?.list?.(entry.sessionId) ?? []).some((job) => ['running', 'stopping'].includes(job.status))) entry.concurrent = true
      for (const state of runningSessions(ctx)) {
        if (state.sessionId === entry.sessionId) continue
        const cwd = ctx.sessions.get(state.sessionId)?.header?.cwd
        if (!cwd || overlaps(entry.workspace, await ctx.fs.resolve(cwd))) entry.concurrent = true
      }
      if (typeof ctx.fs.listDir !== 'function' || typeof ctx.fs.lstat !== 'function') throw new Error('capture-provider')
      entry.before = await scan(entry)
      const events = ctx.jobs?.events
      if (typeof events?.subscribe === 'function') entry.unsubscribe = events.subscribe({ owners: 'all' }, (event) => {
        const job = event.job
        if (job?.kind !== 'pwsh' || job.owner !== exec.agent.id) return
        if (event.type === 'registered' && job.label === exec.arguments?.command) entry.jobs.set(job.id, job.status)
        if (entry.jobs.has(job.id) && event.type === 'settled') {
          entry.jobs.set(job.id, job.status)
          if (event.cause === 'teardown') entry.concurrent = true
          if (entry.waiting && settled(entry)) finish(entry)
        }
      })
    } catch (error) { entry.problem = error.message; log(`retrace: PowerShell capture unavailable: ${error}`) }
    return entry
  }
  const settled = (entry) => [...entry.jobs.values()].every((status) => !['running', 'stopping'].includes(status))
  function finish(entry) {
    if (entry.finishing || disposed) return
    entry.finishing = true
    entry.unsubscribe?.()
    const run = (async () => {
      const changes = [], warnings = new Set(entry.before?.warnings ?? [])
      if (entry.problem) warnings.add(entry.problem)
      if (entry.concurrent) warnings.add('capture-concurrent')
      if (entry.before) {
        const after = await scan(entry)
        if (entry.concurrent) warnings.add('capture-concurrent')
        if (entry.before.workspace.targetKey !== after.workspace.targetKey) { entry.problem = 'capture-raced'; warnings.add('capture-raced') }
        after.warnings.forEach((warning) => warnings.add(warning))
        for (const path of new Set([...entry.before.files.keys(), ...after.files.keys()])) {
          const before = entry.before.files.get(path), next = after.files.get(path)
          if (before?.type !== 'file' && next?.type !== 'file') continue
          if (before && next && ((!before.reason && !next.reason && before.text === next.text) || (before.reason && next.reason && before.version === next.version && before.key === next.key))) continue
          let reason = entry.problem ?? before?.reason ?? next?.reason
          if ((!before && !entry.before.complete) || (!next && !after.complete)) reason = 'capture-incomplete'
          if (before && next && before.key !== next.key) reason = 'path-changed'
          if (entry.concurrent) reason = 'capture-concurrent'
          changes.push({ ...entry, path, key: (before ?? next).key, before: before?.text ?? null, after: next?.text ?? null, created: !before, ...(reason ? { reason } : {}) })
        }
      }
      if (!disposed && (changes.length || warnings.size)) await save(entry, changes, [...warnings])
    })().catch(async (error) => {
      log(`retrace: PowerShell capture failed: ${error}`)
      if (!disposed) await save(entry, [], ['capture-failed']).catch((error) => log(`retrace: PowerShell journal failed: ${error}`))
    }).finally(() => { active.delete(entry); finishing.delete(run) })
    finishing.add(run)
  }
  function end(entry, result) {
    if (!entry) return
    if (!entry.shell) { active.delete(entry); return }
    const value = result?.value
    // The alternate persistent PTY tool also calls itself pwsh, but exposes
    // no completed-command DTO (a stdin prompt can return early). Do not
    // silently certify that terminal as a settled foreground command.
    if (typeof value === 'string') entry.problem = 'capture-persistent'
    if (['background', 'promoted'].includes(value?.kind)) {
      // The subscription was attached before execution, so a very fast job's
      // settled event is retained even if it arrives before this tool returns.
      if (!entry.jobs.has(value.jobId)) {
        try { entry.jobs.set(value.jobId, ctx.jobs.get(value.jobId, entry.sessionId).status) }
        catch { entry.problem = 'capture-job-unavailable' }
      }
      if (!entry.unsubscribe) entry.problem = 'capture-job-unavailable'
    }
    entry.waiting = true
    if (settled(entry) || entry.problem) finish(entry)
  }
  return {
    begin, end,
    pending: () => [...active].filter((entry) => entry.shell),
    flush: async () => { while (finishing.size) await Promise.all([...finishing]) },
    dispose: () => { disposed = true; for (const entry of active) entry.unsubscribe?.(); active.clear() },
  }
}
