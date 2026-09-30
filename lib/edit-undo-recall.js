/** Conversation/file rewind uses Retrace's official surface probe and writer.
 * A preview pins the complete log. Revalidate before files and before marker.
 */
import { createHash } from 'node:crypto'
import { computeSpanProbe, dshAdapter } from './adapter/dsh.js'
import { sessionEvents } from './host-compat.js'

const fail = (code, message) => Object.assign(new Error(message), { code })
const signature = (events) => createHash('sha256').update(JSON.stringify(events)).digest('hex')

export function createUndoRecall(ctx, api, { reader = dshAdapter.reader.readEvents, probe = computeSpanProbe } = {}) {
  async function view(session, messageId) {
    await ctx.sessions.flush?.(session)
    const events = await reader(session.id)
    if (!Array.isArray(events) || !events.length) throw fail('preview-expired', '会话尚未完整落盘，请刷新预览')
    const live = sessionEvents(session)
    if (live.some((event) => event && event.seq > events.at(-1).seq)) throw fail('preview-expired', '会话正在变化，请刷新预览')
    const target = events.findLast((event) => event.type === 'user/message' && event.data?.id === messageId)
    if (!target || target.data?.source?.kind !== 'user') throw fail('message-not-found', '请选择要撤回的用户消息')
    const result = probe(events, messageId, 'tail', { projections: ctx.sessions.messageProjections })
    if (!result?.span) {
      const code = result?.status === 'replay-failed' ? 'span-replay-failed' : 'target-shadowed'
      throw Object.assign(fail(code, code === 'span-replay-failed' ? '会话日志重放失败，无法安全计算撤回范围，请刷新或反馈该会话' : '这条消息已折叠或不在当前对话中，无法同时撤回'), { details: { spanFacts: result?.facts } })
    }
    const turns = [...new Set(events.filter((event) => event.seq >= target.seq && Number.isSafeInteger(event.data?.turn)).map((event) => event.data.turn))]
    const text = (target.data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
    return { messageId, targetSeq: target.seq, text, span: result.span, turns, signature: signature(events) }
  }
  async function validate(session, plan) {
    const fresh = await view(session, plan.messageId)
    if (fresh.signature !== plan.signature || JSON.stringify(fresh.span) !== JSON.stringify(plan.span)) throw fail('preview-expired', '对话已变化，请刷新预览并重新选择')
  }
  return {
    preview: view,
    async run(session, plan, applyFiles) {
      let applied
      const result = await api.recallWithFiles({ sessionId: session.id, messageId: plan.messageId, span: plan.span, recallTarget: { seq: plan.targetSeq, text: plan.text } }, async () => {
        await validate(session, plan)
        const files = await applyFiles()
        applied = files
        if (files.complete) {
          try { await validate(session, plan) }
          catch (error) { throw Object.assign(fail(error.code, '文件已按选择处理，但对话发生变化，未撤回对话；请刷新或使用仅撤回对话'), { details: { files } }) }
        }
        return files
      })
      if (!result.ok) throw Object.assign(fail(result.error.code, applied?.complete ? `文件已按选择处理，但对话撤回失败：${result.error.message}；请刷新或使用仅撤回对话` : result.error.message), { details: { ...result.error, ...(applied ? { files: applied } : {}) } })
      return result.value
    },
  }
}
