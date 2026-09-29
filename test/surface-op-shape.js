/**
 * The live host's `surfaceOp` **replace** shape — derived from the runtime,
 * never hardcoded.
 *
 * `@deepseek-ai/dsh-session` renames the replace keys when the session format
 * version crosses 3: `SESSION_FORMAT_VERSION >= 3` ⇒ `{op:'replace', startSeq,
 * endSeq}`, the v0 tree ⇒ `{op:'replace', start, end}`. Both trees require the
 * key count to be **exactly 3**, so the two spellings can never be mixed
 * (`lib/types/surface.js` `isReplaceOp`).
 *
 * Which tests use this:
 *  - every fixture that feeds the **real** host (`foldSurface`) or the real
 *    writer contract must carry the live spelling;
 *  - the plugin's own dual-shape readers (`markerSurfaceRange` in
 *    `lib/adapter/contract.js`, `spanRangeOf` in `lib/marker-carrier.js`)
 *    deliberately keep covering BOTH spellings — those tests keep their
 *    literal v0/v3 fixtures and do not use this module.
 *
 * ⚠️ `{start, end, shadowedSeqs}` (the plugin's internal span representation)
 * is a different thing entirely and stays spelled `start`/`end` everywhere.
 */
import { runtimeSurfaceOpShape } from '../lib/adapter/contract.js'

/** The live runtime's shape descriptor: `{shape, version, startKey, endKey}`. */
export const RUNTIME_SURFACE_OP_SHAPE = runtimeSurfaceOpShape()

/** Key names of the live host's replace `surfaceOp`. */
export const SURFACE_OP_START_KEY = RUNTIME_SURFACE_OP_SHAPE.startKey
export const SURFACE_OP_END_KEY = RUNTIME_SURFACE_OP_SHAPE.endKey

/**
 * Build a replace `surfaceOp` in the shape the live host accepts.
 * @param {number} start - span start seq (positional order; may exceed `end`)
 * @param {number} end - span end seq
 */
export function replaceOp(start, end) {
  return { op: 'replace', [SURFACE_OP_START_KEY]: start, [SURFACE_OP_END_KEY]: end }
}

/**
 * `assertMarkerShape`'s "endpoint mismatch" violation names the live keys
 * (`surfaceOp.startSeq/endSeq`). Built from the same source so the expectation
 * tracks the runtime instead of pinning `start/end`.
 */
export const SURFACE_OP_ENDPOINT_RE =
  new RegExp(`sourceEventSeqs 首尾 === surfaceOp\\.${SURFACE_OP_START_KEY}\\/${SURFACE_OP_END_KEY}`)
