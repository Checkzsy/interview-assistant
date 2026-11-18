import { describe, expect, it } from 'vitest'

import { whisperModelOptionLabel, whisperModelPathHint } from './whisperModelOptions'

const state = (
  model: string,
  status: 'bundled' | 'downloaded' | 'missing',
) => ({ model, status, path: `/models/${model}`, deletable: status === 'downloaded' })

describe('whisperModelOptionLabel', () => {
  it('marks a bundled model as offline-ready and shows its size', () => {
    expect(whisperModelOptionLabel('base', [state('base', 'bundled')], ['base'])).toBe(
      'base · 已内置，离线可用 (约 145 MB)',
    )
  })

  it('switches to “已下载” once the download completed', () => {
    expect(whisperModelOptionLabel('medium', [state('medium', 'downloaded')], ['base'])).toBe(
      'medium · 已下载，可直接使用 (约 1.5 GB)',
    )
  })

  it('goes back to “需下载” after the user deletes the files', () => {
    expect(whisperModelOptionLabel('medium', [state('medium', 'missing')], ['base'])).toBe(
      'medium · 需下载 (约 1.5 GB)',
    )
  })

  it('uses the bundled fallback list before /api/stt/models has loaded', () => {
    expect(whisperModelOptionLabel('base', undefined, ['base'])).toBe(
      'base · 已内置，离线可用 (约 145 MB)',
    )
    expect(whisperModelOptionLabel('medium', undefined, ['base'])).toBe(
      'medium · 需下载 (约 1.5 GB)',
    )
  })

  it('treats an unknown model without state as needing a download', () => {
    expect(whisperModelOptionLabel('large-v4', [], [])).toBe('large-v4 · 需下载')
  })
})

describe('whisperModelPathHint', () => {
  it('shows where a downloaded model lives and that it can be deleted', () => {
    expect(whisperModelPathHint('medium', [state('medium', 'downloaded')])).toBe(
      '已下载到：/models/medium（可删除；删除后再次选择该模型会重新下载）',
    )
  })

  it('warns that bundled files must not be deleted', () => {
    expect(whisperModelPathHint('base', [state('base', 'bundled')])).toBe(
      '内置模型位置：/models/base（随安装包提供，请勿删除）',
    )
  })

  it('shows the future location for a model that is not downloaded yet', () => {
    expect(whisperModelPathHint('small', [state('small', 'missing')])).toBe(
      '下载后会保存到：/models/small',
    )
  })

  it('renders nothing before states have loaded', () => {
    expect(whisperModelPathHint('small', undefined)).toBeNull()
  })
})
