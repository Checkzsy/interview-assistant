import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UpdateCard from './UpdateCard'

const makeState = (over: Record<string, unknown> = {}) => ({
  current: '1.1.0',
  latest: 'v1.2.0',
  hasUpdate: true,
  asset: { name: 'Interview.Assistant.Setup.1.2.0.exe', size: 1024, url: 'https://u/x', updatedAt: null },
  releaseName: 'Interview Assistant v1.2.0',
  publishedAt: '2026-09-24T00:00:00Z',
  checking: false,
  checkError: null,
  download: { status: 'idle', received: 0, total: 0, error: null, downloadedPath: null },
  installing: false,
  installError: null,
  ...over,
})

describe('UpdateCard', () => {
  const originalElectronAPI = window.electronAPI
  let updaterState: any

  const setElectronAPI = () => {
    ;(window as any).electronAPI = {
      getUpdaterState: vi.fn(async () => updaterState),
      checkForUpdate: vi.fn(async () => updaterState),
      downloadUpdate: vi.fn(async () => updaterState),
      installUpdate: vi.fn(async () => ({ ok: true })),
      onUpdaterState: () => () => {},
    }
  }

  beforeEach(() => {
    updaterState = makeState()
    delete (window as any).electronAPI
  })
  afterEach(() => {
    if (originalElectronAPI) (window as any).electronAPI = originalElectronAPI
    else delete (window as any).electronAPI
  })

  it('renders nothing in non-desktop environment', () => {
    const { container } = render(<UpdateCard />)
    expect(container.innerHTML).toBe('')
  })

  it('shows update prompt with current and latest version in desktop', async () => {
    setElectronAPI()
    render(<UpdateCard />)
    await waitFor(() => expect(screen.getByText(/发现新版本 v1\.2\.0/)).toBeInTheDocument())
    expect(screen.getByText(/当前 1\.1\.0/)).toBeInTheDocument()
  })

  it('shows checking-in-progress state', async () => {
    updaterState = makeState({ hasUpdate: false, latest: 'v1.1.0', checking: true })
    setElectronAPI()
    render(<UpdateCard />)
    await waitFor(() => expect(screen.getByText(/正在检查最新版本/)).toBeInTheDocument())
  })

  it('shows latest-version state when no update', async () => {
    updaterState = makeState({ hasUpdate: false, latest: 'v1.1.0' })
    setElectronAPI()
    render(<UpdateCard />)
    await waitFor(() => expect(screen.getByText(/已是最新版本/)).toBeInTheDocument())
  })

  it('triggers download on button click and progresses to install', async () => {
    updaterState = makeState()
    setElectronAPI()
    render(<UpdateCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: /点击下载更新/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /点击下载更新/ }))
    await waitFor(() => expect((window as any).electronAPI.downloadUpdate).toHaveBeenCalled())
  })
})
