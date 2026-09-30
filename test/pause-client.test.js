import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Render hook state and commit/clean up real effects, including the DOM capture.
const hooks = vi.hoisted(() => ({ values: [], index: 0, effects: [] }))
vi.mock('react', () => ({
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
  useState: (initial) => {
    const i = hooks.index++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[i], (next) => { hooks.values[i] = typeof next === 'function' ? next(hooks.values[i]) : next }]
  },
  useRef: (value) => {
    const i = hooks.index++
    return hooks.values[i] ??= { current: value }
  },
  useEffect: (callback, deps) => {
    const i = hooks.index++
    const old = hooks.values[i]
    if (!old || deps.some((dep, k) => dep !== old.deps[k])) {
      hooks.effects.push(() => {
        old?.dispose?.()
        hooks.values[i] = { deps, dispose: callback() }
      })
    }
  },
}))
import * as react from 'react'
import { createPauseControl } from '../lib/pause-client.js'
const PauseControl = createPauseControl(react)

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function find(node, key) {
  if (!node || typeof node !== 'object') return null
  if (node.props.key === key) return node
  for (const child of node.children) { const hit = find(child, key); if (hit) return hit }
  return null
}
let handlers
beforeEach(() => {
  vi.useFakeTimers()
  hooks.values = []; hooks.index = 0; hooks.effects = []
  handlers = new Map()
  vi.stubGlobal('document', {
    addEventListener: (name, fn, capture) => { expect(capture).toBe(true); handlers.set(name, fn) },
    removeEventListener: (name, fn) => { if (handlers.get(name) === fn) handlers.delete(name) },
  })
})
afterEach(() => {
  for (const value of hooks.values) value?.dispose?.()
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})

function fixture(status = { enabled: true, paused: true, gateId: 'gate-1' }) {
  let input = { draft: '', draftRev: 1, attachmentIds: [], occurrences: [], phase: 'plain' }
  const actions = { setDraft: vi.fn((draft) => { input = { ...input, draft, draftRev: input.draftRev + 1 } }) }
  const call = vi.fn(async (op, payload) => {
    if (op === 'pauseRelease') { status = { ...status, paused: false, gateId: null }; return { ok: true, value: { ...status, released: true } } }
    if (op === 'pauseSetEnabled') status = { ...status, enabled: payload.enabled, paused: payload.enabled && status.paused }
    return { ok: true, value: { ...status } }
  })
  const props = { sessionId: 'a', call, t: (key) => key, useInput: vi.fn((selector) => selector(input)), inputActions: actions }
  const editor = {}
  const card = { contains: (node) => node === editor }
  let tree
  const render = () => {
    hooks.index = 0
    tree = PauseControl(props)
    if (tree) tree.props.ref.current = { isConnected: true, closest: () => card }
    for (const effect of hooks.effects.splice(0)) effect()
    return tree
  }
  const boot = async () => { render(); await flush(); render(); return tree }
  const event = (extra = {}) => ({
    key: 'Enter', target: { closest: () => editor }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
  })
  return {
    props, call, actions, render, boot, event,
    setInput: (patch) => { input = { ...input, ...patch } },
    click: (key) => find(render(), key)?.props.onClick(),
    setStatus: (next) => { status = next },
  }
}

describe('composer request-boundary pause', () => {
  it('uses selector hooks, renders a compact theme button, and enables the current session', async () => {
    const f = fixture({ enabled: false, paused: false, gateId: null })
    const tree = await f.boot()
    expect(f.props.useInput).toHaveBeenCalledWith(expect.any(Function))
    expect(find(tree, 'resume')).toBe(null)
    expect(find(tree, 'toggle').props).toMatchObject({ className: 'dsh-rt-icon dsh-rt-pause-toggle', 'aria-pressed': false })
    await f.click('toggle')
    expect(f.call).toHaveBeenLastCalledWith('pauseSetEnabled', { sessionId: 'a', enabled: true })
    expect(find(f.render(), 'toggle').props['aria-pressed']).toBe(true)
  })
  it('releases an empty draft with Enter and removes the capture listener after release', async () => {
    const f = fixture(); await f.boot()
    const event = f.event(); handlers.get('keydown')(event)
    await flush(); f.render()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(f.call).toHaveBeenLastCalledWith('pauseRelease', { sessionId: 'a', gateId: 'gate-1', text: '' })
    expect(handlers.size).toBe(0)
    expect(find(f.render(), 'resume')).toBe(null)
  })
  it('sends the current draft with the Continue button and clears only after acceptance', async () => {
    const f = fixture(); f.setInput({ draft: '先检查结果' }); await f.boot()
    await f.click('resume')
    expect(f.call).toHaveBeenLastCalledWith('pauseRelease', { sessionId: 'a', gateId: 'gate-1', text: '先检查结果' })
    expect(f.actions.setDraft).toHaveBeenCalledWith('')
  })
  it.each([
    { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
    { isComposing: true }, { keyCode: 229 }, { key: 'Escape' },
    { target: { closest: () => ({}) } }, { target: { closest: () => null } },
  ])('does not intercept modified Enter, IME confirmation or unrelated elements: %j', async (extra) => {
    const f = fixture(); await f.boot()
    const event = f.event(extra); handlers.get('keydown')(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(f.call.mock.calls.filter(([op]) => op === 'pauseRelease')).toHaveLength(0)
  })
  it('has no keyboard listener while enabled but not paused', async () => {
    const f = fixture({ enabled: true, paused: false, gateId: null }); await f.boot()
    expect(handlers.size).toBe(0)
  })
  it('keeps the draft on an RPC failure or stale gate', async () => {
    const f = fixture(); f.setInput({ draft: 'keep this' }); await f.boot()
    f.call.mockResolvedValueOnce({ ok: false, error: { code: 'internal' } })
    await f.click('resume')
    expect(f.actions.setDraft).not.toHaveBeenCalled()
    expect(find(f.render(), 'error').children).toContain('pause.error')
    f.call.mockResolvedValueOnce({ ok: true, value: { enabled: true, paused: false, gateId: null, released: false } })
    await f.click('resume')
    expect(f.actions.setDraft).not.toHaveBeenCalled()
    expect(find(f.render(), 'error').children).toContain('pause.stale')
  })
  it('coalesces repeated Enter and retains text changed during release', async () => {
    const f = fixture(); f.setInput({ draft: 'old draft' }); await f.boot()
    let resolve
    f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    handlers.get('keydown')(f.event()); handlers.get('keydown')(f.event())
    expect(f.call.mock.calls.filter(([op]) => op === 'pauseRelease')).toHaveLength(1)
    f.setInput({ draft: 'new draft', draftRev: 2 }); f.render()
    resolve({ ok: true, value: { enabled: true, paused: false, gateId: null, released: true } })
    await flush()
    expect(f.actions.setDraft).not.toHaveBeenCalled()
  })
  it('never clears another conversation after switching during a release', async () => {
    const f = fixture(); f.setInput({ draft: 'draft A' }); await f.boot()
    let resolve
    f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const done = f.click('resume')
    f.props.sessionId = 'b'; f.setInput({ draft: 'draft B' }); f.render()
    resolve({ ok: true, value: { enabled: true, paused: false, gateId: null, released: true } })
    await done; await flush(); f.render()
    expect(f.actions.setDraft).not.toHaveBeenCalled()
    expect(f.call.mock.calls.findLast(([op]) => op === 'pauseStatus')[1].sessionId).toBe('b')
  })
  it.each([{ attachmentIds: ['image'] }, { occurrences: [{ source: 'file' }] }, { phase: 'claimed' }])('preserves structured input instead of silently flattening it: %j', async (patch) => {
    const f = fixture(); f.setInput({ draft: 'keep', ...patch }); await f.boot()
    await f.click('resume')
    expect(f.call.mock.calls.filter(([op]) => op === 'pauseRelease')).toHaveLength(0)
    expect(f.actions.setDraft).not.toHaveBeenCalled()
    expect(find(f.render(), 'error').children).toContain('pause.textOnly')
  })
  it('disabling pause keeps the draft and disables the resume control', async () => {
    const f = fixture(); f.setInput({ draft: 'keep' }); await f.boot()
    await f.click('toggle')
    expect(f.call).toHaveBeenLastCalledWith('pauseSetEnabled', { sessionId: 'a', enabled: false })
    expect(find(f.render(), 'resume')).toBe(null)
    expect(f.actions.setDraft).not.toHaveBeenCalled()
  })
  it('ignores a late polling response after a mutation', async () => {
    const f = fixture(); await f.boot()
    let resolve
    f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    await vi.advanceTimersByTimeAsync(400)
    await f.click('toggle')
    resolve({ ok: true, value: { enabled: true, paused: true, gateId: 'old-gate' } })
    await flush()
    expect(find(f.render(), 'toggle').props['aria-pressed']).toBe(false)
    expect(find(f.render(), 'resume')).toBe(null)
  })
  it('cleans up the poll timer and key capture on unmount', async () => {
    const f = fixture(); await f.boot()
    for (const value of hooks.values) value?.dispose?.()
    expect(handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
