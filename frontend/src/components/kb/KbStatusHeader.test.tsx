import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import KbStatusHeader from './KbStatusHeader'
import { useKbStore } from '@/stores/kbStore'
import { useInterviewStore } from '@/stores/configStore'

const status = {
  enabled: true,
  trigger_modes: ['manual_text'],
  top_k: 4,
  deadline_ms: 150,
  asr_deadline_ms: 80,
  total_docs: 1,
  total_chunks: 2,
  last_mtime: 0,
  deps: { docx: true, pdf: true, ocr: false, vision: false },
  semantic_enabled: true,
  semantic_top_k: 6,
}

describe('KbStatusHeader semantic badge', () => {
  beforeEach(() => {
    useKbStore.setState({ status: null, recentHits: [] })
    useInterviewStore.setState({ settingsOpen: false } as any)
  })

  it('shows semantic retrieval status when enabled', () => {
    useKbStore.setState({ status: status as any })
    render(<KbStatusHeader />)
    expect(screen.getByText(/语义/)).toBeInTheDocument()
    expect(screen.getByText(/top 6/)).toBeInTheDocument()
  })

  it('shows semantic off badge when disabled', () => {
    useKbStore.setState({ status: { ...status, semantic_enabled: false } as any })
    render(<KbStatusHeader />)
    expect(screen.getByText(/语义/)).toBeInTheDocument()
  })
})
