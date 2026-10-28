import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ConfirmDialog from './ConfirmDialog'

describe('ConfirmDialog', () => {
  it('renders into document.body, not the calling subtree', () => {
    // 回归：祖先节点带 backdrop-filter 时会成为 fixed 定位的 containing block，
    // 遮罩会缩进该容器内而不是铺满视口。portal 到 body 才能摆脱它。
    const { container } = render(
      <div className="backdrop-blur-md">
        <ConfirmDialog open title="删除这条投递记录？" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </div>,
    )

    const blurred = container.querySelector('.backdrop-blur-md')
    expect(blurred).not.toBeNull()
    expect(blurred?.contains(screen.getByRole('dialog'))).toBe(false)
    expect(document.body.contains(screen.getByRole('dialog'))).toBe(true)
  })

  it('renders nothing while closed', () => {
    render(<ConfirmDialog open={false} title="标题" onConfirm={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
