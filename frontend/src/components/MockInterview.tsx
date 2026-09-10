import { useEffect, useState } from 'react'
import {
  api,
  getErrorMessage,
  type MockInterviewQuestion,
  type MockInterviewSession,
} from '@/lib/api'

export default function MockInterview() {
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('')
  const [language, setLanguage] = useState('中文')
  const [jdSnapshot, setJdSnapshot] = useState('')
  const [resumeSnapshot, setResumeSnapshot] = useState('')
  const [plannedCount, setPlannedCount] = useState(5)

  const [session, setSession] = useState<MockInterviewSession | null>(null)
  const [question, setQuestion] = useState<MockInterviewQuestion | null>(null)
  const [answer, setAnswer] = useState('')
  const [statusText, setStatusText] = useState('填写岗位信息后开始模拟面试')
  const [error, setError] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [creatingPractice, setCreatingPractice] = useState(false)
  const [sessions, setSessions] = useState<MockInterviewSession[]>([])
  const [resumingSessionId, setResumingSessionId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    api.mockInterviewSessions()
      .then((res) => {
        if (!cancelled) setSessions(res.items)
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err, '加载历史会话失败'))
      })
    return () => {
      cancelled = true
    }
  }, [])
  const plannedQuestionCount = session?.planned_question_count ?? 0

  const canGenerate =
    Boolean(session) &&
    session?.status !== 'completed' &&
    (!question || question.status === 'reviewed') &&
    (question?.seq ?? 0) < plannedQuestionCount
  const canSubmit = Boolean(question && question.status === 'waiting_answer' && answer.trim())
  const canReview = Boolean(question && question.status === 'answered')
  const canFinish = Boolean(
    session &&
    session.status !== 'completed' &&
    question?.status === 'reviewed' &&
    question?.seq === plannedQuestionCount,
  )
  const canGenerateReport = Boolean(session && session.status === 'completed')
  const sessionTransitionBusy = Boolean(
    creating || finishing || reporting || creatingPractice || resumingSessionId !== null,
  )
  const canCreatePractice = Boolean(
    session?.status === 'completed' && (session.report_focus_areas ?? []).length > 0,
  )

  const handleResumeSession = async (sessionId: number) => {
    if (resumingSessionId !== null) return
    setResumingSessionId(sessionId)
    setError(null)
    try {
      const detail = await api.mockInterviewSession(sessionId)
      setSession(detail)
      setCompany(detail.company)
      setRole(detail.role)
      setLanguage(detail.language)
      setJdSnapshot(detail.jd_snapshot ?? '')
      setResumeSnapshot(detail.resume_snapshot ?? '')
      setPlannedCount(detail.planned_question_count)

      const questions = detail.questions ?? []
      const currentQuestion =
        questions.find((item) => item.status === 'waiting_answer' || item.status === 'answered')
        ?? questions[questions.length - 1]
        ?? null
      setQuestion(currentQuestion)
      setAnswer(currentQuestion?.answer_text ?? '')
      setStatusText('已恢复会话')
    } catch (err) {
      setError(getErrorMessage(err, '恢复会话失败'))
    } finally {
      setResumingSessionId(null)
    }
  }
  const handleCreate = async () => {
    if (!role.trim() || creating) return
    setCreating(true)
    setError(null)
    try {
      const created = await api.mockInterviewCreateSession({
        company: company.trim(),
        role: role.trim(),
        language: language.trim() || '中文',
        jd_snapshot: jdSnapshot.trim(),
        resume_snapshot: resumeSnapshot.trim(),
        planned_question_count: Math.max(1, Math.min(50, Number(plannedCount) || 5)),
      })
      setSession(created)
      setQuestion(null)
      setAnswer('')
      setStatusText('会话已创建')
    } catch (err) {
      setError(getErrorMessage(err, '创建模拟面试会话失败'))
    } finally {
      setCreating(false)
    }
  }

  const handleGenerateQuestion = async () => {
    if (!session || !canGenerate || generating) return
    setGenerating(true)
    setError(null)
    try {
      const nextQuestion = await api.mockInterviewGenerateQuestion(session.id)
      setQuestion(nextQuestion)
      setAnswer('')
      setStatusText(`第 ${nextQuestion.seq} 题已生成`)
    } catch (err) {
      setError(getErrorMessage(err, '生成面试题失败'))
    } finally {
      setGenerating(false)
    }
  }

  const handleSubmitAnswer = async () => {
    if (!question || !canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const updated = await api.mockInterviewSubmitAnswer(question.id, answer.trim())
      setQuestion((prev) => (prev ? { ...prev, ...updated } : updated))
      setStatusText('回答已提交，可以生成点评')
    } catch (err) {
      setError(getErrorMessage(err, '提交回答失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleGenerateFeedback = async () => {
    if (!question || !canReview || reviewing) return
    setReviewing(true)
    setError(null)
    try {
      const reviewed = await api.mockInterviewGenerateFeedback(question.id)
      setQuestion((prev) => (prev ? { ...prev, ...reviewed } : reviewed))
      setStatusText('点评已生成')
    } catch (err) {
      setError(getErrorMessage(err, '生成点评失败'))
    } finally {
      setReviewing(false)
    }
  }

  const handleFinish = async () => {
    if (!session || !canFinish || finishing) return
    setFinishing(true)
    setError(null)
    try {
      await api.mockInterviewFinishSession(session.id)
      setSession((prev) => (prev ? { ...prev, status: 'completed' } : prev))
      setStatusText('面试已完成')
    } catch (err) {
      setError(getErrorMessage(err, '完成面试失败'))
    } finally {
      setFinishing(false)
    }
  }


  const handleGenerateReport = async () => {
    if (!session || !canGenerateReport || reporting) return
    setReporting(true)
    setError(null)
    try {
      const reported = await api.mockInterviewGenerateReport(session.id)
      setSession(reported)
      setStatusText('整场报告已生成')
    } catch (err) {
      setError(getErrorMessage(err, '生成整场报告失败'))
    } finally {
      setReporting(false)
    }
  }

  const handleCreatePracticeSession = async () => {
    if (!session || !canCreatePractice || creatingPractice) return
    setCreatingPractice(true)
    setError(null)
    try {
      const practice = await api.mockInterviewCreatePracticeSession(session.id)
      setSession(practice)
      setQuestion(null)
      setAnswer('')
      setSessions((prev) => [practice, ...prev])
      setStatusText('弱项复练会话已创建')
    } catch (err) {
      setError(getErrorMessage(err, '创建弱项复练会话失败'))
    } finally {
      setCreatingPractice(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-bg-primary">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-text-primary">模拟面试</h1>
          <p className="mt-1 text-sm text-text-muted">
            基于岗位描述和简历快照进行文字练习，点评会标注回答中的证据与改进方向。
          </p>
        </header>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red"
          >
            {error}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <section className="rounded-2xl border border-bg-hover bg-bg-secondary p-4">
            <h2 className="mb-4 text-sm font-semibold text-text-primary">面试设置</h2>
            <div className="space-y-4">
              <div>
                <label htmlFor="mock-company" className="mb-1 block text-xs text-text-muted">公司</label>
                <input
                  id="mock-company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="可留空"
                  className="w-full rounded-lg border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue/60"
                />
              </div>
              <div>
                <label htmlFor="mock-role" className="mb-1 block text-xs text-text-muted">岗位</label>
                <input
                  id="mock-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="例如：后端开发"
                  className="w-full rounded-lg border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue/60"
                />
              </div>
              <div>
                <label htmlFor="mock-language" className="mb-1 block text-xs text-text-muted">语言</label>
                <input
                  id="mock-language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full rounded-lg border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue/60"
                />
              </div>
              <div>
                <label htmlFor="mock-jd" className="mb-1 block text-xs text-text-muted">岗位描述</label>
                <textarea
                  id="mock-jd"
                  value={jdSnapshot}
                  onChange={(e) => setJdSnapshot(e.target.value)}
                  rows={4}
                  placeholder="粘贴 JD，本场会话将使用该快照"
                  className="w-full resize-y rounded-lg border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue/60"
                />
              </div>
              <div>
                <label htmlFor="mock-resume" className="mb-1 block text-xs text-text-muted">简历快照</label>
                <textarea
                  id="mock-resume"
                  value={resumeSnapshot}
                  onChange={(e) => setResumeSnapshot(e.target.value)}
                  rows={5}
                  placeholder="粘贴与本次面试相关的经历，避免提交无关隐私"
                  className="w-full resize-y rounded-lg border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue/60"
                />
              </div>
              <div>
                <label htmlFor="mock-count" className="mb-1 block text-xs text-text-muted">计划题数</label>
                <input
                  id="mock-count"
                  type="number"
                  min={1}
                  max={50}
                  value={plannedCount}
                  onChange={(e) => setPlannedCount(Number(e.target.value))}
                  className="w-full rounded-lg border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue/60"
                />
              </div>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!role.trim() || sessionTransitionBusy}
                className="w-full min-h-[44px] rounded-xl bg-accent-blue text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? '创建中…' : '开始模拟面试'}
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-bg-hover bg-bg-secondary p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">历史会话</h2>
            {sessions.length === 0 ? (
              <p className="text-xs text-text-muted">暂无历史会话</p>
            ) : (
              <ul className="space-y-2">
                {sessions.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-label={`恢复 ${item.company || '未命名公司'} ${item.role}会话`}
                      onClick={() => handleResumeSession(item.id)}
                      disabled={resumingSessionId !== null}
                      className="w-full rounded-xl border border-bg-hover bg-bg-tertiary px-3 py-2 text-left transition hover:border-accent-blue/40 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="block truncate text-xs font-medium text-text-primary">
                        {item.company || '未命名公司'} · {item.role}
                      </span>
                      <span className="mt-1 block text-[11px] text-text-muted">
                        {item.question_count ?? 0}/{item.planned_question_count} 题 ·
                        {item.status === 'completed' ? '已完成' : item.status === 'created' ? '待开始' : '进行中'}
                      </span>
                      {resumingSessionId === item.id && (
                        <span className="mt-1 block text-[11px] text-accent-blue">恢复中…</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="space-y-4">
            <div className="rounded-2xl border border-bg-hover bg-bg-secondary p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">当前会话</h2>
                  <p className="mt-1 text-xs text-text-muted">{statusText}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleGenerateQuestion}
                    disabled={!canGenerate || generating || sessionTransitionBusy}
                    className="min-h-[38px] rounded-lg border border-accent-blue/40 bg-accent-blue/10 px-3 text-sm font-medium text-accent-blue transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {generating ? '出题中…' : '生成下一题'}
                  </button>
                  <button
                    type="button"
                    onClick={handleFinish}
                    disabled={!canFinish || finishing || sessionTransitionBusy}
                    className="min-h-[38px] rounded-lg border border-bg-hover px-3 text-sm font-medium text-text-muted transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {finishing ? '完成中…' : '完成面试'}
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateReport}
                    disabled={!canGenerateReport || reporting || sessionTransitionBusy}
                    className="min-h-[38px] rounded-lg border border-accent-blue/40 px-3 text-sm font-medium text-accent-blue transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {reporting ? '报告生成中…' : '生成整场报告'}
                  </button>
                </div>
              </div>
            </div>


            {session?.report_markdown && (
              <article className="rounded-2xl border border-bg-hover bg-bg-secondary p-4">
                <h2 className="text-sm font-semibold text-text-primary">整场报告</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
                  {session.report_markdown}
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div>
                    <h3 className="text-xs font-semibold text-text-primary">优势</h3>
                    <ul className="mt-1 space-y-1 text-xs text-text-muted">
                      {(session.report_strengths ?? []).map((item) => (
                        <li key={item}>· {item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-text-primary">弱项</h3>
                    <ul className="mt-1 space-y-1 text-xs text-text-muted">
                      {(session.report_weaknesses ?? []).map((item) => (
                        <li key={item}>· {item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-text-primary">练习重点</h3>
                    <ul className="mt-1 space-y-1 text-xs text-text-muted">
                      {(session.report_focus_areas ?? []).map((item) => (
                        <li key={item}>· {item}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={handleCreatePracticeSession}
                    disabled={!canCreatePractice || creatingPractice || sessionTransitionBusy}
                    className="min-h-[38px] rounded-lg bg-accent-blue px-4 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {creatingPractice ? '复练会话创建中…' : '开始弱项复练'}
                  </button>
                </div>
              </article>
            )}
            {question && (
              <article className="rounded-2xl border border-bg-hover bg-bg-secondary p-4">
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <span>第 {question.seq} 题</span>
                  <span>·</span>
                  <span>{question.question_type}</span>
                </div>
                <h3 className="mt-2 text-base font-semibold leading-relaxed text-text-primary">
                  {question.question_text}
                </h3>
                {(question.skill_tags ?? []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(question.skill_tags ?? []).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-bg-hover bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-4">
                  <label htmlFor="mock-answer" className="mb-1 block text-xs text-text-muted">你的回答</label>
                  <textarea
                    id="mock-answer"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    rows={7}
                    disabled={question.status !== 'waiting_answer'}
                    placeholder="按背景、做法、结果、取舍的顺序回答会更清晰"
                    className="w-full resize-y rounded-lg border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue/60 disabled:opacity-70"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleSubmitAnswer}
                      disabled={!canSubmit || submitting}
                      className="min-h-[38px] rounded-lg bg-accent-blue px-4 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {submitting ? '提交中…' : '提交回答'}
                    </button>
                    <button
                      type="button"
                      onClick={handleGenerateFeedback}
                      disabled={!canReview || reviewing}
                      className="min-h-[38px] rounded-lg border border-accent-blue/40 px-4 text-sm font-medium text-accent-blue transition disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {reviewing ? '点评生成中…' : '生成点评'}
                    </button>
                  </div>
                </div>

                {question.feedback && (
                  <div className="mt-5 border-t border-bg-hover pt-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-text-primary">AI 点评</h4>
                      <span aria-label="总体评分" className="text-sm font-semibold text-accent-green">
                        {question.feedback.overall_score} 分
                      </span>
                    </div>

                    <p className="mt-2 text-xs text-text-muted">AI 点评仅供参考，请结合岗位事实自行核对。</p>

                    <div className="mt-3 grid gap-2">
                      {question.feedback.dimensions.map((dimension) => (
                        <div
                          key={dimension.name}
                          className="rounded-xl border border-bg-hover bg-bg-tertiary px-3 py-2"
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-text-primary">{dimension.name}</span>
                            <span className="text-text-muted">{dimension.score} 分</span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-text-muted">{dimension.comment}</p>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div>
                        <h5 className="text-xs font-semibold text-text-primary">亮点</h5>
                        <ul className="mt-1 space-y-1 text-xs text-text-muted">
                          {question.feedback.strengths.map((item) => (
                            <li key={item}>· {item}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h5 className="text-xs font-semibold text-text-primary">改进建议</h5>
                        <ul className="mt-1 space-y-1 text-xs text-text-muted">
                          {question.feedback.improvements.map((item) => (
                            <li key={item}>· {item}</li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="mt-4">
                      <h5 className="text-xs font-semibold text-text-primary">回答证据</h5>
                      <ul className="mt-1 space-y-1 text-xs text-text-muted">
                        {question.feedback.evidence.map((item) => (
                          <li key={item}>· {item}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="mt-4 rounded-xl border border-bg-hover bg-bg-tertiary p-3">
                      <h5 className="text-xs font-semibold text-text-primary">参考回答</h5>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-text-muted">
                        {question.feedback.reference_answer}
                      </p>
                    </div>
                  </div>
                )}
              </article>
            )}

            {!question && (
              <div className="rounded-2xl border border-dashed border-bg-hover bg-bg-secondary/60 p-8 text-center text-sm text-text-muted">
                创建会话后，点击“生成下一题”开始练习。
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
