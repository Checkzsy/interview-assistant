import type { StateCreator } from 'zustand'
import type { RootState } from './rootState'
import type { ModelHealthStatus, TokenUsage } from './types'

export interface SttPreparationState {
  key: [string, string]
  attempt_id: string
  phase: 'queued' | 'resolving' | 'downloading' | 'loading' | 'ready' | 'error' | 'uninitialized'
  downloaded_bytes: number | null
  total_bytes: number | null
  progress: number | null
  started_at: number | null
  updated_at: number
  error: string | null
  roles: string[]
}

export interface SttPreparationSnapshot {
  runtime_id: string | null
  revision: number
  active: SttPreparationState | null
  pending: SttPreparationState[]
  states: SttPreparationState[]
}

export const EMPTY_STT_PREPARATION: SttPreparationSnapshot = {
  runtime_id: null,
  revision: 0,
  active: null,
  pending: [],
  states: [],
}

export interface SttSliceState {
  sttLoaded: boolean
  sttLoading: boolean
  sttActiveProvider: string
  sttFallbackLoaded: boolean
  candidateSttLoaded: boolean
  candidateSttLoading: boolean
  candidateSttProvider: string
  sttPreparation: SttPreparationSnapshot
  sttLastAcceptedPreparation: SttPreparationSnapshot | null
  sttRetiredRuntimes: string[]
  sttConfigVersion: string
  modelHealth: Record<number, ModelHealthStatus>
  modelHealthDetail: Record<number, string>
  modelHealthLatency: Record<number, number>
  tokenUsage: TokenUsage
}

export interface SttSliceActions {
  setSttStatus: (loaded: boolean, loading: boolean, provider?: string) => void
  setCandidateSttStatus: (loaded: boolean, loading: boolean, provider?: string) => void
  applySttPreparation: (snapshot: SttPreparationSnapshot, configVersion?: string) => void
  setSttConfigVersion: (version: string) => void
  setModelHealth: (
    index: number,
    status: ModelHealthStatus,
    detail?: string,
    latencyMs?: number,
    modelFingerprint?: string,
  ) => void
  setTokenUsage: (usage: TokenUsage) => void
}

export type SttSlice = SttSliceState & SttSliceActions

export const createSttSlice: StateCreator<RootState, [], [], SttSlice> = (set) => ({
  sttLoaded: true,
  sttLoading: false,
  sttActiveProvider: '',
  sttFallbackLoaded: false,
  candidateSttLoaded: false,
  candidateSttLoading: false,
  candidateSttProvider: '',
  sttPreparation: EMPTY_STT_PREPARATION,
  sttLastAcceptedPreparation: null,
  sttRetiredRuntimes: [],
  sttConfigVersion: '',
  modelHealth: {},
  modelHealthDetail: {},
  modelHealthLatency: {},
  tokenUsage: { prompt: 0, completion: 0, total: 0, byModel: {} },

  setSttStatus: (loaded, loading, provider) => set((s) => {
    if (provider === 'whisper-preload') {
      return { sttFallbackLoaded: loaded }
    }
    return {
      sttLoaded: loaded,
      sttLoading: loading,
      ...(provider != null ? { sttActiveProvider: provider } : {}),
    }
  }),
  setCandidateSttStatus: (loaded, loading, provider) => set((s) => ({
    candidateSttLoaded: loaded,
    candidateSttLoading: loading,
    ...(provider != null ? { candidateSttProvider: provider } : {}),
  })),
  // The backend restarts its revision counter per runtime, so revision alone
  // cannot order snapshots across a restart. Retired runtimes are remembered for
  // the page lifetime and rejected outright: a late WS frame or an in-flight
  // HTTP poll from a previous backend process must never resurrect or overwrite
  // the live runtime's progress.
  applySttPreparation: (snapshot, configVersion) => set((s) => {
    const current = s.sttPreparation
    const lastAccepted = s.sttLastAcceptedPreparation ?? (current.runtime_id !== null ? current : null)
    if (snapshot.runtime_id !== null && s.sttRetiredRuntimes.includes(snapshot.runtime_id)) {
      return {}
    }
    if (lastAccepted?.runtime_id != null) {
      if (snapshot.runtime_id === lastAccepted.runtime_id && snapshot.revision < lastAccepted.revision) {
        return {}
      }
    }
    return {
      sttPreparation: snapshot,
      ...(configVersion !== undefined ? { sttConfigVersion: configVersion } : {}),
      // Null clears visible states but can be a delayed shutdown poll. Keep
      // the last non-null identity and revision so it cannot retire a still-
      // live runtime or erase same-runtime revision ordering.
      sttLastAcceptedPreparation: snapshot.runtime_id !== null ? snapshot : lastAccepted,
      ...(snapshot.runtime_id !== null && lastAccepted?.runtime_id != null && snapshot.runtime_id !== lastAccepted.runtime_id
        ? { sttRetiredRuntimes: [...s.sttRetiredRuntimes, lastAccepted.runtime_id] }
        : {}),
    }
  }),
  setSttConfigVersion: (version) => set({ sttConfigVersion: version }),
  setModelHealth: (index, status, detail, latencyMs, modelFingerprint) => set((s) => {
    const currentFingerprint = s.config?.models?.[index]?.health_fingerprint
    if (modelFingerprint && currentFingerprint && modelFingerprint !== currentFingerprint) return {}
    return {
      modelHealth: { ...s.modelHealth, [index]: status },
      ...(detail != null ? { modelHealthDetail: { ...s.modelHealthDetail, [index]: detail } } : {}),
      ...(latencyMs != null ? { modelHealthLatency: { ...s.modelHealthLatency, [index]: latencyMs } } : {}),
    }
  }),
  setTokenUsage: (usage) =>
    set({
      tokenUsage: {
        prompt: usage.prompt,
        completion: usage.completion,
        total: usage.total,
        byModel: usage.byModel ?? {},
      },
    }),
})
