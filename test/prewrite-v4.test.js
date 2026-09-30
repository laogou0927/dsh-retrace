import { describe, expect, it, vi } from 'vitest'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { createMarkerGuard } from '../lib/prewrite-guard.js'
import { createPreWriter, supportOfLog } from '../lib/vendor/dsh-log-contract.js'

const header = { type: 'session', version: 4, id: 'v4-test', createdAt: 0, isSeeded: false }
const text = (value) => [{ type: 'text', text: value }]
function v4Events() {
  const events = [
    { type: 'system/message', data: { message: { id: 'system', role: 'system', content: text('system'), source: { kind: 'system-prompt' } } } },
    { type: 'developer/message', data: { message: { id: 'developer', role: 'developer', content: text('tools changed'), source: { kind: 'tools' } } } },
    { type: 'user/message', data: { id: 'user', role: 'user', content: text('question'), source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'assistant', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'echo', input: {} }], source: { kind: 'model', provider: 'test', model: 'test' } } } },
    { type: 'tool/result', data: { message: { id: 'result', role: 'tool', toolCallId: 'call', content: text('result'), isError: false, source: { kind: 'tool', callId: 'call' } } } },
  ]
  return events.map((event, seq) => ({ ...event, seq, time: 0, surfaceOp: 'append' }))
}
function plannedPair() {
  return {
    marker: {
      type: 'user/message', time: 0,
      data: { id: 'retrace-recall-v4', role: 'user', content: text('recalled'), source: { kind: 'model', provider: 'test', model: 'test' } },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: [5, 2, 3, 4],
    },
    extra: { phase: 'pair', auditSeq: 5, audit: { shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 3, 4], shadowedTokenCount: 1 } },
  }
}

describe('bundled v4 pre-write contract (default guard, no profile patch)', () => {
  it('v4 is writable; a future unknown format retains the advisory policy', () => {
    expect(supportOfLog({ header, events: v4Events() }).readOnly).toBe(false)
    expect(supportOfLog({ header: { ...header, version: 5 }, events: [] }).readOnly).toBe(true)
  })

  it('accepts host-valid system/developer/tool events and a planned marker pair', async () => {
    const events = v4Events()
    expect(foldSurface(events).nodes).toEqual([0, 1, 2, 3, 4])
    const log = vi.fn()
    const guard = createMarkerGuard({ log })
    const { marker, extra } = plannedPair()
    await expect(guard.validateMarkerAppend({ id: header.id, header, events }, marker, extra)).resolves.toEqual({ t1Ok: true })
    expect(events).toHaveLength(5)
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/ADVISORY|unavailable/)
  })

  it('rejects damaged provenance before either planned segment is appended', async () => {
    const events = v4Events()
    const log = vi.fn()
    const guard = createMarkerGuard({ log })
    const { marker, extra } = plannedPair()
    marker.sourceEventSeqs = []
    await expect(guard.validateMarkerAppend({ id: header.id, header, events }, marker, extra)).rejects.toMatchObject({ code: 'marker-rejected' })
    expect(events).toHaveLength(5)
    expect(log.mock.calls.flat().join('\n')).toMatch(/rejected by contract guard/)
  })

  it.each([
    ['system source', 0, (event) => { event.data.message.source.kind = 'plugin' }],
    ['tool role', 4, (event) => { event.data.message.role = 'user' }],
    ['tool call id', 4, (event) => { event.data.message.toolCallId = 'other' }],
    ['developer role', 1, (event) => { event.data.message.role = 'user' }],
  ])('rejects an invalid v4 %s through the real rules and official fold', (_name, index, damage) => {
    const events = v4Events()
    damage(events[index])
    expect(createPreWriter({ events, header }).validateAppend({ type: 'session/title', time: 0, data: {} }).ok).toBe(false)
  })

  it('borrows the live projection; missing definitions still fail official replay', async () => {
    const events = [...v4Events(), { seq: 5, time: 0, type: 'image/offload', data: {} }]
    const project = vi.fn(() => [])
    const session = { id: header.id, header, events, surface: { projections: [{ type: 'image/offload', project }] } }
    const candidate = { type: 'user/message', time: 0, surfaceOp: 'append', data: { id: 'next', role: 'user', content: text('next'), source: { kind: 'user' } } }
    await expect(createMarkerGuard().validateMarkerAppend(session, candidate)).resolves.toEqual({ t1Ok: true })
    expect(project).toHaveBeenCalled()
    session.surface.projections = []
    await expect(createMarkerGuard().validateMarkerAppend(session, candidate)).rejects.toMatchObject({ code: 'marker-rejected' })
  })
})
