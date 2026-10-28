import ConfirmDialog from '@/components/common/ConfirmDialog'
import type { Application } from './types'

type Props = {
  /** 待删除的投递；null 表示不显示。 */
  target: Application | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 投递记录的删除二次确认。
 *
 * 进度表与管道看板共用：两处的文案、级联删除警告与公司/岗位预览必须一致，
 * 否则改一处会漏另一处。
 */
export default function DeleteApplicationDialog({ target, onCancel, onConfirm }: Props) {
  return (
    <ConfirmDialog
      open={target != null}
      tone="danger"
      title="删除这条投递记录？"
      description="与该岗位关联的复盘、待办和 Offer 数据也会一并移除。"
      confirmLabel="删除"
      cancelLabel="取消"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {target ? (
        <div className="rounded-lg border border-bg-hover bg-bg-tertiary/20 px-3 py-2">
          <div className="text-sm font-semibold text-text-primary">
            {target.company || '未命名公司'}
          </div>
          <div className="mt-0.5 text-xs text-text-muted">
            {target.position || '岗位未填写'}
          </div>
        </div>
      ) : null}
    </ConfirmDialog>
  )
}
