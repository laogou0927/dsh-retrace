/** Read-only activity metadata; these are not restorable replacement boundaries. */
import { sessionEvents } from './host-compat.js'

export function pauseHistory(session) {
  const records = []
  for (const event of sessionEvents(session)) {
    const message = event?.data
    if (event?.type !== 'user/message' || event.surfaceOp !== 'append' ||
        !Number.isSafeInteger(event.seq) || message?.source?.kind !== 'user' ||
        !message.id?.startsWith?.('retrace-pause-') || !message.source.rpcId?.startsWith?.('retrace-pause-input-')) continue
    const text = (Array.isArray(message.content) ? message.content : [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
    if (!text.trim()) continue
    records.push({ id: message.id, kind: 'pause', seq: event.seq, createdAt: event.time, text })
  }
  return records.slice(-200)
}

export function createTimelineActivityReader(ctx, editUndo) {
  return async (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (!session) throw Object.assign(new Error('Session not found'), { code: 'session-not-found' })
    const pauses = pauseHistory(session)
    try { return { sessionId, pauses, ...await editUndo.timeline(sessionId) } }
    catch (error) {
      // A damaged file journal must not hide committed steering messages.
      return { sessionId, pauses, turns: [], fileUndos: [], fileError: { code: error.code ?? 'internal', message: error.message } }
    }
  }
}
