import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createPauseController } from '../lib/pause.js'
import { createRetraceHttpHandler } from '../lib/http.js'

const controllers = []
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose() })
function fixture(options) {
  const hooks = new Map()
  const ctx = {
    sessions: { get: (id) => ['a', 'b'].includes(id) ? { id } : undefined },
    on: (name, listener) => { hooks.set(name, listener); return () => hooks.delete(name) },
  }
  const controller = createPauseController(ctx, options)
  controllers.push(controller)
  controller.register()
  const ops = controller.ops
  const start = (id = 'a', step = 2, abort = new AbortController(), decision = { kind: 'enter', messages: [] }) => {
    const next = vi.fn(async () => decision)
    const done = hooks.get('agent/pre-step')({ agent: { id }, turn: 1, step, signal: abort.signal }, next)
    return { done, next, abort, gateId: ops.pauseStatus({ sessionId: id }).value?.gateId }
  }
  const enable = (id = 'a', enabled = true) => ops.pauseSetEnabled({ sessionId: id, enabled })
  const release = (gate, text = '', id = 'a') => ops.pauseRelease({ sessionId: id, gateId: gate.gateId, text })
  return { ctx, controller, hooks, ops, start, enable, release }
}

describe('request-boundary pause', () => {
  it('is off by default, does not gate the first request, and keeps sessions independent', async () => {
    const f = fixture()
    expect(f.ops.pauseStatus({ sessionId: 'a' }).value).toEqual({ enabled: false, paused: false, gateId: null })
    expect(await f.start().done).toEqual({ kind: 'enter', messages: [] })
    f.enable()
    expect(await f.start('a', 1).done).toEqual({ kind: 'enter', messages: [] })
    expect(await f.start('b').done).toEqual({ kind: 'enter', messages: [] })
    expect(f.ops.pauseStatus({ sessionId: 'b' }).value.enabled).toBe(false)
  })
  it('blocks before the next handler and returns the exact original decision on empty release', async () => {
    const f = fixture(); f.enable()
    const decision = { kind: 'enter', messages: [{ id: 'original' }], startsRequestSeries: true }
    const gate = f.start('a', 2, new AbortController(), decision)
    expect(gate.next).not.toHaveBeenCalled()
    expect(f.release(gate, '   ').value.released).toBe(true)
    expect(await gate.done).toBe(decision)
    expect(gate.next).toHaveBeenCalledTimes(1)
  })
  it('adds identified steering only to the admitted request, preserving existing messages and flags', async () => {
    const f = fixture(); f.enable()
    const original = { id: 'original', role: 'user' }
    const decision = { kind: 'enter', messages: [original], startsRequestSeries: true }
    const gate = f.start('a', 2, new AbortController(), decision)
    f.release(gate, '  请先检查结果  ')
    const accepted = await gate.done
    expect(accepted.messages[0]).toBe(original)
    expect(accepted.messages[1]).toMatchObject({ id: expect.any(String), role: 'user', content: [{ type: 'text', text: '请先检查结果' }], source: { kind: 'user' } })
    expect(accepted.startsRequestSeries).toBe(true)
    expect(decision.messages).toEqual([original])
  })
  it('rejects a cancelled wait without calling downstream admission, then can pause the next turn', async () => {
    const f = fixture(); f.enable()
    const gate = f.start()
    gate.abort.abort()
    expect(await gate.done).toEqual({ kind: 'reject' })
    expect(gate.next).not.toHaveBeenCalled()
    expect(f.ops.pauseStatus({ sessionId: 'a' }).value.paused).toBe(false)
    const second = f.start(); f.release(second)
    expect((await second.done).kind).toBe('enter')
  })
  it('rejects an already-aborted proposal', async () => {
    const f = fixture(); f.enable()
    const abort = new AbortController(); abort.abort()
    const gate = f.start('a', 2, abort)
    expect(await gate.done).toEqual({ kind: 'reject' })
    expect(gate.next).not.toHaveBeenCalled()
    expect(gate.gateId).toBe(null)
  })
  it('disabling pause releases the current wait without steering', async () => {
    const f = fixture(); f.enable()
    const gate = f.start()
    expect(f.enable('a', false).value).toEqual({ enabled: false, paused: false, gateId: null })
    expect(await gate.done).toEqual({ kind: 'enter', messages: [] })
  })
  it('cannot release the next gate using a duplicate or delayed request', async () => {
    const f = fixture(); f.enable()
    const first = f.start(); f.release(first); await first.done
    const second = f.start('a', 3)
    expect(second.gateId).not.toBe(first.gateId)
    expect(f.release(first, 'stale').value.released).toBe(false)
    expect(second.next).not.toHaveBeenCalled()
    expect(f.release(second).value.released).toBe(true)
    await second.done
  })
  it('never overwrites a waiter if the same session proposes another step', async () => {
    const f = fixture(); f.enable()
    const first = f.start(); const duplicate = f.start()
    expect(await duplicate.done).toEqual({ kind: 'reject' })
    f.release(first); await first.done
  })
  it('respects downstream rejection and cancellation during downstream admission', async () => {
    const f = fixture(); f.enable()
    const rejected = f.start('a', 2, new AbortController(), { kind: 'reject' })
    f.release(rejected, 'text'); expect(await rejected.done).toEqual({ kind: 'reject' })
    const gate = f.start(); gate.next.mockImplementationOnce(async () => { gate.abort.abort(); return { kind: 'enter', messages: [] } })
    f.release(gate); expect(await gate.done).toEqual({ kind: 'reject' })
  })
  it('disposal cleans up both sessions and listeners without hanging pending steps', async () => {
    const f = fixture({ defaultEnabled: true })
    const a = f.start(); const b = f.start('b')
    f.controller.dispose(); f.controller.dispose()
    expect(await a.done).toEqual({ kind: 'reject' })
    expect(await b.done).toEqual({ kind: 'reject' })
    expect(f.hooks.size).toBe(0)
    expect(f.ops.pauseStatus({ sessionId: 'a' }).error.code).toBe('pause-unavailable')
  })
  it('rejects invalid requests without releasing the gate', () => {
    const f = fixture(); f.enable(); const gate = f.start()
    expect(f.ops.pauseStatus(null).error.code).toBe('bad-request')
    expect(f.ops.pauseSetEnabled({ sessionId: 'missing', enabled: true }).error.code).toBe('not-found')
    expect(f.enable('a', 'yes').error.code).toBe('bad-request')
    expect(f.ops.pauseRelease({ sessionId: 'a', text: 'x' }).error.code).toBe('bad-request')
    expect(f.release(gate, 1).error.code).toBe('bad-request')
    expect(f.release(gate, 'x'.repeat(65537)).error.code).toBe('payload-too-large')
    expect(gate.next).not.toHaveBeenCalled()
  })
})

async function post(handler, op, payload) {
  const req = new EventEmitter()
  Object.assign(req, { method: 'POST', url: `/api/plugins/retrace/${op}`, headers: {}, setEncoding() {}, destroy() {} })
  return new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }) } }
    handler(req, res)
    req.emit('data', JSON.stringify(payload)); req.emit('end')
  })
}
describe('pause transports', () => {
  it('uses the existing published HTTP route for status, enable and text release', async () => {
    const f = fixture()
    const handler = createRetraceHttpHandler(f.ctx, { sessions: f.ctx.sessions, agents: {}, seam: { setConfig() {} }, extraOps: f.ops })
    expect((await post(handler, 'pauseStatus', { sessionId: 'a' })).body.value.enabled).toBe(false)
    expect((await post(handler, 'pauseSetEnabled', { sessionId: 'a', enabled: true })).body.ok).toBe(true)
    const gate = f.start()
    const reply = await post(handler, 'pauseRelease', { sessionId: 'a', gateId: gate.gateId, text: 'continue carefully' })
    expect(reply).toMatchObject({ status: 200, body: { ok: true, value: { released: true } } })
    expect((await gate.done).messages[0].content[0].text).toBe('continue carefully')
  })
  it('runs the generated host gate through the dynamic RPC bridge', async () => {
    const handled = new Map(); const hooks = new Map(); const disposers = []
    const harness = { handle: (name, fn) => { handled.set(name, fn); return () => handled.delete(name) } }
    const source = readFileSync(new URL('../lib/dynamic-host.js', import.meta.url), 'utf8')
    const plugin = new Function('harness', source)(harness)
    plugin.apply({ sessions: { get: () => ({ id: 'a' }) }, agents: {}, on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name) }, effect: (fn) => disposers.push(fn()) })
    try {
      handled.get('retrace.pauseSetEnabled')({ sessionId: 'a', enabled: true })
      const done = hooks.get('agent/pre-step')({ agent: { id: 'a' }, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
      const gateId = handled.get('retrace.pauseStatus')({ sessionId: 'a' }).value.gateId
      expect(handled.get('retrace.pauseRelease')({ sessionId: 'a', gateId, text: 'dynamic steering' }).value.released).toBe(true)
      expect((await done).messages[0].content[0].text).toBe('dynamic steering')
    } finally { disposers.forEach((dispose) => dispose()) }
    expect(hooks.size).toBe(0); expect(handled.size).toBe(0)
  })
})
