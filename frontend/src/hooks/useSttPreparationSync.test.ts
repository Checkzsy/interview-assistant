import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInterviewStore } from '@/stores/configStore'
import { useSttPreparationSync } from './useSttPreparationSync'

const apiMock = vi.hoisted(() => ({ getSttStatus: vi.fn() }))

vi.mock('@/lib/api', () => ({ api: apiMock }))

const prepState = (overrides: Record<string, unknown> = {}) => ({
  key: ['medium', 'zh'],
  attempt_id: 'a1',
  phase: 'downloading',
  downloaded_bytes: 30,
  total_bytes: 100,
  progress: 30,
  started_at: 1,
  updated_at: 2,
  error: null,
  roles: ['main'],
  ...overrides,
})

const payload = (state: Record<string, unknown>, revision = 1) => ({
  loaded: false,
  loading: true,
  model: 'medium',
  provider: 'whisper',
  config_version: 'v-1',
  preparation: { runtime_id: 'rt-1', revision, active: null, pending: [], states: [state] },
})

beforeEach(() => {
  apiMock.getSttStatus.mockReset()
  useInterviewStore.setState({
    sttPreparation: { runtime_id: null, revision: 0, active: null, pending: [], states: [] },
    sttLastAcceptedPreparation: null,
    sttRetiredRuntimes: [],
    sttConfigVersion: '',
  } as any)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSttPreparationSync', () => {
  it('applies the status snapshot so a follower tab sees the download', async () => {
    apiMock.getSttStatus.mockResolvedValue(payload(prepState({ phase: 'ready' }), 4))

    renderHook(() => useSttPreparationSync(true))

    await act(async () => { await Promise.resolve() })
    expect(apiMock.getSttStatus).toHaveBeenCalledTimes(1)
    expect(useInterviewStore.getState().sttPreparation.states[0].phase).toBe('ready')
    expect(useInterviewStore.getState().sttConfigVersion).toBe('v-1')
  })

  it('keeps polling only while a consumer is still preparing, then stops', async () => {
    vi.useFakeTimers()
    apiMock.getSttStatus
      .mockResolvedValueOnce(payload(prepState({ phase: 'downloading' }), 2))
      .mockResolvedValueOnce(payload(prepState({ phase: 'ready' }), 3))

    renderHook(() => useSttPreparationSync(true))

    await act(async () => { await Promise.resolve() })
    expect(apiMock.getSttStatus).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(apiMock.getSttStatus).toHaveBeenCalledTimes(2)

    // Terminal: the fast cadence stops; a slow heartbeat remains so a download
    // started later (leader tab, backend preload) still shows up here.
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
    expect(apiMock.getSttStatus).toHaveBeenCalledTimes(4)
  })

  it('picks up a download that starts after an idle first poll', async () => {
    vi.useFakeTimers()
    apiMock.getSttStatus
      .mockResolvedValueOnce({ ...payload(prepState({ phase: 'ready' }), 1), preparation: { runtime_id: 'rt-1', revision: 1, active: null, pending: [], states: [] } })
      .mockResolvedValueOnce(payload(prepState({ phase: 'downloading' }), 2))

    renderHook(() => useSttPreparationSync(true))

    await act(async () => { await Promise.resolve() })
    expect(useInterviewStore.getState().sttPreparation.states).toHaveLength(0)

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(apiMock.getSttStatus).toHaveBeenCalledTimes(2)
    expect(useInterviewStore.getState().sttPreparation.states[0].phase).toBe('downloading')
  })

  it('does not poll while disabled or after unmount', async () => {
    vi.useFakeTimers()
    apiMock.getSttStatus.mockResolvedValue(payload(prepState(), 2))

    const disabled = renderHook(() => useSttPreparationSync(false))
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(apiMock.getSttStatus).not.toHaveBeenCalled()
    disabled.unmount()

    const enabled = renderHook(() => useSttPreparationSync(true))
    await act(async () => { await Promise.resolve() })
    const calls = apiMock.getSttStatus.mock.calls.length
    enabled.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(40000) })
    expect(apiMock.getSttStatus.mock.calls.length).toBe(calls)
  })

  it('survives a failed poll without throwing', async () => {
    apiMock.getSttStatus.mockRejectedValueOnce(new Error('offline'))

    const { unmount } = renderHook(() => useSttPreparationSync(true))

    await act(async () => { await Promise.resolve() })
    expect(apiMock.getSttStatus).toHaveBeenCalledTimes(1)
    expect(useInterviewStore.getState().sttPreparation.states).toHaveLength(0)
    unmount()
  })
})
