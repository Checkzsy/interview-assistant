import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MockInterview from './MockInterview'

const apiMock = vi.hoisted(() => ({
  mockInterviewCreateSession: vi.fn(),
  mockInterviewGenerateQuestion: vi.fn(),
  mockInterviewSubmitAnswer: vi.fn(),
  mockInterviewGenerateFeedback: vi.fn(),
  mockInterviewFinishSession: vi.fn(),
  mockInterviewGenerateReport: vi.fn(),
  mockInterviewSessions: vi.fn(),
  mockInterviewSession: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: apiMock,
  getErrorMessage: (error: unknown, fallback = '操作失败') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

beforeEach(() => {
  apiMock.mockInterviewSessions.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 20,
  })
})

describe('MockInterview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.mockInterviewCreateSession.mockResolvedValue({
      id: 7,
      status: 'created',
      company: 'ACME',
      role: '后端开发',
      language: '中文',
      planned_question_count: 1,
      question_count: 0,
      answered_question_count: 0,
      reviewed_question_count: 0,
      average_score: null,
    })
    apiMock.mockInterviewGenerateQuestion.mockResolvedValue({
      id: 11,
      session_id: 7,
      seq: 1,
      question_text: '请介绍你在 FastAPI 项目中做过的一次接口性能优化。',
      question_type: 'project',
      status: 'waiting_answer',
      skill_tags: ['FastAPI', '性能优化'],
    })
    apiMock.mockInterviewSubmitAnswer.mockResolvedValue({
      id: 11,
      status: 'answered',
      answer_text: '我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。',
    })
    apiMock.mockInterviewGenerateFeedback.mockResolvedValue({
      id: 11,
      status: 'reviewed',
      overall_score: 8,
      feedback: {
        overall_score: 8,
        dimensions: [
          { name: '事实正确性', score: 8, comment: '技术描述基本正确' },
          { name: '表达结构', score: 7, comment: '缺少背景与结果衔接' },
        ],
        strengths: ['量化了性能收益'],
        improvements: ['补充排查过程和取舍'],
        evidence: ['P95 延迟从 800ms 降到 120ms'],
        reference_answer: '建议按背景-做法-结果-取舍结构回答。',
      },
    })
    apiMock.mockInterviewFinishSession.mockResolvedValue({ ok: true, status: 'completed' })
    apiMock.mockInterviewGenerateReport.mockResolvedValue({
      id: 7,
      status: 'completed',
      report_markdown: '## 整场总结\n基础概念覆盖较好，但需要补足持久化取舍。',
      report_strengths: ['基础概念覆盖较好'],
      report_weaknesses: ['持久化取舍表达不足'],
      report_focus_areas: ['Redis 持久化与恢复', '缓存场景取舍'],
      report_generated_at: 1234567890,
    })
  })

  it('runs the text mock-interview flow from setup to completion', async () => {
    render(<MockInterview />)

    fireEvent.change(screen.getByLabelText('公司'), { target: { value: 'ACME' } })
    fireEvent.change(screen.getByLabelText('岗位'), { target: { value: '后端开发' } })
    fireEvent.change(screen.getByLabelText('岗位描述'), {
      target: { value: '负责高并发服务，熟悉 Redis 和 FastAPI。' },
    })
    fireEvent.change(screen.getByLabelText('简历快照'), {
      target: { value: '做过订单查询接口优化，P95 从 800ms 降到 120ms。' },
    })
    fireEvent.change(screen.getByLabelText('计划题数'), { target: { value: '1' } })

    fireEvent.click(screen.getByRole('button', { name: '开始模拟面试' }))

    await waitFor(() =>
      expect(apiMock.mockInterviewCreateSession).toHaveBeenCalledWith({
        company: 'ACME',
        role: '后端开发',
        language: '中文',
        jd_snapshot: '负责高并发服务，熟悉 Redis 和 FastAPI。',
        resume_snapshot: '做过订单查询接口优化，P95 从 800ms 降到 120ms。',
        planned_question_count: 1,
      }),
    )
    await waitFor(() => expect(screen.getByText('会话已创建')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '生成下一题' }))
    await waitFor(() =>
      expect(screen.getByText('请介绍你在 FastAPI 项目中做过的一次接口性能优化。')).toBeInTheDocument(),
    )
    expect(apiMock.mockInterviewGenerateQuestion).toHaveBeenCalledWith(7)
    expect(screen.getByText('FastAPI')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('你的回答'), {
      target: { value: '我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    await waitFor(() =>
      expect(apiMock.mockInterviewSubmitAnswer).toHaveBeenCalledWith(
        11,
        '我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。',
      ),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '生成点评' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: '生成点评' }))
    await waitFor(() => expect(screen.getByText('事实正确性')).toBeInTheDocument())
    expect(apiMock.mockInterviewGenerateFeedback).toHaveBeenCalledWith(11)
    expect(screen.getByLabelText('总体评分')).toHaveTextContent('8 分')
    expect(screen.getByText('AI 点评仅供参考，请结合岗位事实自行核对。')).toBeInTheDocument()
    expect(screen.getAllByText(/P95 延迟从 800ms 降到 120ms/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/补充排查过程和取舍/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '完成面试' }))
    await waitFor(() => expect(apiMock.mockInterviewFinishSession).toHaveBeenCalledWith(7))
    await waitFor(() => expect(screen.getByText('面试已完成')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '生成整场报告' }))
    await waitFor(() => expect(apiMock.mockInterviewGenerateReport).toHaveBeenCalledWith(7))
    await waitFor(() => expect(screen.getByText('整场报告')).toBeInTheDocument())
    expect(screen.getAllByText(/基础概念覆盖较好/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/持久化取舍表达不足/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Redis 持久化与恢复/).length).toBeGreaterThan(0)
  })

  it('shows an actionable create error and keeps the form ready for retry', async () => {
    render(<MockInterview />)

    fireEvent.change(screen.getByLabelText('岗位'), { target: { value: '后端开发' } })
    apiMock.mockInterviewCreateSession.mockRejectedValueOnce(new Error('模型未配置有效 API Key'))
    fireEvent.click(screen.getByRole('button', { name: '开始模拟面试' }))

    await waitFor(() => expect(screen.getByText('模型未配置有效 API Key')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '开始模拟面试' })).toBeInTheDocument()
  })
})


describe('MockInterview action boundaries', () => {
  it('disables interview actions until prerequisites are met', () => {
    render(<MockInterview />)

    expect(screen.getByRole('button', { name: '开始模拟面试' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '生成下一题' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '完成面试' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '生成整场报告' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('岗位'), { target: { value: '后端开发' } })
    expect(screen.getByRole('button', { name: '开始模拟面试' })).toBeEnabled()
  })
})







describe('MockInterview planned question boundaries', () => {
  it('allows finishing only after all planned questions are reviewed', async () => {
    apiMock.mockInterviewCreateSession.mockResolvedValue({
      id: 8,
      status: 'created',
      company: 'ACME',
      role: '后端开发',
      language: '中文',
      planned_question_count: 2,
      question_count: 0,
      answered_question_count: 0,
      reviewed_question_count: 0,
      average_score: null,
    })
    apiMock.mockInterviewGenerateQuestion
      .mockResolvedValueOnce({
        id: 21,
        session_id: 8,
        seq: 1,
        question_text: 'Redis 持久化有哪些方式？',
        question_type: 'technical',
        status: 'waiting_answer',
        skill_tags: ['Redis'],
      })
      .mockResolvedValue({
        id: 22,
        session_id: 8,
        seq: 2,
        question_text: '缓存穿透如何处理？',
        question_type: 'technical',
        status: 'waiting_answer',
        skill_tags: ['缓存'],
      })
    apiMock.mockInterviewSubmitAnswer
      .mockResolvedValueOnce({ id: 21, status: 'answered', answer_text: 'RDB 和 AOF。' })
      .mockResolvedValue({ id: 22, status: 'answered', answer_text: '布隆过滤器和空值缓存。' })
    apiMock.mockInterviewGenerateFeedback
      .mockResolvedValueOnce({
        id: 21,
        status: 'reviewed',
        overall_score: 7,
        feedback: {
          overall_score: 7,
          dimensions: [{ name: '事实正确性', score: 7, comment: '答到两类方式' }],
          strengths: [],
          improvements: [],
          evidence: [],
          reference_answer: '',
        },
      })
      .mockResolvedValue({
        id: 22,
        status: 'reviewed',
        overall_score: 8,
        feedback: {
          overall_score: 8,
          dimensions: [{ name: '事实正确性', score: 8, comment: '方案正确' }],
          strengths: [],
          improvements: [],
          evidence: [],
          reference_answer: '',
        },
      })
    apiMock.mockInterviewFinishSession.mockResolvedValue({ ok: true, status: 'completed' })

    render(<MockInterview />)
    fireEvent.change(screen.getByLabelText('岗位'), { target: { value: '后端开发' } })
    fireEvent.change(screen.getByLabelText('计划题数'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '开始模拟面试' }))
    await waitFor(() => expect(screen.getByText('会话已创建')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '生成下一题' }))
    await waitFor(() => expect(screen.getByText('Redis 持久化有哪些方式？')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('你的回答'), { target: { value: 'RDB 和 AOF。' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '生成点评' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '生成点评' }))
    await waitFor(() => expect(screen.getByText('事实正确性')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: '完成面试' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '生成下一题' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '生成下一题' }))
    await waitFor(() => expect(screen.getByText('缓存穿透如何处理？')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('你的回答'), { target: { value: '布隆过滤器和空值缓存。' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '生成点评' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '生成点评' }))
    await waitFor(() => expect(screen.getByText('方案正确')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: '完成面试' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '完成面试' }))
    await waitFor(() => expect(apiMock.mockInterviewFinishSession).toHaveBeenCalledWith(8))
  })
})



describe('MockInterview session history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads sessions and restores an in-progress question with its answer', async () => {
    apiMock.mockInterviewSessions.mockResolvedValue({
      items: [
        {
          id: 9,
          status: 'in_progress',
          company: 'ACME',
          role: '后端开发',
          language: '中文',
          planned_question_count: 1,
          question_count: 1,
          answered_question_count: 1,
          reviewed_question_count: 0,
          average_score: null,
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
    })
    apiMock.mockInterviewSession.mockResolvedValue({
      id: 9,
      status: 'in_progress',
      company: 'ACME',
      role: '后端开发',
      language: '中文',
      jd_snapshot: '负责高并发服务',
      resume_snapshot: '做过订单查询优化',
      planned_question_count: 1,
      question_count: 1,
      answered_question_count: 1,
      reviewed_question_count: 0,
      average_score: null,
      questions: [
        {
          id: 31,
          session_id: 9,
          seq: 1,
          question_text: '请介绍你在 FastAPI 项目中做过的一次接口性能优化。',
          question_type: 'project',
          status: 'answered',
          skill_tags: ['FastAPI'],
          answer_text: '我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。',
          overall_score: null,
          feedback: null,
        },
      ],
    })

    render(<MockInterview />)

    const resumeButton = await screen.findByRole('button', { name: /恢复 ACME 后端开发会话/ })
    fireEvent.click(resumeButton)

    await waitFor(() => expect(apiMock.mockInterviewSessions).toHaveBeenCalled())
    await waitFor(() => expect(apiMock.mockInterviewSession).toHaveBeenCalledWith(9))
    await waitFor(() =>
      expect(screen.getByText('请介绍你在 FastAPI 项目中做过的一次接口性能优化。')).toBeInTheDocument(),
    )
    expect(screen.getByLabelText('你的回答')).toHaveValue(
      '我用 Redis 缓存热点查询，并将 P95 延迟从 800ms 降到 120ms。',
    )
    expect(screen.getByText('已恢复会话')).toBeInTheDocument()
  })
})
