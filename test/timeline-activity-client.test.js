import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTimelineActivityPanel } from '../lib/timeline-activity-client.js'

let values, index, effects
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
  useState(initial) { const i = index++; if (!(i in values)) values[i] = initial; return [values[i], (next) => { values[i] = typeof next === 'function' ? next(values[i]) : next }] },
  useRef(initial) { const i = index++; return values[i] ??= { current: initial } },
  useEffect(callback, deps) { const i = index++, old = values[i]; if (!old || deps.some((dep, k) => dep !== old.deps[k])) effects.push(() => { old?.dispose?.(); values[i] = { deps, dispose: callback() } }) },
}
function find(node, key) {
  if (!node || typeof node !== 'object') return null
  if (node.props.key === key) return node
  for (const child of node.children ?? []) { const found = find(child, key); if (found) return found }
  return null
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const EditUndoControl = () => null
function fixture() {
  const read = vi.fn(async (sessionId) => ({ ok: true, value: {
    sessionId, turns: [{ turn: 0, updatedAt: 1000, files: [{ id: 'file', path: 'a.txt', status: 'recorded' }] }],
    pauses: [{ id: 'p', seq: 5, text: 'first\nsecond', createdAt: 2000 }],
    fileUndos: [{ id: 'u', createdAt: 3000, complete: false, results: [{ id: 'file', path: 'b.txt', status: 'failed', reason: 'conflict' }] }],
  } }))
  const Panel = createTimelineActivityPanel({ ...react, read, EditUndoControl })
  const props = { sessionId: 's', t: (key) => key, onJump: vi.fn(), canJump: () => true }
  const render = () => { index = 0; const tree = Panel(props); effects.splice(0).forEach((run) => run()); return tree }
  const boot = async () => { render(); await flush(); return render() }
  return { read, props, render, boot, click: (key) => find(render(), key)?.props.onClick() }
}
beforeEach(() => { values = []; index = 0; effects = []; vi.useFakeTimers() })
afterEach(() => { values.forEach((value) => value?.dispose?.()); vi.clearAllTimers(); vi.useRealTimers() })

describe('checkpoint page file entry and steering history', () => {
  it('offers a visible file entry, opens the existing dialog for the exact turn, and refreshes after apply', async () => {
    const f = fixture(), tree = await f.boot()
    expect(find(tree, 'files-toggle').props).toMatchObject({ className: 'dsh-rt-path-head', 'aria-expanded': false })
    expect(find(tree, 'file-list')).toBe(null)
    f.click('files-toggle'); await flush()
    const undo = find(find(f.render(), 'turn:0'), 'undo')
    expect(undo.type).toBe(EditUndoControl)
    expect(undo.props).toMatchObject({ sessionId: 's', turn: 0, buttonLabel: 'undo.open' })
    undo.props.onApplied(); await flush()
    expect(f.read).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(f.render())).toContain('conflict')
  })
  it('shows the full committed steering text and offers only navigation to a live message', async () => {
    const f = fixture(); await f.boot(); f.click('pauses-toggle')
    const row = find(f.render(), 'p')
    expect(row.type).toBe('details')
    expect(find(row, 'text').children).toEqual(['first\nsecond'])
    find(row, 'jump').props.onClick()
    expect(f.props.onJump).toHaveBeenCalledWith(5)
    f.props.canJump = () => false
    expect(find(find(f.render(), 'p'), 'jump')).toBe(null)
    expect(JSON.stringify(row)).not.toContain('restore')
  })
  it('loads sequentially and ignores a previous session response after switching', async () => {
    const f = fixture(); let finish
    f.read.mockImplementationOnce(() => new Promise((done) => { finish = done }))
    f.render(); await vi.advanceTimersByTimeAsync(6000)
    expect(f.read).toHaveBeenCalledTimes(1)
    f.props.sessionId = 'other'; f.render(); await flush(); f.render()
    finish({ ok: true, value: { sessionId: 's', pauses: [{ id: 'old', text: 'old text' }], turns: [], fileUndos: [] } }); await flush()
    f.click('pauses-toggle')
    expect(find(f.render(), 'old')).toBe(null)
    expect(f.read.mock.calls.map(([id]) => id)).toEqual(['s', 'other'])
  })
  it('reports failed reads and retries through the entry without overlap', async () => {
    const f = fixture(); f.read.mockResolvedValueOnce({ ok: false, error: { message: 'unavailable' } })
    expect(find(await f.boot(), 'error').children.join(' ')).toContain('unavailable')
    f.click('files-toggle'); await flush()
    expect(find(f.render(), 'error')).toBe(null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.read).toHaveBeenCalledTimes(3)
  })
  it('cleans up polling when the checkpoint view closes', async () => {
    const f = fixture(); await f.boot(); values.forEach((value) => value?.dispose?.())
    await vi.advanceTimersByTimeAsync(8000)
    expect(f.read).toHaveBeenCalledTimes(1)
  })
})
