import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import TranscriptionPanel from './TranscriptionPanel'
import { useInterviewStore } from '@/stores/configStore'

function setScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  el.scrollTop = metrics.scrollTop
}

describe('TranscriptionPanel translation preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollTo = vi.fn() as any
    useInterviewStore.setState({
      transcriptions: ['第一段'],
      isRecording: true,
      audioLevel: 0,
      isTranscribing: false,
      config: { written_exam_mode: false },
      translations: {},
      translationErrors: [],
    } as any)
  })

  it('shows translations and failure markers only after the toggle is enabled', () => {
    useInterviewStore.setState({
      translations: { 1: '你好', 2: '世界' },
      translationErrors: [3],
    } as any)

    render(<TranscriptionPanel />)

    expect(screen.queryByText('纪要译文')).not.toBeInTheDocument()
    expect(screen.queryByText('译文：你好')).not.toBeInTheDocument()
    expect(screen.queryByText('翻译失败')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: '翻译' }))

    expect(screen.getByText('纪要译文')).toBeInTheDocument()
    expect(screen.getByText('译文：你好')).toBeInTheDocument()
    expect(screen.getByText('译文：世界')).toBeInTheDocument()
    expect(screen.getByText('翻译失败')).toBeInTheDocument()
    expect(screen.getByText('部分翻译失败')).toBeInTheDocument()
  })

  it('shows an empty hint when the toggle is on but no translation data exists', () => {
    render(<TranscriptionPanel />)

    fireEvent.click(screen.getByRole('switch', { name: '翻译' }))

    expect(screen.getByText('暂无译文')).toBeInTheDocument()
    expect(screen.queryByText('部分翻译失败')).not.toBeInTheDocument()
  })
})

describe('TranscriptionPanel auto-follow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollTo = vi.fn(function scrollTo(this: Element, options?: ScrollToOptions | number) {
      if (typeof options === 'object' && typeof options.top === 'number') {
        ;(this as HTMLElement).scrollTop = options.top
      }
    }) as any
    useInterviewStore.setState({
      transcriptions: ['第一段', '第二段'],
      isRecording: true,
      audioLevel: 0,
      isTranscribing: false,
      config: { written_exam_mode: false },
    } as any)
  })

  it('does not force-scroll when the user is reviewing older transcription lines', async () => {
    render(<TranscriptionPanel />)

    const scroller = screen.getByLabelText('转写记录')
    setScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 240, scrollTop: 760 })
    await waitFor(() => expect(scroller.scrollTop).toBe(1000))
    scroller.scrollTop = 120
    fireEvent.scroll(scroller)

    expect(await screen.findByRole('button', { name: '回到最新转写' })).toBeInTheDocument()

    act(() => {
      useInterviewStore.getState().addTranscription('第三段')
    })

    await waitFor(() => expect(screen.getByText('第三段')).toBeInTheDocument())
    expect(scroller.scrollTop).toBe(120)
  })

  it('keeps following new transcription lines while the user is near the bottom', async () => {
    render(<TranscriptionPanel />)

    const scroller = screen.getByLabelText('转写记录')
    setScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 240, scrollTop: 760 })
    fireEvent.scroll(scroller)

    act(() => {
      useInterviewStore.getState().addTranscription('第三段')
    })

    await waitFor(() => expect(scroller.scrollTop).toBe(1000))
    expect(screen.queryByRole('button', { name: '回到最新转写' })).not.toBeInTheDocument()
  })

  it('lets the user jump back to the latest transcription', async () => {
    render(<TranscriptionPanel />)

    const scroller = screen.getByLabelText('转写记录')
    setScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 240, scrollTop: 760 })
    await waitFor(() => expect(scroller.scrollTop).toBe(1000))
    scroller.scrollTop = 120
    fireEvent.scroll(scroller)

    fireEvent.click(await screen.findByRole('button', { name: '回到最新转写' }))

    expect(scroller.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: '回到最新转写' })).not.toBeInTheDocument()
  })
})
