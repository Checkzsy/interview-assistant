import { describe, expect, it } from 'vitest'
import { describeMainSttPreparation, describeSttPreparation, downloadPercent } from './sttPreparationDisplay'

const state = (overrides: Record<string, unknown> = {}) => ({
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
}) as any

describe('stt preparation display', () => {
  it('floors a partial transfer instead of claiming 100%', () => {
    expect(downloadPercent(state({ progress: 99.9, downloaded_bytes: 999, total_bytes: 1000 }))).toBe(99)
    expect(describeSttPreparation(state({ progress: 99.9 }))?.label).toBe('正在下载模型 99%')
  })

  it('does not guess progress without a denominator', () => {
    expect(downloadPercent(state({ progress: null, downloaded_bytes: 30, total_bytes: null }))).toBeNull()
    expect(describeSttPreparation(state({ progress: null, total_bytes: null }))?.label).toBe('正在下载模型')
  })

  it('distinguishes a completed transfer from a local cache load', () => {
    expect(describeSttPreparation(state({ phase: 'loading', downloaded_bytes: 100, total_bytes: 100 }))?.label).toBe(
      '下载完成，正在加载模型',
    )
    expect(describeSttPreparation(state({ phase: 'loading', downloaded_bytes: null, total_bytes: null }))?.label).toBe(
      '正在加载本地模型',
    )
  })

  it('keeps the full preparation error reason', () => {
    const reason = '连接 huggingface.co 失败：SSL 证书校验未通过，请检查代理或网络设置后重试（错误码 7）'
    expect(describeSttPreparation(state({ phase: 'error', error: reason }))).toMatchObject({
      kind: 'error',
      detail: reason,
    })
  })
})

describe('main-role preparation summary for the status chip', () => {
  const whisperCfg = { stt_provider: 'whisper', whisper_model: 'medium', whisper_language: 'zh' }
  const medium = (overrides: Record<string, unknown> = {}) =>
    state({ key: ['medium', 'zh'], attempt_id: 'm1', ...overrides })
  const snapshot = (...states: any[]) => ({ runtime_id: 'rt', revision: 1, active: null, pending: [], states })

  it('surfaces the active main download instead of a silent "loading" chip', () => {
    expect(
      describeMainSttPreparation(
        snapshot(medium({ phase: 'downloading', downloaded_bytes: 458_400_000, total_bytes: 1_528_000_000, progress: 30 })),
        whisperCfg,
      ),
    ).toMatchObject({ kind: 'downloading', label: '正在下载模型 30%' })
  })

  it('stays silent when the main model is already ready', () => {
    expect(describeMainSttPreparation(snapshot(medium({ phase: 'ready' })), whisperCfg)).toBeNull()
  })

  it('ignores another model key and another consumer role', () => {
    expect(
      describeMainSttPreparation(
        snapshot(
          state({ key: ['small', 'zh'], phase: 'downloading', progress: 10 }),
          state({ key: ['medium', 'zh'], phase: 'downloading', progress: 10, roles: ['candidate'] }),
        ),
        whisperCfg,
      ),
    ).toBeNull()
  })

  it('does not claim local download progress while a remote provider is selected', () => {
    expect(
      describeMainSttPreparation(
        snapshot(medium({ phase: 'downloading', progress: 30 })),
        { ...whisperCfg, stt_provider: 'doubao' },
      ),
    ).toBeNull()
  })

  it('reports a main preparation error with its full reason', () => {
    const reason = '连接 huggingface.co 失败：SSL 证书校验未通过'
    expect(
      describeMainSttPreparation(snapshot(medium({ phase: 'error', error: reason })), whisperCfg),
    ).toMatchObject({ kind: 'error', label: '模型准备失败', detail: reason })
  })
})
