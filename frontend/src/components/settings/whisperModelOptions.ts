/**
 * Whisper 模型下拉项的显示文案。
 *
 * 三个状态要分开：安装包自带（不可删）、已下载到本机缓存（可删）、尚未下载。
 * 用户删掉已下载的模型后，状态应立刻回到“需下载”，下次使用重新下载。
 */

export const WHISPER_MODEL_SIZE_HINTS: Record<string, string> = {
  tiny: '约 75 MB',
  base: '约 145 MB',
  small: '约 480 MB',
  medium: '约 1.5 GB',
  'large-v3': '约 3 GB',
}

export interface WhisperModelState {
  model: string
  status: 'bundled' | 'downloaded' | 'missing'
  path: string
  deletable: boolean
}

/**
 * `states` is the on-disk truth from /api/stt/models. Until it loads we fall
 * back to the older bundled list so the select still renders honest labels
 * instead of guessing everything is already downloaded.
 */
export function whisperModelOptionLabel(
  model: string,
  states: readonly WhisperModelState[] | undefined,
  bundled: readonly string[] | undefined,
): string {
  const hint = WHISPER_MODEL_SIZE_HINTS[model]
  const state = states?.find((entry) => entry.model === model)
  const suffix = hint ? ` (${hint})` : ''

  if (state?.status === 'bundled' || (!state && bundled?.includes(model))) {
    return `${model} · 已内置，离线可用${suffix}`
  }
  if (state?.status === 'downloaded') {
    return `${model} · 已下载，可直接使用${suffix}`
  }
  return `${model} · 需下载${suffix}`
}

/**
 * Human-readable location for the currently selected model, so the user can
 * find and delete it. Bundled files live inside the install directory and must
 * not be deleted — saying so plainly is more useful than hiding the path.
 */
export function whisperModelPathHint(
  model: string,
  states: readonly WhisperModelState[] | undefined,
): string | null {
  const state = states?.find((entry) => entry.model === model)
  if (!state) return null
  if (state.status === 'bundled') {
    return `内置模型位置：${state.path}（随安装包提供，请勿删除）`
  }
  if (state.status === 'downloaded') {
    return `已下载到：${state.path}（可删除；删除后再次选择该模型会重新下载）`
  }
  return `下载后会保存到：${state.path}`
}
