import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ values: [], index: 0 }))
vi.mock('react', () => ({
  Component: class {},
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
  useState: (initial) => {
    const i = hooks.index++
    if (!(i in hooks.values)) hooks.values[i] = initial
    return [hooks.values[i], (value) => { hooks.values[i] = typeof value === 'function' ? value(hooks.values[i]) : value }]
  },
  useRef: (value) => {
    const i = hooks.index++
    return hooks.values[i] ??= { current: value }
  },
  useEffect: () => {},
}))
import { EditUndoControl, __setMessageEditorWire, zh } from '../lib/client.js'

const t = (key) => zh[key] ?? key
const render = (extra = {}) => { hooks.index = 0; return EditUndoControl({ sessionId: 's', messageId: 'reply', t, ...extra }) }
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children ?? []) { const hit = find(child, predicate); if (hit) return hit }
  return null
}
const button = (node, key) => find(node, (n) => n.type === 'button' && n.props.key === key)
const row = (id, status) => ({ id, path: `${id}.txt`, status, action: 'restore', before: 'old', after: 'new' })
const response = (value) => ({ status: 200, json: async () => ({ ok: true, value }) })
beforeEach(() => { hooks.values = []; hooks.index = 0; __setMessageEditorWire(null) })
afterEach(() => { vi.unstubAllGlobals(); __setMessageEditorWire(null) })

describe('file undo preview controls', () => {
  it('explains incomplete PowerShell coverage and blocks all-file or combined undo while allowing a verified file', async () => {
    const value = { ticket: 't', files: [row('a', 'ready')], busy: false, incomplete: true, warnings: ['capture-limit'] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    await button(render(), 'open').props.onClick()
    expect(find(render(), (n) => n.type === 'p' && n.props.key === 'coverage').children).toEqual([zh['undo.captureIncomplete']])
    expect(find(render(), (n) => n.type === 'p' && n.props.key === 'capture:capture-limit').children).toEqual([zh['undo.capture-limit']])
    expect(button(render(), 'all').props.disabled).toBe(true)
    expect(button(render(), 'undo').props.disabled).toBe(false)
    hooks.values = []
    await button(render({ mode: 'both' }), 'open').props.onClick()
    expect(button(render({ mode: 'both' }), 'all').props.disabled).toBe(true)
  })
  it('opens a preview before applying, disables whole-turn undo on conflicts, and permits a safe single file', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ticket: 'ticket', files: [row('a', 'ready'), row('b', 'conflict')], busy: false }))
      .mockResolvedValueOnce(response({ complete: true, results: [] }))
      .mockResolvedValueOnce(response({ ticket: 'new', files: [row('a', 'restored'), row('b', 'conflict')], busy: false }))
    vi.stubGlobal('fetch', fetch)
    await button(render(), 'open').props.onClick()
    let view = render()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toContain('/editUndoPreview')
    expect(button(view, 'all').props.disabled).toBe(true)
    const safeFile = find(view, (n) => n.type === 'section' && n.props.key === 'a')
    expect(button(safeFile, 'undo').props.disabled).toBe(false)
    await button(safeFile, 'undo').props.onClick()
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ sessionId: 's', ticket: 'ticket', fileId: 'a' })
    view = render()
    expect(button(find(view, (n) => n.type === 'section' && n.props.key === 'a'), 'undo').props.disabled).toBe(true)
  })
  it('disables mutations while the session is running and renders an explicit empty state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ticket: 't', files: [row('a', 'ready')], busy: true })))
    await button(render(), 'open').props.onClick()
    expect(button(render(), 'all').props.disabled).toBe(true)
    expect(button(render(), 'undo').props.disabled).toBe(true)
    hooks.values = []
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ticket: null, files: [], busy: false })))
    await button(render(), 'open').props.onClick()
    expect(find(render(), (n) => n.type === 'p' && n.props.key === 'empty').children).toEqual([zh['undo.empty']])
  })
  it('does not offer the filesystem feature on a dynamic editor-only bridge', () => {
    __setMessageEditorWire(() => Promise.resolve({ ok: true }))
    expect(render()).toBe(null)
  })
  it('keeps the preview visible and displays an apply failure without making a second mutation', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ticket: 't', files: [row('a', 'ready')], busy: false }))
      .mockResolvedValueOnce({ status: 200, json: async () => ({ ok: false, error: { code: 'conflict', message: 'File changed since preview' } }) })
    vi.stubGlobal('fetch', fetch)
    await button(render(), 'open').props.onClick()
    await button(render(), 'all').props.onClick()
    expect(find(render(), (n) => n.type === 'dialog')).toBeTruthy()
    expect(find(render(), (n) => n.type === 'p' && n.props.key === 'error').children).toEqual(['File changed since preview'])
    expect(button(render(), 'all').props.disabled).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('requires explicit choices, submits them only on confirmation, and clears them on refresh', async () => {
    const conflictRow = { ...row('a', 'needs-choice'), conflicts: [{ id: 'c1', kind: 'text', startLine: 1, endLine: 1, current: 'manual', undo: 'old' }] }
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ticket: 't', files: [conflictRow], busy: false }))
      .mockResolvedValueOnce(response({ ticket: 'fresh', files: [conflictRow], busy: false }))
      .mockResolvedValueOnce(response({ complete: true, results: [] }))
      .mockResolvedValueOnce(response({ ticket: 'done', files: [row('a', 'restored')], busy: false }))
    vi.stubGlobal('fetch', fetch)
    await button(render(), 'open').props.onClick()
    expect(button(render(), 'all').props.disabled).toBe(true)
    const choice = (side) => find(render(), (n) => n.type === 'input' && n.props.key === side)
    expect(choice('current').props.checked).toBe(false)
    expect(choice('undo').props.checked).toBe(false)
    choice('current').props.onChange()
    expect(button(render(), 'all').props.disabled).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    await button(render(), 'refresh').props.onClick()
    expect(choice('current').props.checked).toBe(false)
    expect(button(render(), 'all').props.disabled).toBe(true)
    choice('undo').props.onChange()
    await button(render(), 'all').props.onClick()
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ sessionId: 's', ticket: 'fresh', resolutions: { a: { c1: 'undo' } } })
  })
  it('requires every overlap and scopes choices to the selected file', async () => {
    const conflicted = (id) => ({ ...row(id, 'needs-choice'), conflicts: ['c1', 'c2'].map((id) => ({ id, kind: 'text', startLine: 1, endLine: 1, current: 'manual', undo: 'old' })) })
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ticket: 't', files: [conflicted('a'), conflicted('b')], busy: false }))
      .mockResolvedValueOnce(response({ complete: true, results: [] }))
      .mockResolvedValueOnce(response({ ticket: 'done', files: [row('a', 'restored'), conflicted('b')], busy: false }))
    vi.stubGlobal('fetch', fetch)
    await button(render(), 'open').props.onClick()
    const file = (id) => find(render(), (n) => n.type === 'section' && n.props.key === id)
    const choose = (fileId, conflictId, side) => find(find(file(fileId), (n) => n.type === 'fieldset' && n.props.key === conflictId), (n) => n.type === 'input' && n.props.key === side).props.onChange()
    choose('a', 'c1', 'current')
    expect(button(file('a'), 'undo').props.disabled).toBe(true)
    choose('a', 'c2', 'undo')
    choose('b', 'c1', 'undo')
    expect(button(file('a'), 'undo').props.disabled).toBe(false)
    expect(button(render(), 'all').props.disabled).toBe(true)
    await button(file('a'), 'undo').props.onClick()
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ sessionId: 's', ticket: 't', fileId: 'a', resolutions: { a: { c1: 'current', c2: 'undo' } } })
  })
  it('labels whole-file delete choices explicitly and disables them during running tasks', async () => {
    const deletion = { ...row('a', 'needs-choice'), action: 'delete', conflicts: [{ id: 'file-state', kind: 'file-state', current: 'manual', undo: null }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ticket: 't', files: [deletion], busy: true })))
    await button(render(), 'open').props.onClick()
    const label = find(render(), (n) => n.type === 'label' && n.children.includes(zh['undo.chooseDelete']))
    expect(label).toBeTruthy()
    expect(find(label, (n) => n.type === 'input').props.disabled).toBe(true)
    expect(find(label, (n) => n.type === 'input').props.checked).toBe(false)
  })
  it('previews the whole tail, confirms once, returns the original input and closes after recall', async () => {
    const onRecalled = vi.fn(), props = { mode: 'both', onRecalled }
    const fetch = vi.fn().mockResolvedValueOnce(response({ ticket: 't', files: [row('a', 'ready')], busy: false }))
      .mockResolvedValueOnce(response({ complete: true, conversation: { text: 'original input' } }))
    vi.stubGlobal('fetch', fetch)
    await button(render(props), 'open').props.onClick()
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ sessionId: 's', messageId: 'reply', mode: 'both' })
    expect(button(render(props), 'undo')).toBe(null)
    expect(onRecalled).not.toHaveBeenCalled()
    await button(render(props), 'all').props.onClick()
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ sessionId: 's', ticket: 't', mode: 'both' })
    expect(onRecalled).toHaveBeenCalledWith({ text: 'original input' })
    expect(find(render(props), (n) => n.type === 'dialog')).toBe(null)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('allows an explicit empty file preview in both mode and keeps dialogue intact on partial failure', async () => {
    const onRecalled = vi.fn(), props = { mode: 'both', onRecalled }
    const fetch = vi.fn().mockResolvedValueOnce(response({ ticket: 't', files: [], busy: false }))
      .mockResolvedValueOnce(response({ complete: false, conversation: null }))
      .mockResolvedValueOnce(response({ ticket: 'fresh', files: [row('a', 'conflict')], busy: false }))
    vi.stubGlobal('fetch', fetch)
    await button(render(props), 'open').props.onClick()
    expect(button(render(props), 'all').props.disabled).toBe(false)
    expect(find(render(props), (n) => n.type === 'p' && n.props.key === 'empty').children).toEqual([zh['undo.rewindEmpty']])
    await button(render(props), 'all').props.onClick()
    expect(onRecalled).not.toHaveBeenCalled()
    expect(find(render(props), (n) => n.type === 'p' && n.props.key === 'error').children).toEqual([zh['undo.rewindPartial']])
    expect(button(render(props), 'all').props.disabled).toBe(true)
  })
})
