import { requestTakeover } from '@/lib/wsLeader'
import type { ToastItem } from '@/stores/configStore'

interface AppToastStackProps {
  wsIsLeader: boolean
  fallbackToast: { from: string; to: string; reason: string } | null
  toasts: ToastItem[]
  dismissToast: (id: string) => void
}

export function AppToastStack({
  wsIsLeader,
  fallbackToast,
  toasts,
  dismissToast,
}: AppToastStackProps) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col-reverse gap-2 items-center">
      {!wsIsLeader && (
        <div className="animate-toast-in">
          <div className="glass border border-accent-amber/40 text-text-primary text-xs px-4 py-2.5 rounded-2xl shadow-2xl shadow-black/30 flex items-center gap-3 backdrop-blur-xl">
            <span className="text-accent-amber font-semibold">⏸</span>
            <span>本标签处于备用状态(其他标签正在连接后端)</span>
            <button
              type="button"
              onClick={requestTakeover}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-accent-amber/20 hover:bg-accent-amber/30 text-accent-amber transition-all duration-150 active:scale-95"
            >
              在此页接管
            </button>
          </div>
        </div>
      )}
      {fallbackToast && (
        <div className="animate-toast-in" role="alert" aria-live="assertive">
          <div className="glass border border-accent-amber/40 text-text-primary text-xs px-4 py-2.5 rounded-2xl shadow-2xl shadow-black/30 backdrop-blur-xl">
            <span className="text-accent-amber font-semibold" aria-hidden>⚠</span>&nbsp; {fallbackToast.from} 不可用，切换到 {fallbackToast.to}
          </div>
        </div>
      )}
      {toasts.map((toast) => {
        const cls = {
          info: 'border-bg-hover/60',
          success: 'border-accent-green/50',
          warn: 'border-accent-amber/50',
          error: 'border-accent-red/60',
        }[toast.level]
        const icon = { info: 'ℹ', success: '✓', warn: '⚠', error: '✕' }[toast.level]
        const iconCls = {
          info: 'text-text-muted',
          success: 'text-accent-green',
          warn: 'text-accent-amber',
          error: 'text-accent-red',
        }[toast.level]
        const role = toast.level === 'error' || toast.level === 'warn' ? 'alert' : 'status'
        const live = toast.level === 'error' ? 'assertive' : 'polite'
        return (
          <div key={toast.id} className="animate-toast-in" role={role} aria-live={live}>
            <div
              className={`glass border ${cls} text-text-primary text-xs pl-3.5 pr-2.5 py-2.5 rounded-2xl shadow-2xl shadow-black/30 backdrop-blur-xl font-medium flex items-center gap-2.5 max-w-[90vw] transition-all`}
            >
              <span className={`font-semibold ${iconCls}`} aria-hidden>{icon}</span>
              <span className="truncate">{toast.message}</span>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                aria-label="关闭提示"
                className="ml-1 w-5 h-5 shrink-0 inline-flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover/70 transition-all duration-150 active:scale-90"
              >
                ×
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
