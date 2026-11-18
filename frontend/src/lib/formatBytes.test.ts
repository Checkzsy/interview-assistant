import { describe, expect, it } from 'vitest'
import { formatBytes } from './formatBytes'

describe('formatBytes', () => {
  it('renders a dash for missing sizes', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(0)).toBe('—')
  })

  it('uses binary units for model files', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
