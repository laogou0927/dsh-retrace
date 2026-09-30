import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as disk } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { createCheckpoints } from '../lib/checkpoints.js'
import { createEditorApi } from '../lib/host-core.js'
import { createDshMarkerWriter } from '../lib/adapter/dsh-writer.js'
import { createMarkerGuard } from '../lib/prewrite-guard.js'
import { createCheckpointStore } from '../lib/checkpoint-store.js'
import { surfaceEntries, surfaceKey } from '../lib/checkpoint-replay.js'
import { estimateMessage, deriveMessage, officialSurfaceProjection } from './official-meter.js'
import { createPreWriter } from '../lib/vendor/dsh-log-contract.js'
import { tokenMeterViolations } from 'dsh-log-contract'
import { __recallMarkerDefinition } from '../lib/client.js'

const roots = [], contexts = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('retrace-checkpoint-')) throw new Error('Invalid fixture cleanup path')
    await disk.rm(root, { recursive: true, force: true })
  }
})
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const model = { kind: 'model', provider: 'test', model: 'test' }
async function fixture({ projections = [] } = {}) {
  const root = await disk.mkdtemp(join(tmpdir(), 'retrace-checkpoint-')), workspace = join(root, 'workspace')
  roots.push(root); await disk.mkdir(workspace)
  const eventCtx = new Context(); contexts.push(eventCtx)
  const session = Session.create('s1', undefined, { id: 's1', version: 4, createdAt: 0, isSeeded: false, cwd: workspace }, undefined, projections)
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' } } })
  const agent = { id: 's1', session, status: 'idle', followup: vi.fn(), runMaintenance: vi.fn((fn) => fn()), cancel: vi.fn(), whenIdle: async () => {} }
  const fs = {
    async resolve(path, opts = {}) { const displayPath = resolve(opts.cwd ?? workspace, path); return { displayPath, targetKey: displayPath } },
    contains(parent, child) { const rel = relative(parent.targetKey, child.targetKey); return !rel || (!rel.startsWith('..') && !rel.startsWith(sep)) },
    async stat(target) {
      try { const st = await disk.stat(target.targetKey, { bigint: true }); return { type: st.isFile() ? 'file' : 'directory', size: Number(st.size), version: `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` } }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    },
    async lstat(path, opts = {}) {
      try { const st = await disk.lstat(resolve(opts.cwd ?? workspace, path)); return { type: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'directory' } }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    },
    readBytes: (target) => disk.readFile(target.targetKey),
    async listDir(target) { return Promise.all((await disk.readdir(target.targetKey)).map(async (name) => ({ name, target: await fs.resolve(join(target.displayPath, name)) }))) },
    withLock: async (_key, fn) => fn(),
    processPath: (target) => target.targetKey,
    checkedTarget: async (target, policy) => { if (policy.mode === 'read-only') throw Object.assign(new Error('Denied'), { code: 'FS_SANDBOX_DENIED' }); return target },
    async writeText(target, text, expected, _signal, policy) {
      await fs.checkedTarget(target, policy)
      const st = await fs.stat(target)
      if ((expected.kind === 'replaceIfVersion' && st?.version !== expected.version) || (expected.kind === 'createIfAbsent' && st)) throw Object.assign(new Error('Conflict'), { code: 'file-conflict' })
      await disk.mkdir(resolve(target.targetKey, '..'), { recursive: true }); await disk.writeFile(target.targetKey, text)
    },
  }
  const policy = { mode: 'workspace-write' }, config = { versioning: true, retentionLimit: 50 }
  const ctx = {
    sessions: { get: (id) => id === 's1' ? session : undefined, list: () => [session], flush: vi.fn(async () => {}), messageProjections: projections },
    agents: { get: (id) => id === 's1' ? agent : undefined }, jobs: { list: () => [] },
    fs, sandboxPolicy: { resolve: () => policy }, tokenMeter: { estimateMessage },
    on: (...args) => eventCtx.on(...args),
  }
  const history = { turns: [] }
  const seam = { storeRoot: () => join(root, 'private'), configFor: () => config }
  const checkpoints = createCheckpoints(ctx, { seam, fileHistory: () => history })
  checkpoints.register()
  const writer = createDshMarkerWriter({ validateMarker: createMarkerGuard().validateMarkerAppend, meter: ctx.tokenMeter, deriveMessage })
  const api = createEditorApi(ctx, ctx.sessions, ctx.agents, () => {}, { writeMarker: writer.writeMarker, withCheckpoint: checkpoints.withCheckpoint })
  let turn = 0
  const input = async (text, { canceled = false, resend = false } = {}) => {
    turn++
    session.append('turn/start', { turn })
    const message = user(resend ? `retrace-resend-${turn}` : `user-${turn}`, text)
    const decision = await eventCtx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal, turn, step: 1 }, () => ({ kind: 'enter', messages: [message] }))
    if (!canceled) {
      session.append('step/start', { turn, step: 1 })
      if (turn === 1) session.append('system/message', { turn, step: 1, message: { id: 'system', role: 'system', content: [{ type: 'text', text: 'System prompt' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
      for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
      session.append('assistant/message', { turn, step: 1, message: { id: `reply-${turn}`, role: 'assistant', content: [{ type: 'text', text: `${text} reply` }], source: model }, stream: [] }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
    }
    session.append('turn/end', { turn, reason: { kind: canceled ? 'blocked' : 'completed' } })
    return message.id
  }
  const entries = () => surfaceEntries(session.snapshotEvents(), projections)
  const texts = () => entries().flatMap(({ message }) => message.content.filter((b) => b.type === 'text').map((b) => b.text))
  const records = async () => (await checkpoints.snapshot('s1')).versions
  const restore = async (record, scope = 'both') => {
    const args = { sessionId: 's1', versionId: record.versionId, scope }
    const preview = await checkpoints.preview(args)
    return checkpoints.execute({ ...args, previewToken: preview.previewToken })
  }
  return { root, workspace, session, ctx, agent, api, config, policy, fs, history, checkpoints, eventCtx, input, entries, texts, records, restore, seam }
}

describe('pre-operation checkpoints', () => {
  it('saves every committed normal input, but no canceled input or synthetic resend', async () => {
    const f = await fixture()
    await f.input('A'); await f.input('cancel', { canceled: true }); await f.input('B'); await f.input('resend', { resend: true })
    const records = await f.records()
    expect(records.map((r) => [r.kind, r.messageCount])).toEqual([['input', 0], ['input', 3]])
    expect((await f.restore(records[0], 'context')).complete).toBe(true)
    expect(f.entries()).toEqual([])
    expect(tokenMeterViolations(f.session.snapshotEvents().map((event) => ({ event })))).toEqual([])
    expect(Session.create('s1', f.session.snapshotEvents(), f.session.header).surface.nodes).toEqual(f.session.surface.nodes)
  })
  it('A+B → recall B → A → restore → A+B → restore previous restore → A, including replies and reload', async () => {
    const f = await fixture()
    await f.input('A'); const b = await f.input('B')
    const original = surfaceKey(f.entries())
    expect((await f.api.recall({ sessionId: 's1', messageId: b })).ok).toBe(true)
    const recall = (await f.records()).at(-1)
    expect(recall.kind).toBe('recall')
    expect((await f.checkpoints.preview({ sessionId: 's1', versionId: recall.versionId, scope: 'context' })).context.changed).toBe(true)
    const recalled = surfaceKey(f.entries())
    expect((await f.restore(recall, 'context')).complete).toBe(true)
    expect(surfaceKey(f.entries())).toBe(original)
    const restorePoint = (await f.records()).at(-1)
    expect(restorePoint.kind).toBe('restore')
    const restarted = createCheckpoints(f.ctx, { seam: f.seam, fileHistory: () => f.history })
    expect((await restarted.snapshot('s1')).versions.at(-1).versionId).toBe(restorePoint.versionId)
    expect((await f.restore(restorePoint, 'context')).complete).toBe(true)
    expect(surfaceKey(f.entries())).toBe(recalled)
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.agent.runMaintenance).toHaveBeenCalledTimes(2)
    const log = f.session.snapshotEvents()
    const clears = log.filter((event) => event.type === 'system/message' && event.data.message.id.startsWith('restore-empty-'))
    expect(clears.length).toBeGreaterThan(0)
    for (const event of clears) {
      expect(__recallMarkerDefinition.match(event)?.role).toBe('start')
      expect(__recallMarkerDefinition.start({}, { event }).op).toBe('restore')
      expect(__recallMarkerDefinition.start({}, { event }).shadowedSeqs).toEqual(event.sourceEventSeqs.slice(1))
    }
    expect(createPreWriter({ header: f.session.header, events: log }).validateEdit(log).ok).toBe(true)
    expect(tokenMeterViolations(log.map((event) => ({ event })))).toEqual([])
    let claim, total = 0
    for (const event of log) { const next = officialSurfaceProjection.foldSurfaceProjection(claim, event); claim = next.claim; total += next.deltaTokens }
    expect(total).toBe(f.entries().reduce((sum, { message }) => sum + estimateMessage(message), 0))
  })
  it('preserves developer messages, reasoning, images, tool calls/results and original embedded streams', async () => {
    const f = await fixture(); await f.input('A'); const b = await f.input('B')
    const stream = [{ t: 1, chunk: { type: 'text-delta', text: 'tool work' } }]
    const turn = 2, step = 2
    f.session.append('step/start', { turn, step })
    f.session.append('developer/message', { turn, step, message: { id: 'developer', role: 'developer', content: [{ type: 'text', text: 'instruction' }], source: { kind: 'tools' } } }, { surfaceOp: 'append' })
    f.session.append('user/message', { ...user('image', 'image'), content: [{ type: 'image', attachment: { id: 'image-asset', mimeType: 'image/png', name: 'test.png', size: 4, width: 1, height: 1 } }] }, { surfaceOp: 'append' })
    f.session.append('assistant/message', { turn, step, stream, message: { id: 'tool-assistant', role: 'assistant', source: model, content: [{ type: 'reasoning', text: 'reason' }, { type: 'tool-call', toolCallId: 'call', toolName: 'echo', input: {} }] } }, { surfaceOp: 'append' })
    f.session.append('tool/call', { turn, step, callId: 'call', name: 'echo', arguments: '{}' })
    f.session.append('tool/result', { turn, step, meta: { original: true }, message: { id: 'result', role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: 'result' }], source: { kind: 'tool', callId: 'call' }, isError: false } }, { surfaceOp: 'append' })
    f.session.append('step/end', { turn, step })
    const before = surfaceKey(f.entries()), length = f.session.snapshotEvents().length
    await f.api.recall({ sessionId: 's1', messageId: b })
    await f.restore((await f.records()).at(-1), 'context')
    expect(surfaceKey(f.entries())).toBe(before)
    const replay = f.session.snapshotEvents().slice(length)
    expect(replay.findLast((e) => e.type === 'assistant/message' && e.data.message.content.some((b) => b.type === 'tool-call')).data.stream).toEqual(stream)
    expect(replay.some((e) => e.type === 'tool/call')).toBe(false)
    expect(f.agent.followup).not.toHaveBeenCalled()
  })
  it('uses the live image-offload interpreter for both checkpoint and write validation', async () => {
    const projections = [{ type: 'image/offload', project: (event, context) => {
      const seq = event.data.seq, message = context.messages.get(seq) ?? context.events[seq].data
      return [[seq, { ...message, content: message.content.map((b) => b.type === 'image' ? { ...b, offloaded: true } : b) }]]
    } }]
    const f = await fixture({ projections }); await f.input('A')
    const message = { ...user('image', 'image'), content: [{ type: 'image', attachment: { id: 'asset', mimeType: 'image/png' } }] }
    const image = f.session.append('user/message', message, { surfaceOp: 'append' })
    f.session.append('image/offload', { seq: image.seq })
    const before = surfaceKey(f.entries())
    await f.api.recall({ sessionId: 's1', messageId: 'image' })
    await f.restore((await f.records()).at(-1), 'context')
    expect(surfaceKey(f.entries())).toBe(before)
    expect(f.entries().at(-1).message.content[0].offloaded).toBe(true)
  })
  it('captures edit/regenerate before the operation and does not duplicate their resend checkpoint', async () => {
    const f = await fixture(); const a = await f.input('A')
    expect((await f.api.editAndResend({ sessionId: 's1', messageId: a, text: 'edited' })).ok).toBe(true)
    const record = (await f.records()).at(-1)
    expect(record.kind).toBe('edit')
    await f.restore(record, 'context')
    const reply = f.entries().find(({ message }) => message.role === 'assistant').message.id
    expect((await f.api.regenerate({ sessionId: 's1', messageId: reply })).ok).toBe(true)
    expect((await f.records()).at(-1).kind).toBe('regenerate')
  })
  it('previews and no-op restores never create records; rejected edits never create records', async () => {
    const f = await fixture(); await f.input('A'); const b = await f.input('B')
    await f.api.recall({ sessionId: 's1', messageId: b })
    await f.restore((await f.records()).at(-1), 'context')
    const record = (await f.records()).find((r) => r.kind === 'recall'), count = (await f.records()).length
    const preview = await f.checkpoints.preview({ sessionId: 's1', versionId: record.versionId, scope: 'context' })
    expect(preview.applicable).toBe(false)
    expect((await f.restore(record, 'context')).context.messages).toBe(0)
    await f.api.editAndResend({ sessionId: 's1', messageId: 'missing', text: 'x' })
    expect((await f.records()).length).toBe(count)
  })
  it('restores matching file preimages and saves the files before restore for the reverse operation', async () => {
    const f = await fixture(), path = join(f.workspace, 'test.txt')
    await disk.writeFile(path, 'A'); await f.input('A')
    await f.input('B')
    await disk.writeFile(path, 'A+B')
    f.history.turns.push({ turn: 2, files: [{ path }] })
    const point = (await f.records()).at(-1)
    expect((await f.restore(point)).complete).toBe(true)
    expect(await disk.readFile(path, 'utf8')).toBe('A')
    const beforeRestore = (await f.records()).at(-1)
    expect((await f.restore(beforeRestore)).complete).toBe(true)
    expect(await disk.readFile(path, 'utf8')).toBe('A+B')
  })
  it('safely removes newly created files and can restore that deletion', async () => {
    const f = await fixture(), path = join(f.workspace, 'created.txt')
    await f.input('A'); await f.input('B'); await disk.writeFile(path, 'created')
    f.history.turns.push({ turn: 2, files: [{ path }] })
    const record = (await f.records()).at(-1)
    expect((await f.restore(record)).complete).toBe(true)
    await expect(disk.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.restore((await f.records()).at(-1))).complete).toBe(true)
    expect(await disk.readFile(path, 'utf8')).toBe('created')
  })
  it('rejects changed preview before any restore and records no-op/failed file mutations honestly', async () => {
    const f = await fixture(), path = join(f.workspace, 'test.txt')
    await disk.writeFile(path, 'A'); await f.input('A'); await f.input('B'); await disk.writeFile(path, 'B')
    f.history.turns.push({ turn: 2, files: [{ path }] })
    const record = (await f.records()).at(-1), args = { sessionId: 's1', versionId: record.versionId, scope: 'both' }
    const preview = await f.checkpoints.preview(args), key = surfaceKey(f.entries())
    await disk.writeFile(path, 'manual')
    await expect(f.checkpoints.execute({ ...args, previewToken: preview.previewToken })).rejects.toMatchObject({ code: 'preview-expired' })
    expect(surfaceKey(f.entries())).toBe(key)
    const count = (await f.records()).length
    await expect(f.checkpoints.withCheckpoint(f.session, 'file-undo', async () => { throw new Error('rejected') }, { paths: [path] })).rejects.toThrow('rejected')
    expect((await f.records()).length).toBe(count)
    await expect(f.checkpoints.withCheckpoint(f.session, 'file-undo', async () => { await disk.writeFile(path, 'partial'); throw new Error('partial') }, { paths: [path] })).rejects.toThrow('partial')
    expect((await f.records()).at(-1).kind).toBe('file-undo')
  })
  it('never pretends old after-operation file snapshots are preimages', async () => {
    const f = await fixture(); await f.input('A'); const b = await f.input('B')
    const writer = createDshMarkerWriter({ meter: f.ctx.tokenMeter, deriveMessage })
    const nodes = f.session.surface.nodes.slice(-2)
    await writer.writeMarker(f.session, { start: nodes[0], end: nodes.at(-1), shadowedSeqs: nodes }, { op: 'recall', targetSeq: nodes[0] })
    const record = (await f.records()).at(-1)
    expect(record.legacy).toBe(true)
    expect((await f.restore(record, 'context')).complete).toBe(true)
    expect(f.texts()).toContain('B')
  })
  it('caps retained records and collects unused private snapshot objects', async () => {
    const f = await fixture(), path = join(f.workspace, 'test.txt')
    f.config.retentionLimit = 1
    await disk.writeFile(path, 'A'); await f.input('A')
    await disk.writeFile(path, 'B'); await f.input('B')
    const store = createCheckpointStore(join(f.seam.storeRoot(), 'checkpoints'))
    await f.records()
    expect((await store.read('s1')).length).toBe(2)
    expect((await f.records())[0].filesUnavailable).toBe(true)
    expect((await store.objectsFor('s1').list()).length).toBe(1)
  })
  it('canceled input does not consume snapshot retention and restore requires a checked preview', async () => {
    const f = await fixture(), path = join(f.workspace, 'test.txt')
    f.config.retentionLimit = 1
    await disk.writeFile(path, 'A'); await f.input('A')
    await disk.writeFile(path, 'canceled draft'); await f.input('canceled', { canceled: true })
    const records = await f.records()
    expect(records).toHaveLength(1)
    expect(records[0].filesUnavailable).not.toBe(true)
    await expect(f.checkpoints.execute({ sessionId: 's1', versionId: records[0].versionId, scope: 'context' })).rejects.toMatchObject({ code: 'preview-required' })
    expect(await f.records()).toHaveLength(1)
  })
  it('message identity may change on replay but attachment and tool-input identities are compared', () => {
    const message = { ...user('original', 'x'), content: [{ type: 'image', attachment: { id: 'asset-A' } }, { type: 'tool-call', toolCallId: 'call', input: { id: 'input-A' } }] }
    const changed = structuredClone(message)
    changed.id = 'replayed'
    expect(surfaceKey([{ message }])).toBe(surfaceKey([{ message: changed }]))
    changed.content[0].attachment.id = 'asset-B'
    expect(surfaceKey([{ message }])).not.toBe(surfaceKey([{ message: changed }]))
    changed.content[0].attachment.id = 'asset-A'; changed.content[1].input.id = 'input-B'
    expect(surfaceKey([{ message }])).not.toBe(surfaceKey([{ message: changed }]))
  })
})
