/** Reverse range patches from exact before/after snapshots. No fuzzy matching.
 * The after snapshot is the common base: merge after->before with after->disk.
 * Overlapping replacements remain explicit choices, never conflict markers.
 */
const limit = () => Object.assign(new Error('The changes are too large to merge safely'), { code: 'merge-limit' })
const lines = (text) => {
  const bom = text.startsWith('\uFEFF')
  return [...(bom ? ['\uFEFF'] : []), ...(text.slice(bom ? 1 : 0).match(/[^\n]*\n|[^\n]+$/g) ?? [])]
}
const words = (text) => text.match(/\r\n|\n|\r|[\p{L}\p{N}_$]+|[^\S\r\n]+|[^\s\p{L}\p{N}_$]/gu) ?? []

/** Bounded Myers diff. Equal prefixes/suffixes cost no trace storage. */
function rangePatch(base, target) {
  let prefix = 0, suffix = 0
  while (prefix < base.length && prefix < target.length && base[prefix] === target[prefix]) prefix++
  while (suffix < base.length - prefix && suffix < target.length - prefix && base[base.length - suffix - 1] === target[target.length - suffix - 1]) suffix++
  const a = base.slice(prefix, base.length - suffix), b = target.slice(prefix, target.length - suffix)
  if (!a.length && !b.length) return []
  if (!a.length || !b.length) return [{ start: prefix, end: prefix + a.length, replacement: b }]
  const matches = new Set(a)
  if (!b.some((token) => matches.has(token))) return [{ start: prefix, end: prefix + a.length, replacement: b }]
  const trace = [], v = new Map([[1, 0]])
  let work = 0, distance = -1
  search: for (let d = 0; d <= Math.min(a.length + b.length, 700); d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++; y++
        if (++work > 2000000) throw limit()
      }
      if (++work > 2000000) throw limit()
      v.set(k, x)
      if (x >= a.length && y >= b.length) { distance = d; break search }
    }
  }
  if (distance < 0) throw limit()
  const operations = []
  let x = a.length, y = b.length
  for (let d = distance; d >= 0; d--) {
    const previous = trace[d], k = x - y
    const previousK = k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1)) ? k + 1 : k - 1
    const previousX = previous.get(previousK) ?? 0, previousY = previousX - previousK
    while (x > previousX && y > previousY) { operations.push({ kind: 'equal' }); x--; y-- }
    if (d === 0) break
    if (x === previousX) { operations.push({ kind: 'insert', token: b[--y] }) }
    else { operations.push({ kind: 'delete' }); x-- }
  }
  const patch = []
  let cursor = prefix, edit
  const flush = () => { if (edit) patch.push(edit); edit = undefined }
  for (const operation of operations.reverse()) {
    if (operation.kind === 'equal') { flush(); cursor++; continue }
    edit ??= { start: cursor, end: cursor, replacement: [] }
    if (operation.kind === 'insert') edit.replacement.push(operation.token)
    else edit.end = ++cursor
  }
  flush()
  return patch
}

function applyRegion(base, start, end, changes) {
  let cursor = start, text = ''
  for (const change of changes) {
    text += base.slice(cursor, change.start).join('') + change.replacement.join('')
    cursor = change.end
  }
  return text + base.slice(cursor, end).join('')
}

function merge(base, undoPatch, laterPatch, state, firstLine, refine) {
  const changes = [
    ...undoPatch.map((edit) => ({ ...edit, side: 'undo' })),
    ...laterPatch.map((edit) => ({ ...edit, side: 'current' })),
  ].sort((a, b) => a.start - b.start || a.end - b.end)
  const lineNumbers = [firstLine]
  for (const token of base) lineNumbers.push(lineNumbers.at(-1) + (token.match(/\n/g)?.length ?? 0))
  const parts = []
  let cursor = 0
  for (let i = 0; i < changes.length;) {
    const start = changes[i].start, group = [changes[i++]]
    let end = group[0].end
    while (i < changes.length && (changes[i].start < end || (start === end && changes[i].start === start && changes[i].end === start))) {
      group.push(changes[i++]); end = Math.max(end, group.at(-1).end)
    }
    parts.push(base.slice(cursor, start).join(''))
    const undo = group.filter((edit) => edit.side === 'undo'), later = group.filter((edit) => edit.side === 'current')
    const undoText = applyRegion(base, start, end, undo), currentText = applyRegion(base, start, end, later)
    if (!undo.length) parts.push(currentText)
    else if (!later.length || currentText === undoText) parts.push(undoText)
    else {
      const common = base.slice(start, end).join('')
      // Refine a line overlap into word/punctuation ranges, so unrelated
      // identifiers or values on the same line can still be preserved.
      if (refine && common.length + undoText.length + currentText.length <= 64000) {
        const tokens = words(common)
        parts.push(...merge(tokens, rangePatch(tokens, words(undoText)), rangePatch(tokens, words(currentText)), state, lineNumbers[start], false))
      } else {
        if (state.conflicts.length >= 256) throw limit()
        const id = `conflict-${state.conflicts.length + 1}`
        const conflict = { id, kind: 'text', startLine: lineNumbers[start], endLine: lineNumbers[end], current: currentText, undo: undoText }
        state.conflicts.push(conflict)
        parts.push(conflict)
      }
    }
    cursor = end
  }
  parts.push(base.slice(cursor).join(''))
  return parts
}

export function planTextUndo(before, after, current) {
  const state = { conflicts: [] }
  if (current === after) return { parts: [before], conflicts: [] }
  if (before === after || current === before) return { parts: [current], conflicts: [] }
  // Encoding metadata is independent of a changed first line. Otherwise a
  // BOM included in a replacement and an identical later insertion double up.
  const hasBom = (text) => text.startsWith('\uFEFF')
  const withoutBom = (text) => text.slice(hasBom(text) ? 1 : 0)
  const bom = hasBom(before) !== hasBom(after) ? hasBom(before) : hasBom(current)
  const base = lines(withoutBom(after))
  const undoPatch = rangePatch(base, lines(withoutBom(before)))
  const laterPatch = rangePatch(base, lines(withoutBom(current)))
  const parts = merge(base, undoPatch, laterPatch, state, 1, true)
  if (bom) parts.unshift('\uFEFF')
  return { parts, conflicts: state.conflicts }
}

export function resolveTextUndo(plan, choices = {}) {
  const valid = new Set(plan.conflicts.map((conflict) => conflict.id))
  if (Object.keys(choices).some((id) => !valid.has(id)) || plan.conflicts.some((conflict) => !['current', 'undo'].includes(choices[conflict.id]))) {
    throw Object.assign(new Error('Choose which content to keep for every conflicting section'), { code: 'resolution-required' })
  }
  return plan.parts.map((part) => typeof part === 'string' ? part : part[choices[part.id]]).join('')
}
