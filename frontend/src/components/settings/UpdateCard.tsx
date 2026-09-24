import { useEffect, useState } from 'react'
import { RefreshCw, Download, PackageCheck, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'

const IDLE_STATE: UpdaterState = {
  current: null,
  latest: null,
  hasUpdate: false,
  asset: null,
  releaseName: null,
  publishedAt: null,
  checking: false,
  checkError: null,
  download: { status: 'idle', received: 0, total: 0, error: null, downloadedPath: null },
  installing: false,
  installError: null,
}

function formatBytes(n: number | null | undefined): string {
  const num = Number(n) || 0
  if (num <= 0) return '—'
  if (num < 1024) return `${num} B`
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`
  return `${(num / 1024 / 1024).toFixed(1)} MB`
}

function formatProgress(state: UpdaterState): string {
  const { received, total } = state.download
  if (!total) return `${formatBytes(received)}`
  const pct = Math.min(100, Math.round((received / total) * 100))
  return `${formatBytes(received)} / ${formatBytes(total)}（${pct}%）`
}

export default function UpdateCard() {
  const [state, setState] = useState<UpdaterState>(IDLE_STATE)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.getUpdaterState || !api?.onUpdaterState) return
    const unsub = api.onUpdaterState((s) => setState(s))
    api.getUpdaterState().then((s) => setState(s)).catch(() => {})
    return unsub
  }, [])

  if (!window.electronAPI?.getUpdaterState) return null

  const busy = state.checking || state.download.status === 'downloading' || state.installing
  const hasUpdate = state.hasUpdate && !!state.asset && !state.installError
  const downloadDone = state.download.status === 'done'

  const handleCheck = () => {
    window.electronAPI?.checkForUpdate?.().then(setState).catch(() => {})
  }
  const handleDownload = () => {
    window.electronAPI?.downloadUpdate?.().then(setState).catch(() => {})
  }
  const handleInstall = async () => {
    const result = await window.electronAPI?.installUpdate?.()
    if (result && !result.ok && result.error) {
      setState((prev) => ({ ...prev, installError: result.error ?? '启动安装器失败' }))
    }
  }

  return (
    <section className="rounded-xl border border-bg-hover/60 bg-bg-primary/35 overflow-hidden" data-search-title="检查更新">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-bg-hover/50">
        <PackageCheck className="w-3.5 h-3.5 text-accent-blue" />
        <h3 className="text-sm font-semibold text-text-primary">检查更新</h3>
        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          className="ml-auto text-[11px] text-text-muted hover:text-text-primary"
        >
          {detailsOpen ? '收起' : '详情'}
        </button>
      </div>
      <div className="px-4 py-4 space-y-3">
        {hasUpdate ? (
          <div className="rounded-lg border border-accent-blue/25 bg-accent-blue/5 px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-accent-amber text-xs font-semibold">发现新版本 {state.latest}</span>
              <span className="text-[11px] text-text-muted">当前 {state.current}</span>
            </div>
            {state.download.status !== 'done' ? (
              <button
                type="button"
                disabled={busy}
                onClick={handleDownload}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-blue px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {state.download.status === 'downloading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                {state.download.status === 'downloading' ? `下载中 ${formatProgress(state)}` : '点击下载更新'}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={handleInstall}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-green px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {state.installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {state.installing ? '正在启动安装…' : '下载完成，静默安装并重启'}
              </button>
            )}
            {state.download.status === 'error' && (
              <p className="text-[11px] text-accent-red">{state.download.error}</p>
            )}
            {state.installError && <p className="text-[11px] text-accent-red">{state.installError}</p>}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-text-muted">
              {state.checking ? '正在检查最新版本…' : state.checkError ? `检查失败：${state.checkError}` : `已是最新版本（v${state.current ?? '—'}）`}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={handleCheck}
              className="inline-flex items-center gap-1.5 rounded-lg border border-bg-hover bg-bg-tertiary/40 px-3 py-1.5 text-xs text-text-primary transition hover:bg-bg-tertiary/70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              检查更新
            </button>
          </div>
        )}

        {detailsOpen && state.asset && (
          <div className="rounded-lg bg-bg-tertiary/40 border border-bg-hover/50 px-3 py-2 text-[11px] text-text-muted space-y-1">
            <p>发布内容：{state.releaseName ?? '—'}</p>
            <p>文件：{state.asset.name}（{formatBytes(state.asset.size)}）</p>
            {state.publishedAt && <p>发布于：{state.publishedAt}</p>}
            <p className="text-text-secondary">安装包下载完成前不会启用安装按钮；安装使用静默模式，完成后自动退出并重启应用。</p>
          </div>
        )}
      </div>
    </section>
  )
}
