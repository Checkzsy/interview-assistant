import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SpeechTab from './SpeechTab'
import { updateConfigAndRefresh } from '@/lib/configSync'
import { useInterviewStore } from '@/stores/configStore'

const apiMock = vi.hoisted(() => ({
  sttTest: vi.fn(),
  getSttStatus: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: apiMock,
}))

vi.mock('@/lib/configSync', () => ({
  updateConfigAndRefresh: vi.fn().mockResolvedValue({ ok: true }),
}))

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
    vi.mocked(updateConfigAndRefresh).mockReset()
    vi.mocked(updateConfigAndRefresh).mockImplementation(async (data) => ({
      ...useInterviewStore.getState().config!,
      ...data,
      stt_config_version: 'v-1',
    }))
    apiMock.sttTest.mockReset()
    apiMock.sttTest.mockResolvedValue({ ok: true, text: 'demo' })
    apiMock.getSttStatus.mockReset()
    apiMock.getSttStatus.mockResolvedValue({
      loaded: false,
      loading: false,
      model: 'base',
      provider: 'whisper',
      config_version: 'v-1',
      preparation: { runtime_id: null, revision: 0, active: null, pending: [], states: [] },
    })

    useInterviewStore.setState({
      config: {
        stt_provider: 'iflytek',
        whisper_model: 'base',
        whisper_language: 'auto',
        doubao_stt_app_id: '',
        doubao_stt_access_token: '',
        doubao_stt_api_key: '',
        doubao_stt_resource_id: '',
        doubao_stt_boosting_table_id: '',
        generic_stt_api_base_url: '',
        generic_stt_api_key: '',
        generic_stt_model: '',
        generic_stt_custom_headers: '',
        candidate_asr_enabled: false,
        candidate_stt_provider: 'whisper',
        candidate_whisper_model: '',
        candidate_whisper_language: '',
        candidate_remote_stt_enabled: false,
        candidate_context_enabled: true,
        candidate_context_wait_ms: 200,
        candidate_context_max_chars: 900,
        candidate_context_min_chars: 6,
        candidate_streaming_asr_enabled: true,
        candidate_streaming_asr_interval_ms: 1500,
        candidate_mic_compatibility_mode: true,
        silence_threshold: 0.01,
        silence_duration: 1.2,
        transcription_min_sig_chars: 2,
        assist_transcription_merge_gap_sec: 2.0,
        assist_transcription_merge_max_sec: 12.0,
        assist_high_churn_short_answer: false,
        auto_detect: true,
      },
      options: {
        stt_providers: ['whisper', 'doubao', 'generic'],
        whisper_models: ['tiny', 'base'],
      },
      toastMessage: null,
      setToastMessage: vi.fn(),
      sttPreparation: { runtime_id: null, revision: 0, active: null, pending: [], states: [] },
      sttLastAcceptedPreparation: null,
      sttRetiredRuntimes: [],
      sttConfigVersion: 'v-1',
      wsConnected: false,
    } as any)
  })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SpeechTab', () => {
  it('shows a warning when the saved provider is no longer supported', async () => {
    render(<SpeechTab />)

    expect(await screen.findByText(/该 provider 已不再受支持/)).toBeInTheDocument()
    expect(screen.getByText(/请切换到“通用 ASR”或“Whisper”/)).toBeInTheDocument()
  })

  it('marks which whisper models ship inside the installer', () => {
    useInterviewStore.setState((state) => ({
      config: { ...(state.config as any), stt_provider: 'whisper' },
    }) as any)
    render(<SpeechTab />)

    const options = Array.from(
      (screen.getByTestId('main-whisper-model') as HTMLSelectElement).options,
    ).map((option) => option.textContent)

    expect(options).toContain('base · 需下载 (约 145 MB)')
    expect(options).toContain('tiny · 需下载 (约 75 MB)')
  })

  it('labels bundled models as offline-ready when the backend reports them', () => {
    useInterviewStore.setState((state) => ({
      config: { ...(state.config as any), stt_provider: 'whisper' },
      options: { ...(state.options as any), bundled_whisper_models: ['base'] },
    }) as any)
    render(<SpeechTab />)

    const options = Array.from(
      (screen.getByTestId('main-whisper-model') as HTMLSelectElement).options,
    ).map((option) => option.textContent)

    expect(options).toContain('base · 已内置，离线可用 (约 145 MB)')
    expect(options).toContain('tiny · 需下载 (约 75 MB)')
  })

  it('shows candidate microphone ASR defaults as local whisper', () => {
    render(<SpeechTab />)

    expect(screen.getByText('实时辅助语音链路')).toBeInTheDocument()
    expect(screen.getByText('主链路 ASR（面试官 / 会议音频）')).toBeInTheDocument()
    expect(screen.getByText('可选辅助 ASR（我的回答）')).toBeInTheDocument()
    expect(screen.queryByText(/Beta/i)).not.toBeInTheDocument()
    expect(screen.getByText('我的回答记录（麦克风）')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '我的回答记录（麦克风）' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getAllByText(/不会触发自动答题/).length).toBeGreaterThan(0)
    expect(screen.getByText(/不读取麦克风，不写入复盘，追问按旧逻辑/)).toBeInTheDocument()
    expect(screen.getByText('麦克风兼容模式')).toBeInTheDocument()
    expect(screen.getByText('共享兼容优先')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Whisper（本地，免费）')).toBeInTheDocument()
    expect(screen.getByText(/高级设置：Whisper 模型与追问上下文/)).toBeInTheDocument()
    expect(screen.getByText(/生成下一轮答案时会携带上一轮/)).toBeInTheDocument()
    expect(screen.getByText('边听边写')).toBeInTheDocument()
    expect(screen.getByText('兜底等最后一句 (ms)')).toBeInTheDocument()
    expect(screen.getByDisplayValue('200')).toBeInTheDocument()
  })

  it('describes candidate microphone ASR as review recording even when follow-up context is off', () => {
    useInterviewStore.setState((state) => ({
      config: {
        ...(state.config as any),
        stt_provider: 'whisper',
        candidate_asr_enabled: true,
        candidate_context_enabled: false,
      },
    }) as any)

    render(<SpeechTab />)

    expect(screen.getByText(/Whisper 本地，仅记录复盘，追问按旧逻辑/)).toBeInTheDocument()
    expect(screen.getByText(/用于把你的真实回答写入复盘/)).toBeInTheDocument()
    expect(screen.getByText('仅写入复盘记录')).toBeInTheDocument()
  })

  it('describes candidate microphone ASR as review recording plus spoken follow-up context when enabled', () => {
    useInterviewStore.setState((state) => ({
      config: {
        ...(state.config as any),
        stt_provider: 'whisper',
        candidate_asr_enabled: true,
        candidate_context_enabled: true,
      },
    }) as any)

    render(<SpeechTab />)

    expect(screen.getByText(/Whisper 本地，记录复盘，并给追问补真实口述/)).toBeInTheDocument()
    expect(screen.getByText('下一题携带真实口述')).toBeInTheDocument()
  })

  it('warns when candidate cloud ASR is selected without matching credentials', () => {
    useInterviewStore.setState((state) => ({
      config: {
        ...(state.config as any),
        stt_provider: 'whisper',
        candidate_asr_enabled: true,
        candidate_stt_provider: 'generic',
        generic_stt_api_base_url: '',
        generic_stt_api_key: '',
        generic_stt_model: '',
      },
    }) as any)

    render(<SpeechTab />)

    expect(screen.getByDisplayValue('通用 ASR（云端，会增加成本）')).toBeInTheDocument()
    expect(screen.getByText(/已选择 通用 ASR 麦克风 ASR，但上方 通用 ASR 凭据还没补全/)).toBeInTheDocument()
    expect(screen.getByText(/请切到对应主链路 ASR 填写凭据并保存，或改回 Whisper/)).toBeInTheDocument()
  })

  it('does not save candidate remote STT as enabled while candidate ASR is off', async () => {
    useInterviewStore.setState((state) => ({
      config: {
        ...(state.config as any),
        stt_provider: 'whisper',
        candidate_asr_enabled: false,
        candidate_stt_provider: 'generic',
        candidate_remote_stt_enabled: true,
      },
    }) as any)

    render(<SpeechTab />)

    fireEvent.click(screen.getByText('保存语音配置'))

    await waitFor(() => {
      expect(updateConfigAndRefresh).toHaveBeenCalledWith(expect.objectContaining({
        candidate_asr_enabled: false,
        candidate_stt_provider: 'generic',
        candidate_remote_stt_enabled: false,
      }))
    })
  })

  it('normalizes runtime numeric fields before saving speech settings', async () => {
    useInterviewStore.setState((state) => ({
      config: {
        ...(state.config as any),
        stt_provider: 'whisper',
        candidate_context_wait_ms: -20,
        candidate_context_max_chars: 99999,
        candidate_context_min_chars: 'not-a-number',
        candidate_streaming_asr_interval_ms: 10,
        silence_threshold: 'not-a-number',
        silence_duration: 99,
        transcription_min_sig_chars: -4,
        assist_transcription_merge_gap_sec: 99,
        assist_transcription_merge_max_sec: -3,
      },
    }) as any)

    render(<SpeechTab />)

    fireEvent.click(screen.getByText('保存语音配置'))

    await waitFor(() => {
      expect(updateConfigAndRefresh).toHaveBeenCalledWith(expect.objectContaining({
        candidate_context_wait_ms: 0,
        candidate_context_max_chars: 4000,
        candidate_context_min_chars: 6,
        candidate_streaming_asr_interval_ms: 800,
        silence_threshold: 0.01,
        silence_duration: 10,
        transcription_min_sig_chars: 1,
        assist_transcription_merge_gap_sec: 15,
        assist_transcription_merge_max_sec: 1,
      }))
    })
    expect(screen.queryByDisplayValue('NaN')).not.toBeInTheDocument()
  })

  it('marks speech settings dirty and clears after saving', async () => {
    useInterviewStore.setState((state) => ({
      config: {
        ...(state.config as any),
        stt_provider: 'whisper',
      },
    }) as any)
    render(<SpeechTab />)

    fireEvent.change(screen.getByTestId('main-whisper-model'), { target: { value: 'tiny' } })

    expect(screen.getAllByText('有未保存更改').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('保存语音配置'))

    await waitFor(() => {
      expect(updateConfigAndRefresh).toHaveBeenCalled()
    })
    expect(await screen.findAllByText('已保存')).not.toHaveLength(0)
  })

  it('ignores rapid duplicate speech saves while saving is pending', async () => {
    const save = createDeferred<{ ok: boolean }>()
    vi.mocked(updateConfigAndRefresh).mockReturnValueOnce(save.promise as any)

    render(<SpeechTab />)

    const saveButton = screen.getByRole('button', { name: '保存语音配置' })
    act(() => {
      saveButton.click()
      saveButton.click()
    })

    expect(updateConfigAndRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存并测试' })).toBeDisabled()

    await act(async () => {
      save.resolve({ ok: true })
      await save.promise
    })
  })

  it('keeps unsaved speech edits when config refreshes from another section', () => {
    useInterviewStore.setState((state) => ({
      config: {
        ...(state.config as any),
        stt_provider: 'whisper',
      },
    }) as any)
    render(<SpeechTab />)

    fireEvent.change(screen.getByTestId('main-whisper-model'), { target: { value: 'tiny' } })
    useInterviewStore.setState((state) => ({
      config: {
        ...(state.config as any),
        max_parallel_answers: 3,
      },
    }) as any)

    expect((screen.getByTestId('main-whisper-model') as HTMLSelectElement).value).toBe('tiny')
    expect(screen.getAllByText('有未保存更改').length).toBeGreaterThan(0)
  })

  it('saves before testing the main STT connection', async () => {
    render(<SpeechTab />)

    fireEvent.click(screen.getByText('保存并测试'))

    await waitFor(() => {
      expect(updateConfigAndRefresh).toHaveBeenCalled()
      expect(apiMock.sttTest).toHaveBeenCalled()
    })
  })

  it('ignores rapid duplicate STT tests while the save-and-test flow is pending', async () => {
    const save = createDeferred<{ ok: boolean }>()
    const stt = createDeferred<{ ok: boolean; text: string }>()
    vi.mocked(updateConfigAndRefresh).mockReturnValueOnce(save.promise as any)
    apiMock.sttTest.mockReturnValueOnce(stt.promise)

    render(<SpeechTab />)

    const testButton = screen.getByRole('button', { name: '保存并测试' })
    act(() => {
      testButton.click()
      testButton.click()
    })

    expect(updateConfigAndRefresh).toHaveBeenCalledTimes(1)
    expect(apiMock.sttTest).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '测试中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()

    await act(async () => {
      save.resolve({ ok: true })
      await save.promise
    })
    expect(apiMock.sttTest).toHaveBeenCalledTimes(1)

    await act(async () => {
      stt.resolve({ ok: true, text: 'hello' })
      await stt.promise
    })

    expect(screen.getByText('连接成功')).toBeInTheDocument()
  })

  it('keeps edits made during an in-flight save and does not test the stale form', async () => {
    const save = createDeferred<{ ok: boolean; stt_config_version?: string }>()
    vi.mocked(updateConfigAndRefresh).mockReturnValueOnce(save.promise as any)
    useInterviewStore.setState((state) => ({
      config: { ...(state.config as any), stt_provider: 'whisper' },
    }) as any)

    render(<SpeechTab />)

    fireEvent.click(screen.getByText('保存并测试'))
    fireEvent.change(screen.getByTestId('main-whisper-model'), { target: { value: 'tiny' } })

    await act(async () => {
      save.resolve({ ok: true, stt_config_version: 'v-2' })
      await save.promise
    })

    expect((screen.getByTestId('main-whisper-model') as HTMLSelectElement).value).toBe('tiny')
    expect(apiMock.sttTest).not.toHaveBeenCalled()
  })

  it('ignores a late test result after the form was edited', async () => {
    const stt = createDeferred<{ ok: boolean; text: string }>()
    apiMock.sttTest.mockReturnValueOnce(stt.promise)
    useInterviewStore.setState((state) => ({
      config: { ...(state.config as any), stt_provider: 'whisper' },
    }) as any)

    render(<SpeechTab />)

    fireEvent.click(screen.getByText('保存并测试'))
    await waitFor(() => expect(apiMock.sttTest).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId('main-whisper-model'), { target: { value: 'tiny' } })

    await act(async () => {
      stt.resolve({ ok: true, text: 'hello' })
      await stt.promise
    })

    expect(screen.queryByText('连接成功')).not.toBeInTheDocument()
  })
})

describe('SpeechTab staged preparation feedback', () => {
  const prepState = (overrides: Record<string, unknown> = {}) => ({
    key: ['base', 'auto'],
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

  const statusPayload = (prep: Record<string, unknown>, revision = 1) => ({
    loaded: false,
    loading: true,
    model: 'base',
    provider: 'whisper',
    config_version: 'v-1',
    preparation: { runtime_id: 'rt-1', revision, active: null, pending: [], states: [prep] },
  })

  it('loads the current preparation snapshot on mount', async () => {
    apiMock.getSttStatus.mockResolvedValueOnce(statusPayload(prepState({ phase: 'resolving', downloaded_bytes: null, total_bytes: null })))

    render(<SpeechTab />)

    await waitFor(() => expect(apiMock.getSttStatus).toHaveBeenCalledTimes(1))
  })

  it('waits for the model, then runs the real test exactly once', async () => {
    apiMock.sttTest
      .mockResolvedValueOnce({ ok: false, pending: true, config_version: 'v-1', attempt_id: 'a1', state: prepState({ phase: 'downloading' }) })
      .mockResolvedValueOnce({ ok: true, text: 'demo', config_version: 'v-1' })
    apiMock.getSttStatus
      .mockResolvedValueOnce(statusPayload(prepState({ phase: 'downloading', downloaded_bytes: 30, total_bytes: 100, progress: 30 })))
      .mockResolvedValueOnce(statusPayload(prepState({ phase: 'ready', downloaded_bytes: 100, total_bytes: 100, progress: 100 }), 2))

    render(<SpeechTab />)
    fireEvent.click(screen.getByText('保存并测试'))

    expect(await screen.findByText(/正在下载模型 30%/)).toBeInTheDocument()

    await waitFor(() => expect(apiMock.sttTest).toHaveBeenCalledTimes(2), { timeout: 6000 })
    expect(await screen.findByText('连接成功')).toBeInTheDocument()
  })

  it('never rounds a partially downloaded model up to 100%', async () => {
    apiMock.sttTest.mockResolvedValueOnce({
      ok: false,
      pending: true,
      config_version: 'v-1',
      attempt_id: 'a1',
      state: prepState({ phase: 'downloading', downloaded_bytes: 999, total_bytes: 1000, progress: 99.9 }),
    })

    render(<SpeechTab />)
    fireEvent.click(screen.getByText('保存并测试'))

    expect(await screen.findByText(/正在下载模型 99%/)).toBeInTheDocument()
    expect(screen.queryByText(/正在下载模型 100%/)).not.toBeInTheDocument()
  })

  it('reports a busy admission instead of pretending to download', async () => {
    apiMock.sttTest.mockResolvedValueOnce({
      ok: false,
      busy: true,
      reason: 'admission_busy',
      config_version: 'v-1',
      detail: 'STT 测试繁忙，请等待当前测试结束后重试',
    })

    render(<SpeechTab />)
    fireEvent.click(screen.getByText('保存并测试'))

    expect(await screen.findByText(/正在测试其他配置/)).toBeInTheDocument()
    expect(screen.queryByText(/正在下载/)).not.toBeInTheDocument()
  })

  it('shows the full download error and retries only on request', async () => {
    const longError = '连接 huggingface.co 失败：SSL 证书校验未通过，请检查代理或网络设置后重试（错误码 7）'
    apiMock.sttTest
      .mockResolvedValueOnce({ ok: false, config_version: 'v-1', state: prepState({ phase: 'error', error: longError }), detail: longError })
      .mockResolvedValueOnce({ ok: false, pending: true, config_version: 'v-1', attempt_id: 'a2', state: prepState({ phase: 'resolving' }) })

    render(<SpeechTab />)
    fireEvent.click(screen.getByText('保存并测试'))

    expect(await screen.findByText(new RegExp('SSL 证书校验未通过'))).toBeInTheDocument()
    expect(apiMock.sttTest).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '重试准备并测试' }))

    await waitFor(() => expect(apiMock.sttTest).toHaveBeenCalledTimes(2))
    expect(apiMock.sttTest.mock.calls[1][0]).toMatchObject({ retry: true })
  })

  it('follows the lane when the attempt is replaced without a new pending response', async () => {
    apiMock.sttTest
      .mockResolvedValueOnce({ ok: false, pending: true, config_version: 'v-1', attempt_id: 'a1', state: prepState({ phase: 'downloading' }) })
      .mockResolvedValueOnce({ ok: true, text: 'demo', config_version: 'v-1' })
    // Nothing tells this tab about a2 except the status snapshot: another tab
    // retried, so the a1 state no longer exists.
    apiMock.getSttStatus
      .mockResolvedValueOnce(statusPayload(prepState({ phase: 'downloading' })))
      .mockResolvedValueOnce(statusPayload(prepState({ attempt_id: 'a2', phase: 'ready', progress: 100 }), 2))

    render(<SpeechTab />)
    fireEvent.click(screen.getByText('保存并测试'))

    expect(await screen.findByText('连接成功', {}, { timeout: 6000 })).toBeInTheDocument()
    expect(apiMock.sttTest.mock.calls[1][0]).toMatchObject({ attempt_id: 'a2' })
  })

  it('re-arms the staged test when the backend hands back a superseded attempt', async () => {
    apiMock.sttTest
      .mockResolvedValueOnce({ ok: false, pending: true, config_version: 'v-1', attempt_id: 'a1', state: prepState({ phase: 'downloading' }) })
      // The real test raced a replacement: the answer is "still preparing", not
      // a result. The panel must follow the new attempt instead of sticking on
      // "测试中…" forever.
      .mockResolvedValueOnce({ ok: false, pending: true, config_version: 'v-1', attempt_id: 'a2', state: prepState({ attempt_id: 'a2', phase: 'downloading' }) })
      .mockResolvedValueOnce({ ok: true, text: 'demo', config_version: 'v-1' })
    apiMock.getSttStatus
      .mockResolvedValueOnce(statusPayload(prepState({ phase: 'ready', progress: 100 })))
      .mockResolvedValueOnce(statusPayload(prepState({ attempt_id: 'a2', phase: 'ready', progress: 100 }), 2))

    render(<SpeechTab />)
    fireEvent.click(screen.getByText('保存并测试'))

    expect(await screen.findByText('连接成功', {}, { timeout: 6000 })).toBeInTheDocument()
    expect(apiMock.sttTest).toHaveBeenCalledTimes(3)
    expect(apiMock.sttTest.mock.calls[2][0]).toMatchObject({ attempt_id: 'a2' })
  })

  it('does not re-POST the same attempt while the snapshot still reads ready', async () => {
    apiMock.sttTest.mockResolvedValue({
      ok: false,
      pending: true,
      config_version: 'v-1',
      attempt_id: 'a1',
      state: prepState({ phase: 'downloading' }),
    })
    // The snapshot is stale: it still says ready for the attempt that just
    // answered "pending". Re-testing at the same revision would spin.
    apiMock.getSttStatus.mockResolvedValue(statusPayload(prepState({ phase: 'ready', progress: 100 })))

    render(<SpeechTab />)
    fireEvent.click(screen.getByText('保存并测试'))

    // One admission POST plus one real test for attempt a1; the stale "ready"
    // snapshot must not add a third.
    await waitFor(() => expect(apiMock.sttTest).toHaveBeenCalledTimes(2))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2500)) })

    expect(apiMock.sttTest).toHaveBeenCalledTimes(2)
  })

  it('stops polling when the panel unmounts', async () => {
    apiMock.sttTest.mockResolvedValueOnce({
      ok: false,
      pending: true,
      config_version: 'v-1',
      attempt_id: 'a1',
      state: prepState({ phase: 'downloading' }),
    })

    const view = render(<SpeechTab />)
    fireEvent.click(screen.getByText('保存并测试'))
    await screen.findByText(/正在下载模型/)

    const callsBeforeUnmount = apiMock.getSttStatus.mock.calls.length
    view.unmount()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)) })

    expect(apiMock.getSttStatus.mock.calls.length).toBe(callsBeforeUnmount)
  })
})
