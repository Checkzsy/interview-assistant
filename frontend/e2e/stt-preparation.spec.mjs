/**
 * Replay of the original "saved small -> switched to medium -> 保存并测试 spins
 * forever" flow at the real UI boundary.
 *
 * Everything is intercepted: /api/config, /api/options, /api/stt/status,
 * /api/stt/test and the WebSocket (installMocks replaces it with a scripted
 * socket). No backend, no model download, no microphone.
 *
 * The staged protocol is: POST /api/stt/test returns `pending` while the model
 * is still resolving/downloading; the settings panel then polls
 * GET /api/stt/status with at most one in-flight request, and issues the real
 * test exactly once after the model is ready. Preparation state must never be
 * rounded up to 100%, must survive closing the drawer, and a late result must
 * not resurrect an operation the user has already edited away from.
 *
 * Backend counterpart at real lane/HTTP/WS/stop boundaries:
 * backend/tests/test_stt_switch_lifecycle.py
 */
import { test, expect } from '@playwright/test'
import { installMocks, COMMON_WS_BOOTSTRAP } from './fixtures/setup.mjs'

const SMALL_VERSION = 'v-small'
const MEDIUM_VERSION = 'v-medium'
const MEDIUM_TOTAL_BYTES = 1_528_000_000

const SAMPLE_CONFIG = {
  models: [{ name: 'GPT-4.1 Mini', supports_think: true, supports_vision: true, enabled: true }],
  active_model: 0,
  model_name: 'GPT-4.1 Mini',
  temperature: 0.2,
  max_tokens: 2048,
  think_mode: true,
  stt_provider: 'whisper',
  whisper_model: 'small',
  whisper_language: 'zh',
  doubao_stt_app_id: '',
  doubao_stt_access_token: '',
  doubao_stt_api_key: '',
  doubao_stt_resource_id: '',
  doubao_stt_boosting_table_id: '',
  generic_stt_api_base_url: '',
  generic_stt_api_key: '',
  generic_stt_model: '',
  generic_stt_custom_headers: '',
  candidate_asr_enabled: false,
  candidate_stt_provider: 'whisper',
  candidate_whisper_model: '',
  candidate_whisper_language: '',
  candidate_remote_stt_enabled: false,
  candidate_context_enabled: false,
  candidate_context_wait_ms: 1200,
  candidate_context_max_chars: 900,
  candidate_context_min_chars: 6,
  candidate_streaming_asr_enabled: false,
  candidate_streaming_asr_interval_ms: 1500,
  candidate_mic_compatibility_mode: false,
  position: '后端开发工程师',
  language: '中文',
  auto_detect: false,
  silence_threshold: 0.01,
  silence_duration: 1.2,
  api_key_set: true,
  has_resume: false,
  max_parallel_answers: 2,
  stt_config_version: SMALL_VERSION,
}

const SAMPLE_OPTIONS = {
  stt_providers: ['whisper', 'doubao', 'generic'],
  whisper_models: ['tiny', 'base', 'small', 'medium', 'large-v3'],
  languages: ['auto', 'zh', 'en', 'ja'],
}

const DEFAULT_STATUS = {
  loaded: true,
  loading: false,
  model: 'small',
  provider: 'whisper',
  config_version: SMALL_VERSION,
  preparation: { runtime_id: null, revision: 0, active: null, pending: [], states: [] },
}

function mediumConfig() {
  return { ...SAMPLE_CONFIG, whisper_model: 'medium', stt_config_version: MEDIUM_VERSION }
}

function prepState(overrides = {}) {
  return {
    key: ['medium', 'zh'],
    attempt_id: 'attempt-medium',
    phase: 'resolving',
    downloaded_bytes: null,
    total_bytes: null,
    progress: null,
    started_at: 1,
    updated_at: 2,
    error: null,
    roles: ['main'],
    ...overrides,
  }
}

function snapshot(states, revision) {
  return { runtime_id: 'runtime-e2e', revision, active: null, pending: [], states }
}

function statusPayload(preparation, phase = 'downloading') {
  return {
    loaded: phase === 'ready',
    loading: phase !== 'ready',
    model: 'medium',
    provider: 'whisper',
    config_version: MEDIUM_VERSION,
    preparation,
  }
}

async function openSpeechSettings(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '学习助手' })).toBeVisible()
  await page.getByRole('button', { name: '打开设置' }).click()
  const speechTab = page.getByRole('button', { name: '语音', exact: true })
  await speechTab.click()
  await expect(page.getByRole('heading', { name: '主链路 ASR（面试官 / 会议音频）' })).toBeVisible()
}

/** The Whisper model select is the only one that also offers "medium". */
function modelSelect(page) {
  return page.locator('select:has(option[value="medium"])').first()
}

test.describe('STT switch: saved small -> medium preparation', () => {
  test.beforeEach(async ({ context }) => {
    // Wire-level interception: every /api/** call is fulfilled locally and the
    // real WebSocket is replaced by a scripted one. A small-model preparation
    // snapshot is pushed over WS too, so the HTTP snapshot later has to win.
    await installMocks(context, {
      messages: [
        ...COMMON_WS_BOOTSTRAP,
        {
          type: 'stt_preparation',
          config_version: SMALL_VERSION,
          preparation: snapshot(
            [prepState({ key: ['small', 'zh'], attempt_id: 'attempt-small', phase: 'ready', progress: 100 })],
            0,
          ),
        },
      ],
      localStorage: { 'ia-color-scheme': 'vscode-light-plus' },
    })
  })

  test('waits for medium preparation (resolving -> percent -> 100 -> ready), then tests once', async ({ context, page }) => {
    const calls = { test: 0, status: 0 }
    const savedConfigs = []
    const testBodies = []
    let configSaved = false
    let preparation = snapshot([prepState({ phase: 'resolving' })], 1)

    await context.route('**/api/config', async (route) => {
      if (route.request().method() === 'POST') {
        savedConfigs.push(route.request().postDataJSON() ?? {})
        configSaved = true
        preparation = snapshot([prepState({ phase: 'resolving' })], 2)
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify(mediumConfig()),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(configSaved ? mediumConfig() : SAMPLE_CONFIG),
      })
    })

    await context.route('**/api/options', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(SAMPLE_OPTIONS),
      })
    })

    await context.route('**/api/stt/status', async (route) => {
      calls.status += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(statusPayload(preparation, preparation.states[0]?.phase)),
      })
    })

    await context.route('**/api/stt/test', async (route) => {
      calls.test += 1
      testBodies.push(route.request().postDataJSON() ?? {})
      const phase = preparation.states[0]?.phase
      if (phase !== 'ready') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            ok: false,
            pending: true,
            config_version: MEDIUM_VERSION,
            attempt_id: 'attempt-medium',
            state: preparation.states[0],
          }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ ok: true, text: '切换后的测试转写', config_version: MEDIUM_VERSION }),
      })
    })

    await openSpeechSettings(page)
    await modelSelect(page).selectOption('medium')
    await page.getByRole('button', { name: '保存并测试' }).click()

    // Pending admission: no trustworthy byte denominator, so no percent is
    // invented — not 0%, and certainly not 100%.
    await expect.poll(() => calls.test).toBe(1)
    expect(testBodies[0]).toMatchObject({ model: 'medium', language: 'zh', config_version: MEDIUM_VERSION })
    await expect(page.getByText(/正在下载模型\s*\d+%/)).toHaveCount(0)
    await expect(page.getByText('连接成功', { exact: true })).toHaveCount(0)

    preparation = snapshot(
      [
        prepState({
          phase: 'downloading',
          downloaded_bytes: 458_400_000,
          total_bytes: MEDIUM_TOTAL_BYTES,
          progress: 30,
        }),
      ],
      3,
    )
    await expect(page.getByTestId('stt-preparation-status').getByText('正在下载模型 30%')).toBeVisible({ timeout: 10_000 })
    // The header chip mirrors the same truthful state, so the download is
    // visible without the settings drawer being open.
    await expect(page.locator('[title^="正在下载模型 30%"]')).toBeVisible()

    // 99.9% is still a partial download: show 99, never round up to 100.
    preparation = snapshot(
      [
        prepState({
          phase: 'downloading',
          downloaded_bytes: 1_526_472_000,
          total_bytes: MEDIUM_TOTAL_BYTES,
          progress: 99.9,
        }),
      ],
      4,
    )
    await expect(page.getByTestId('stt-preparation-status').getByText('正在下载模型 99%')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/正在下载模型\s*100%/)).toHaveCount(0)
    expect(calls.test).toBe(1)

    // Bytes finished, weights still loading: progress must leave the download
    // wording instead of sitting at 100%.
    preparation = snapshot(
      [
        prepState({
          phase: 'loading',
          downloaded_bytes: MEDIUM_TOTAL_BYTES,
          total_bytes: MEDIUM_TOTAL_BYTES,
          progress: 100,
        }),
      ],
      5,
    )
    await expect(page.getByText(/正在下载模型\s*\d+%/)).toHaveCount(0, { timeout: 10_000 })
    expect(calls.test).toBe(1)

    // Ready: the real test fires exactly once for the saved medium identity.
    preparation = snapshot(
      [
        prepState({
          phase: 'ready',
          downloaded_bytes: MEDIUM_TOTAL_BYTES,
          total_bytes: MEDIUM_TOTAL_BYTES,
          progress: 100,
        }),
      ],
      6,
    )
    await expect(page.getByText('连接成功', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/切换后的测试转写/)).toBeVisible()

    expect(calls.test).toBe(2)
    expect(testBodies[1]).toMatchObject({
      model: 'medium',
      language: 'zh',
      config_version: MEDIUM_VERSION,
      attempt_id: 'attempt-medium',
    })
    expect(savedConfigs).toHaveLength(1)
    expect(savedConfigs[0].whisper_model).toBe('medium')
  })

  test('pending preparation does not block closing the drawer, and resumes from the status snapshot', async ({ context, page }) => {
    let preparation = snapshot(
      [
        prepState({
          phase: 'downloading',
          downloaded_bytes: 305_600_000,
          total_bytes: MEDIUM_TOTAL_BYTES,
          progress: 20,
        }),
      ],
      3,
    )
    const calls = { test: 0, status: 0 }

    await context.route('**/api/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(mediumConfig()),
      })
    })
    await context.route('**/api/options', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(SAMPLE_OPTIONS),
      })
    })
    await context.route('**/api/stt/status', async (route) => {
      calls.status += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(statusPayload(preparation)),
      })
    })
    await context.route('**/api/stt/test', async (route) => {
      calls.test += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          ok: false,
          pending: true,
          config_version: MEDIUM_VERSION,
          attempt_id: 'attempt-medium',
          state: preparation.states[0],
        }),
      })
    })

    await openSpeechSettings(page)
    await page.getByRole('button', { name: '保存并测试' }).click()
    await expect(page.getByTestId('stt-preparation-status').getByText('正在下载模型 20%')).toBeVisible({ timeout: 10_000 })

    // Closing must be immediate: the pending download is a backend task, not a
    // modal operation, so the drawer cannot hang on it.
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByRole('heading', { name: '学习助手' })).toBeVisible()

    // No polling once the panel is unmounted (same rule as the unit test).
    const callsAtUnmount = calls.status
    await page.waitForTimeout(2600)
    expect(calls.status).toBe(callsAtUnmount)

    // Reopening recovers the same truthful preparation from /stt/status.
    // The drawer always reopens on the general tab, so speech must be selected
    // again before its panel exists.
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByRole('button', { name: '语音', exact: true }).click()
    await expect(page.getByRole('heading', { name: '主链路 ASR（面试官 / 会议音频）' })).toBeVisible()
    await expect(page.getByTestId('stt-preparation-status').getByText('正在下载模型 20%')).toBeVisible({ timeout: 10_000 })
    expect(calls.test).toBe(1)
  })

  test('a late readiness result after the user edits the selection is ignored', async ({ context, page }) => {
    let preparation = snapshot(
      [
        prepState({
          phase: 'downloading',
          downloaded_bytes: 458_400_000,
          total_bytes: MEDIUM_TOTAL_BYTES,
          progress: 30,
        }),
      ],
      3,
    )
    const calls = { test: 0 }

    await context.route('**/api/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(mediumConfig()),
      })
    })
    await context.route('**/api/options', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(SAMPLE_OPTIONS),
      })
    })
    await context.route('**/api/stt/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(statusPayload(preparation)),
      })
    })
    await context.route('**/api/stt/test', async (route) => {
      calls.test += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          ok: false,
          pending: true,
          config_version: MEDIUM_VERSION,
          attempt_id: 'attempt-medium',
          state: preparation.states[0],
        }),
      })
    })

    await openSpeechSettings(page)
    await page.getByRole('button', { name: '保存并测试' }).click()
    await expect(page.getByTestId('stt-preparation-status').getByText('正在下载模型 30%')).toBeVisible({ timeout: 10_000 })

    // The user moves on while the medium target is still preparing.
    await modelSelect(page).selectOption('small')
    await expect(page.getByText('有未保存更改').first()).toBeVisible()

    // The retired operation completes late. It must not claim success on the
    // selection the user is now editing, and must not fire a second test.
    preparation = snapshot(
      [
        prepState({
          phase: 'ready',
          downloaded_bytes: MEDIUM_TOTAL_BYTES,
          total_bytes: MEDIUM_TOTAL_BYTES,
          progress: 100,
        }),
      ],
      9,
    )
    await page.waitForTimeout(2600)
    await expect(page.getByText('连接成功', { exact: true })).toHaveCount(0)
    await expect(page.getByText('有未保存更改').first()).toBeVisible()
    expect(calls.test).toBe(1)
  })
})
