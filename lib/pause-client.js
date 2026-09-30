/** Composer pause control adapted from dsh-pause (MIT, betterer 2026; LICENSE). */
const initial = (sessionId) => ({ sessionId, enabled: false, paused: false, gateId: null, ready: false })

// Use the client's existing React hooks, including in the dynamic realm.
export function createPauseControl({ createElement, useEffect, useRef, useState }) {
  return function PauseControl({ sessionId, useInput, inputActions, call, t }) {
    const input = typeof useInput === 'function' ? useInput((state) => state) : null
    const [snapshot, setSnapshot] = useState(() => initial(sessionId))
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const root = useRef(null)
    const alive = useRef(false)
    const revision = useRef(0)
    const pending = useRef(false)
    const latest = useRef(null)
    const state = snapshot.sessionId === sessionId ? snapshot : initial(sessionId)
    latest.current = { sessionId, input, inputActions, state, call, t }

    useEffect(() => {
      let retired = false
      let timer
      alive.current = true
      pending.current = false
      revision.current += 1
      setSnapshot(initial(sessionId))
      setError('')
      setBusy(false)
      const poll = async () => {
        if (pending.current) { timer = setTimeout(poll, 400); return }
        const version = revision.current
        let enabled = latest.current.state.enabled
        try {
          const reply = await call('pauseStatus', { sessionId })
          if (!retired && version === revision.current && !pending.current && reply?.ok) {
            setSnapshot({ sessionId, ...reply.value, ready: true })
            enabled = reply.value.enabled
          }
        } catch { /* Retry without changing the draft or last known gate. */ }
        if (!retired) timer = setTimeout(poll, enabled ? 400 : 2000)
      }
      void poll()
      return () => {
        retired = true
        alive.current = false
        revision.current += 1
        clearTimeout(timer)
      }
    }, [sessionId, call])

    async function mutate(op, payload, captured) {
      if (pending.current) return
      pending.current = true
      revision.current += 1
      setBusy(true)
      setError('')
      const version = revision.current
      try {
        const reply = await captured.call(op, payload)
        if (!alive.current || latest.current.sessionId !== captured.sessionId || version !== revision.current) return
        if (!reply?.ok) { setError(captured.t('pause.error')); return }
        setSnapshot({ sessionId: captured.sessionId, ...reply.value, ready: true })
        if (op === 'pauseRelease') {
          if (reply.value.released) {
            const current = latest.current
            // Do not erase text typed, revised or switched while release settles.
            if (current.input?.draft === captured.input?.draft
                && current.input?.draftRev === captured.input?.draftRev
                && current.inputActions === captured.inputActions) captured.inputActions.setDraft('')
          } else setError(captured.t('pause.stale'))
        }
      } catch {
        if (alive.current && latest.current.sessionId === captured.sessionId && version === revision.current) setError(captured.t('pause.error'))
      } finally {
        if (alive.current && version === revision.current) { pending.current = false; setBusy(false) }
      }
    }
    const release = () => {
      const captured = latest.current
      if (!captured.state.paused || pending.current) return
      // This channel carries ordinary text only; never flatten structured input.
      if ((captured.input?.attachmentIds?.length ?? 0) > 0
          || (captured.input?.occurrences?.length ?? 0) > 0
          || (captured.input?.phase && captured.input.phase !== 'plain')) {
        setError(captured.t('pause.textOnly'))
        return
      }
      return mutate('pauseRelease', {
        sessionId: captured.sessionId, gateId: captured.state.gateId, text: captured.input?.draft ?? '',
      }, captured)
    }
    const releaseRef = useRef(release)
    releaseRef.current = release
    useEffect(() => {
      if (!state.paused) return
      const capture = (event) => {
        if (!latest.current.state.paused || event.key !== 'Enter'
            || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
            || event.isComposing || event.keyCode === 229) return
        const card = root.current?.isConnected && root.current.closest('[data-composer-card]')
        const editor = event.target?.closest?.('[contenteditable="true"], textarea')
        if (!card || !editor || !card.contains(editor)) return
        event.preventDefault()
        event.stopPropagation()
        void releaseRef.current()
      }
      document.addEventListener('keydown', capture, true)
      return () => document.removeEventListener('keydown', capture, true)
    }, [state.paused, sessionId])

    if (!input || !inputActions || !sessionId) return null
    return createElement('div', { ref: root, className: 'dsh-rt-pause', 'data-retrace-pause': true }, [
      createElement('button', {
        key: 'toggle', type: 'button', className: 'dsh-rt-icon dsh-rt-pause-toggle',
        'aria-pressed': state.enabled, 'aria-label': t(state.enabled ? 'pause.disable' : 'pause.enable'),
        title: t(state.enabled ? 'pause.disable' : 'pause.enable'), disabled: busy || !state.ready,
        onClick: () => mutate('pauseSetEnabled', { sessionId, enabled: !state.enabled }, latest.current),
      }, createElement('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'currentColor', 'aria-hidden': true }, [
        createElement('rect', { key: 'left', x: 3, y: 2, width: 3.5, height: 12, rx: 1 }),
        createElement('rect', { key: 'right', x: 9.5, y: 2, width: 3.5, height: 12, rx: 1 }),
      ])),
      state.paused && createElement('button', {
        key: 'resume', type: 'button', className: 'dsh-rt-chip dsh-rt-pause-resume',
        title: t('pause.hint'), 'aria-label': t('pause.hint'), disabled: busy, onClick: release,
      }, t('pause.resume')),
      error && createElement('span', { key: 'error', role: 'status', className: 'dsh-rt-pause-error', title: error }, error),
    ])
  }
}
