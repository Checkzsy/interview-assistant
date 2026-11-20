export type ShortcutAction =
  | 'hideOrShowWindow'
  | 'hardClearSession'
  | 'askFromServerScreen'
  | 'cancelAnswer'
  | 'addMultiServerScreenShot'
  | 'toggleInterviewOverlay'
  | 'moveOverlayToMouse'
  | 'focusPrevTab'
  | 'focusNextTab'
  | 'overlayPrevQuestion'
  | 'overlayNextQuestion'
  | 'overlayScrollPrevAnswer'
  | 'overlayScrollNextAnswer'
  | 'overlayScrollPrevQuestion'
  | 'overlayScrollNextQuestion'
  | 'toggleOverlayPassthrough'
  | 'askScreenForceThink'
  | 'askScreenForceNoThink'
  | 'toggleThinkMode'
export type ShortcutStatus = 'registered' | 'failed' | 'available'

export type ShortcutConfig = {
  action: ShortcutAction
  key: string
  defaultKey: string
  label: string
  category: string
  status?: ShortcutStatus
  conflict?: ShortcutAction
}

export const defaultShortcuts: Record<ShortcutAction, ShortcutConfig> = {
  hideOrShowWindow: {
    action: 'hideOrShowWindow',
    key: 'CommandOrControl+B',
    defaultKey: 'CommandOrControl+B',
    label: '隐藏/显示窗口',
    category: '窗口',
    status: 'available',
  },
  hardClearSession: {
    action: 'hardClearSession',
    key: 'CommandOrControl+.',
    defaultKey: 'CommandOrControl+.',
    label: '硬清空',
    category: '实时辅助',
    status: 'available',
  },
  askFromServerScreen: {
    action: 'askFromServerScreen',
    key: 'CommandOrControl+/',
    defaultKey: 'CommandOrControl+/',
    label: '服务端截图审题',
    category: '实时辅助',
    status: 'available',
  },
  cancelAnswer: {
    action: 'cancelAnswer',
    key: 'CommandOrControl+Escape',
    defaultKey: 'CommandOrControl+Escape',
    label: '取消生成',
    category: '实时辅助',
    status: 'available',
  },
  addMultiServerScreenShot: {
    action: 'addMultiServerScreenShot',
    key: 'CommandOrControl+Shift+/',
    defaultKey: 'CommandOrControl+Shift+/',
    label: '多图截图判题',
    category: '实时辅助',
    status: 'available',
  },
  toggleInterviewOverlay: {
    action: 'toggleInterviewOverlay',
    key: 'CommandOrControl+O',
    defaultKey: 'CommandOrControl+O',
    label: '显示/隐藏悬浮窗',
    category: '实时辅助',
    status: 'available',
  },
  moveOverlayToMouse: {
    action: 'moveOverlayToMouse',
    key: 'CommandOrControl+M',
    defaultKey: 'CommandOrControl+M',
    label: '移动悬浮窗到鼠标位置',
    category: '实时辅助',
    status: 'available',
  },
  focusPrevTab: {
    action: 'focusPrevTab',
    key: 'CommandOrControl+Left',
    defaultKey: 'CommandOrControl+Left',
    label: '专注面板上一栏',
    category: '专注面板',
    status: 'available',
  },
  focusNextTab: {
    action: 'focusNextTab',
    key: 'CommandOrControl+Right',
    defaultKey: 'CommandOrControl+Right',
    label: '专注面板下一栏',
    category: '专注面板',
    status: 'available',
  },
  overlayPrevQuestion: {
    action: 'overlayPrevQuestion',
    key: 'CommandOrControl+Up',
    defaultKey: 'CommandOrControl+Up',
    label: '悬浮窗上一题',
    category: '悬浮窗',
    status: 'available',
  },
  overlayNextQuestion: {
    action: 'overlayNextQuestion',
    key: 'CommandOrControl+Down',
    defaultKey: 'CommandOrControl+Down',
    label: '悬浮窗下一题',
    category: '悬浮窗',
    status: 'available',
  },
  overlayScrollPrevAnswer: {
    action: 'overlayScrollPrevAnswer',
    key: 'CommandOrControl+Shift+Up',
    defaultKey: 'CommandOrControl+Shift+Up',
    label: '答案向上滚动',
    category: '悬浮窗',
    status: 'available',
  },
  overlayScrollNextAnswer: {
    action: 'overlayScrollNextAnswer',
    key: 'CommandOrControl+Shift+Down',
    defaultKey: 'CommandOrControl+Shift+Down',
    label: '答案向下滚动',
    category: '悬浮窗',
    status: 'available',
  },
  overlayScrollPrevQuestion: {
    action: 'overlayScrollPrevQuestion',
    key: 'CommandOrControl+Shift+Left',
    defaultKey: 'CommandOrControl+Shift+Left',
    label: '题目向上滚动',
    category: '专注面板',
    status: 'available',
  },
  overlayScrollNextQuestion: {
    action: 'overlayScrollNextQuestion',
    key: 'CommandOrControl+Shift+Right',
    defaultKey: 'CommandOrControl+Shift+Right',
    label: '题目向下滚动',
    category: '专注面板',
    status: 'available',
  },
  toggleOverlayPassthrough: {
    action: 'toggleOverlayPassthrough',
    key: 'CommandOrControl+1',
    defaultKey: 'CommandOrControl+1',
    label: '悬浮窗鼠标穿透',
    category: '悬浮窗',
    status: 'available',
  },
  askScreenForceThink: {
    action: 'askScreenForceThink',
    key: 'CommandOrControl+Alt+/',
    defaultKey: 'CommandOrControl+Alt+/',
    label: '截图审题（强制思考）',
    category: '实时辅助',
    status: 'available',
  },
  askScreenForceNoThink: {
    action: 'askScreenForceNoThink',
    key: 'CommandOrControl+Alt+.',
    defaultKey: 'CommandOrControl+Alt+.',
    label: '截图审题（强制非思考）',
    category: '实时辅助',
    status: 'available',
  },
  toggleThinkMode: {
    action: 'toggleThinkMode',
    key: 'CommandOrControl+Shift+T',
    defaultKey: 'CommandOrControl+Shift+T',
    label: '切换思考模式',
    category: '实时辅助',
    status: 'available',
  },
}

const supportedPhysicalKeys = new Map<string, string>([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((key) => [`Key${key}`, key] as const),
  ...'0123456789'.split('').map((digit) => [`Digit${digit}`, digit] as const),
  ['Period', '.'],
  ['Slash', '/'],
  ['Backslash', '\\'],
  ['Minus', '-'],
  ['Equal', '='],
  ['Comma', ','],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backquote', '`'],
  ['Enter', 'Enter'],
  ['Escape', 'Escape'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
])

export function isMacPlatform() {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

export function getShortcutAccelerator(event: KeyboardEvent): string | null {
  if (!(event.metaKey || event.ctrlKey)) return null
  const key = supportedPhysicalKeys.get(event.code)
  if (!key) return null
  const parts: string[] = ['CommandOrControl']
  if (event.shiftKey) parts.push('Shift')
  if (event.altKey) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}

const KEY_DISPLAY: Record<string, string> = {
  Enter: 'Enter',
  Escape: 'Esc',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
}

export function getShortcutDisplay(accelerator: string) {
  const parts = accelerator.split('+')
  const ctrl = isMacPlatform() ? '⌘' : 'Ctrl'
  const shiftSym = isMacPlatform() ? '⇧' : 'Shift'
  const altSym = isMacPlatform() ? '⌥' : 'Alt'
  const out: string[] = []
  for (const p of parts) {
    if (p === 'CommandOrControl') out.push(ctrl)
    else if (p === 'Shift') out.push(shiftSym)
    else if (p === 'Alt') out.push(altSym)
    else out.push(KEY_DISPLAY[p] ?? p)
  }
  return out.join(isMacPlatform() ? '' : '+')
}

const LEGACY_SHORTCUT_ACTIONS = new Set<ShortcutAction>([
  'hideOrShowWindow',
  'hardClearSession',
  'askFromServerScreen',
  'cancelAnswer',
  'addMultiServerScreenShot',
  'toggleInterviewOverlay',
  'moveOverlayToMouse',
  'focusPrevTab',
  'focusNextTab',
  'overlayPrevQuestion',
  'overlayNextQuestion',
  'askScreenForceThink',
  'askScreenForceNoThink',
  'toggleThinkMode',
])

const VALID_ACTIONS = new Set<string>(Object.keys(defaultShortcuts))
const SUPPORTED_KEY_RE = /^CommandOrControl(\+Shift)?(\+Alt)?\+([A-Za-z0-9./\\\- =;,'`\[\]\{\}]|Enter|Escape|Up|Down|Left|Right)$/

export function mergeShortcutConfigs(
  input: Record<string, Partial<ShortcutConfig> | Record<string, unknown>> | undefined,
) {
  const merged = Object.fromEntries(
    Object.entries(defaultShortcuts).map(([action, shortcut]) => [action, { ...shortcut }]),
  ) as Record<ShortcutAction, ShortcutConfig>
  for (const [action, shortcut] of Object.entries(input || {})) {
    if (!(action in merged)) continue
    if (!shortcut || typeof shortcut !== 'object') continue
    const s = shortcut as Record<string, unknown>
    if (!(typeof s.key === 'string' && s.key.trim() && SUPPORTED_KEY_RE.test(s.key))) continue
    const next: ShortcutConfig = {
      ...merged[action as ShortcutAction],
      key: s.key as string,
    }
    // 只接受合法原生状态：注册结果以主进程为准，非法值一律回落到默认。
    if (s.status === 'registered' || s.status === 'failed' || s.status === 'available') {
      next.status = s.status
    }
    if (s.status === 'failed' && typeof s.conflict === 'string' && s.conflict !== action
      && Object.prototype.hasOwnProperty.call(merged, s.conflict)) {
      next.conflict = s.conflict as ShortcutAction
    }
    merged[action as ShortcutAction] = next
  }

  const conflicts = new Map<ShortcutAction, ShortcutAction>()
  for (const [action, shortcut] of Object.entries(merged) as [ShortcutAction, ShortcutConfig][]) {
    for (const [otherAction, other] of Object.entries(merged) as [ShortcutAction, ShortcutConfig][]) {
      if (action === otherAction || shortcut.key !== other.key) continue
      const actionIsLegacy = LEGACY_SHORTCUT_ACTIONS.has(action)
      const otherIsLegacy = LEGACY_SHORTCUT_ACTIONS.has(otherAction)
      if (actionIsLegacy && !otherIsLegacy) {
        conflicts.set(otherAction, action)
      } else if (actionIsLegacy === otherIsLegacy && Object.keys(merged).indexOf(action) > Object.keys(merged).indexOf(otherAction)) {
        conflicts.set(action, otherAction)
      }
    }
  }

  for (const [action, conflictingAction] of conflicts) {
    merged[action] = { ...merged[action], status: 'failed', conflict: conflictingAction } as ShortcutConfig
  }
  return merged
}
