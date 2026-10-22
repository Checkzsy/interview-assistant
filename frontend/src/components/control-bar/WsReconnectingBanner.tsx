import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import ConfirmDialog from '@/components/common/ConfirmDialog'

export function WsReconnectingBanner() {
  const [elapsed, setElapsed] = useState(0)
  const [confirmReload, setConfirmReload] = useState(false)

  useEffect(() => {
    const start = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])

  const allowReload = elapsed >= 10
  const handleReload = () => {
    // 刷新会丢掉当前转录，先弹统一确认框，确认后再真的 reload。
    setConfirmReload(true)
  }

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-xs text-accent-amber bg-accent-amber/10 px-3 py-1.5 rounded-lg"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
        <span>
          连接已断开 ({elapsed}s), 正在自动重连…
        </span>
        {allowReload && (
          <button
            type="button"
            onClick={handleReload}
            className="ml-auto text-accent-blue hover:underline font-medium"
            title="长时间未恢复时,手动刷新页面 (会丢失当前对话)"
          >
            手动刷新
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmReload}
        tone="danger"
        title="刷新页面？"
        description="刷新会丢失当前转录与未保存的对话。"
        confirmLabel="刷新"
        cancelLabel="继续等待重连"
        onCancel={() => setConfirmReload(false)}
        onConfirm={() => {
          setConfirmReload(false)
          window.location.reload()
        }}
      />
    </>
  )
}
