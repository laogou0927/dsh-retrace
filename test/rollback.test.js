/**
 * Rollback executor unit tests. A fake session is seeded with correctly
 * shaped surface events (every surface-eligible event carries its `surfaceOp`
 * marker — as real durable logs do) so `foldSurface` works; a fake seam /
 * ctx / subprocess stand in for the host services.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { posix } from 'node:path'
import { lstat, unlink } from 'node:fs/promises'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
import { createRollbackExecutor } from '../lib/rollback.js'
import { carrierTargetSeq } from '../lib/marker-carrier.js'
import { makeAgent, makeHooks } from './helpers.js'
import { replaceOp, SURFACE_OP_START_KEY, SURFACE_OP_END_KEY } from './surface-op-shape.js'

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), unlink: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  lstat.mockResolvedValue({ isFile: () => true })
  unlink.mockResolvedValue(undefined)
})

/** User message event (real user input → round boundary). */
function userMessage(id, text, extra = {}) {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra },
  }
}

/** Assistant model reply (carries provider/model for marker append). */
function assistantMessage(id, text) {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
    },
  }
}

/**
 * A recall-style marker replacement — the plugin's real two-segment carrier
 * (`user/message` + `surfaceOp` + provenance).
 *
 * It cannot be an `assistant/message`: the host refuses
 * `assistant/message embeds its source stream and cannot carry sourceEventSeqs`,
 * while a replace is *required* to cite `sourceEventSeqs`. The old
 * `assistant/message` marker fixture only folded on the v0 tree.
 */
function markerEvent(id, span, sourceEventSeqs) {
  return {
    type: 'user/message',
    surfaceOp: replaceOp(span[0], span[span.length - 1]),
    sourceEventSeqs,
    data: {
      role: 'user',
      id,
      content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  }
}

/** Fake session: append-only log + shadow-able surface + header.cwd. */
function makeSession(cwd = '/work') {
  const events = []
  const surface = { nodes: [] }
  const session = {
    id: 's1',
    header: { cwd },
    events,
    surface,
    seed(...events) {
      for (const event of events) this.appendRaw(event)
      return this
    },
    appendRaw(event) {
      const record = { seq: events.length, time: Date.now(), ...event }
      events.push(record)
      if (record.type !== 'request/header') {
        if (record.surfaceOp && record.surfaceOp.op === 'replace') {
          // Keys the live host actually writes (see test/surface-op-shape.js)
          const start = record.surfaceOp[SURFACE_OP_START_KEY]
          const end = record.surfaceOp[SURFACE_OP_END_KEY]
          surface.nodes = surface.nodes.filter((seq) => seq < start || seq > end)
        }
        surface.nodes.push(record.seq)
      }
      return record
    },
    append(type, data, options = {}) {
      const record = { seq: events.length, time: Date.now(), type, data, ...options }
      events.push(record)
      // 与真实 dsh-session 一致：step/turn 边界不进 surface
      if (type === 'step/start' || type === 'step/end' || type === 'turn/start' || type === 'turn/end') return record
      if (options.surfaceOp && options.surfaceOp.op === 'replace') {
        // Keys the live host actually writes (see test/surface-op-shape.js)
        const start = options.surfaceOp[SURFACE_OP_START_KEY]
        const end = options.surfaceOp[SURFACE_OP_END_KEY]
        surface.nodes = surface.nodes.filter((seq) => seq < start || seq > end)
      }
      surface.nodes.push(record.seq)
      return record
    },
  }
  return session
}

/** A version record shape as served by the projection view. */
function versionRecord(overrides = {}) {
  return {
    versionId: 'v3',
    boundarySeq: 3,
    createdAt: 1,
    kind: 'recall',
    markerText: 'edited',
    messageCount: 3,
    fileCounts: { created: 1, modified: 0, deleted: 0 },
    touchedFiles: [{ path: 'src/a.ts', mode: 'created' }],
    git: null,
    ...overrides,
  }
}

/** A fake seam implementing the surface the rollback executor consumes. */
function makeSeam(overrides = {}) {
  return {
    configFor: () => ({ versioning: true, git: false, retentionLimit: 50 }),
    snapshot: () => ({ enabled: true, versions: [versionRecord()] }),
    agentOf: () => undefined,
    resolveSnapshot: vi.fn(async () => 'sha-a'),
    readSnapshot: vi.fn(async () => new TextEncoder().encode('file content')),
    gitStatus: vi.fn(async () => null),
    gitCheckout: vi.fn(async (cwd, headHash, paths) => ({ ok: true, checked: paths, skipped: [] })),
    gitHeadFor: vi.fn(async () => null),
    ...overrides,
  }
}

/** rc.2-shaped FsTargets and opaque FsVersion values. Real fs is smoke-tested. */
function makeCtx() {
  const writes = []
  const spawns = []
  const ctx = {
    fs: {
      resolve: async (path, { cwd = '/work' } = {}) => {
        const targetKey = posix.resolve(cwd, path)
        return { displayPath: targetKey, targetKey }
      },
      contains: (root, target) => target.targetKey === root.targetKey || target.targetKey.startsWith(root.targetKey + '/'),
      stat: vi.fn(async () => ({ type: 'file', version: 'rc2-version-7' })),
      withLock: vi.fn(async (_key, fn) => fn()),
      checkedTarget: vi.fn(async (target, policy) => {
        if (policy?.mode === 'read-only') throw new Error('FS_WRITE_DENIED')
        return target
      }),
      processPath: (target) => target.targetKey,
      writeText: vi.fn(async (target, content, expected, _signal, policy) => {
        if (policy?.mode === 'read-only') throw new Error('FS_WRITE_DENIED')
        writes.push({ target, content, expected, policy })
      }),
    },
    subprocess: {
      spawn: (spec) => {
        spawns.push(spec)
        return { done: Promise.resolve({ exitCode: 0 }) }
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  }
  return { ctx, writes, spawns }
}

/** Convenience: a ready rollback executor. */
function makeRollback(session, seamOverrides = {}, ctxOverrides = {}) {
  const { ctx, writes, spawns } = makeCtx()
  const seam = makeSeam(seamOverrides)
  const sessions = { get: (id) => (id === 's1' ? session : undefined), flush: vi.fn(async () => {}) }
  const agents = { get: () => makeAgent() }
  const writeMarker = makeHooks(agents).writeMarker
  const rollback = createRollbackExecutor({ ctx: { ...ctx, ...ctxOverrides }, sessions, seam, writeMarker, log: () => {} })
  return { rollback, seam, writes, spawns, sessions, ctx }
}

describe('rollback preview', () => {
  it('rejects an invalid scope', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
    )
    const { rollback } = makeRollback(session)
    await expect(rollback.preview({ sessionId: 's1', versionId: 'v4', scope: 'nope' })).rejects.toMatchObject({ code: 'bad-scope' })
  })

  it('reports the context diff (messages after the boundary) and the artifact plan', async () => {
    // v3 boundary: marker at seq 3 shadows u1..a1; then u3 appended at seq 4.
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
      userMessage('u3', 'more'),
    )
    const { rollback } = makeRollback(session)
    const result = await rollback.preview({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(result.context.messages).toBe(1)
    expect(result.context.firstSeq).toBe(4)
    expect(result.applicable).toBe(true)
    expect(result.artifacts.rows[0]).toMatchObject({ path: 'src/a.ts', action: 'restore', method: 'snapshot' })
  })

  it('reports non-applicable when the session is already at the version', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
    )
    const { rollback } = makeRollback(session)
    const result = await rollback.preview({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(result.context.messages).toBe(0)
    expect(result.applicable).toBe(true) // artifact row still applies
  })
})

describe('rollback execute', () => {
  it('appends a restore marker shadowing the post-boundary surface', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
      userMessage('u3', 'more'),
    )
    const { rollback, sessions } = makeRollback(session)
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'context' })
    // 两段结构：第 1 段（审计）@5、第 2 段（载体）@6（不再有 turn/step 信封）
    expect(result.markerSeq).toBe(6)
    expect(result.context.messages).toBe(1)
    const audit = eventAt(session, 5)
    expect(audit.type).toBe('compaction/prune')
    expect(audit.data.shadowedSeqs).toEqual([4])
    const marker = eventAt(session, 6)
    expect(marker.type).toBe('user/message')
    expect(marker.surfaceOp).toEqual(replaceOp(4, 4))
    expect(marker.sourceEventSeqs).toEqual([5, 4])
    // 业务溯源 targetSeq 由区间起点派生（editor 已不再落盘；restore 的边界 seq 3
    // 不等于区间起点 4 ⇒ 该场景读到的派生值是区间起点，见报告「能力损失」一节）
    expect(carrierTargetSeq(marker)).toBe(4)
    expect(marker.data.source.kind).toBe('model')
    expect(sessions.flush).toHaveBeenCalled()
  })

  it('restores artifacts from snapshots through the sandboxed fs (CAS-guarded)', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
    )
    const { rollback, writes, seam } = makeRollback(session)
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'artifacts' })
    expect(seam.resolveSnapshot).toHaveBeenCalledWith('v3', 'src/a.ts')
    expect(seam.readSnapshot).toHaveBeenCalledWith('sha-a')
    expect(writes.length).toBe(1)
    expect(writes[0].target.targetKey).toBe('/work/src/a.ts')
    expect(writes[0].content).toBe('file content')
    expect(writes[0].expected).toEqual({ kind: 'replaceIfVersion', version: 'rc2-version-7' })
    expect(result.artifacts[0]).toMatchObject({ path: 'src/a.ts', status: 'restored' })
    expect(result.complete).toBe(true)
  })

  it('deletes an absent-at-version file under the host lock and sandbox check', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
    )
    const { rollback, spawns, ctx } = makeRollback(session, {
      snapshot: () => ({ enabled: true, versions: [versionRecord({ touchedFiles: [{ path: 'gone.txt', mode: 'deleted' }] })] }),
    })
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'artifacts' })
    expect(spawns).toEqual([])
    expect(ctx.fs.withLock).toHaveBeenCalledWith('/work/gone.txt', expect.any(Function))
    expect(ctx.fs.checkedTarget).toHaveBeenCalledWith(expect.objectContaining({ targetKey: '/work/gone.txt' }), { mode: 'workspace-write' })
    expect(unlink).toHaveBeenCalledWith('/work/gone.txt')
    expect(result.artifacts[0]).toMatchObject({ path: 'gone.txt', status: 'deleted' })
    expect(result.complete).toBe(true)
  })

  it('uses git checkout when the workspace is a repository with a recorded HEAD', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
    )
    const seam = makeSeam({
      configFor: () => ({ versioning: true, git: true, retentionLimit: 50 }),
      gitStatus: async () => ({ root: '/work', headHash: 'abc123', dirty: true, paths: [] }),
    })
    const { rollback } = makeRollback(session, seam)
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'artifacts' })
    expect(seam.gitCheckout).toHaveBeenCalledWith('/work', 'abc123', ['src/a.ts'])
    expect(result.artifacts[0]).toMatchObject({ path: 'src/a.ts', status: 'restored' })
  })

  it('both scope: context marker first, then artifacts', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
      userMessage('u3', 'more'),
    )
    const { rollback, writes } = makeRollback(session)
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(result.markerSeq).toBe(6)
    expect(writes.length).toBe(1)
  })
})

describe('rc.2 file rollback guards', () => {
  const args = { sessionId: 's1', versionId: 'v3', scope: 'artifacts' }
  const deleteVersion = (path = 'gone.txt') => ({
    snapshot: () => ({ versions: [versionRecord({ touchedFiles: [{ path, mode: 'deleted' }] })] }),
  })

  it('creates a missing snapshot file only if it is still absent', async () => {
    const { rollback, ctx, writes } = makeRollback(makeSession())
    ctx.fs.stat.mockResolvedValue(null)
    expect((await rollback.execute(args)).complete).toBe(true)
    expect(writes[0].expected).toEqual({ kind: 'createIfAbsent' })
  })

  it.each([
    ['missing version', { type: 'file' }],
    ['directory', { type: 'directory', version: 'v1' }],
  ])('refuses an unguardable restore: %s', async (_label, stat) => {
    const { rollback, ctx, writes } = makeRollback(makeSession())
    ctx.fs.stat.mockResolvedValue(stat)
    const result = await rollback.execute(args)
    expect(result.complete).toBe(false)
    expect(result.artifacts[0].status).toBe('failed')
    expect(writes).toEqual([])
  })

  it('does not turn a stat error into an unguarded write', async () => {
    const { rollback, ctx, writes } = makeRollback(makeSession())
    ctx.fs.stat.mockRejectedValue(new Error('FS_READ_DENIED'))
    const result = await rollback.execute(args)
    expect(result.artifacts[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('FS_READ_DENIED') })
    expect(writes).toEqual([])
    expect(result.complete).toBe(false)
  })

  it('preserves BOM and CRLF in snapshot text', async () => {
    const original = '\uFEFFfirst\r\nsecond\r\n'
    const { rollback, writes } = makeRollback(makeSession(), { readSnapshot: async () => Buffer.from(original) })
    await rollback.execute(args)
    expect(writes[0].content).toBe(original)
  })

  it('rejects invalid UTF-8 rather than writing replacement characters', async () => {
    const { rollback, writes } = makeRollback(makeSession(), { readSnapshot: async () => Buffer.from([0xff]) })
    const result = await rollback.execute(args)
    expect(result.complete).toBe(false)
    expect(writes).toEqual([])
  })

  it('reports file conflicts while preserving an already completed context rollback', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'), userMessage('u2', 'again'), markerEvent('retrace-recall-1', [0, 1], [0, 1]), userMessage('u3', 'more'))
    const { rollback, ctx } = makeRollback(session)
    ctx.fs.writeText.mockRejectedValue(new Error('FS_STALE_VERSION'))
    const result = await rollback.execute({ ...args, scope: 'both' })
    expect(result.context.messages).toBe(1)
    expect(result.markerSeq).toBe(6)
    expect(result.artifacts[0].status).toBe('failed')
    expect(result.complete).toBe(false)
  })

  it('honors read-only policy for restore and deletion', async () => {
    for (const seam of [{}, deleteVersion()]) {
      const { rollback, writes } = makeRollback(makeSession(), seam, { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } })
      const result = await rollback.execute(args)
      expect(result.artifacts[0].status).toBe('failed')
      expect(result.complete).toBe(false)
      expect(writes).toEqual([])
    }
    expect(unlink).not.toHaveBeenCalled()
  })

  it('refuses deletion when the version changes before acquiring the lock', async () => {
    const { rollback, ctx } = makeRollback(makeSession(), deleteVersion())
    ctx.fs.stat.mockResolvedValueOnce({ type: 'file', version: 'before' }).mockResolvedValue({ type: 'file', version: 'after' })
    const result = await rollback.execute(args)
    expect(result.artifacts[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('changed before deletion') })
    expect(unlink).not.toHaveBeenCalled()
  })

  it('refuses deletion if sandbox resolution redirects the target', async () => {
    const { rollback, ctx } = makeRollback(makeSession(), deleteVersion())
    ctx.fs.checkedTarget.mockResolvedValue({ displayPath: '/outside/gone.txt', targetKey: '/outside/gone.txt' })
    expect((await rollback.execute(args)).complete).toBe(false)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('refuses a symlink in the final native deletion check', async () => {
    const { rollback } = makeRollback(makeSession(), deleteVersion())
    lstat.mockResolvedValue({ isFile: () => false })
    expect((await rollback.execute(args)).complete).toBe(false)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('treats an already absent deletion target as unchanged', async () => {
    const { rollback, ctx } = makeRollback(makeSession(), deleteVersion())
    ctx.fs.stat.mockResolvedValue(null)
    const result = await rollback.execute(args)
    expect(result.artifacts[0].status).toBe('unchanged')
    expect(result.complete).toBe(true)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('fails closed on a backend without checked native deletion', async () => {
    const { rollback, ctx } = makeRollback(makeSession(), deleteVersion())
    ctx.fs.checkedTarget = undefined
    expect((await rollback.execute(args)).complete).toBe(false)
    expect(unlink).not.toHaveBeenCalled()
  })

  it.each(['../outside.txt', '.'])('rejects a deletion outside the file boundary: %s', async (path) => {
    const { rollback } = makeRollback(makeSession(), deleteVersion(path))
    const result = await rollback.execute(args)
    expect(result.artifacts[0]).toMatchObject({ status: 'skipped', reason: 'outside-workspace' })
    expect(result.complete).toBe(false)
    expect(unlink).not.toHaveBeenCalled()
  })
})
