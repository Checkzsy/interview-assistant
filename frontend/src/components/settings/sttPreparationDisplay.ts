import type { SttPrepState, SttPrepSnapshot } from '@/lib/api'
import { formatBytes } from '@/lib/formatBytes'

export type SttPrepDisplay = {
  kind: 'waiting' | 'downloading' | 'loading' | 'ready' | 'error'
  label: string
  detail?: string
}

/** Download percent, floored and capped at 99 so a partial transfer never reads 100%. */
export function downloadPercent(state: SttPrepState): number | null {
  const progress = state.progress
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    return Math.max(0, Math.min(99, Math.floor(progress)))
  }
  const downloaded = state.downloaded_bytes
  const total = state.total_bytes
  if (typeof downloaded === 'number' && downloaded > 0 && typeof total === 'number' && total > 0) {
    return Math.max(0, Math.min(99, Math.floor((downloaded / total) * 100)))
  }
  return null
}

export function findPreparationState(
  snapshot: SttPrepSnapshot | null | undefined,
  key: [string, string],
  attemptId?: string | null,
): SttPrepState | null {
  if (!snapshot) return null
  const candidates = [...snapshot.states, ...(snapshot.active ? [snapshot.active] : [])]
  const matching = candidates.filter((state) => state.key?.[0] === key[0] && state.key?.[1] === key[1])
  if (attemptId) {
    const attempted = matching.find((state) => state.attempt_id === attemptId)
    if (attempted) return attempted
    if (matching.length > 0) return null
  }
  return matching[0] ?? null
}

export function describeSttPreparation(state: SttPrepState | null | undefined): SttPrepDisplay | null {
  if (!state) return null
  switch (state.phase) {
    case 'queued':
      return { kind: 'waiting', label: '等待其他模型准备完成' }
    case 'resolving':
      return { kind: 'waiting', label: '正在获取模型大小' }
    case 'downloading': {
      const percent = downloadPercent(state)
      if (percent === null) return { kind: 'downloading', label: '正在下载模型' }
      const downloaded = state.downloaded_bytes
      const total = state.total_bytes
      const hasSize = typeof downloaded === 'number' && typeof total === 'number' && total > 0
      return {
        kind: 'downloading',
        label: `正在下载模型 ${percent}%`,
        ...(hasSize ? { detail: `${formatBytes(downloaded)} / ${formatBytes(total)}` } : {}),
      }
    }
    case 'loading': {
      const downloaded = state.downloaded_bytes
      const total = state.total_bytes
      if (typeof downloaded === 'number' && typeof total === 'number' && total > 0 && downloaded >= total) {
        return { kind: 'loading', label: '下载完成，正在加载模型' }
      }
      if (downloaded == null && total == null) {
        return { kind: 'loading', label: '正在加载本地模型' }
      }
      return { kind: 'loading', label: '正在加载模型' }
    }
    case 'ready':
      return { kind: 'ready', label: '模型已就绪' }
    case 'error':
      return { kind: 'error', label: '模型准备失败', detail: state.error || '未知原因' }
    default:
      return null
  }
}

/**
 * Status-chip summary for the interview's main STT target only.
 *
 * Returns null for a ready model (the existing chip already covers that) so the
 * header stays silent in the steady state. Remote providers never surface local
 * whisper preparation, and another consumer's target must not masquerade as the
 * main one.
 */
export function describeMainSttPreparation(
  snapshot: SttPrepSnapshot | null | undefined,
  config: { stt_provider?: string; whisper_model?: string; whisper_language?: string } | null | undefined,
): SttPrepDisplay | null {
  if (!snapshot || !config || config.stt_provider !== 'whisper') return null
  const key: [string, string] = [config.whisper_model || 'base', config.whisper_language || 'auto']
  const state = findPreparationState(snapshot, key)
  if (!state || state.phase === 'ready' || !state.roles?.includes('main')) return null
  return describeSttPreparation(state)
}
