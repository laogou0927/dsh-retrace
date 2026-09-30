import { afterEach, describe, expect, it } from 'vitest'
import { promises as disk } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createEditUndo, createEditUndoStore } from '../lib/edit-undo.js'
import { Context } from '@deepseek-ai/cordis'

const roots = []
const eventContexts = []
afterEach(async () => {
  for (const ctx of eventContexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await disk.rm(root, { recursive: true, force: true })
})
const norm = (s) => s?.replace(/\r\n/g, '\n') ?? null

async function fixture({ terminalPolicy = false, rejectEdit = false, conversation, powerShellLimits } = {}) {
  const root = await disk.mkdtemp(join(tmpdir(), 'retrace-edit-undo-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await disk.mkdir(workspace)
  const listeners = new Map(), locks = new Map()
  const eventCtx = new Context()
  eventContexts.push(eventCtx)
  for (const name of ['tools/execute', 'fs/write-intent', 'fs/edit-intent']) {
    listeners.set(name, (...args) => eventCtx.waterfall(name, ...args))
  }
  listeners.set('fs/observed', (...args) => eventCtx.emit('fs/observed', ...args))
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'turn/end', data: { turn: 1 } }, { seq: 2, type: 'assistant/message', data: { turn: 1, message: { id: 'reply' } } }]
  const session = { id: 's1', header: { cwd: workspace }, snapshotEvents: () => events }
  const sessions = new Map([['s1', session]])
  const agent = { id: 's1', session, status: 'idle' }
  const agents = new Map([['s1', agent]])
  const fs = {
    async resolve(path, opts = {}) {
      const displayPath = resolve(opts.cwd ?? workspace, path)
      let base = displayPath, suffix = []
      for (;;) {
        try { return { displayPath, targetKey: join(await disk.realpath(base), ...suffix.reverse()) } }
        catch (error) {
          if (error.code !== 'ENOENT') throw error
          suffix.push(base.slice(base.lastIndexOf(sep) + 1))
          base = resolve(base, '..')
        }
      }
    },
    contains(parent, child) { const p = relative(parent.targetKey, child.targetKey); return p === '' || (p !== '..' && !p.startsWith(`..${sep}`) && !p.startsWith(sep)) },
    async stat(target) {
      try {
        const st = await disk.stat(target.targetKey, { bigint: true })
        return { type: st.isFile() ? 'file' : 'directory', size: Number(st.size), version: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` }
      } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    },
    readBytes: (target) => disk.readFile(target.targetKey),
    async lstat(path, opts = {}) {
      try {
        const st = await disk.lstat(resolve(opts.cwd ?? workspace, path), { bigint: true })
        return { type: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'directory', size: Number(st.size), version: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` }
      } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    },
    async listDir(target) {
      const children = await disk.readdir(target.targetKey)
      return Promise.all(children.sort().map(async (name) => ({ name, target: await fs.resolve(join(target.displayPath, name)) })))
    },
    async withLock(key, fn) {
      const run = (locks.get(key) ?? Promise.resolve()).then(fn)
      const tail = run.catch(() => {})
      locks.set(key, tail)
      try { return await run } finally { if (locks.get(key) === tail) locks.delete(key) }
    },
    processPath: (target) => target.targetKey,
    async checkedTarget(target, policy) {
      if (policy.mode === 'read-only') throw Object.assign(new Error('Denied'), { code: 'FS_SANDBOX_DENIED' })
      if (policy.mode === 'danger-full-access') return target
      const fresh = await fs.resolve(target.displayPath)
      if (!fs.contains(await fs.resolve(policy.workspaceRoot), fresh)) throw new Error('Denied')
      return fresh
    },
    async writeText(target, text, expected, _signal, policy) {
      target = await fs.checkedTarget(target, policy)
      return fs.withLock(target.targetKey, async () => {
        const stat = await fs.stat(target)
        if (expected?.kind === 'replaceIfVersion' && stat?.version !== expected.version) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
        if (expected?.kind === 'createIfAbsent' && stat) throw new Error('exists')
        await disk.mkdir(resolve(target.targetKey, '..'), { recursive: true })
        await disk.writeFile(target.targetKey, text)
      })
    },
  }
  const ctx = {
    fs, sessions: { get: (id) => sessions.get(id), list: () => [...sessions.values()] }, agents: { get: (id) => agents.get(id) },
    jobs: { list: () => [] }, sandboxPolicy: { resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: session.header.cwd }) },
    on: (name, fn, options) => { expect(options.global).toBe(true); return eventCtx.on(name, fn, options) },
  }
  // Match Desktop's composition order and terminal (no next()) behavior.
  // The separate installed-host smoke uses the official policy implementation.
  if (terminalPolicy) {
    eventCtx.on('fs/write-intent', async (target) => {
      const stat = await fs.stat(target)
      return stat ? { kind: 'replaceIfVersion', version: stat.version } : { kind: 'createIfAbsent' }
    })
    eventCtx.on('fs/edit-intent', async (target) => {
      if (rejectEdit) throw Object.assign(new Error('read required'), { code: 'FS_NOT_OBSERVED' })
      return { version: (await fs.stat(target))?.version }
    })
  }
  const undo = createEditUndo(ctx, { root: join(root, 'journal'), conversation, powerShellLimits })
  undo.register()
  async function tool(path, after, { turn = 1, name = 'write', isError = false, omittedBefore = false, abortAfterCommit = false } = {}) {
    events.push({ seq: events.length, type: 'turn/end', data: { turn } })
    const target = await fs.resolve(path)
    const stat = await fs.stat(target)
    const before = stat ? (await disk.readFile(target.targetKey)).toString('utf8') : null
    const exec = { name, agent, arguments: { file_path: path } }
    const result = { isError, value: { path: target.displayPath, before: omittedBefore ? null : norm(before)?.replace(/^\uFEFF/, '') ?? null, after: norm(after), ...(name === 'write' ? { operation: before === null ? 'create' : 'update' } : {}) } }
    await listeners.get('tools/execute')(exec, async () => {
      if (!['write', 'edit'].includes(name)) { await disk.writeFile(target.targetKey, after); return result }
      const expected = stat ? { kind: 'replaceIfVersion', version: stat.version } : { kind: 'createIfAbsent' }
      await listeners.get(name === 'write' ? 'fs/write-intent' : 'fs/edit-intent')(target, exec, async () => name === 'edit' ? { version: stat?.version } : expected)
      if (!isError) {
        await fs.writeText(target, after, expected, undefined, ctx.sandboxPolicy.resolve({ session }))
        listeners.get('fs/observed')(target, { kind: 'present', version: (await fs.stat(target)).version }, exec)
        if (abortAfterCommit) { result.isError = true; delete result.value }
      }
      return result
    })
  }
  const preview = (args = {}) => undo.preview({ sessionId: 's1', turn: 1, ...args })
  const apply = (ticket, fileId, resolutions) => undo.apply({ sessionId: 's1', ticket, ...(fileId ? { fileId } : {}), ...(resolutions ? { resolutions } : {}) })
  const pwsh = async (run, { turn = 1, result = { isError: false, value: { kind: 'foreground', exitCode: 0 } }, command = 'fixture' } = {}) => {
    events.push({ seq: events.length, type: 'turn/end', data: { turn } })
    return listeners.get('tools/execute')({ name: 'pwsh', agent, arguments: { command } }, async () => { await run(); return result })
  }
  return { root, workspace, ctx, fs, undo, events, agent, agents, sessions, session, listeners, tool, pwsh, preview, apply }
}

describe('PowerShell workspace capture', () => {
  it('offers old captures in the timeline, persists exact outcomes and exposes no file contents', async () => {
    const f = await fixture()
    await disk.writeFile(join(f.workspace, 'a'), 'private-before')
    await f.tool('a', 'private-after')
    const before = await f.undo.timeline('s1')
    expect(before.turns).toMatchObject([{ turn: 1, files: [{ status: 'recorded' }] }])
    expect(before.fileUndos).toEqual([])
    expect(JSON.stringify(before)).not.toMatch(/private-before|private-after/)
    const p = await f.preview()
    expect((await f.undo.timeline('s1')).fileUndos).toEqual([])
    await f.apply(p.value.ticket)
    const after = await f.undo.timeline('s1')
    expect(after.turns[0].files[0].status).toBe('restored')
    expect(after.fileUndos).toMatchObject([{ kind: 'file-undo', turn: 1, complete: true, results: [{ status: 'restored' }] }])
    const restarted = createEditUndo(f.ctx, { root: join(f.root, 'journal') })
    expect(await restarted.timeline('s1')).toEqual(after)
    const again = await f.preview()
    await f.apply(again.value.ticket)
    expect((await f.undo.timeline('s1')).fileUndos).toHaveLength(1)
    await f.apply('expired')
    expect((await f.undo.timeline('s1')).fileUndos).toHaveLength(1)
  })
  it('bounds durable file undo history without discarding current captured edits', async () => {
    const f = await fixture(), store = createEditUndoStore(join(f.root, 'journal'))
    await f.tool('a', 'a')
    await store.update('s1', (data) => { data.activities = Array.from({ length: 205 }, (_, i) => ({ id: String(i), results: [], complete: true })) })
    const history = await f.undo.timeline('s1')
    expect(history.fileUndos).toHaveLength(200)
    expect(history.fileUndos[0].id).toBe('5')
    expect(history.turns).toHaveLength(1)
  })
  it('records modification, creation, deletion and rename without prior read calls; raw bytes return', async () => {
    const f = await fixture(), path = (name) => join(f.workspace, name)
    const raw = '\uFEFFfirst\r\nsecond\r\n'
    await disk.writeFile(path('old.txt'), raw)
    await disk.writeFile(path('deleted.txt'), 'removed')
    await disk.writeFile(path('renamed.txt'), 'moved')
    await f.pwsh(async () => {
      await disk.writeFile(path('old.txt'), 'changed\r\nsecond\r\n')
      await disk.mkdir(path('sub'))
      await disk.writeFile(path('sub/new.txt'), 'new')
      await disk.unlink(path('deleted.txt'))
      await disk.rename(path('renamed.txt'), path('moved.txt'))
    })
    const p = await f.preview()
    expect(p.value.incomplete).toBe(false)
    expect(p.value.files).toHaveLength(5)
    expect(p.value.files.every((file) => file.status === 'ready')).toBe(true)
    const beforeLog = JSON.stringify(f.events)
    expect((await f.apply(p.value.ticket)).value.complete).toBe(true)
    expect(await disk.readFile(path('old.txt'), 'utf8')).toBe(raw)
    expect(await disk.readFile(path('deleted.txt'), 'utf8')).toBe('removed')
    expect(await disk.readFile(path('renamed.txt'), 'utf8')).toBe('moved')
    for (const name of ['moved.txt', 'sub/new.txt']) await expect(disk.stat(path(name))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(f.events)).toBe(beforeLog)
  })
  it('combines shell and standard edits in one turn, preserving unrelated later changes and requiring overlap choices', async () => {
    const f = await fixture(), path = join(f.workspace, 'a')
    await disk.writeFile(path, 'first = old\nsecond = old\n')
    await f.pwsh(() => disk.writeFile(path, 'first = shell\nsecond = old\n'))
    await f.tool('a', 'first = standard\nsecond = old\n', { name: 'edit' })
    await disk.writeFile(path, 'first = manual\nsecond = later\n')
    const p = await f.preview(), file = p.value.files[0]
    expect(p.value.files).toHaveLength(1)
    expect(file).toMatchObject({ status: 'needs-choice', before: 'first = old\nsecond = old\n', after: 'first = standard\nsecond = old\n' })
    expect((await f.apply(p.value.ticket)).error.code).toBe('resolution-required')
    const fresh = await f.preview()
    const choices = Object.fromEntries(file.conflicts.map((c) => [c.id, 'undo']))
    expect((await f.apply(fresh.value.ticket, file.id, { [file.id]: choices })).value.complete).toBe(true)
    expect(await disk.readFile(path, 'utf8')).toBe('first = old\nsecond = later\n')
  })
  it('captures published changes even when the command fails or throws after partial work', async () => {
    const f = await fixture(), path = join(f.workspace, 'partial')
    await f.pwsh(() => disk.writeFile(path, 'one'), { result: { isError: true } })
    await expect(f.pwsh(async () => { await disk.writeFile(path, 'two'); throw new Error('aborted') })).rejects.toThrow('aborted')
    const p = await f.preview()
    expect(p.value.files[0]).toMatchObject({ before: null, after: 'two', status: 'ready' })
    expect((await f.apply(p.value.ticket)).value.complete).toBe(true)
    await expect(disk.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('requires a file-state choice when a shell-deleted file is recreated afterwards', async () => {
    const f = await fixture(), path = join(f.workspace, 'deleted')
    await disk.writeFile(path, 'old')
    await f.pwsh(() => disk.unlink(path))
    await disk.writeFile(path, 'manual')
    const p = await f.preview(), file = p.value.files[0]
    expect(file).toMatchObject({ status: 'needs-choice', after: null, conflicts: [{ id: 'file-state', current: 'manual', undo: 'old' }] })
    expect((await f.apply(p.value.ticket, file.id, { [file.id]: { 'file-state': 'current' } })).value.complete).toBe(true)
    expect(await disk.readFile(path, 'utf8')).toBe('manual')
  })
  it('waits for a background or promoted job, attaches its final image to the originating turn, and blocks early undo', async () => {
    for (const kind of ['background', 'promoted']) {
      const f = await fixture(), path = join(f.workspace, kind)
      let listener, removed = false, started = false, job = { id: 'j', owner: 's1', kind: 'pwsh', label: 'fixture', status: 'running' }
      f.ctx.jobs = { list: () => started && job.status === 'running' ? [job] : [], events: { subscribe: (_filter, fn) => { listener = fn; return () => { removed = true } } }, get: () => job }
      await f.pwsh(async () => { started = true; listener({ type: 'registered', job }); await disk.writeFile(path, 'partial') }, { turn: 3, result: { isError: false, value: { kind, jobId: 'j' } } })
      expect((await f.preview({ turn: 3 })).value.busy).toBe(true)
      expect((await f.preview({ turn: 3 })).value.files).toEqual([])
      // The agent has advanced before the detached process publishes its end.
      f.events.push({ seq: f.events.length, type: 'turn/end', data: { turn: 4 } })
      await disk.writeFile(path, 'final')
      job = { ...job, status: 'completed' }; listener({ type: 'settled', job, cause: 'producer' })
      const p = await f.preview({ turn: 3 })
      expect(removed).toBe(true)
      expect(p.value.busy).toBe(false)
      expect(p.value.files[0]).toMatchObject({ before: null, after: 'final', status: 'ready' })
      expect((await f.apply(p.value.ticket)).value.complete).toBe(true)
      expect((await f.preview({ turn: 4 })).value.files).toEqual([])
    }
  })
  it('handles settlement before the background tool returns and cancellation with an outstanding job', async () => {
    const f = await fixture()
    let listener, job = { id: 'fast', owner: 's1', kind: 'pwsh', label: 'fixture', status: 'running' }
    f.ctx.jobs = { list: () => [], events: { subscribe: (_filter, fn) => { listener = fn; return () => {} } }, get: () => job }
    await f.pwsh(async () => {
      listener({ type: 'registered', job })
      await disk.writeFile(join(f.workspace, 'fast'), 'final')
      job = { ...job, status: 'completed' }; listener({ type: 'settled', job })
    }, { result: { isError: false, value: { kind: 'background', jobId: 'fast' } } })
    expect((await f.preview()).value.files[0].status).toBe('ready')
    job = { ...job, id: 'cancelled', status: 'running' }
    await expect(f.pwsh(async () => { listener({ type: 'registered', job }); throw new Error('abort') }, { turn: 2 })).rejects.toThrow('abort')
    expect((await f.preview({ turn: 2 })).value.busy).toBe(true)
    await disk.writeFile(join(f.workspace, 'partial'), 'published before kill')
    job = { ...job, status: 'killed' }; listener({ type: 'settled', job, cause: 'kill' })
    expect((await f.preview({ turn: 2 })).value.files[0]).toMatchObject({ after: 'published before kill', status: 'ready' })
  })
  it('refuses ambiguous attribution when shell and standard tools overlap', async () => {
    const f = await fixture(), path = join(f.workspace, 'overlap')
    await disk.writeFile(path, 'original')
    await f.pwsh(async () => { await f.tool('overlap', 'standard'); await disk.writeFile(path, 'shell') })
    const p = await f.preview()
    expect(p.value).toMatchObject({ incomplete: true, warnings: ['capture-concurrent'] })
    expect(p.value.files[0]).toMatchObject({ status: 'unsupported', reason: 'capture-concurrent' })
    expect((await f.apply(p.value.ticket)).error.code).toBe('capture-incomplete')
    expect(await disk.readFile(path, 'utf8')).toBe('shell')
  })
  it('excludes dependencies, Git internals, outside paths and directory links; rejects non-UTF-8 changes', async () => {
    const f = await fixture(), path = (name) => join(f.workspace, name)
    await disk.mkdir(path('node_modules')); await disk.mkdir(path('.git'))
    const outside = join(f.root, 'outside'); await disk.mkdir(outside)
    await disk.symlink(outside, path('link'), 'junction')
    await f.pwsh(async () => {
      await disk.writeFile(path('node_modules/pkg'), 'dependency')
      await disk.writeFile(path('.git/metadata'), 'git')
      await disk.writeFile(join(outside, 'external'), 'external')
      await disk.writeFile(path('utf16'), Buffer.from('text', 'utf16le'))
      await disk.writeFile(path('binary'), Buffer.from([0, 255]))
      await disk.writeFile(path('large'), Buffer.alloc(1024 * 1024 + 1, 65))
      await disk.writeFile(path('safe'), 'captured')
    })
    const p = await f.preview()
    expect(p.value.files.map((file) => file.path.split(sep).at(-1)).sort()).toEqual(['binary', 'large', 'safe', 'utf16'])
    expect(p.value.files.filter((file) => file.status === 'unsupported')).toHaveLength(3)
    const safe = p.value.files.find((file) => file.path === path('safe'))
    expect((await f.apply(p.value.ticket, safe.id)).value.complete).toBe(true)
    expect(await disk.readFile(join(outside, 'external'), 'utf8')).toBe('external')
  })
  it('reports scan limits instead of claiming unobserved files were newly created, and keeps safe individual undo', async () => {
    const f = await fixture({ powerShellLimits: { entries: 1, bytes: 100, milliseconds: 5000, depth: 64 } })
    await disk.writeFile(join(f.workspace, 'a'), 'before')
    await disk.writeFile(join(f.workspace, 'b'), 'unobserved')
    await f.pwsh(async () => { await disk.writeFile(join(f.workspace, 'a'), 'after'); await disk.writeFile(join(f.workspace, 'b'), 'changed') })
    const p = await f.preview()
    expect(p.value).toMatchObject({ incomplete: true, warnings: ['capture-limit'] })
    expect(p.value.files).toHaveLength(1)
    expect((await f.apply(p.value.ticket)).error.code).toBe('capture-incomplete')
    const fresh = await f.preview(), safe = fresh.value.files[0]
    expect((await f.apply(fresh.value.ticket, safe.id)).value.complete).toBe(true)
    expect(await disk.readFile(join(f.workspace, 'b'), 'utf8')).toBe('changed')
  })
  it('does not block tool execution on missing provider support and does not certify persistent PTY completion', async () => {
    const f = await fixture(); delete f.fs.listDir
    await f.pwsh(() => disk.writeFile(join(f.workspace, 'a'), 'executed'))
    expect((await f.preview()).value).toMatchObject({ incomplete: true, warnings: ['capture-provider'] })
    const g = await fixture()
    await g.pwsh(() => disk.writeFile(join(g.workspace, 'a'), 'executed'), { result: { isError: false, value: 'stdin prompt or command output' } })
    const p = await g.preview()
    expect(p.value).toMatchObject({ incomplete: true, warnings: ['capture-persistent'] })
    expect(p.value.files[0]).toMatchObject({ status: 'unsupported', reason: 'capture-persistent' })
  })
  it('does not journal read-only commands and never treats a missing baseline as a newly created file', async () => {
    const f = await fixture(), path = join(f.workspace, 'existing')
    await disk.writeFile(path, 'before')
    await f.pwsh(() => disk.readFile(path))
    expect((await f.preview()).value.files).toEqual([])
    await expect(disk.readdir(join(f.root, 'journal'))).rejects.toMatchObject({ code: 'ENOENT' })
    const list = f.fs.listDir; let called = false
    f.fs.listDir = (target) => { if (!called) { called = true; throw new Error('unreadable baseline') } return list(target) }
    await f.pwsh(() => disk.writeFile(path, 'after'))
    const p = await f.preview()
    expect(p.value).toMatchObject({ incomplete: true, warnings: ['capture-unreadable'] })
    expect(p.value.files[0]).toMatchObject({ status: 'unsupported', reason: 'capture-incomplete' })
    expect((await f.apply(p.value.ticket, p.value.files[0].id)).error.code).toBe('conflict')
    expect(await disk.readFile(path, 'utf8')).toBe('after')
  })
  it('reports content-budget exhaustion and pre-existing background writers', async () => {
    const f = await fixture({ powerShellLimits: { entries: 100, bytes: 3, milliseconds: 5000, depth: 64 } })
    const path = join(f.workspace, 'a'); await disk.writeFile(path, 'before')
    await f.pwsh(() => disk.writeFile(path, 'after'))
    const p = await f.preview()
    expect(p.value).toMatchObject({ incomplete: true, warnings: ['capture-budget'] })
    expect(p.value.files[0]).toMatchObject({ status: 'unsupported', reason: 'capture-budget' })
    const g = await fixture()
    g.ctx.jobs.list = () => [{ id: 'old-job', owner: 's1', status: 'running' }]
    await g.pwsh(() => disk.writeFile(join(g.workspace, 'a'), 'after'))
    expect((await g.preview()).value).toMatchObject({ incomplete: true, warnings: ['capture-concurrent'] })
  })
})

describe('per-turn file undo', () => {
  it('records write/create and edit behind an earlier terminal host intent policy', async () => {
    const f = await fixture({ terminalPolicy: true })
    const original = '\uFEFForiginal\r\n'
    await disk.writeFile(join(f.workspace, 'existing.txt'), original)
    await f.tool('existing.txt', 'written\r\n')
    await f.tool('existing.txt', 'edited\r\n', { name: 'edit' })
    await f.tool('created.txt', 'new')
    const preview = await f.preview()
    expect(preview.value.files).toHaveLength(2)
    expect(preview.value.files[0]).toMatchObject({ before: original, after: 'edited\r\n', status: 'ready' })
    expect(preview.value.files[1]).toMatchObject({ before: null, action: 'delete', status: 'ready' })
    expect((await f.apply(preview.value.ticket)).value.complete).toBe(true)
    expect(await disk.readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe(original)
    await expect(disk.stat(join(f.workspace, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a terminal intent policy rejection and does not record or change the file', async () => {
    const f = await fixture({ terminalPolicy: true, rejectEdit: true })
    await disk.writeFile(join(f.workspace, 'existing.txt'), 'original')
    await expect(f.tool('existing.txt', 'edited', { name: 'edit' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await disk.readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('original')
    expect((await f.preview()).value.files).toEqual([])
  })

  it('restores the first raw before-image after several edits; CRLF and BOM survive, log does not change', async () => {
    const f = await fixture(), path = join(f.workspace, 'a.txt')
    const original = '\uFEFFfirst\r\nsecond\r\n'
    await disk.writeFile(path, original)
    await f.tool('a.txt', 'changed\r\n')
    await f.tool('a.txt', 'final\r\n', { name: 'edit' })
    const beforeLog = JSON.stringify(f.events)
    const result = await f.preview()
    expect(result.value.files[0]).toMatchObject({ before: original, after: 'final\r\n', status: 'ready' })
    expect((await f.apply(result.value.ticket)).value.complete).toBe(true)
    expect(await disk.readFile(path, 'utf8')).toBe(original)
    expect(JSON.stringify(f.events)).toBe(beforeLog)
    expect((await f.preview()).value.files[0].status).toBe('restored')
  })
  it('records create+edit as one newly created file and safely deletes it', async () => {
    const f = await fixture()
    await f.tool('new.txt', 'first')
    await f.tool('new.txt', 'second', { name: 'edit' })
    const p = await f.preview()
    expect(p.value.files[0]).toMatchObject({ action: 'delete', before: null, status: 'ready' })
    expect((await f.apply(p.value.ticket)).value.complete).toBe(true)
    await expect(disk.stat(join(f.workspace, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.preview()).value.files[0].status).toBe('restored')
  })
  it('survives a plugin restart and maps an assistant message to the right turn', async () => {
    const f = await fixture()
    await disk.writeFile(join(f.workspace, 'a'), 'before')
    await f.tool('a', 'after')
    const restarted = createEditUndo(f.ctx, { root: join(f.root, 'journal') })
    const p = await restarted.preview({ sessionId: 's1', messageId: 'reply' })
    expect(p.value.turn).toBe(1)
    expect((await restarted.apply({ sessionId: 's1', ticket: p.value.ticket })).value.complete).toBe(true)
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('before')
  })
  it('records guarded edits committed just before cancellation discards the tool value', async () => {
    const f = await fixture()
    await disk.writeFile(join(f.workspace, 'a'), 'before\r\n')
    await f.tool('a', 'after\r\n', { abortAfterCommit: true })
    const p = await f.preview()
    expect(p.value.files[0]).toMatchObject({ status: 'ready', before: 'before\r\n', after: 'after\r\n' })
    expect((await f.apply(p.value.ticket)).value.complete).toBe(true)
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('before\r\n')
  })
  it('reports partial completion when a CAS race happens after preflight and preserves the competing edit', async () => {
    const f = await fixture()
    await disk.writeFile(join(f.workspace, 'a'), 'a-before')
    await disk.writeFile(join(f.workspace, 'b'), 'b-before')
    await f.tool('a', 'a-after'); await f.tool('b', 'b-after')
    const p = await f.preview()
    const write = f.fs.writeText
    f.fs.writeText = async (target, ...args) => {
      if (target.displayPath.endsWith(`${sep}b`)) await disk.writeFile(target.targetKey, 'competing edit')
      return write(target, ...args)
    }
    const result = await f.apply(p.value.ticket)
    expect(result.value.complete).toBe(false)
    expect(result.value.results.map((x) => x.status)).toEqual(['restored', 'failed'])
    expect((await f.undo.timeline('s1')).fileUndos).toMatchObject([{ complete: false, results: [{ status: 'restored' }, { status: 'failed', reason: 'FS_STALE_VERSION' }] }])
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('a-before')
    expect(await disk.readFile(join(f.workspace, 'b'), 'utf8')).toBe('competing edit')
  })
  it('requires choices for later edits to a new file and preflights the whole batch', async () => {
    const f = await fixture()
    await f.tool('a', 'a'); await f.tool('b', 'b')
    await disk.writeFile(join(f.workspace, 'b'), 'manual')
    const p = await f.preview()
    expect(p.value.files.map((x) => x.status)).toEqual(['ready', 'needs-choice'])
    expect((await f.apply(p.value.ticket)).error.code).toBe('resolution-required')
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('a')
    expect(await disk.readFile(join(f.workspace, 'b'), 'utf8')).toBe('manual')
    const fresh = await f.preview()
    expect((await f.apply(fresh.value.ticket, fresh.value.files[0].id)).value.complete).toBe(true)
    expect(await disk.readFile(join(f.workspace, 'b'), 'utf8')).toBe('manual')
  })
  it('pins the preview version, consumes tickets, and rejects wrong-session requests', async () => {
    const f = await fixture()
    await f.tool('a', 'after')
    const p = await f.preview()
    await disk.writeFile(join(f.workspace, 'a'), 'after')
    expect((await f.apply(p.value.ticket)).error.code).toBe('conflict')
    expect((await f.apply(p.value.ticket)).error.code).toBe('preview-expired')
    const fresh = await f.preview()
    expect((await f.undo.apply({ sessionId: 'other', ticket: fresh.value.ticket })).error.code).toBe('preview-expired')
  })
  it('asks about overlapping later turns; undoing the newest turn removes the overlap', async () => {
    const f = await fixture()
    await disk.writeFile(join(f.workspace, 'a'), 'original')
    await f.tool('a', 'turn-one')
    await f.tool('a', 'turn-two', { turn: 2 })
    expect((await f.preview()).value.files[0].status).toBe('needs-choice')
    const p2 = await f.preview({ turn: 2 })
    await f.apply(p2.value.ticket)
    const p1 = await f.preview()
    expect(p1.value.files[0].status).toBe('ready')
    await f.apply(p1.value.ticket)
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('original')
  })
  it('undoes recorded ranges while preserving a later edit and exact CRLF/BOM bytes', async () => {
    const f = await fixture(), path = join(f.workspace, 'a')
    await disk.writeFile(path, '\uFEFFfirst = old\r\nsecond = old\r\n')
    await f.tool('a', '\uFEFFfirst = new\r\nsecond = old\r\n')
    await disk.writeFile(path, '\uFEFFfirst = new\r\nsecond = manual\r\n')
    const p = await f.preview()
    expect(p.value.files[0].status).toBe('ready')
    expect((await f.apply(p.value.ticket)).value.complete).toBe(true)
    expect(await disk.readFile(path, 'utf8')).toBe('\uFEFFfirst = old\r\nsecond = manual\r\n')
  })
  it('resolves each overlapping region independently and preserves other edits', async () => {
    const f = await fixture(), path = join(f.workspace, 'a')
    await disk.writeFile(path, 'first = old\nsecond = old\nthird = old\nfourth = old\n')
    await f.tool('a', 'first = new\nsecond = new\nthird = new\nfourth = old\n')
    await disk.writeFile(path, 'first = manual\nsecond = manual\nthird = new\nfourth = manual\n')
    const p = await f.preview(), file = p.value.files[0]
    expect(file.status).toBe('needs-choice')
    expect(file.conflicts).toHaveLength(2)
    const choices = { [file.id]: { [file.conflicts[0].id]: 'current', [file.conflicts[1].id]: 'undo' } }
    expect((await f.apply(p.value.ticket, file.id, choices)).value.complete).toBe(true)
    expect(await disk.readFile(path, 'utf8')).toBe('first = manual\nsecond = old\nthird = old\nfourth = manual\n')
  })
  it('rejects stale or incomplete choices before making any file changes', async () => {
    const f = await fixture(), path = join(f.workspace, 'a')
    await disk.writeFile(path, 'old'); await f.tool('a', 'new')
    await disk.writeFile(path, 'manual')
    let p = await f.preview(), file = p.value.files[0]
    expect((await f.apply(p.value.ticket, file.id, { [file.id]: { invented: 'undo' } })).error.code).toBe('resolution-required')
    expect(await disk.readFile(path, 'utf8')).toBe('manual')
    p = await f.preview(); file = p.value.files[0]
    const choices = { [file.id]: { [file.conflicts[0].id]: 'undo' } }
    await disk.writeFile(path, 'even newer')
    expect((await f.apply(p.value.ticket, file.id, choices)).error.code).toBe('conflict')
    expect(await disk.readFile(path, 'utf8')).toBe('even newer')
  })
  it('keeps or explicitly deletes a later-edited file created in this turn', async () => {
    for (const side of ['current', 'undo']) {
      const f = await fixture(), path = join(f.workspace, 'new')
      await f.tool('new', 'created'); await disk.writeFile(path, 'manual')
      const p = await f.preview(), file = p.value.files[0]
      expect(file.conflicts[0]).toMatchObject({ kind: 'file-state', current: 'manual', undo: null })
      const result = await f.apply(p.value.ticket, file.id, { [file.id]: { 'file-state': side } })
      expect(result.value.complete).toBe(true)
      if (side === 'current') {
        expect(await disk.readFile(path, 'utf8')).toBe('manual')
        expect((await f.preview()).value.files[0].status).toBe('kept')
      } else await expect(disk.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  it('asks whether to keep a later deletion or recreate the old contents with an absence guard', async () => {
    for (const side of ['current', 'undo']) {
      const f = await fixture(), path = join(f.workspace, 'a')
      await disk.writeFile(path, 'old'); await f.tool('a', 'new'); await disk.unlink(path)
      const p = await f.preview(), file = p.value.files[0]
      expect(file.conflicts[0]).toMatchObject({ kind: 'file-state', current: null, undo: 'old' })
      expect((await f.apply(p.value.ticket, file.id, { [file.id]: { 'file-state': side } })).value.complete).toBe(true)
      if (side === 'undo') expect(await disk.readFile(path, 'utf8')).toBe('old')
      else await expect(disk.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  it('does not let conflict choices bypass a read-only policy or a target identity change', async () => {
    const f = await fixture(), path = join(f.workspace, 'a')
    await disk.writeFile(path, 'old'); await f.tool('a', 'new'); await disk.writeFile(path, 'manual')
    let p = await f.preview(), file = p.value.files[0]
    f.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: f.workspace })
    const choices = { [file.id]: { [file.conflicts[0].id]: 'undo' } }
    expect((await f.apply(p.value.ticket, file.id, choices)).value.results[0].reason).toBe('FS_SANDBOX_DENIED')
    expect(await disk.readFile(path, 'utf8')).toBe('manual')
    p = await f.preview(); file = p.value.files[0]
    const resolveOriginal = f.fs.resolve
    f.fs.resolve = async (...args) => ({ ...await resolveOriginal(...args), targetKey: f.root })
    expect((await f.apply(p.value.ticket, file.id, choices)).error.code).toBe('conflict')
    expect(await disk.readFile(path, 'utf8')).toBe('manual')
  })
  it('does not merge across a manual edit between tools in the same turn', async () => {
    const f = await fixture()
    await f.tool('a', 'one')
    await disk.writeFile(join(f.workspace, 'a'), 'manual')
    await f.tool('a', 'two')
    expect((await f.preview()).value.files[0]).toMatchObject({ status: 'unsupported', reason: 'intervening-change' })
  })
  it('blocks running, queued and overlapping-workspace sessions without canceling them', async () => {
    const f = await fixture()
    await f.tool('a', 'after')
    f.agent.status = 'running'
    expect((await f.preview()).value.busy).toBe(true)
    let p = await f.preview()
    expect((await f.apply(p.value.ticket)).error.code).toBe('agent-busy')
    f.agent.status = 'idle'
    f.agent.inbox = { hasPending: true }
    p = await f.preview()
    expect((await f.apply(p.value.ticket)).error.code).toBe('agent-busy')
    f.agent.inbox = { hasPending: false }
    const other = { id: 's2', header: { cwd: join(f.workspace, 'sub') }, snapshotEvents: () => [] }
    await disk.mkdir(other.header.cwd)
    f.sessions.set('s2', other); f.agents.set('s2', { status: 'running' })
    p = await f.preview()
    expect((await f.apply(p.value.ticket)).error.code).toBe('agent-busy')
  })
  it('honors read-only sandbox policy for restore and deletion', async () => {
    const f = await fixture()
    await disk.writeFile(join(f.workspace, 'old'), 'before')
    await f.tool('old', 'after'); await f.tool('new', 'new')
    f.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: f.workspace })
    const p = await f.preview()
    const result = await f.apply(p.value.ticket)
    expect(result.value.complete).toBe(false)
    expect(result.value.results[0].reason).toBe('FS_SANDBOX_DENIED')
    const fresh = await f.preview()
    expect((await f.apply(fresh.value.ticket, fresh.value.files[1].id)).value.complete).toBe(false)
    expect(await disk.readFile(join(f.workspace, 'old'), 'utf8')).toBe('after')
    expect(await disk.readFile(join(f.workspace, 'new'), 'utf8')).toBe('new')
  })
  it('skips failed standard tools and unrelated shells; refuses binary and omitted update bases', async () => {
    const f = await fixture()
    await f.tool('failed', 'x', { isError: true })
    await f.tool('shell', 'x', { name: 'bash' })
    expect((await f.preview()).value.files).toEqual([])
    await disk.writeFile(join(f.workspace, 'binary'), Buffer.from([0, 255]))
    await f.tool('binary', 'text')
    await disk.writeFile(join(f.workspace, 'old'), 'before')
    await f.tool('old', 'after', { omittedBefore: true })
    const p = await f.preview()
    expect(p.value.files.every((x) => x.status === 'unsupported')).toBe(true)
    expect(p.value.files[1].action).toBe('restore')
  })
  it('blocks escaped paths and a target replaced by a symlink', async () => {
    const f = await fixture()
    const policy = f.ctx.sandboxPolicy.resolve
    f.ctx.sandboxPolicy.resolve = () => ({ mode: 'danger-full-access' })
    await f.tool('../outside', 'outside')
    f.ctx.sandboxPolicy.resolve = policy
    expect((await f.preview()).value.files[0].status).toBe('unsupported')
    await f.tool('a', 'a')
    const p = await f.preview()
    await disk.unlink(join(f.workspace, 'a'))
    // Junctions are available to unprivileged Windows users for directories.
    // A changed parent directory exercises the same realpath identity guard.
    const dir = join(f.workspace, 'dir'), moved = join(f.workspace, 'moved')
    await disk.mkdir(dir); await f.tool('dir/file', 'file')
    await disk.rename(dir, moved)
    await disk.symlink(f.root, dir, process.platform === 'win32' ? 'junction' : 'dir')
    const fresh = await f.preview()
    expect(fresh.value.files.at(-1).status).toBe('conflict')
    expect((await f.apply(p.value.ticket)).ok).toBe(false)
  })
  it('refuses safe-delete-unaware backends while retaining existing-file undo', async () => {
    const f = await fixture()
    await f.tool('new', 'new')
    delete f.fs.withLock
    expect((await f.preview()).value.files[0]).toMatchObject({ status: 'unsupported', reason: 'no-safe-delete' })
  })
  it('bounds journal retention and fails closed on corrupt journals', async () => {
    const f = await fixture()
    const store = createEditUndoStore(join(f.root, 'other'))
    await store.update('s', (data) => { data.turns = Array.from({ length: 60 }, (_, turn) => ({ turn })) })
    expect((await store.read('s')).turns.map((x) => x.turn)).toEqual(Array.from({ length: 50 }, (_, i) => i + 10))
    const file = (await disk.readdir(join(f.root, 'other')))[0]
    await disk.writeFile(join(f.root, 'other', file), '{')
    await expect(store.read('s')).rejects.toThrow()
  })
  it('never changes the host tool result when journal persistence fails', async () => {
    const f = await fixture()
    // Make the private journal directory unavailable after registration.
    await disk.writeFile(join(f.root, 'journal'), 'not a directory')
    await expect(f.tool('a', 'after')).resolves.toBeUndefined()
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('after')
  })
})

describe('conversation and tail file rewind', () => {
  async function combined() {
    let recalls = 0
    let f
    const conversation = {
      preview: async () => ({ messageId: 'u', targetSeq: 4, turns: [1, 2], span: { start: 4, end: 20, shadowedSeqs: [4, 20] } }),
      run: async (_session, _plan, apply) => {
        const files = await apply()
        if (!files.complete) return { ...files, conversation: null }
        recalls++
        return { ...files, conversation: { text: 'original input', markerSeq: 21 } }
      },
    }
    f = await fixture({ conversation })
    const preview = () => f.undo.preview({ sessionId: 's1', messageId: 'u', mode: 'both' })
    const apply = (ticket, extra = {}) => f.undo.apply({ sessionId: 's1', ticket, mode: 'both', ...extra })
    return { ...f, preview, apply, recalls: () => recalls }
  }
  it('rewinds standard and PowerShell edits across the requested dialogue tail', async () => {
    const f = await combined()
    f.events.push({ seq: 3, type: 'user/message', data: {} })
    await disk.writeFile(join(f.workspace, 'existing'), 'before\nuntouched\n')
    await f.tool('existing', 'standard\nuntouched\n')
    await f.pwsh(async () => {
      await disk.writeFile(join(f.workspace, 'existing'), 'shell\nuntouched\n')
      await disk.writeFile(join(f.workspace, 'created'), 'created via shell')
    }, { turn: 2 })
    await disk.writeFile(join(f.workspace, 'existing'), 'shell\nmanual\n')
    const p = await f.preview()
    expect(p.value.files).toHaveLength(2)
    const result = await f.apply(p.value.ticket)
    expect(result).toMatchObject({ ok: true, value: { complete: true, conversation: { text: 'original input' } } })
    expect(await disk.readFile(join(f.workspace, 'existing'), 'utf8')).toBe('before\nmanual\n')
    await expect(disk.stat(join(f.workspace, 'created'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rewinds all captured subsequent turns once, preserves unrelated edits, and leaves older files alone', async () => {
    const f = await combined()
    await f.tool('older.txt', 'older', { turn: 0 }) // before target seq 4
    await disk.writeFile(join(f.workspace, 'existing.txt'), 'first = old\nsecond = old\n')
    await f.tool('existing.txt', 'first = agent\nsecond = old\n')
    await f.tool('existing.txt', 'first = agent\nsecond = agent\n', { turn: 2 })
    await f.tool('created.txt', 'created', { turn: 2 })
    await disk.writeFile(join(f.workspace, 'existing.txt'), 'first = agent\nsecond = agent\nlater\n')
    const preview = await f.preview()
    expect(preview.ok).toBe(true)
    expect(preview.value.turns).toEqual([1, 2])
    expect(preview.value.files).toHaveLength(2)
    const result = await f.apply(preview.value.ticket)
    expect(result).toMatchObject({ ok: true, value: { complete: true, conversation: { text: 'original input' } } })
    expect(f.recalls()).toBe(1)
    expect(await disk.readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('first = old\nsecond = old\nlater\n')
    expect(await disk.readFile(join(f.workspace, 'older.txt'), 'utf8')).toBe('older')
    await expect(disk.stat(join(f.workspace, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.preview()).value.files).toEqual([])
  })
  it('requires every conflict choice before changing any file or recalling the conversation', async () => {
    const f = await combined()
    f.events.push({ seq: 3, type: 'user/message', data: { id: 'padding' } })
    await disk.writeFile(join(f.workspace, 'a'), 'old')
    await f.tool('a', 'agent')
    await f.tool('b', 'created', { turn: 2 })
    await disk.writeFile(join(f.workspace, 'a'), 'manual')
    const preview = await f.preview()
    expect((await f.apply(preview.value.ticket)).error.code).toBe('resolution-required')
    expect(f.recalls()).toBe(0)
    expect(await disk.readFile(join(f.workspace, 'b'), 'utf8')).toBe('created')
    const refreshed = await f.preview()
    const file = refreshed.value.files.find((row) => row.path.endsWith('a'))
    const resolutions = { [file.id]: Object.fromEntries(file.conflicts.map((row) => [row.id, 'current'])) }
    expect((await f.apply(refreshed.value.ticket, { resolutions })).value.conversation.text).toBe('original input')
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('manual')
  })
  it('keeps the conversation on partial filesystem failure and reports completed files', async () => {
    const f = await combined()
    f.events.push({ seq: 3, type: 'user/message', data: {} })
    await disk.writeFile(join(f.workspace, 'a'), 'old-a')
    await disk.writeFile(join(f.workspace, 'b'), 'old-b')
    await f.tool('a', 'agent-a')
    await f.tool('b', 'agent-b', { turn: 2 })
    const write = f.fs.writeText
    f.fs.writeText = (target, ...args) => target.displayPath.endsWith('b') ? Promise.reject(new Error('fixture denied')) : write(target, ...args)
    const preview = await f.preview()
    const result = await f.apply(preview.value.ticket)
    expect(result).toMatchObject({ ok: true, value: { complete: false, conversation: null } })
    expect(result.value.results.map((row) => row.status)).toEqual(['restored', 'failed'])
    expect(f.recalls()).toBe(0)
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('old-a')
    expect((await f.preview()).value.files).toHaveLength(1)
  })
  it('refuses ambiguous between-turn changes and mode or single-file scope changes', async () => {
    const f = await combined()
    f.events.push({ seq: 3, type: 'user/message', data: {} })
    await disk.writeFile(join(f.workspace, 'a'), 'old')
    await f.tool('a', 'agent')
    await disk.writeFile(join(f.workspace, 'a'), 'between turns')
    await f.tool('a', 'last', { turn: 2 })
    let preview = await f.preview()
    expect(preview.value.files[0].status).toBe('unsupported')
    expect((await f.apply(preview.value.ticket)).error.code).toBe('conflict')
    preview = await f.preview()
    expect((await f.apply(preview.value.ticket, { fileId: preview.value.files[0].id })).error.code).toBe('bad-request')
    preview = await f.preview()
    expect((await f.undo.apply({ sessionId: 's1', ticket: preview.value.ticket })).error.code).toBe('bad-request')
    expect(f.recalls()).toBe(0)
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('last')
  })
  it('permits an explicit conversation-only effect when the preview has no file records', async () => {
    const f = await combined()
    const preview = await f.preview()
    expect(preview.value.files).toEqual([])
    expect((await f.apply(preview.value.ticket)).value.conversation.text).toBe('original input')
  })
  it('preserves unrelated edits between captured turns and asks before deleting a manually edited new file', async () => {
    const f = await combined()
    f.events.push({ seq: 3, type: 'user/message', data: {} })
    await disk.writeFile(join(f.workspace, 'a'), 'first = old\nsecond = old\n')
    await f.tool('a', 'first = agent\nsecond = old\n')
    await disk.writeFile(join(f.workspace, 'a'), 'first = agent\nsecond = manual\n')
    await f.tool('a', 'first = latest\nsecond = manual\n', { turn: 2 })
    await f.tool('b', 'created')
    await disk.writeFile(join(f.workspace, 'b'), 'manual before next turn')
    await f.tool('b', 'last', { turn: 2 })
    const preview = await f.preview()
    const created = preview.value.files.find((row) => row.action === 'delete')
    expect(created.status).toBe('needs-choice')
    expect((await f.apply(preview.value.ticket)).error.code).toBe('resolution-required')
    const refreshed = await f.preview()
    const choices = { [created.id]: { 'file-state': 'current' } }
    expect((await f.apply(refreshed.value.ticket, { resolutions: choices })).value.complete).toBe(true)
    expect(await disk.readFile(join(f.workspace, 'a'), 'utf8')).toBe('first = old\nsecond = manual\n')
    expect(await disk.readFile(join(f.workspace, 'b'), 'utf8')).toBe('last')
  })
  it('uses recorded turn boundaries for journals written before sequence capture was added', async () => {
    const f = await combined()
    f.events.push({ seq: 3, type: 'user/message', data: {} })
    await f.tool('a', 'new')
    const store = createEditUndoStore(join(f.root, 'journal'))
    await store.update('s1', (data) => { for (const group of data.turns) delete group.firstSeq })
    const preview = await f.preview()
    expect(preview.value.files).toHaveLength(1)
    expect((await f.apply(preview.value.ticket)).value.complete).toBe(true)
  })
})
