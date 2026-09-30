import { describe, expect, it, vi } from 'vitest'
import { createTimelineActivityReader, pauseHistory } from '../lib/timeline-activity.js'
import { editorId } from '../lib/host-core.js'

const steering = (seq, text = '先检查文件') => ({
  seq, time: 1234 + seq, type: 'user/message', surfaceOp: 'append',
  data: { id: editorId('pause'), source: { kind: 'user', rpcId: editorId('pause-input') }, content: [{ type: 'text', text }] },
})

describe('checkpoint-page activity reads', () => {
  it('reads committed steering verbatim, including messages later removed from the surface', () => {
    const event = steering(2, 'first\nsecond')
    const events = [event, { seq: 3, type: 'user/message', surfaceOp: { kind: 'replace', range: [2, 2] }, data: { id: 'retrace-recall' } }]
    const before = JSON.stringify(events)
    expect(pauseHistory({ snapshotEvents: () => events })).toEqual([{ id: event.data.id, kind: 'pause', seq: 2, createdAt: 1236, text: 'first\nsecond' }])
    expect(JSON.stringify(events)).toBe(before)
  })
  it('ignores ordinary messages, empty releases, replaced carriers and unrelated retrace messages', () => {
    const ordinary = steering(1); ordinary.data.id = 'ordinary'
    const replacement = steering(2); replacement.surfaceOp = { kind: 'replace', range: [0, 1] }
    const unrelated = steering(3); unrelated.data.source.rpcId = editorId('resend')
    expect(pauseHistory({ events: [ordinary, replacement, unrelated, steering(4, '  ')] })).toEqual([])
  })
  it('bounds steering history to the newest 200 committed entries', () => {
    const result = pauseHistory({ events: Array.from({ length: 205 }, (_, i) => steering(i)) })
    expect(result).toHaveLength(200); expect(result[0].seq).toBe(5)
  })
  it('reads the journal metadata for this session and rejects missing sessions', async () => {
    const journal = { timeline: vi.fn(async () => ({ turns: [{ turn: 1 }], fileUndos: [] })) }
    const read = createTimelineActivityReader({ sessions: new Map([['s', { events: [steering(0)] }]]) }, journal)
    expect(await read('s')).toMatchObject({ sessionId: 's', pauses: [{ seq: 0 }], turns: [{ turn: 1 }] })
    expect(journal.timeline).toHaveBeenCalledWith('s')
    await expect(read('missing')).rejects.toMatchObject({ code: 'session-not-found' })
  })
  it('preserves steering history and explicitly reports a damaged file journal', async () => {
    const read = createTimelineActivityReader({ sessions: new Map([['s', { events: [steering(0)] }]]) }, { timeline: async () => { throw Object.assign(new Error('bad journal'), { code: 'journal-invalid' }) } })
    expect(await read('s')).toMatchObject({ pauses: [{ seq: 0 }], fileError: { code: 'journal-invalid' }, turns: [], fileUndos: [] })
  })
})
