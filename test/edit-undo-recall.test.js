import { describe, expect, it, vi } from 'vitest'
import { createUndoRecall } from '../lib/edit-undo-recall.js'
import { createEditorApi } from '../lib/host-core.js'
import { makeSession, userMessage, assistantMessage, headerEvent, makeAgent, makeEnv, makeHooks } from './helpers.js'

function fixture(hooks = {}) {
  const session = makeSession().seed(headerEvent(), userMessage('u1', 'first input'), assistantMessage('a1', 'first output'), userMessage('u2', 'second input'), assistantMessage('a2', 'second output'))
  const agent = makeAgent()
  const env = makeEnv(session, { agent })
  const ctx = { ...env }
  const api = createEditorApi(ctx, env.sessions, env.agents, () => {}, makeHooks(env.agents, hooks))
  const persisted = session.snapshotEvents
  const bridge = createUndoRecall(ctx, api, { reader: async () => persisted().map((event) => ['user/message', 'assistant/message'].includes(event.type) && !event.surfaceOp ? { ...event, surfaceOp: 'append' } : event) })
  return { session, bridge }
}
describe('conversation/file rewind composition', () => {
  it('uses the official tail surface and returns the original input only after complete file undo', async () => {
    const f = fixture()
    const plan = await f.bridge.preview(f.session, 'u1')
    expect(plan.span.shadowedSeqs).toEqual([1, 2, 3, 4])
    const original = f.session.snapshotEvents()
    const files = vi.fn(async () => {
      expect(f.session.snapshotEvents()).toEqual(original)
      return { complete: true, results: [{ status: 'restored' }] }
    })
    const result = await f.bridge.run(f.session, plan, files)
    expect(result.conversation.text).toBe('first input')
    expect(f.session.surface.nodes).not.toContain(1)
    expect(f.session.surface.nodes).not.toContain(4)
    expect(f.session.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(files).toHaveBeenCalledTimes(1)
  })
  it('leaves the complete dialogue intact if the file pass is incomplete', async () => {
    const f = fixture(), original = f.session.snapshotEvents()
    const plan = await f.bridge.preview(f.session, 'u2')
    const result = await f.bridge.run(f.session, plan, async () => ({ complete: false, results: [{ status: 'failed' }] }))
    expect(result.conversation).toBe(null)
    expect(f.session.snapshotEvents()).toEqual(original)
  })
  it('invalidates a stale dialogue preview before files, even when the target remains visible', async () => {
    const f = fixture()
    const plan = await f.bridge.preview(f.session, 'u1')
    f.session.append('session/title', { title: 'changed' })
    const files = vi.fn()
    await expect(f.bridge.run(f.session, plan, files)).rejects.toMatchObject({ code: 'preview-expired' })
    expect(files).not.toHaveBeenCalled()
    expect(f.session.surface.nodes).toContain(1)
  })
  it('reports completed files if the dialogue changes while files are being restored', async () => {
    const f = fixture()
    const plan = await f.bridge.preview(f.session, 'u1')
    await expect(f.bridge.run(f.session, plan, async () => {
      f.session.append('session/title', { title: 'concurrent' })
      return { complete: true, results: [] }
    })).rejects.toMatchObject({ code: 'preview-expired', details: { files: { complete: true } } })
    expect(f.session.surface.nodes).toContain(1)
  })
  it('reports a marker failure without claiming that the dialogue was withdrawn', async () => {
    const f = fixture({ writeMarker: async () => { throw new Error('fixture marker rejected') } })
    const original = f.session.snapshotEvents(), plan = await f.bridge.preview(f.session, 'u1')
    await expect(f.bridge.run(f.session, plan, async () => ({ complete: true, results: [] }))).rejects.toMatchObject({ message: expect.stringContaining('对话撤回失败'), details: { files: { complete: true } } })
    expect(f.session.snapshotEvents()).toEqual(original)
  })
  it('refuses assistant and already withdrawn targets', async () => {
    const f = fixture()
    await expect(f.bridge.preview(f.session, 'a1')).rejects.toMatchObject({ code: 'message-not-found' })
    const plan = await f.bridge.preview(f.session, 'u1')
    await f.bridge.run(f.session, plan, async () => ({ complete: true, results: [] }))
    await expect(f.bridge.preview(f.session, 'u1')).rejects.toMatchObject({ code: 'target-shadowed' })
  })
  it('uses the file-authoritative input when the live event window no longer contains the target', async () => {
    const f = fixture()
    const plan = await f.bridge.preview(f.session, 'u1')
    const full = f.session.snapshotEvents()
    f.session.snapshotEvents = () => full.map((event) => event.seq === 1 ? undefined : event)
    const result = await f.bridge.run(f.session, plan, async () => ({ complete: true, results: [] }))
    expect(result.conversation.text).toBe('first input')
    expect(f.session.surface.nodes).not.toContain(1)
  })
})
