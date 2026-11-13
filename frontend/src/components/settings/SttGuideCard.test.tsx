import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import SttGuideCard from './SttGuideCard'

function openWhisperGuide() {
  render(<SttGuideCard provider="whisper" />)
  fireEvent.click(screen.getByRole('button'))
}

describe('SttGuideCard whisper guide', () => {
  it('says the packaged build bundles base instead of always downloading', () => {
    openWhisperGuide()
    expect(screen.getByText(/安装包已内置 base 模型/)).toBeInTheDocument()
    expect(screen.queryByText(/首次使用会自动下载模型（base/)).not.toBeInTheDocument()
  })

  it('still tells source users to install faster-whisper', () => {
    openWhisperGuide()
    expect(screen.getByText(/源码运行需先安装 faster-whisper/)).toBeInTheDocument()
  })

  it('does not claim every model is bundled', () => {
    openWhisperGuide()
    expect(screen.getByText(/small \/ medium 等其他模型不内置/)).toBeInTheDocument()
  })
})
