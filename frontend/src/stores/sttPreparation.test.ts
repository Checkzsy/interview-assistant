import { beforeEach, describe, expect, it } from 'vitest'
import { useInterviewStore } from './configStore'

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  runtime_id: 'rt-1',
  revision: 1,
  active: null,
  pending: [],
  states: [],
  ...overrides,
})

const state = (overrides: Record<string, unknown> = {}) => ({
  key: ['medium', 'zh'],
  attempt_id: 'a1',
  phase: 'downloading',
  downloaded_bytes: 10,
  total_bytes: 100,
  progress: 10,
  started_at: 1,
  updated_at: 2,
  error: null,
  roles: ['main'],
  ...overrides,
})

describe('stt preparation snapshot sync', () => {
  beforeEach(() => {
    useInterviewStore.setState({
      sttPreparation: { runtime_id: null, revision: 0, active: null, pending: [], states: [] },
      sttLastAcceptedPreparation: null,
      sttConfigVersion: '',
      sttRetiredRuntimes: [],
    })
  })

  it('stores the newest snapshot so the settings page can render progress', () => {
    useInterviewStore.getState().applySttPreparation(snapshot({ states: [state()] }))

    expect(useInterviewStore.getState().sttPreparation.states[0].phase).toBe('downloading')
    expect(useInterviewStore.getState().sttPreparation.revision).toBe(1)
  })

  it('ignores a snapshot older than the last applied revision', () => {
    useInterviewStore.getState().applySttPreparation(snapshot({ revision: 5, states: [state({ progress: 50 })] }))
    useInterviewStore.getState().applySttPreparation(snapshot({ revision: 3, states: [state({ progress: 10 })] }))

    expect(useInterviewStore.getState().sttPreparation.revision).toBe(5)
    expect(useInterviewStore.getState().sttPreparation.states[0].progress).toBe(50)
  })

  it('accepts a fresh runtime even when its revision counter restarts', () => {
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-1', revision: 9 }))
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-2', revision: 1 }))

    expect(useInterviewStore.getState().sttPreparation.runtime_id).toBe('rt-2')
    expect(useInterviewStore.getState().sttPreparation.revision).toBe(1)
  })

  it('never lets a retired runtime come back with a higher revision', () => {
    // A late WS frame or an in-flight HTTP poll from the previous backend
    // process must not resurrect its download bar over the live one.
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-old', revision: 9, states: [state({ progress: 90 })] }))
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-new', revision: 1, states: [state({ progress: 5 })] }))
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-old', revision: 10, states: [state({ progress: 100 })] }))

    const applied = useInterviewStore.getState().sttPreparation
    expect(applied.runtime_id).toBe('rt-new')
    expect(applied.states[0].progress).toBe(5)
  })

  it('keeps the config version atomic with the snapshot it belongs to', () => {
    useInterviewStore.getState().applySttPreparation(snapshot({ revision: 5 }), 'v-5')
    useInterviewStore.getState().applySttPreparation(snapshot({ revision: 3 }), 'v-3')

    expect(useInterviewStore.getState().sttConfigVersion).toBe('v-5')
  })

  it('drops every state when the backend restarts without an active runtime', () => {
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-1', revision: 9, states: [state()] }))
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: null, revision: 0 }))

    expect(useInterviewStore.getState().sttPreparation.runtime_id).toBeNull()
    expect(useInterviewStore.getState().sttPreparation.states).toHaveLength(0)
  })

  it('does not let a late frame from a shut-down runtime take over after a restart', () => {
    // A null snapshot only clears the visible states: it can be an HTTP poll
    // captured during shutdown that is applied after the next runtime's frame.
    // The old runtime is retired when a different non-null runtime is accepted,
    // so a late frame from the old process still cannot come back.
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-1', revision: 9, states: [state({ progress: 90 })] }), 'v-1')
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: null, revision: 0 }), 'v-null')
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-2', revision: 1, states: [state({ progress: 5 })] }), 'v-2')
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-1', revision: 10, states: [state({ progress: 100 })] }), 'v-1-late')

    const applied = useInterviewStore.getState().sttPreparation
    expect(applied.runtime_id).toBe('rt-2')
    expect(applied.states[0].progress).toBe(5)
    // The rejected snapshot must not carry its config version along.
    expect(useInterviewStore.getState().sttConfigVersion).toBe('v-2')
  })

  it('accepts the live runtime again after a delayed null captured during shutdown', () => {
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-1', revision: 9 }), 'v-1')
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-2', revision: 1, states: [state({ progress: 5 })] }), 'v-2')
    // Delayed null: it hides rt-2 but must not retire it.
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: null, revision: 0 }), 'v-null')

    expect(useInterviewStore.getState().sttPreparation.runtime_id).toBeNull()
    expect(useInterviewStore.getState().sttPreparation.states).toHaveLength(0)
    expect(useInterviewStore.getState().sttRetiredRuntimes).not.toContain('rt-2')

    // rt-2 is still live, so its later revisions must be accepted.
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-2', revision: 2, states: [state({ progress: 20 })] }), 'v-3')
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-2', revision: 3, states: [state({ progress: 30 })] }), 'v-4')

    const applied = useInterviewStore.getState().sttPreparation
    expect(applied.runtime_id).toBe('rt-2')
    expect(applied.revision).toBe(3)
    expect(applied.states[0].progress).toBe(30)
    expect(useInterviewStore.getState().sttConfigVersion).toBe('v-4')
    expect(useInterviewStore.getState().sttRetiredRuntimes).not.toContain('rt-2')
  })

  it('keeps same-runtime revision ordering across a null gap and later recovers', () => {
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-1', revision: 9, states: [state({ progress: 90 })] }), 'v-9')
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: null, revision: 0 }), 'v-null')
    // An older in-flight response must not revive progress or change the
    // version merely because the visible snapshot currently has no runtime.
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-1', revision: 8, states: [state({ progress: 80 })] }), 'v-8')

    expect(useInterviewStore.getState().sttPreparation.runtime_id).toBeNull()
    expect(useInterviewStore.getState().sttPreparation.states).toHaveLength(0)
    expect(useInterviewStore.getState().sttConfigVersion).toBe('v-null')

    // The same runtime is not retired by the null gap; a newer frame can
    // restore it normally while preserving its monotonic revision.
    useInterviewStore.getState().applySttPreparation(snapshot({ runtime_id: 'rt-1', revision: 10, states: [state({ progress: 100 })] }), 'v-10')

    const applied = useInterviewStore.getState().sttPreparation
    expect(applied.runtime_id).toBe('rt-1')
    expect(applied.revision).toBe(10)
    expect(applied.states[0].progress).toBe(100)
    expect(useInterviewStore.getState().sttConfigVersion).toBe('v-10')
    expect(useInterviewStore.getState().sttRetiredRuntimes).not.toContain('rt-1')
  })

  it('records the saved config version reported by the backend', () => {
    useInterviewStore.getState().setSttConfigVersion('v-abc')

    expect(useInterviewStore.getState().sttConfigVersion).toBe('v-abc')
  })
})
