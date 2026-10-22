import dayjs from 'dayjs'
import ConfirmDialog from '../common/ConfirmDialog'
import type { ReviewSession } from './types'

type Props = {
  /** 待删除的复盘；为 null 时不渲染。 */
  session: ReviewSession | null
  /** 删除请求进行中：禁用关闭与重复点击。 */
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 复盘删除确认弹窗。
 *
 * 只负责组装「删什么」的内容，外壳统一走 ConfirmDialog，
 * 保证和清空内容、结束面试等确认框是同一套视觉。
 */
export default function DeleteReviewDialog({ session, deleting, onCancel, onConfirm }: Props) {
  if (!session) return null

  const title = session.title || session.company || '未命名复盘'
  const roleText = session.role || '岗位未填写'
  const timeText = dayjs.unix(Math.floor(session.started_at)).format('YYYY-MM-DD HH:mm')
  const linkedApplication = session.application

  return (
    <ConfirmDialog
      open
      tone="danger"
      title="删除这条复盘？"
      description="删除后无法恢复，请确认下面的内容。"
      confirmLabel="删除"
      busy={deleting}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-bg-hover bg-bg-tertiary/20 px-3.5 py-3">
          <div className="truncate text-sm font-semibold text-text-primary" title={title}>
            {title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-text-muted">
            <span>{roleText}</span>
            <span>{timeText}</span>
            <span>{session.turn_count} 条问答</span>
            {session.avg_score != null ? <span>{session.avg_score.toFixed(1)} 分</span> : null}
          </div>
          {linkedApplication ? (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-bg-hover bg-bg-primary/40 px-2 py-1 text-[11px] text-text-secondary">
              <span className="text-text-muted">关联岗位</span>
              <span className="font-medium text-text-primary">
                {linkedApplication.company || '未命名公司'} · {linkedApplication.position || '岗位'}
              </span>
            </div>
          ) : null}
        </div>

        <ul className="space-y-1.5 text-xs leading-relaxed text-text-secondary">
          <li className="flex gap-2">
            <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent-red" />
            <span>该复盘的 {session.turn_count} 条问答记录与逐题分析会一并删除。</span>
          </li>
          {linkedApplication ? (
            <li className="flex gap-2">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent-red" />
              <span>同步到该岗位的复盘待办会一并移除，你手动添加的待办不受影响。</span>
            </li>
          ) : null}
        </ul>
      </div>
    </ConfirmDialog>
  )
}
