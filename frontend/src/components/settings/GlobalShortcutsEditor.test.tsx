import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import GlobalShortcutsEditor from './GlobalShortcutsEditor'
import { defaultShortcuts } from '@/lib/shortcuts'
import { useInterviewStore } from '@/stores/configStore'
import { useShortcutsStore } from '@/stores/shortcutsStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('GlobalShortcutsEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useShortcutsStore.getState().resetShortcuts()
    useInterviewStore.setState({ toastMessage: null } as any)
    ;(window as any).electronAPI = {
      getShortcuts: vi.fn().mockResolvedValue(defaultShortcuts),
      updateShortcuts: vi.fn().mockResolvedValue({ ok: true, shortcuts: defaultShortcuts }),
      resetShortcuts: vi.fn().mockResolvedValue({ ok: true, shortcuts: defaultShortcuts }),
    }
  })

  it('renders operation hints, failure hint, and focus/overlay conditions for mixed statuses', async () => {
    const mixed = {
      ...defaultShortcuts,
      hideOrShowWindow: { ...defaultShortcuts.hideOrShowWindow, status: 'registered' as const },
      cancelAnswer: { ...defaultShortcuts.cancelAnswer, status: 'failed' as const },
      focusPrevTab: { ...defaultShortcuts.focusPrevTab, status: 'available' as const },
      focusNextTab: { ...defaultShortcuts.focusNextTab, status: 'available' as const },
      overlayPrevQuestion: { ...defaultShortcuts.overlayPrevQuestion, status: 'available' as const },
      overlayNextQuestion: { ...defaultShortcuts.overlayNextQuestion, status: 'available' as const },
    }

    render(<GlobalShortcutsEditor />)

    await screen.findByText('隐藏/显示窗口')
    act(() => {
      useShortcutsStore.setState({ shortcuts: mixed })
    })

    expect(screen.getByText('显示或隐藏主窗口')).toBeInTheDocument()
    expect(screen.getByText('注册失败')).toBeInTheDocument()
    expect(screen.getByText('当前组合注册失败，请更换快捷键后重试')).toBeInTheDocument()
    expect(screen.getAllByText('需在专注面板展开时生效')).toHaveLength(2)
    expect(screen.getAllByText('需悬浮窗已显示时生效')).toHaveLength(2)
  })

  it('ignores rapid duplicate shortcut recordings while save is pending', async () => {
    const save = deferred<{ ok: boolean; shortcuts: Record<string, any> }>()
    window.electronAPI!.updateShortcuts = vi.fn().mockReturnValueOnce(save.promise)

    render(<GlobalShortcutsEditor />)

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+B' }))
    expect(screen.getByRole('button', { name: '按下新快捷键…' })).toBeInTheDocument()

    const eventInit = {
      key: 'H',
      code: 'KeyH',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', eventInit))
      window.dispatchEvent(new KeyboardEvent('keydown', eventInit))
      await Promise.resolve()
    })

    expect(window.electronAPI!.updateShortcuts).toHaveBeenCalledTimes(1)
    expect(window.electronAPI!.updateShortcuts).toHaveBeenCalledWith([
      { action: 'hideOrShowWindow', key: 'CommandOrControl+H' },
    ])
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()

    await act(async () => {
      save.resolve({
        ok: true,
        shortcuts: {
          ...defaultShortcuts,
          hideOrShowWindow: {
            ...defaultShortcuts.hideOrShowWindow,
            key: 'CommandOrControl+H',
          },
        },
      })
      await save.promise
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Ctrl+H' })).toBeInTheDocument())
  })

  it('ignores rapid duplicate shortcut resets while reset is pending', async () => {
    const reset = deferred<{ ok: boolean; shortcuts: Record<string, any> }>()
    window.electronAPI!.resetShortcuts = vi.fn().mockReturnValueOnce(reset.promise)

    render(<GlobalShortcutsEditor />)

    const resetButton = screen.getByRole('button', { name: '恢复默认快捷键' })
    act(() => {
      resetButton.click()
      resetButton.click()
    })

    expect(window.electronAPI!.resetShortcuts).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '重置中…' })).toBeDisabled()

    await act(async () => {
      reset.resolve({ ok: true, shortcuts: defaultShortcuts })
      await reset.promise
    })

    expect(await screen.findByRole('button', { name: '恢复默认快捷键' })).toBeEnabled()
  })
})
