import { useState, useEffect, useRef } from 'react'
import { Section } from './shared'
import { useInterviewStore } from '@/stores/configStore'
import { useShortcutsStore } from '@/stores/shortcutsStore'
import {
  defaultShortcuts,
  getShortcutAccelerator,
  getShortcutDisplay,
  type ShortcutAction,
} from '@/lib/shortcuts'

const SHORTCUT_OPERATION_HINTS: Record<ShortcutAction, string> = {
  hideOrShowWindow: '显示或隐藏主窗口',
  hardClearSession: '清空当前会话上下文并重新开始',
  askFromServerScreen: '截取服务端屏幕并提交审题',
  cancelAnswer: '取消当前正在生成的回答',
  addMultiServerScreenShot: '依次截取多张屏幕图片，最后一次按下后等待设置时长再统一提交判题',
  toggleInterviewOverlay: '显示或隐藏悬浮窗',
  moveOverlayToMouse: '将悬浮窗移动到鼠标所在位置',
  focusPrevTab: '切换到专注面板上一栏',
  focusNextTab: '切换到专注面板下一栏',
  overlayPrevQuestion: '悬浮窗中切换到上一题',
  overlayNextQuestion: '悬浮窗中切换到下一题',
  askScreenForceThink: '强制思考模式截图审题',
  askScreenForceNoThink: '强制非思考模式截图审题',
  toggleThinkMode: '切换思考模式',
}

const FOCUS_MODE_ACTIONS = new Set<ShortcutAction>(['focusPrevTab', 'focusNextTab'])
const OVERLAY_VISIBLE_ACTIONS = new Set<ShortcutAction>([
  'cancelAnswer',
  'overlayPrevQuestion',
  'overlayNextQuestion',
])

export default function GlobalShortcutsEditor() {
  const shortcuts = useShortcutsStore((s) => s.shortcuts)
  const setShortcuts = useShortcutsStore((s) => s.setShortcuts)
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null)
  const [savingAction, setSavingAction] = useState<ShortcutAction | null>(null)
  const [resetting, setResetting] = useState(false)
  const savingShortcutRef = useRef(false)
  const resettingRef = useRef(false)

  useEffect(() => {
    if (!window.electronAPI?.getShortcuts) return
    window.electronAPI.getShortcuts()
      .then((next) => setShortcuts(next))
      .catch(() => {})
  }, [setShortcuts])

  useEffect(() => {
    if (!recordingAction) return
    const handleKeyDown = async (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (savingShortcutRef.current) return
      if (e.key === 'Escape') {
        setRecordingAction(null)
        return
      }
      const accelerator = getShortcutAccelerator(e)
      if (!accelerator || !window.electronAPI?.updateShortcuts) return
      savingShortcutRef.current = true
      setSavingAction(recordingAction)
      try {
        const res = await window.electronAPI.updateShortcuts([
          { action: recordingAction, key: accelerator },
        ])
        if (!res.ok) {
          useInterviewStore.getState().setToastMessage(res.error || '快捷键保存失败')
        } else {
          setShortcuts(res.shortcuts as Record<string, any>)
          useInterviewStore.getState().setToastMessage('快捷键已更新')
        }
      } catch (err) {
        useInterviewStore.getState().setToastMessage(err instanceof Error ? err.message : '快捷键保存失败')
      } finally {
        savingShortcutRef.current = false
        setSavingAction(null)
        setRecordingAction(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recordingAction, setShortcuts])

  if (!window.electronAPI?.getShortcuts) return null

  const items = Object.keys(defaultShortcuts) as ShortcutAction[]

  const resetDefaults = async () => {
    if (!window.electronAPI?.resetShortcuts) return
    if (resettingRef.current) return
    resettingRef.current = true
    setResetting(true)
    try {
      const res = await window.electronAPI.resetShortcuts()
      if (!res.ok) {
        useInterviewStore.getState().setToastMessage(res.error || '重置失败')
      } else {
        setShortcuts(res.shortcuts as Record<string, any>)
        useInterviewStore.getState().setToastMessage('已恢复默认快捷键')
      }
    } catch (err) {
      useInterviewStore.getState().setToastMessage(err instanceof Error ? err.message : '重置失败')
    } finally {
      resettingRef.current = false
      setResetting(false)
    }
  }

  const statusTone = (status?: string) => {
    if (status === 'registered') return 'text-accent-green'
    if (status === 'failed') return 'text-accent-red'
    return 'text-text-muted'
  }

  const statusLabel = (status?: string) => {
    if (status === 'registered') return '已注册'
    if (status === 'failed') return '注册失败'
    return '待注册'
  }

  return (
    <Section title="全局快捷键" keywords="hotkey shortcut 快捷键 alt ctrl cmd shift 截图">
      <div className="bg-bg-tertiary/30 rounded-lg p-3 text-xs text-text-muted leading-relaxed">
        必须以 <code className="px-1 py-0.5 rounded bg-bg-tertiary border border-bg-hover font-mono text-[11px]">⌘/Ctrl</code> 开头，可叠加 <code className="px-1 py-0.5 rounded bg-bg-tertiary border border-bg-hover font-mono text-[11px]">⇧Shift</code>、<code className="px-1 py-0.5 rounded bg-bg-tertiary border border-bg-hover font-mono text-[11px]">⌥Alt</code>。
        支持字母、数字、Enter、方向键和常用符号。点击某项后直接按新快捷键，<code className="px-1 py-0.5 rounded bg-bg-tertiary border border-bg-hover font-mono text-[11px]">Esc</code> 取消。
        仅在 Electron 桌面模式下生效；截图类快捷键需要已配置支持识图的模型；多图快捷键在最后一次按下后按设置时间等待提交。
      </div>
      <div className="space-y-2">
        {items.map((action) => {
          const shortcut = shortcuts[action]
          if (!shortcut) return null
          const isRecording = recordingAction === action
          const isSaving = savingAction === action
          return (
            <div
              key={action}
              className="flex items-center justify-between gap-3 rounded-xl border border-bg-hover bg-bg-primary/40 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-text-primary">{shortcut.label}</div>
                <div className={`text-[10px] mt-0.5 ${statusTone(shortcut.status)}`}>
                  {statusLabel(shortcut.status)}
                </div>
                <div className="text-[10px] mt-0.5 text-text-muted">
                  {SHORTCUT_OPERATION_HINTS[action]}
                </div>
                {shortcut.status === 'failed' && (
                  <div className="text-[10px] mt-0.5 text-accent-red">当前组合注册失败，请更换快捷键后重试</div>
                )}
                {shortcut.status === 'available' && FOCUS_MODE_ACTIONS.has(action) && (
                  <div className="text-[10px] mt-0.5 text-text-muted">需在专注面板展开时生效</div>
                )}
                {shortcut.status === 'available' && OVERLAY_VISIBLE_ACTIONS.has(action) && (
                  <div className="text-[10px] mt-0.5 text-text-muted">需悬浮窗已显示时生效</div>
                )}
              </div>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => setRecordingAction(isRecording ? null : action)}
                className={`min-w-[120px] rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  isRecording
                    ? 'border-accent-blue bg-accent-blue/10 text-accent-blue animate-pulse'
                    : 'border-bg-hover bg-bg-tertiary text-text-primary hover:border-accent-blue/40'
                }`}
              >
                {isSaving
                  ? '保存中…'
                  : isRecording
                    ? '按下新快捷键…'
                    : getShortcutDisplay(shortcut.key)}
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        disabled={resetting}
        onClick={resetDefaults}
        className="w-full py-2.5 text-xs font-medium rounded-xl border border-bg-hover text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50"
      >
        {resetting ? '重置中…' : '恢复默认快捷键'}
      </button>
    </Section>
  )
}
