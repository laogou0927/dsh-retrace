/** Request-boundary pause adapted from dsh-pause (MIT, betterer 2026; LICENSE).
 * Also inlined into the dynamic host. The driver commits accepted messages. */
import { editorId } from './host-core.js'
export function createPauseController(ctx, { defaultEnabled = false } = {}) {
  const states = new Map()
  let disposed = false
  const empty = () => ({ enabled: defaultEnabled === true, waiting: null })
  const stateFor = (id) => states.get(id) ?? empty()
  const status = (id) => {
    const state = stateFor(id)
    return { enabled: state.enabled, paused: state.waiting !== null, gateId: state.waiting?.id ?? null }
  }
  const result = (value) => ({ ok: true, value })
  const failure = (code, message) => ({ ok: false, error: { code, message } })
  function validate(args) {
    if (disposed) return failure('pause-unavailable', 'Pause controller has been disposed')
    if (typeof args?.sessionId !== 'string' || args.sessionId.trim() === '') return failure('bad-request', 'sessionId is required')
    if (!ctx.sessions?.get?.(args.sessionId)) return failure('not-found', 'Session not found')
    return null
  }
  function settle(id, gate, messages) {
    const state = stateFor(id)
    if (state.waiting !== gate) return false
    state.waiting = null
    gate.resolve(messages)
    return true
  }
  const ops = {
    pauseStatus(args) { return validate(args) ?? result(status(args.sessionId)) },
    pauseSetEnabled(args) {
      const error = validate(args)
      if (error) return error
      if (typeof args.enabled !== 'boolean') return failure('bad-request', 'enabled must be a boolean')
      const state = stateFor(args.sessionId)
      states.set(args.sessionId, state)
      state.enabled = args.enabled
      if (!state.enabled && state.waiting) settle(args.sessionId, state.waiting, [])
      return result(status(args.sessionId))
    },
    pauseRelease(args) {
      const error = validate(args)
      if (error) return error
      if (typeof args.gateId !== 'string' || (args.text !== undefined && typeof args.text !== 'string')) {
        return failure('bad-request', 'gateId:string and optional text:string are required')
      }
      const gate = stateFor(args.sessionId).waiting
      if (!gate || gate.id !== args.gateId || gate.signal.aborted) return result({ ...status(args.sessionId), released: false })
      const text = (args.text ?? '').trim()
      if (text.length > 64 * 1024) return failure('payload-too-large', 'Pause text exceeds 64 KiB')
      // Same identified user-message shape as retrace resends. Empty release
      // adds no message, marker or notice. Never write the session log here.
      const messages = text === '' ? [] : [Object.freeze({
        id: editorId('pause'), role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text })]),
        source: Object.freeze({ kind: 'user', rpcId: editorId('pause-input') }),
      })]
      const released = settle(args.sessionId, gate, messages)
      return result({ ...status(args.sessionId), released })
    },
  }
  async function preStep({ agent, step, signal }, next) {
    if (disposed || signal.aborted) return { kind: 'reject' }
    const state = stateFor(agent.id)
    if (!state.enabled || step <= 1) return next()
    if (state.waiting) return { kind: 'reject' } // Never orphan an existing waiter.
    let resolve
    const ready = new Promise((done) => { resolve = done })
    const gate = { id: editorId('pause-gate'), resolve, signal }
    state.waiting = gate
    states.set(agent.id, state)
    const abort = () => settle(agent.id, gate, null)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    let messages
    try { messages = await ready } finally { signal.removeEventListener('abort', abort) }
    if (messages === null || disposed || signal.aborted) return { kind: 'reject' }
    const decision = await next()
    if (signal.aborted || disposed) return { kind: 'reject' }
    if (decision.kind === 'reject' || messages.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...messages] }
  }
  let disposeHook = null
  return {
    ops,
    register() {
      if (!disposeHook && !disposed && typeof ctx.on === 'function') disposeHook = ctx.on('agent/pre-step', preStep)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (typeof disposeHook === 'function') disposeHook()
      for (const [id, state] of states) if (state.waiting) settle(id, state.waiting, null)
      states.clear()
    },
  }
}
