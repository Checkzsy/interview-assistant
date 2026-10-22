import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsReconnectingBanner } from './WsReconnectingBanner'

describe('WsReconnectingBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('hides the manual reload action before 10 seconds', () => {
    render(<WsReconnectingBanner />)

    expect(screen.getByRole('status')).toHaveTextContent('正在自动重连')
    expect(screen.queryByRole('button', { name: '手动刷新' })).not.toBeInTheDocument()
  })

  it('asks for confirmation before reloading instead of using window.confirm', () => {
    const reload = vi.fn()
    // jsdom 不支持真实导航，替换 location.reload 以便断言
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })

    render(<WsReconnectingBanner />)
    act(() => {
      vi.advanceTimersByTime(11_000)
    })

    fireEvent.click(screen.getByRole('button', { name: '手动刷新' }))

    // 先弹统一确认框，此时不应该立刻刷新
    const dialog = screen.getByRole('dialog', { name: '刷新页面？' })
    expect(reload).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: '刷新' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when the confirmation is cancelled', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })

    render(<WsReconnectingBanner />)
    act(() => {
      vi.advanceTimersByTime(11_000)
    })

    fireEvent.click(screen.getByRole('button', { name: '手动刷新' }))
    const dialog = screen.getByRole('dialog', { name: '刷新页面？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '继续等待重连' }))

    expect(screen.queryByRole('dialog', { name: '刷新页面？' })).not.toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })
})
