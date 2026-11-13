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

describe('UpdateCard install mode', () => {
  const originalElectronAPI = window.electronAPI

  beforeEach(() => {
    delete (window as any).electronAPI
    localStorage.clear()
  })
  afterEach(() => {
    if (originalElectronAPI) (window as any).electronAPI = originalElectronAPI
    else delete (window as any).electronAPI
    localStorage.clear()
  })

  const setElectronAPI = () => {
    const state = makeState({
      download: { status: 'done', received: 1024, total: 1024, error: null, downloadedPath: 'C:/x.exe' },
    })
    const api = {
      getUpdaterState: vi.fn(async () => state),
      checkForUpdate: vi.fn(async () => state),
      downloadUpdate: vi.fn(async () => state),
      installUpdate: vi.fn(async () => ({ ok: true })),
      onUpdaterState: () => () => {},
    }
    ;(window as any).electronAPI = api
    return api
  }

  it('defaults to silent in-place upgrade', async () => {
    const api = setElectronAPI()
    render(<UpdateCard />)
    const btn = await screen.findByRole('button', { name: /静默安装并重启/ })
    fireEvent.click(btn)
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledWith({ silent: true }))
  })

  it('switches to the guided installer when silent install is turned off', async () => {
    const api = setElectronAPI()
    render(<UpdateCard />)
    const toggle = await screen.findByRole('switch', { name: /静默安装/ })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))

    const btn = await screen.findByRole('button', { name: /打开安装向导/ })
    fireEvent.click(btn)
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledWith({ silent: false }))
    // 开关本机持久化，重启应用后仍生效。
    expect(localStorage.getItem('ia_update_silent_install')).toBe('0')
  })

  it('remembers a previously disabled silent toggle across mounts', async () => {
    localStorage.setItem('ia_update_silent_install', '0')
    setElectronAPI()
    render(<UpdateCard />)
    const toggle = await screen.findByRole('switch', { name: /静默安装/ })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await screen.findByRole('button', { name: /打开安装向导/ })
  })
})
