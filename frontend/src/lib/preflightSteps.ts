// 实时辅助/笔试预检面板共享的步骤状态工具。
// 两个面板消费同一协议的后端 preflight 步骤事件（preflight_step / exam_preflight_step），
// 状态结构与展示格式完全一致，统一从这里走避免逐组件复制。

export type StepStatus = 'idle' | 'running' | 'pass' | 'fail' | 'warn' | 'skip' | 'done'

export interface StepState {
  status: StepStatus
  detail: string
  answer?: string
  question?: string
  transcript?: string
  expected_phrase?: string
  first_token_ms?: number
  total_ms?: number
  model_name?: string
}

export function formatLatency(ms?: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeStatusSteps(value: unknown): Record<string, Partial<StepState>> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, step]) => isRecord(step)),
  ) as Record<string, Partial<StepState>>
}

// 预检面板共用的 /ws 连接：ping → pong 心跳由这里统一处理，
// 其余帧交给组件自己的消息解析器。
export function attachPreflightWebSocket(
  ws: WebSocket,
  handleMessage: (event: MessageEvent) => void,
): void {
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg?.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }
    } catch {
      /* malformed frames are ignored by the component message parser */
    }
    handleMessage(event)
  }
}
