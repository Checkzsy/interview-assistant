/** Shared byte formatter for progress text (settings download UI + updater card). */
export function formatBytes(n: number | null | undefined): string {
  const num = Number(n) || 0
  if (num <= 0) return '—'
  if (num < 1024) return `${num} B`
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`
  return `${(num / 1024 / 1024).toFixed(1)} MB`
}
