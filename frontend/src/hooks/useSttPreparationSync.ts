import { useEffect } from 'react'
import { useInterviewStore } from '@/stores/configStore'
import { api } from '@/lib/api'

const POLL_INTERVAL_MS = 4000
const IDLE_INTERVAL_MS = 15000
const ACTIVE_PHASES = new Set(['queued', 'resolving', 'downloading', 'loading'])

/**
 * Snapshot-backed preparation status for clients that do not receive WS
 * increments (follower tabs) or whose socket is currently down.
 *
 * The WS leader already gets every preparation frame; polling there would just
 * duplicate traffic. While enabled this keeps one request in flight and polls
 * fast only while some consumer is actually preparing; the idle heartbeat stays
 * on so a download that starts later (leader tab, startup preload) still shows
 * up here.
 */
export function useSttPreparationSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const status = await api.getSttStatus()
        if (cancelled) return
        if (status.preparation) {
          useInterviewStore.getState().applySttPreparation(status.preparation, status.config_version)
        }
      } catch {
        // Status is best-effort: a missed poll only leaves the chip stale and
        // the download itself keeps running in the backend.
      }
      if (cancelled) return
      const snapshot = useInterviewStore.getState().sttPreparation
      const active = [...snapshot.states, snapshot.active].some(
        (state) => state && ACTIVE_PHASES.has(state.phase) && state.roles.length > 0,
      )
      timer = setTimeout(tick, active ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [enabled])
}
