/** Immutable operation preimages. Publication is atomic; session logs own the
 * conversation bytes, and this private store owns matching file snapshots. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createArtifactStore } from './artifact-store.js'

export function createCheckpointStore(root) {
  const objectStores = new Map()
  const tails = new Map()
  const pathOf = (id) => join(root, `${createHash('sha256').update(id).digest('hex')}.json`)
  const objectsFor = (id) => {
    if (!objectStores.has(id)) objectStores.set(id, createArtifactStore(pathOf(id).slice(0, -5)))
    return objectStores.get(id)
  }
  async function read(id) {
    try {
      const data = JSON.parse(await readFile(pathOf(id), 'utf8'))
      if (data.schema !== 1 || data.sessionId !== id || !Array.isArray(data.records)) throw new Error('Invalid checkpoint index')
      if (data.records.some((r) => !Number.isSafeInteger(r.cutSeq) || r.cutSeq < -1 || typeof r.versionId !== 'string' || !Array.isArray(r.files)
        || r.files.some((f) => typeof f.path !== 'string' || (f.sha !== undefined && !/^[a-f0-9]{64}$/.test(f.sha))))) throw new Error('Invalid checkpoint record')
      return data.records
    } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  async function update(id, change) {
    const run = (tails.get(id) ?? Promise.resolve()).then(async () => {
      const records = await read(id)
      const result = await change(records)
      await mkdir(root, { recursive: true, mode: 0o700 })
      const temp = `${pathOf(id)}.${randomUUID()}.tmp`
      try {
        const handle = await open(temp, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify({ schema: 1, sessionId: id, records })); await handle.sync() }
        finally { await handle.close() }
        await rename(temp, pathOf(id))
      } finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error }) }
      return result
    })
    const tail = run.catch(() => {})
    tails.set(id, tail)
    try { return await run } finally { if (tails.get(id) === tail) tails.delete(id) }
  }
  async function collect(id) {
    const refs = new Set((await read(id)).filter((r) => !r.filesUnavailable).flatMap((r) => r.files.map((file) => file.sha).filter(Boolean)))
    const objects = objectsFor(id)
    for (const sha of await objects.list()) if (!refs.has(sha)) await objects.remove(sha)
  }
  return { read, update, objectsFor, collect }
}
