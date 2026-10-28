import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'

export type ConfirmDialogTone = 'default' | 'danger'

type Props = {
  /** 是否显示。 */
  open: boolean
  title: string
  /** 一句话说明；也可以传 children 放更丰富的内容。 */
  description?: string
  children?: React.ReactNode
  /** 确认按钮文案。 */
  confirmLabel?: string
  cancelLabel?: string
  /** danger 用 accent-red，default 用 accent-blue。 */
  tone?: ConfirmDialogTone
  /** 请求进行中：禁用关闭与重复点击。 */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 统一的二次确认弹窗。
 *
 * 视觉与 OfferEditModal / DeleteReviewDialog 对齐：共用同一套遮罩、圆角面板、
 * 分隔线头部与底部操作条，避免各处再退化成浏览器原生 confirm。
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // 焦点默认落在「取消」：破坏性操作不应让回车误触发。
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onCancel])

  if (!open) return null

  const isDanger = tone === 'danger'
  const iconWrap = isDanger
    ? 'border-accent-red/30 bg-accent-red/10 text-accent-red'
    : 'border-accent-blue/30 bg-accent-blue/10 text-accent-blue'
  const confirmClass = isDanger
    ? 'bg-accent-red text-white'
    : 'bg-accent-blue text-white'

  // 必须 portal 到 body：任何祖先带 backdrop-filter（如看板根节点的 backdrop-blur）
  // 都会成为 fixed 定位的 containing block，遮罩会缩到该容器内而不是铺满视口。
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-fade-in"
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={description ? 'confirm-dialog-desc' : undefined}
        className="animate-modal-pop-in w-full max-w-md overflow-hidden rounded-2xl border border-bg-hover/80 bg-bg-secondary/95 shadow-2xl shadow-black/40 backdrop-blur-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-bg-hover px-5 py-4">
          <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${iconWrap}`}>
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id="confirm-dialog-title" className="text-sm font-bold text-text-primary">
              {title}
            </h2>
            {description ? (
              <p id="confirm-dialog-desc" className="mt-0.5 text-xs text-text-muted">
                {description}
              </p>
            ) : null}
          </div>
        </div>

        {children ? <div className="px-5 py-4 text-xs text-text-secondary">{children}</div> : null}

        <div className="flex items-center justify-end gap-2 border-t border-bg-hover bg-bg-tertiary/20 px-5 py-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-xl border border-bg-hover px-4 py-2 text-xs hover:bg-bg-tertiary disabled:opacity-50 transition-all duration-150 active:scale-[0.97]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-medium disabled:opacity-50 transition-all duration-150 active:scale-[0.97] shadow-sm ${confirmClass}`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
