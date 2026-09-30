/** Checkpoint-page activities reuse the existing theme and guarded undo dialog. */
export function createTimelineActivityPanel({ createElement: h, useEffect, useRef, useState, EditUndoControl, read }) {
  return function TimelineActivityPanel({ sessionId, t, onJump, canJump }) {
    const [value, setValue] = useState(null)
    const [error, setError] = useState(null)
    const [filesOpen, setFilesOpen] = useState(false)
    const [pausesOpen, setPausesOpen] = useState(false)
    const refresh = useRef(() => {})
    useEffect(() => {
      let disposed = false, pending = false, again = false, timer
      const load = async () => {
        if (disposed) return
        if (pending) { again = true; return }
        clearTimeout(timer)
        pending = true
        try {
          const result = await read(sessionId)
          if (disposed) return
          if (result?.ok !== true || result.value?.sessionId !== sessionId) throw new Error(result?.error?.message ?? t('activity.error'))
          setValue(result.value)
          setError(null)
        } catch (cause) { if (!disposed) setError(cause?.message ?? t('activity.error')) }
        finally {
          pending = false
          if (!disposed) {
            const delay = again ? 0 : 2000
            again = false
            timer = setTimeout(load, delay)
          }
        }
      }
      refresh.current = load
      setValue(null); setError(null); setFilesOpen(false); setPausesOpen(false)
      void load()
      return () => { disposed = true; clearTimeout(timer); refresh.current = () => {} }
    }, [sessionId])
    const current = value?.sessionId === sessionId ? value : null
    const turns = Array.isArray(current?.turns) ? current.turns : []
    const pauses = Array.isArray(current?.pauses) ? current.pauses : []
    const fileUndos = Array.isArray(current?.fileUndos) ? current.fileUndos : []
    const statusOf = (status) => t(status === 'restored' ? 'undo.restored' : status === 'kept' ? 'undo.kept' : status === 'failed' ? 'activity.failed' : 'activity.recorded')
    const stamp = (at) => typeof at === 'number' && Number.isFinite(at) ? new Date(at).toLocaleString() : ''
    const clip = (text) => String(text ?? '').replace(/\s+/g, ' ').slice(0, 120)
    return h('div', { className: 'dsh-rt-activities' }, [
      h('div', { key: 'files', className: 'dsh-rt-path dsh-rt-activity-block' }, [
        h('button', { key: 'files-toggle', type: 'button', className: 'dsh-rt-path-head', 'aria-expanded': filesOpen, onClick: () => { setFilesOpen(!filesOpen); void refresh.current() } }, `${filesOpen ? '▾' : '▸'} ${t('activity.files', { count: turns.length })}`),
        filesOpen && h('div', { key: 'file-list', className: 'dsh-rt-path-list' }, [
          h('div', { key: 'hint', className: 'dsh-rt-path-empty' }, t('activity.filesHint')),
          current?.fileError && h('div', { key: 'file-error', className: 'dsh-rt-error', role: 'status' }, `${t('activity.fileError')} ${current.fileError.message}`),
          !current && !error && h('div', { key: 'loading', className: 'dsh-rt-path-empty' }, t('timeline.loading')),
          current && !current.fileError && turns.length === 0 && h('div', { key: 'empty-files', className: 'dsh-rt-path-empty' }, t('activity.noFiles')),
          ...turns.map((group) => h('div', { key: `turn:${group.turn}`, className: 'dsh-rt-activity-entry' }, [
            h('div', { key: 'head', className: 'dsh-rt-version-line' }, [
              h('span', { key: 'turn', className: 'dsh-rt-version-kind-label' }, t('timeline.round', { n: group.turn })),
              h('span', { key: 'time', className: 'dsh-rt-version-time' }, stamp(group.updatedAt)),
              h(EditUndoControl, { key: 'undo', sessionId, turn: group.turn, t, buttonLabel: t('undo.open'), onApplied: () => { void refresh.current() } }),
            ]),
            ...group.files.map((file) => h('div', { key: file.id, className: 'dsh-rt-activity-text' }, `${file.path} · ${statusOf(file.status)}`)),
            ...(group.warnings ?? []).map((warning) => h('div', { key: warning, className: 'dsh-rt-error' }, t(`undo.${warning}`))),
          ])),
          fileUndos.length > 0 && h('div', { key: 'history-title', className: 'dsh-rt-path-title' }, t('activity.undoHistory')),
          ...fileUndos.slice().reverse().map((record) => h('div', { key: record.id, className: 'dsh-rt-activity-entry' }, [
            h('div', { key: 'head', className: 'dsh-rt-version-line' }, [
              h('span', { key: 'title', className: 'dsh-rt-version-kind-label' }, t('activity.undoResult')),
              h('span', { key: 'time', className: 'dsh-rt-version-time' }, stamp(record.createdAt)),
              !record.complete && h('span', { key: 'partial', className: 'dsh-rt-error' }, t('activity.partial')),
            ]),
            ...record.results.map((file) => h('div', { key: file.id, className: 'dsh-rt-activity-text' }, `${file.path} · ${statusOf(file.status)}${file.reason ? ` (${file.reason})` : ''}`)),
          ])),
        ]),
      ]),
      pauses.length > 0 && h('div', { key: 'pauses', className: 'dsh-rt-path dsh-rt-activity-block' }, [
        h('button', { key: 'pauses-toggle', type: 'button', className: 'dsh-rt-path-head', 'aria-expanded': pausesOpen, onClick: () => setPausesOpen(!pausesOpen) }, `${pausesOpen ? '▾' : '▸'} ${t('activity.pauses', { count: pauses.length })}`),
        pausesOpen && h('div', { key: 'pause-list', className: 'dsh-rt-path-list' }, pauses.map((record) => h('details', { key: record.id, className: 'dsh-rt-activity-entry' }, [
          h('summary', { key: 'summary' }, [h('span', { key: 'time', className: 'dsh-rt-version-time' }, stamp(record.createdAt)), ' · ', clip(record.text)]),
          h('div', { key: 'text', className: 'dsh-rt-activity-text' }, record.text),
          canJump?.(record.seq) === true && h('button', { key: 'jump', type: 'button', className: 'dsh-rt-chip', onClick: () => onJump?.(record.seq) }, t('timeline.jump')),
        ]))),
      ]),
      error && h('div', { key: 'error', className: 'dsh-rt-error', role: 'status' }, `${t('activity.error')} ${error}`),
    ])
  }
}
