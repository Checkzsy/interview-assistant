import { describe, expect, it } from 'vitest'

import { whisperModelOptionLabel } from './whisperModelOptions'

describe('whisperModelOptionLabel', () => {
  it('marks a bundled model as offline-ready and shows its size', () => {
    expect(whisperModelOptionLabel('base', ['base'])).toBe('base · 已内置，离线可用 (约 145 MB)')
  })

  it('marks every other model as needing a download', () => {
    expect(whisperModelOptionLabel('medium', ['base'])).toBe('medium · 需下载 (约 1.5 GB)')
  })

  it('still labels correctly when the backend reports no bundled models', () => {
    // A source checkout has no packaged model directory, so everything downloads.
    expect(whisperModelOptionLabel('base', [])).toBe('base · 需下载 (约 145 MB)')
    expect(whisperModelOptionLabel('base', undefined)).toBe('base · 需下载 (约 145 MB)')
  })

  it('falls back to a bare label for unknown model sizes', () => {
    expect(whisperModelOptionLabel('large-v4', ['base'])).toBe('large-v4 · 需下载')
  })
})
