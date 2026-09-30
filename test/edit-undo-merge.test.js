import { describe, expect, it } from 'vitest'
import { planTextUndo, resolveTextUndo } from '../lib/edit-undo-merge.js'

describe('reverse snapshot patches', () => {
  it('preserves later edits, inserted lines, CRLF and BOM while undoing an earlier change', () => {
    const before = '\uFEFFone\r\ntwo\r\nthree\r\n'
    const after = '\uFEFFchanged\r\ntwo\r\nthree\r\n'
    const current = '\uFEFFchanged\r\ninserted later\r\ntwo\r\nmanual\r\n'
    const plan = planTextUndo(before, after, current)
    expect(plan.conflicts).toEqual([])
    expect(resolveTextUndo(plan)).toBe('\uFEFFone\r\ninserted later\r\ntwo\r\nmanual\r\n')
  })
  it('merges independent values on the same line without splitting changed identifiers', () => {
    const plan = planTextUndo('const first = 1; const second = 2;\n', 'const first = 10; const second = 2;\n', 'const first = 10; const second = 20;\n')
    expect(plan.conflicts).toEqual([])
    expect(resolveTextUndo(plan)).toBe('const first = 1; const second = 20;\n')
    const overlapping = planTextUndo('original', 'changed', 'manual')
    expect(overlapping.conflicts).toHaveLength(1)
    const id = overlapping.conflicts[0].id
    expect(resolveTextUndo(overlapping, { [id]: 'current' })).toBe('manual')
    expect(resolveTextUndo(overlapping, { [id]: 'undo' })).toBe('original')
  })
  it('asks about each overlap while keeping all independent changes from both sides', () => {
    const before = 'first = old\nsecond = old\nthird = old\nfourth = old\n'
    const after = 'first = new\nsecond = new\nthird = new\nfourth = old\n'
    const current = 'first = manual\nsecond = manual\nthird = new\nfourth = manual\n'
    const plan = planTextUndo(before, after, current)
    expect(plan.conflicts).toHaveLength(2)
    expect(() => resolveTextUndo(plan)).toThrow(/Choose/)
    expect(() => resolveTextUndo(plan, { [plan.conflicts[0].id]: 'current' })).toThrow(/Choose/)
    const choices = { [plan.conflicts[0].id]: 'current', [plan.conflicts[1].id]: 'undo' }
    expect(resolveTextUndo(plan, choices)).toBe('first = manual\nsecond = old\nthird = old\nfourth = manual\n')
    expect(() => resolveTextUndo(plan, { ...choices, invented: 'undo' })).toThrow(/Choose/)
  })
  it('handles insertions, deletions, identical changes and a missing final newline', () => {
    const plan = planTextUndo('a\nb\nc', 'a\ninserted\nb\nc', 'a\ninserted\nb\nmanual')
    expect(resolveTextUndo(plan)).toBe('a\nb\nmanual')
    expect(resolveTextUndo(planTextUndo('a\nb\nc\n', 'a\nc\n', 'a\nc\nmanual\n'))).toBe('a\nb\nc\nmanual\n')
    expect(resolveTextUndo(planTextUndo('old', 'new', 'old'))).toBe('old')
    expect(resolveTextUndo(planTextUndo('same', 'same', 'later'))).toBe('later')
    const collision = planTextUndo('a\nundo\nb\n', 'a\nb\n', 'a\ncurrent\nb\n')
    expect(collision.conflicts).toHaveLength(1)
    expect(resolveTextUndo(collision, { [collision.conflicts[0].id]: 'undo' })).toBe('a\nundo\nb\n')
  })
  it('keeps repeated context and unrelated deletions in their original places', () => {
    const before = 'start\nsame\nleft\nsame\nright\nsame\nend\n'
    const after = before.replace('left', 'new-left')
    const current = after.replace('right\n', '')
    expect(resolveTextUndo(planTextUndo(before, after, current))).toBe(before.replace('right\n', ''))
  })
  it('keeps insertions at either boundary of an independently replaced line', () => {
    expect(resolveTextUndo(planTextUndo('a\nrestored\nc\n', 'a\nc\n', 'a\nmanual\n'))).toBe('a\nrestored\nmanual\n')
    expect(resolveTextUndo(planTextUndo('a\nc\nrestored\n', 'a\nc\n', 'a\nmanual\n'))).toBe('a\nmanual\nrestored\n')
    expect(resolveTextUndo(planTextUndo('a\nold\n', 'a\nnew\n', 'a\nlater\nnew\n'))).toBe('a\nlater\nold\n')
  })
  it('refuses unbounded diffs and preserves independent encoding details', () => {
    const base = Array.from({ length: 900 }, (_, i) => `line-${i}\n`)
    const changed = base.map((line, i) => i % 2 ? line : `changed-${i}\n`).join('')
    expect(() => planTextUndo(changed, base.join(''), base.join('') + 'later\n')).toThrow(/too large/)
    const plan = planTextUndo('\uFEFFold\r\nsecond\r\n', '\uFEFFnew\r\nsecond\r\n', 'new\r\nmanual\r\n')
    expect(plan.conflicts).toEqual([])
    expect(resolveTextUndo(plan)).toBe('old\r\nmanual\r\n')
  })
  it('does not duplicate a BOM independently restored after the host removed it', () => {
    const plan = planTextUndo('\uFEFFfirst\r\nsecond\r\n', 'agent\r\nsecond\r\n', '\uFEFFagent\r\nmanual\r\n')
    expect(plan.conflicts).toEqual([])
    expect(resolveTextUndo(plan)).toBe('\uFEFFfirst\r\nmanual\r\n')
    expect(resolveTextUndo(planTextUndo('first\nsecond\n', '\uFEFFagent\nsecond\n', 'agent\nmanual\n'))).toBe('first\nmanual\n')
  })
  it('preserves independent edits across many different line positions', () => {
    const base = Array.from({ length: 24 }, (_, i) => `line ${i}: unchanged\n`)
    for (let earlier = 0; earlier < base.length; earlier++) {
      for (let later = 0; later < base.length; later++) {
        if (earlier === later) continue
        const after = [...base], current = [...base], expected = [...base]
        after[earlier] = `line ${earlier}: agent\n`
        current[earlier] = after[earlier]
        current[later] = expected[later] = `line ${later}: manual\n`
        const plan = planTextUndo(base.join(''), after.join(''), current.join(''))
        expect(plan.conflicts).toEqual([])
        expect(resolveTextUndo(plan)).toBe(expected.join(''))
      }
    }
  })
})
