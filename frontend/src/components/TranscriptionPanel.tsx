import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Activity, Volume2, Radio, Languages, ClipboardPaste, Keyboard, Brain, ArrowDown } from 'lucide-react'
import { useInterviewStore } from '@/stores/configStore'
import { useShallow } from 'zustand/react/shallow'

// 译文预览最多展示最近几条（store 侧保留最近 100 条）。
const TRANSLATION_PREVIEW = 4

export default function TranscriptionPanel() {
  const transcriptions = useInterviewStore((s) => s.transcriptions)
  const isRecording = useInterviewStore((s) => s.isRecording)
  const audioLevel = useInterviewStore((s) => s.audioLevel)
  const isTranscribing = useInterviewStore((s) => s.isTranscribing)
  const config = useInterviewStore((s) => s.config)
  // 契约：translations / translationErrors 的 key/条目是后端翻译消息携带的 seq。
  // seq 需与后端 transcription 消息对齐；当前 transcription 消息不带 seq，
  // translations 只按序匹配最后一条预期 —— 因此这里不依赖 transcriptions 数组索引，
  // 仅在用户打开翻译开关后展示后端已返回的译文区块。
  const translations = useInterviewStore(useShallow((s) => s.translations))
  const translationErrors = useInterviewStore(useShallow((s) => s.translationErrors))
  const isExamMode = config?.written_exam_mode === true
  const contentRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [translateEnabled, setTranslateEnabled] = useState(false)

  const updateAutoFollow = useCallback(() => {
    const el = contentRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 36
    autoFollowRef.current = nearBottom
    setShowJumpToLatest(!nearBottom && transcriptions.length > 0)
  }, [transcriptions.length])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = contentRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    autoFollowRef.current = true
    setShowJumpToLatest(false)
  }, [])

  useEffect(() => {
    if (!autoFollowRef.current) {
      setShowJumpToLatest(transcriptions.length > 0)
      return
    }
    requestAnimationFrame(() => scrollToLatest('auto'))
  }, [scrollToLatest, transcriptions])

  useEffect(() => {
    updateAutoFollow()
  }, [updateAutoFollow])

  const levelPercent = Math.min(audioLevel * 500, 100)
  const translationKeys = Object.keys(translations)
  const recentTranslations = translationKeys.slice(-TRANSLATION_PREVIEW).map((seq) => ({
    seq: Number(seq),
    text: translations[Number(seq)],
  }))
  const recentErrors = translationErrors.slice(-TRANSLATION_PREVIEW)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-bg-tertiary/60 flex-shrink-0">
        <div className="flex items-center gap-2">
          {isRecording ? (
            <div className="relative">
              <Mic className="w-4 h-4 text-accent-green" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent-green recording-pulse" />
            </div>
          ) : (
            <MicOff className="w-4 h-4 text-text-muted" />
          )}
          <span className="text-sm font-semibold tracking-tight">
            {isRecording ? (isExamMode ? '答题中' : '正在录音') : (isExamMode ? '答题记录' : '实时转录')}
          </span>
        </div>
        {!isExamMode && (
          <button
            type="button"
            role="switch"
            aria-checked={translateEnabled}
            aria-label="翻译"
            title="打开后显示后端已返回的实时译文（seq 按消息顺序对齐最近转录）"
            onClick={() => setTranslateEnabled((v) => !v)}
            className={`ml-2 inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors ${
              translateEnabled
                ? 'border-accent-blue/45 bg-accent-blue/10 text-accent-blue'
                : 'border-bg-hover/40 bg-bg-tertiary/40 text-text-muted hover:text-text-secondary'
            }`}
          >
            <Languages className="w-3 h-3" />
            翻译
          </button>
        )}
        {isRecording && (
          <div className="flex items-center gap-2.5 ml-auto">
            {isTranscribing && (
              <span className="flex items-center gap-1 text-xs text-accent-amber font-medium">
                <Activity className="w-3 h-3 animate-pulse" />
                转写中
              </span>
            )}
            <div className="flex items-end gap-[2px] h-4">
              {[0.6, 1.0, 0.75, 0.9, 0.5].map((scale, i) => (
                <div
                  key={i}
                  className="w-[3px] rounded-full bg-accent-green/80 transition-all duration-75"
                  style={{
                    height: `${Math.max(15, Math.min(100, levelPercent * scale))}%`,
                    opacity: levelPercent > 5 ? 0.5 + (levelPercent / 200) : 0.2,
                  }}
                />
              ))}
            </div>
            <span className="text-[10px] text-text-muted font-mono tabular-nums w-8 text-right">
              {Math.round(levelPercent)}%
            </span>
          </div>
        )}
      </div>

      <div
        ref={contentRef}
        aria-label="转写记录"
        className="relative flex-1 overflow-y-auto p-4 space-y-2"
        onScroll={updateAutoFollow}
      >
        {transcriptions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="relative w-14 h-14">
              <div className={`absolute inset-0 rounded-2xl bg-gradient-to-br from-accent-blue/15 to-accent-green/10 ${isRecording ? 'animate-glow' : ''}`} />
              <div className="relative flex items-center justify-center w-14 h-14 rounded-2xl bg-bg-tertiary/50">
                {isRecording ? (
                  <Activity className="w-6 h-6 text-accent-amber animate-pulse" />
                ) : (
                  <Mic className="w-6 h-6 text-text-muted/60" />
                )}
              </div>
            </div>
            <div className="text-center space-y-1">
              <p className="text-text-primary text-sm font-semibold">
                {isRecording ? (isExamMode ? '等待截图或手动输入…' : '等待语音输入…') : (isExamMode ? '笔试答题记录' : '实时语音转录')}
              </p>
              <p className="text-text-muted text-xs leading-relaxed">
                {isRecording
                  ? isExamMode
                    ? '截图审题或手动输入问题后，AI 会自动生成答案'
                    : '检测到语音会自动分段转录,问题会发给 AI 生成答案'
                  : isExamMode
                  ? '点击「开始笔试」，通过截图或输入题目获取答案'
                  : '选择音频设备后,点击「开始面试」启动实时识别'}
              </p>
            </div>
            {!isRecording && (
              <div className="flex items-center gap-1.5 flex-wrap justify-center pt-1">
                {(isExamMode
                  ? [
                      { icon: ClipboardPaste, label: '截图审题', hint: '输入框 Ctrl/⌘+V 粘贴' },
                      { icon: Keyboard, label: '手动输入', hint: '底部输入框 + Enter' },
                      { icon: Brain, label: 'AI 答题', hint: '自动识别题目类型并生成答案' },
                    ]
                  : [
                      { icon: Volume2, label: '会议拾音', hint: '优先选 BlackHole / 系统音频 (loopback), 可录远端声音' },
                      { icon: Radio, label: '自动断句', hint: 'VAD 静音超阈值即切段并识别' },
                      { icon: Languages, label: '中英混读', hint: '默认中文优先, 英文术语保留原样' },
                    ]
                ).map(({ icon: Icon, label, hint }: { icon: typeof Mic; label: string; hint: string }) => (
                  <span
                    key={label}
                    title={hint}
                    className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full bg-bg-tertiary/50 border border-bg-hover/40 text-text-secondary"
                  >
                    <Icon className="w-3 h-3 text-accent-blue/70" />
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          transcriptions.map((text, i) => (
            <div
              key={i}
              className="transcription-item px-3.5 py-2.5 rounded-lg bg-bg-tertiary/40 text-sm leading-relaxed text-text-primary"
              style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
            >
              <span className="text-accent-blue/70 font-mono mr-1.5 text-[10px] select-none">{String(i + 1).padStart(2, '0')}</span>
              {text}
            </div>
          ))
        )}
        {translateEnabled && (
          <section
            aria-label="纪要译文"
            className="mt-2 rounded-lg border border-bg-hover/40 bg-bg-tertiary/25 p-3"
          >
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-secondary">
              <Languages className="w-3 h-3 text-accent-blue/70" />
              <span>纪要译文</span>
              {translationKeys.length > 0 && (
                <span className="font-mono text-[10px] text-text-muted">
                  · {translationKeys.length}
                </span>
              )}
            </div>
            {translationKeys.length + translationErrors.length === 0 ? (
              <p className="mt-1 text-xs text-text-muted">暂无译文</p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {recentTranslations.map(({ seq, text }) => (
                  <li key={seq} className="flex items-start gap-1.5 text-xs text-text-secondary">
                    <span className="font-mono text-[10px] text-accent-amber/80 select-none whitespace-nowrap">#{seq}</span>
                    <span className="min-w-0 break-all">译文：{text}</span>
                  </li>
                ))}
                {recentErrors.map((seq) => (
                  <li key={`err-${seq}`} className="flex items-start gap-1.5 text-xs text-accent-red/80">
                    <span className="font-mono text-[10px] text-accent-red/60 select-none whitespace-nowrap">#{seq}</span>
                    <span>翻译失败</span>
                  </li>
                ))}
              </ul>
            )}
            {translationErrors.length > 0 && (
              <p className="mt-1.5 text-[10px] text-accent-red/80">部分翻译失败</p>
            )}
          </section>
        )}
        {showJumpToLatest && (
          <button
            type="button"
            onClick={() => scrollToLatest()}
            className="sticky bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent-blue/35 bg-bg-secondary/95 px-3 py-1.5 text-[11px] font-medium text-accent-blue shadow-lg shadow-black/10 backdrop-blur"
            aria-label="回到最新转写"
          >
            <ArrowDown className="h-3 w-3" />
            回到最新转写
          </button>
        )}
      </div>
    </div>
  )
}
