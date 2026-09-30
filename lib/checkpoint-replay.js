/** Restore a complete surface through native append-only events. Replayed tool
 * results are historical data: no model request or tool execution is started. */
import { randomUUID } from 'node:crypto'
import { Session, deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'
import { createPreWriter } from './vendor/dsh-log-contract.js'
import { sessionEvents } from './host-compat.js'
import { editorError } from './host-core.js'

export function surfaceEntries(events, projections = []) {
  const surface = foldSurface(events, projections)
  return surface.nodes.map((seq) => ({ event: events[seq], message: deriveEventMessage(events[seq], surface.projectedMessages) }))
    .filter((entry) => entry.message !== null)
}

/** Only message identity and transport ids change on replay. Attachment ids,
 * call/result associations and every tool input field remain actual content. */
export function surfaceKey(entries) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    return value
  }
  return JSON.stringify(entries.map(({ message }) => {
    const value = structuredClone(message)
    delete value.id
    delete value.source.rpcId
    // Attachment ids and tool input fields named id/rpcId are actual content.
    return stable(value)
  }))
}

export function planCheckpointReplay(session, target, { projections = [], meter } = {}) {
  const events = sessionEvents(session)
  const surface = foldSurface(events, projections), nodes = surface.nodes
  const current = surfaceEntries(events, projections)
  let common = 0
  while (common < target.length && common < current.length && surfaceKey([target[common]]) === surfaceKey([current[common]])) common += 1
  const keepEnd = common ? nodes.indexOf(current[common - 1].event.seq) : -1
  const removed = nodes.filter((_seq, index) => index > keepEnd)
  const planned = []
  const turn = events.reduce((n, e) => Math.max(n, Number.isSafeInteger(e.data?.turn) ? e.data.turn : 0), 0)
  let step = events.reduce((n, e) => Math.max(n, e.data?.turn === turn && Number.isSafeInteger(e.data?.step) ? e.data.step : 0), 0) + 1
  const add = (type, data, extra = {}) => {
    const event = { type, data, seq: events.length + planned.length, time: Date.now(), ...extra }
    planned.push(event)
    return event
  }
  // Step envelopes use the existing turn watermark; opening a synthetic turn
  // would desynchronize the live agent's next-turn counter. Each envelope is
  // balanced and carries no request/header or usage (no new model work).
  const withinStep = (fn) => { add('step/start', { turn, step }); fn(); add('step/end', { turn, step }); step += 1 }
  const emptySystem = () => ({ role: 'system', id: `restore-empty-${randomUUID()}`, content: [], source: { kind: 'system-prompt' } })
  const head = nodes.length && events[nodes[0]].type === 'system/message' ? nodes[0] : null
  const targetHead = target[0]?.event.type === 'system/message' ? target[0] : null
  const replacement = (seqs, message) => {
    if (!seqs.length) return
    const prices = typeof meter?.measure === 'function' ? new Map((meter.measure(session)?.nodes ?? []).map((node) => [node.seq, node.tokens])) : new Map()
    const tokens = seqs.reduce((sum, seq) => {
      const msg = deriveEventMessage(events[seq], surface.projectedMessages)
      const price = msg === null ? 0 : typeof meter?.estimateMessage === 'function' ? meter.estimateMessage(msg) : prices.get(seq)
      if (!Number.isSafeInteger(price) || price < 0) throw editorError('meter-unavailable', 'Invalid token price')
      return sum + price
    }, 0)
    const audit = add('compaction/prune', { shadowedRange: { start: seqs[0], end: seqs.at(-1) }, shadowedSeqs: seqs, shadowedTokenCount: tokens })
    add('system/message', { turn, step, message }, {
      surfaceOp: { op: 'replace', startSeq: seqs[0], endSeq: seqs.at(-1) }, sourceEventSeqs: [audit.seq, ...seqs],
    })
  }
  const rewriteHead = common === 0 && head !== null
  if (removed.length) withinStep(() => {
    if (rewriteHead) replacement([head], targetHead ? { ...structuredClone(targetHead.message), id: `restore-message-${randomUUID()}` } : emptySystem())
    replacement(rewriteHead ? removed.filter((seq) => seq !== head) : removed, emptySystem())
  })
  for (const [index, entry] of target.entries()) {
    if (index < common || (entry === targetHead && rewriteHead)) continue
    const type = entry.event.type
    const message = { ...structuredClone(entry.message), id: `restore-message-${randomUUID()}` }
    if (type === 'user/message') add(type, message, { surfaceOp: 'append' })
    else withinStep(() => {
      const data = { ...structuredClone(entry.event.data), turn, step, message }
      delete data.usage
      if (type === 'assistant/message') data.stream ??= []
      add(type, data, { surfaceOp: 'append' })
    })
  }
  const full = [...events, ...planned]
  // Both the real host and the shipped contract must accept the ENTIRE batch
  // before its first append, so rejection cannot leave a partial restore.
  Session.create(session.id, full, session.header, session.inheritedEventCount, projections)
  const verdict = createPreWriter({ events, header: session.header, projections }).validateEdit(full)
  if (!verdict.ok) throw editorError('restore-rejected', verdict.violations.filter((v) => v.severity === 'error').map((v) => `${v.ruleId ?? v.code}: ${v.message}`).join('; '))
  if (surfaceKey(surfaceEntries(full, projections)) !== surfaceKey(target)) throw editorError('restore-rejected', 'Restored surface differs from checkpoint')
  return { cut: events.length, events: planned }
}

export function appendCheckpointReplay(session, plan) {
  if (sessionEvents(session).length !== plan.cut) throw editorError('preview-expired', 'Conversation changed; refresh the preview')
  for (const event of plan.events) {
    const { type, data, surfaceOp, sourceEventSeqs } = event
    session.append(type, data, surfaceOp === undefined ? undefined : { surfaceOp, ...(sourceEventSeqs ? { sourceEventSeqs } : {}) })
  }
}
