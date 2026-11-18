/**
 * Whisper 模型下拉项的显示文案。
 *
 * 安装包只内置一部分模型（当前是 base），其余模型首次使用需要联网下载。
 * 用户分不清两者，会误以为选了就要卡住下载；这里把归属直接写在选项上。
 */

export const WHISPER_MODEL_SIZE_HINTS: Record<string, string> = {
  tiny: '约 75 MB',
  base: '约 145 MB',
  small: '约 480 MB',
  medium: '约 1.5 GB',
  'large-v3': '约 3 GB',
}

export function whisperModelOptionLabel(model: string, bundled: readonly string[] | undefined): string {
  const hint = WHISPER_MODEL_SIZE_HINTS[model]
  if (bundled?.includes(model)) {
    return hint ? `${model} · 已内置，离线可用 (${hint})` : `${model} · 已内置，离线可用`
  }
  return hint ? `${model} · 需下载 (${hint})` : `${model} · 需下载`
}
