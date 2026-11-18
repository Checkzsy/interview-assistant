import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, getErrorMessage } from './api'

function jsonResponse(body: unknown, init: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('api error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('formats FastAPI validation detail arrays into readable field messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(
        {
          detail: [
            {
              loc: ['body', 'screen_capture_region'],
              msg: 'Input should be one of full,left_half',
            },
          ],
        },
        { status: 422, statusText: 'Unprocessable Entity' },
      ),
    ))

    await expect(api.getConfig()).rejects.toThrow(
      '请求失败 (422): body.screen_capture_region: Input should be one of full,left_half',
    )
  })

  it('keeps non-json server failures actionable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('upstream gateway timeout', { status: 504, statusText: 'Gateway Timeout' }),
    ))

    await expect(api.getConfig()).rejects.toThrow(
      '请求失败 (504): upstream gateway timeout',
    )
  })

  it('normalizes network failures to a product-facing backend message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(api.getConfig()).rejects.toThrow(
      '无法连接后端服务，请确认应用服务已启动后重试',
    )
  })

  it('normalizes upload network failures to the same backend message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(api.uploadResume(new File(['demo'], 'resume.pdf'))).rejects.toThrow(
      '无法连接后端服务，请确认应用服务已启动后重试',
    )
    await expect(api.kbUpload(new File(['demo'], 'notes.md'))).rejects.toThrow(
      '无法连接后端服务，请确认应用服务已启动后重试',
    )
  })

  it('extracts safe messages from unknown caught values', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom')
    expect(getErrorMessage({ detail: 'backend says no' })).toBe('backend says no')
    expect(getErrorMessage(null, '兜底失败')).toBe('兜底失败')
  })
})

describe('stt preparation api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends an optional identity body for a staged test', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false, pending: true, config_version: 'v-1' }, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.sttTest({ model: 'medium', language: 'zh', config_version: 'v-1', attempt_id: 'a1', retry: true })

    expect(result.pending).toBe(true)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'medium',
      language: 'zh',
      config_version: 'v-1',
      attempt_id: 'a1',
      retry: true,
    })
  })

  it('keeps the body-less legacy call working', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, text: 'demo' }, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.sttTest()).resolves.toMatchObject({ ok: true, text: 'demo' })
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  it('returns the preparation snapshot from status', async () => {
    const payload = {
      loaded: false,
      loading: true,
      model: 'medium',
      provider: 'whisper',
      config_version: 'v-1',
      preparation: { runtime_id: 'rt-1', revision: 3, active: null, pending: [], states: [] },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload, { status: 200 })))

    await expect(api.getSttStatus()).resolves.toMatchObject({
      config_version: 'v-1',
      preparation: { revision: 3 },
    })
  })
})
