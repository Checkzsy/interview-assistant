import { buildOverlayStatePayload } from '@/lib/interviewOverlay'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

export function prepareExamOverlayPrompt() {
  const prefs = useUiPrefsStore.getState()
  prefs.setInterviewOverlayEnabled(true)
  prefs.setInterviewOverlayMode('prompt')
}

export function showExamOverlayPrompt() {
  prepareExamOverlayPrompt()
  const next = useUiPrefsStore.getState()
  window.electronAPI?.syncOverlayWindow?.({
    ...buildOverlayStatePayload(next),
    visible: true,
    showBg: false,
    mode: 'prompt',
  }).catch(() => {})
}
