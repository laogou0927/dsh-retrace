/** Execute the installed rc.2 tool bodies and filesystem in a private temp
 * workspace, without touching Desktop profiles or live sessions. The asar is
 * read-only. This checks tool/event integration, not Desktop activation.
 * Usage: node scripts/smoke-edit-undo-host.mjs E:/DSHD/resources/app.asar
 */
import fs from 'node:fs'
import { promises as disk } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { isBuiltin } from 'node:module'
import { build } from 'esbuild'
import { createEditUndo } from '../lib/edit-undo.js'

const archive = process.argv[2]
if (!archive) throw new Error('Pass the installed app.asar path')
const fd = fs.openSync(archive, 'r')
const header = Buffer.alloc(16)
fs.readSync(fd, header, 0, 16, 0)
const raw = Buffer.alloc(header.readUInt32LE(12))
fs.readSync(fd, raw, 0, raw.length, 16)
const tree = JSON.parse(raw.toString('utf8'))
const base = 8 + header.readUInt32LE(4)
function read(file) {
  let entry = tree
  for (const part of file.split('/').filter(Boolean)) entry = entry?.files?.[part]
  if (!entry || entry.files) return null
  if (entry.unpacked) return fs.readFileSync(`${archive}.unpacked${file}`)
  const bytes = Buffer.alloc(entry.size)
  fs.readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset))
  return bytes
}
const runtimeRoot = read('/dsh/node_modules/@deepseek-ai/dsh-fs/package.json') ? '/dsh' : ''
function target(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return target(value[0])
  if (value && typeof value === 'object') return target(value.node ?? value.import ?? value.default)
  return null
}
function resolveHost(specifier, importer) {
  const locate = (file) => [file, `${file}.js`, `${file}.json`, `${file}/index.js`].find((candidate) => read(candidate) !== null) ?? file
  if (specifier.startsWith('.')) return locate(path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)))
  const parts = specifier.split('/')
  const name = parts.splice(0, specifier.startsWith('@') ? 2 : 1).join('/')
  const directory = `${runtimeRoot}/node_modules/${name}`
  const bytes = read(`${directory}/package.json`)
  if (!bytes) throw new Error(`Host package missing: ${name}`)
  const pkg = JSON.parse(bytes.toString('utf8'))
  const subpath = parts.length ? `./${parts.join('/')}` : '.'
  const exports = pkg.exports
  let entry = typeof exports === 'string' ? (subpath === '.' ? exports : null) : target(exports?.[subpath] ?? (subpath === '.' ? exports : null))
  if (!entry && exports && typeof exports === 'object') {
    for (const [key, value] of Object.entries(exports)) {
      if (!key.includes('*')) continue
      const [start, end] = key.split('*')
      if (subpath.startsWith(start) && subpath.endsWith(end)) { entry = target(value)?.replace('*', subpath.slice(start.length, end ? -end.length : undefined)); break }
    }
  }
  entry ??= parts.length ? parts.join('/') : pkg.module ?? pkg.main ?? 'index.js'
  return locate(path.posix.join(directory, entry))
}

const root = await disk.mkdtemp(path.join(tmpdir(), 'retrace-rc2-undo-'))
try {
  const outfile = path.join(root, 'host.mjs')
  const built = await build({
    stdin: {
      contents: 'export { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox"; export { Context } from "@deepseek-ai/cordis"; export { ToolRuntime } from "@deepseek-ai/dsh-tools"; export { apply as applyObservationPolicy } from "@deepseek-ai/dsh-fs-observation-policy"; export { apply as applyTools, Config as ToolConfig } from "@deepseek-ai/dsh-tool-fs"; export { apply as applyPwsh } from "@deepseek-ai/dsh-tool-pwsh"; export { PwshLocalExecutor } from "@deepseek-ai/dsh-pwsh-local"; export { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local"; export { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local"; export { foldSurface, deriveEventMessage, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session"; export { estimateMessage } from "@deepseek-ai/dsh-token-meter/lib/types/estimate.js"; export { createUndoRecall } from "./lib/edit-undo-recall.js"; export { createEditorApi } from "./lib/host-core.js"; export { createDshMarkerWriter } from "./lib/adapter/dsh-writer.js";',
      resolveDir: process.cwd(), sourcefile: 'host-undo-fixture.mjs',
    },
    bundle: true, format: 'esm', platform: 'node', outfile, write: false,
    banner: { js: 'import { createRequire as smokeCreateRequire } from "node:module"; const require = smokeCreateRequire(import.meta.url);' },
    plugins: [{
      name: 'read-installed-asar', setup(builder) {
        builder.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }))
        builder.onResolve({ filter: /^koffi$/ }, () => ({ path: 'koffi', external: true }))
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (isBuiltin(args.path)) return { path: args.path, external: true }
          if (args.namespace !== 'asar') {
            if (args.path.startsWith('.') || path.isAbsolute(args.path)) return { path: path.resolve(args.resolveDir, args.path) }
            if (!args.path.startsWith('@deepseek-ai/')) return
          }
          return { path: resolveHost(args.path, args.importer), namespace: 'asar' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'asar' }, (args) => {
          const bytes = read(args.path)
          if (!bytes) throw new Error(`Host file missing: ${args.path}`)
          // dsh-llm reads its own package version through createRequire. A
          // single-file fixture must embed that exact read-only metadata.
          const contents = bytes.toString('utf8').replace(/createRequire\(import\.meta\.url\)\("\.\.\/package\.json"\)/g,
            () => `(${JSON.stringify(JSON.parse(read(path.posix.join(path.posix.dirname(args.path), '../package.json')).toString('utf8')))})`)
          return { contents, loader: args.path.endsWith('.json') ? 'json' : 'js' }
        })
      },
    }],
  })
  await disk.writeFile(outfile, built.outputFiles[0].contents)
  const { SandboxedFileSystem, Context, ToolRuntime, applyObservationPolicy, applyTools, ToolConfig, applyPwsh, PwshLocalExecutor, LocalSubprocessRuntime, LocalJobRegistry, foldSurface, deriveEventMessage, SESSION_FORMAT_VERSION, estimateMessage, createUndoRecall, createEditorApi, createDshMarkerWriter } = await import(pathToFileURL(outfile).href)
  const ctx = new Context()
  const workspace = path.join(root, 'workspace')
  await disk.mkdir(workspace)
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }]
  const session = { id: 'smoke', header: { cwd: workspace }, snapshotEvents: () => events }
  const agent = { id: session.id, session, status: 'idle', ctx }
  let policyMode = 'workspace-write'
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: () => ({ mode: policyMode, workspaceRoot: workspace }) })
  const provider = new SandboxedFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 })
  // Keep the real rc.2 atomic writer, version guards, locks and sandbox checks.
  // Its native Windows DACL helper is not needed for this isolated ACL fixture.
  provider.internals.copyFileDacl = async () => {}
  provider.internals.replaceFile = (destination, staged) => disk.rename(staged, destination)
  ctx.provide('systemPrompt', { getSectionOrder: () => 0, section: () => () => {}, tools: () => () => {} })
  const tools = new ToolRuntime(ctx)
  ctx.provide('sessions', { get: (id) => id === session.id ? session : undefined, list: () => [session] })
  ctx.provide('agents', { get: () => agent })
  ctx.provide('logger', { warn: console.log, info: console.log, error: console.error })
  const jobsConfig = await LocalJobRegistry.Config['~standard'].validate({})
  const jobs = new LocalJobRegistry(ctx, jobsConfig.value)
  jobs.attachController('isolated smoke')
  const subprocess = new LocalSubprocessRuntime(ctx)
  // This private fixture exercises real pwsh subprocesses using the provider's
  // ordinary spawn implementation; native Job/DACL binaries stay out of it.
  subprocess.selectContainmentMode = () => 'fallback'
  const shellConfig = await PwshLocalExecutor.Config['~standard'].validate({ cwd: workspace })
  new PwshLocalExecutor(ctx, shellConfig.value)
  ctx.provide('shellEnv', { collect: () => ({}) })
  applyPwsh(ctx)
  const config = await ToolConfig['~standard'].validate({})
  assert.equal(config.issues, undefined)
  applyTools(ctx, config.value)
  // Desktop installs this terminal intent policy before third-party plugins.
  // It returns the intent directly, so later waterfall listeners are bypassed.
  applyObservationPolicy(ctx)
  const undo = createEditUndo(ctx, { root: path.join(root, 'journal'), log: console.log })
  const disposeUndo = undo.register()
  const signal = new AbortController().signal
  async function call(name, args) {
    const exec = { callId: 'smoke-' + events.length + '-' + name, name, arguments: args, agent, signal }
    const result = await tools.execute(exec)
    assert.equal(result.isError, false, JSON.stringify(result))
    return result
  }
  const original = '\uFEFFfirst\r\nsecond\r\n'
  await disk.writeFile(path.join(workspace, 'existing.txt'), original)
  await call('read', { file_path: 'existing.txt' })
  await call('write', { file_path: 'existing.txt', content: 'one\r\n' })
  await call('edit', { file_path: 'existing.txt', old_string: 'one', new_string: 'two', replace_all: false })
  await call('write', { file_path: 'new.txt', content: 'new\r\n' })
  events.push({ seq: 1, type: 'turn/end', data: { turn: 1 } })
  const beforeLog = JSON.stringify(events)
  let preview = await undo.preview({ sessionId: session.id, turn: 1 })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.value.files.length, 2)
  assert.deepEqual(preview.value.files.map((f) => f.status), ['ready', 'ready'])
  assert.equal(preview.value.files[0].before, original)
  let result = await undo.apply({ sessionId: session.id, ticket: preview.value.ticket })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.complete, true, JSON.stringify(result))
  assert.equal(await disk.readFile(path.join(workspace, 'existing.txt'), 'utf8'), original)
  await assert.rejects(disk.stat(path.join(workspace, 'new.txt')), { code: 'ENOENT' })
  assert.equal(JSON.stringify(events), beforeLog)
  events.push({ seq: 2, type: 'turn/start', data: { turn: 2 } })
  // Undo changes the file's version outside the tools' observation cache.
  await call('read', { file_path: 'existing.txt' })
  await call('write', { file_path: 'existing.txt', content: 'another' })
  events.push({ seq: 3, type: 'turn/end', data: { turn: 2 } })
  await disk.writeFile(path.join(workspace, 'existing.txt'), 'manual edit')
  preview = await undo.preview({ sessionId: session.id, turn: 2 })
  assert.equal(preview.value.files[0].status, 'needs-choice')
  result = await undo.apply({ sessionId: session.id, ticket: preview.value.ticket })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'resolution-required')
  assert.equal(await disk.readFile(path.join(workspace, 'existing.txt'), 'utf8'), 'manual edit')
  preview = await undo.preview({ sessionId: session.id, turn: 2 })
  const file = preview.value.files[0]
  result = await undo.apply({ sessionId: session.id, ticket: preview.value.ticket, resolutions: { [file.id]: Object.fromEntries(file.conflicts.map((conflict) => [conflict.id, 'current'])) } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.complete, true)
  // The text overlap is kept; the independent BOM removal is still undone.
  assert.equal(await disk.readFile(path.join(workspace, 'existing.txt'), 'utf8'), '\uFEFFmanual edit')
  const mergeBefore = '\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n'
  await disk.writeFile(path.join(workspace, 'existing.txt'), mergeBefore)
  events.push({ seq: 4, type: 'turn/start', data: { turn: 3 } })
  await call('read', { file_path: 'existing.txt' })
  await call('edit', { file_path: 'existing.txt', old_string: 'first', new_string: 'agent-first', replace_all: false })
  await call('edit', { file_path: 'existing.txt', old_string: 'second', new_string: 'agent-second', replace_all: false })
  events.push({ seq: 5, type: 'turn/end', data: { turn: 3 } })
  const afterToolsLog = JSON.stringify(events)
  await disk.writeFile(path.join(workspace, 'existing.txt'), '\uFEFFmanual-first\r\nagent-second\r\nthird\r\nmanual-fourth\r\n')
  preview = await undo.preview({ sessionId: session.id, turn: 3 })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  const mergeFile = preview.value.files[0]
  assert.equal(mergeFile.status, 'needs-choice')
  result = await undo.apply({ sessionId: session.id, ticket: preview.value.ticket, resolutions: { [mergeFile.id]: Object.fromEntries(mergeFile.conflicts.map((conflict) => [conflict.id, 'undo'])) } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.complete, true)
  assert.equal(await disk.readFile(path.join(workspace, 'existing.txt'), 'utf8'), '\uFEFFfirst\r\nsecond\r\nthird\r\nmanual-fourth\r\n')
  assert.equal(JSON.stringify(events), afterToolsLog)
  // Run the installed rc.2 pwsh tool/executor/registry, not a synthetic write.
  // Literal deletion targets are all under this already resolved private cwd.
  events.push({ seq: 6, type: 'turn/start', data: { turn: 5 } })
  await disk.writeFile(path.join(workspace, 'ps-existing.txt'), original)
  await disk.writeFile(path.join(workspace, 'ps-delete.txt'), 'restore deleted')
  await disk.writeFile(path.join(workspace, 'ps-rename.txt'), 'restore name')
  const ps = await call('pwsh', { command: "Set-Content -LiteralPath './ps-existing.txt' -Value 'shell-change' -Encoding utf8; Set-Content -LiteralPath './ps-created.txt' -Value 'new' -Encoding utf8; Remove-Item -LiteralPath './ps-delete.txt'; Move-Item -LiteralPath './ps-rename.txt' -Destination './ps-renamed.txt'", description: 'Modify private fixture files', timeoutMs: 10000 })
  assert.equal(ps.value.kind, 'foreground')
  assert.equal(ps.value.exitCode, 0, JSON.stringify(ps))
  events.push({ seq: 7, type: 'turn/end', data: { turn: 5 } })
  preview = await undo.preview({ sessionId: session.id, turn: 5 })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.value.incomplete, false, JSON.stringify(preview))
  assert.equal(preview.value.files.length, 5, JSON.stringify(preview))
  result = await undo.apply({ sessionId: session.id, ticket: preview.value.ticket })
  assert.equal(result.ok && result.value.complete, true, JSON.stringify(result))
  assert.equal(await disk.readFile(path.join(workspace, 'ps-existing.txt'), 'utf8'), original)
  assert.equal(await disk.readFile(path.join(workspace, 'ps-delete.txt'), 'utf8'), 'restore deleted')
  assert.equal(await disk.readFile(path.join(workspace, 'ps-rename.txt'), 'utf8'), 'restore name')
  await assert.rejects(disk.stat(path.join(workspace, 'ps-created.txt')), { code: 'ENOENT' })
  await assert.rejects(disk.stat(path.join(workspace, 'ps-renamed.txt')), { code: 'ENOENT' })
  events.push({ seq: 8, type: 'turn/start', data: { turn: 6 } })
  const background = await call('pwsh', { command: "Start-Sleep -Milliseconds 500; Set-Content -LiteralPath './ps-background.txt' -Value 'complete' -Encoding utf8", description: 'Background private fixture write', run_in_background: true })
  assert.equal(background.value.kind, 'background')
  assert.equal((await undo.preview({ sessionId: session.id, turn: 6 })).value.busy, true)
  await jobs.wait(background.value.jobId, 10000, session.id)
  events.push({ seq: 9, type: 'turn/end', data: { turn: 6 } })
  preview = await undo.preview({ sessionId: session.id, turn: 6 })
  assert.equal(preview.value.files[0].status, 'ready', JSON.stringify(preview))
  assert.equal(preview.value.files[0].after.trim(), 'complete')
  result = await undo.apply({ sessionId: session.id, ticket: preview.value.ticket })
  assert.equal(result.ok && result.value.complete, true, JSON.stringify(result))
  await assert.rejects(disk.stat(path.join(workspace, 'ps-background.txt')), { code: 'ENOENT' })
  events.push({ seq: 10, type: 'turn/start', data: { turn: 7 } })
  const promoted = await call('pwsh', { command: "Start-Sleep -Milliseconds 500; Set-Content -LiteralPath './ps-promoted.txt' -Value 'complete' -Encoding utf8", description: 'Timeout promotion private fixture', timeoutMs: 100 })
  assert.equal(promoted.value.kind, 'promoted', JSON.stringify(promoted))
  assert.equal((await undo.preview({ sessionId: session.id, turn: 7 })).value.busy, true)
  await jobs.wait(promoted.value.jobId, 10000, session.id)
  events.push({ seq: 11, type: 'turn/end', data: { turn: 7 } })
  preview = await undo.preview({ sessionId: session.id, turn: 7 })
  assert.equal(preview.value.files[0].after.trim(), 'complete')
  result = await undo.apply({ sessionId: session.id, ticket: preview.value.ticket })
  assert.equal(result.ok && result.value.complete, true, JSON.stringify(result))
  events.push({ seq: 12, type: 'turn/start', data: { turn: 8 } })
  const failed = await call('pwsh', { command: "Set-Content -LiteralPath './ps-partial.txt' -Value 'written before error' -Encoding utf8; exit 3", description: 'Nonzero exit private fixture', timeoutMs: 10000 })
  assert.equal(failed.value.exitCode, 3)
  events.push({ seq: 13, type: 'turn/end', data: { turn: 8 } })
  preview = await undo.preview({ sessionId: session.id, turn: 8 })
  assert.equal(preview.value.files[0].status, 'ready', JSON.stringify(preview))
  result = await undo.apply({ sessionId: session.id, ticket: preview.value.ticket })
  assert.equal(result.ok && result.value.complete, true, JSON.stringify(result))
  await assert.rejects(disk.stat(path.join(workspace, 'ps-partial.txt')), { code: 'ENOENT' })
  console.log('PASS: rc.2 real PowerShell create/edit/delete/rename, background + timeout promotion settlement, nonzero exit + undo')
  disposeUndo()

  // The combined operation uses the installed official surface/price routines
  // and Retrace's existing two-segment writer, after the real fs tool pass.
  policyMode = 'workspace-write'
  session.header.version = SESSION_FORMAT_VERSION
  session.surface = { get nodes() { return foldSurface(events).nodes } }
  session.eventAt = (seq) => events.find((event) => event.seq === seq)
  session.append = (type, data, options = {}) => {
    const event = { seq: events.length, type, data, ...options }
    events.push(event)
    return event
  }
  const writer = createDshMarkerWriter({
    validateMarker: async () => ({ t1Ok: true }), deriveMessage: deriveEventMessage,
    meter: { measure: () => ({ nodes: session.surface.nodes.map((seq) => ({ seq, tokens: estimateMessage(deriveEventMessage(session.eventAt(seq))) })) }) },
  })
  const api = createEditorApi(ctx, ctx.sessions, ctx.agents, console.log, { writeMarker: writer.writeMarker })
  const bridge = createUndoRecall(ctx, api, { reader: async () => events.slice() })
  const combined = createEditUndo(ctx, { root: path.join(root, 'combined-journal'), conversation: bridge })
  const disposeCombined = combined.register()
  const chatInput = session.append('user/message', { id: 'rewind-input', role: 'user', content: [{ type: 'text', text: 'original input' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 9 })
  await disk.writeFile(path.join(workspace, 'coupled.txt'), '\uFEFFfirst\r\nsecond\r\n')
  await call('read', { file_path: 'coupled.txt' })
  await call('edit', { file_path: 'coupled.txt', old_string: 'first', new_string: 'agent', replace_all: false })
  await call('pwsh', { command: "Set-Content -LiteralPath './ps-combined.txt' -Value 'combined file' -Encoding utf8", description: 'Combined rewind private fixture', timeoutMs: 10000 })
  session.append('turn/end', { turn: 9 })
  const chatReply = session.append('assistant/message', { turn: 9, message: { id: 'rewind-reply', role: 'assistant', content: [{ type: 'text', text: 'completed' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } }, { surfaceOp: 'append' })
  const beforeCombined = events.slice()
  await disk.writeFile(path.join(workspace, 'coupled.txt'), '\uFEFFagent\r\nmanual\r\n')
  preview = await combined.preview({ sessionId: session.id, messageId: 'rewind-input', mode: 'both' })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  result = await combined.apply({ sessionId: session.id, ticket: preview.value.ticket, mode: 'both' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.conversation.text, 'original input')
  assert.equal(await disk.readFile(path.join(workspace, 'coupled.txt'), 'utf8'), '\uFEFFfirst\r\nmanual\r\n')
  await assert.rejects(disk.stat(path.join(workspace, 'ps-combined.txt')), { code: 'ENOENT' })
  assert.equal(session.surface.nodes.includes(chatInput.seq), false)
  assert.equal(session.surface.nodes.includes(chatReply.seq), false)
  assert.deepEqual(events.slice(0, beforeCombined.length), beforeCombined)
  disposeCombined()
  await ctx.fiber.dispose()
  console.log('host-undo smoke: PASS (installed tool registry + observation policy, raw CRLF/BOM, create/delete, reverse patch, unrelated edits preserved, explicit overlap choices, unchanged log)')
  console.log('host-combined smoke: PASS (installed surface/price + tool pipeline, file patch before dialogue cut, original input returned, append-only log)')
} finally {
  fs.closeSync(fd)
  // `root` is the exact path returned by mkdtemp, not a derived user path.
  await disk.rm(root, { recursive: true, force: true })
}
