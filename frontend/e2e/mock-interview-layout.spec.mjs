/**
 * Mock interview layout regression: the global header must stay inside the
 * viewport and keep its controls reachable while the answer / feedback content
 * grows, and only the mock-interview pane may scroll.
 *
 * jsdom has no layout engine, so MockInterview.test.tsx cannot catch this.
 */
import { expect, test } from '@playwright/test'

import { COMMON_WS_BOOTSTRAP, installMocks } from './fixtures/setup.mjs'

const SESSION = {
  id: 7,
  status: 'created',
  company: 'ACME',
  role: '后端开发',
  language: '中文',
  planned_question_count: 2,
  question_count: 0,
  answered_question_count: 0,
  reviewed_question_count: 0,
  average_score: null,
}

const QUESTION = {
  id: 11,
  session_id: 7,
  seq: 1,
  question_text:
    '请完整介绍你在 FastAPI 项目里做过的一次接口性能优化：当时的流量规模、你如何定位瓶颈、最终采用了哪些手段，以及这些手段分别带来了多少收益和什么代价。',
  question_type: 'project',
  status: 'waiting_answer',
  skill_tags: ['FastAPI', '性能优化', 'Redis', 'SQLite', '可观测性'],
}

const ANSWER_TEXT = [
  '背景：订单查询接口在高峰期 QPS 约 1200，P95 延迟 800ms，上游网关开始出现超时重试。',
  '定位：先用访问日志按路由聚合耗时，再在可疑分支加 span，确认 70% 时间花在同一张大表的重复查询上。',
  '做法：对热点查询加 Redis 缓存并设置短 TTL，补了复合索引，把两个串行调用改成并发，最后给慢查询加了超时兜底。',
  '结果：P95 从 800ms 降到 120ms，超时重试基本消失，缓存命中率稳定在 92% 左右。',
  '取舍：缓存带来最多 30 秒的数据延迟，这个接口可以接受；并发调用提高了下游瞬时压力，所以限制了并发度。',
].join('\n')

const FEEDBACK = {
  id: 11,
  status: 'reviewed',
  overall_score: 8,
  feedback: {
    overall_score: 8,
    dimensions: [
      { name: '事实正确性', score: 8, comment: '技术描述基本正确，缓存与索引的收益说明可信。' },
      { name: '表达结构', score: 7, comment: '缺少背景与结果之间的衔接，建议先讲目标再讲手段。' },
      { name: '问题定位', score: 8, comment: '定位过程有数据支撑，说明了从日志到 span 的收敛路径。' },
      { name: '工程取舍', score: 7, comment: '提到了数据延迟，但没有说明如何验证这个延迟是可接受的。' },
      { name: '结果量化', score: 9, comment: '关键指标前后对比清晰，命中率和延迟都有具体数字。' },
    ],
    strengths: ['量化了性能收益', '定位过程有数据支撑', '主动说明了缓存的数据延迟代价'],
    improvements: ['补充排查过程和取舍的判断依据', '说明并发度限制是如何定出来的', '补一句回滚方案'],
    evidence: ['P95 延迟从 800ms 降到 120ms', '缓存命中率稳定在 92% 左右', '高峰 QPS 约 1200'],
    reference_answer:
      '建议按背景-做法-结果-取舍结构回答。\n背景先给流量和痛点，做法说明每一步为什么选它，结果给前后指标对比，取舍要讲清楚你接受了什么代价以及凭什么认为可以接受。',
  },
}

const ANSWERED = { ...QUESTION, status: 'answered', answer_text: ANSWER_TEXT }
const REVIEWED = { ...ANSWERED, ...FEEDBACK }

function installMockInterviewMocks(context) {
  return installMocks(context, {
    messages: COMMON_WS_BOOTSTRAP,
    localStorage: {
      'ia-color-scheme': 'vscode-light-plus',
      ia_app_mode: 'mock-interview',
    },
    apiOverrides: (pathname, method) => {
      if (pathname === '/api/mock-interview/sessions' && method === 'GET') {
        return { items: [], total: 0, page: 1, page_size: 20 }
      }
      if (pathname === '/api/mock-interview/sessions' && method === 'POST') return SESSION
      if (/^\/api\/mock-interview\/sessions\/\d+\/questions$/.test(pathname)) return QUESTION
      if (/^\/api\/mock-interview\/questions\/\d+\/answer$/.test(pathname)) return ANSWERED
      if (/^\/api\/mock-interview\/questions\/\d+\/feedback$/.test(pathname)) return REVIEWED
      return undefined
    },
  })
}

/** Geometry of the global app header plus page-level scroll state. */
function readShellMetrics(page) {
  return page.evaluate(() => {
    const header = document.querySelector('header.header-gradient')
    const root = document.getElementById('root')
    const box = header.getBoundingClientRect()
    return {
      header: { top: box.top, bottom: box.bottom, left: box.left, height: box.height, width: box.width },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      windowScrollY: window.scrollY,
      docScrollTop: document.documentElement.scrollTop,
      bodyScrollTop: document.body.scrollTop,
      rootScrollTop: root.scrollTop,
      rootScrollHeight: root.scrollHeight,
      rootClientHeight: root.clientHeight,
      docScrollHeight: document.documentElement.scrollHeight,
      docClientHeight: document.documentElement.clientHeight,
    }
  })
}

/**
 * The header must be fully inside the viewport and hit-testable — a header that
 * is painted but pushed out of view still passes toBeVisible().
 */
async function expectHeaderUsable(page, label) {
  const metrics = await readShellMetrics(page)
  const { header, viewport } = metrics
  expect(header.height, `${label}: header collapsed`).toBeGreaterThan(20)
  expect(header.top, `${label}: header pushed above viewport`).toBeGreaterThanOrEqual(0)
  expect(header.bottom, `${label}: header pushed below the fold`).toBeLessThanOrEqual(viewport.height)
  expect(metrics.windowScrollY, `${label}: window scrolled`).toBe(0)
  expect(metrics.rootScrollTop, `${label}: #root scrolled`).toBe(0)
  expect(
    metrics.rootScrollHeight,
    `${label}: #root content overflows the shell`,
  ).toBeLessThanOrEqual(metrics.rootClientHeight + 1)

  // The document itself must never become scrollable: html/body/#root are
  // overflow:hidden, so document-level overflow is still a scroll container that
  // can drag the fixed-height shell (and the header) out of view.
  expect(
    metrics.docScrollHeight,
    `${label}: 文档产生了页面级溢出，顶部工具栏可被滚出视口`,
  ).toBeLessThanOrEqual(metrics.docClientHeight + 1)

  const settingsButton = page.getByRole('button', { name: '打开设置' })
  const hit = await settingsButton.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const inViewport =
      r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth
    const topMost = document.elementFromPoint(x, y)
    return { inViewport, hits: !!topMost && (topMost === el || el.contains(topMost)) }
  })
  expect(hit.inViewport, `${label}: settings button outside viewport`).toBe(true)
  expect(hit.hits, `${label}: settings button not hit-testable`).toBe(true)

  return metrics
}

/** The mock-interview pane owns the scrolling, not the page shell. */
function readPaneMetrics(page) {
  return page.evaluate(() => {
    const heading = [...document.querySelectorAll('h1')].find((el) => el.textContent.trim() === '模拟面试')
    let pane = heading
    while (pane && pane !== document.body) {
      const style = getComputedStyle(pane)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') break
      pane = pane.parentElement
    }
    if (!pane || pane === document.body) return { found: false }
    const box = pane.getBoundingClientRect()
    return {
      found: true,
      overflowY: getComputedStyle(pane).overflowY,
      scrollTop: pane.scrollTop,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      top: box.top,
      bottom: box.bottom,
    }
  })
}

async function runMockInterviewFlow(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '模拟面试', level: 1 })).toBeVisible({ timeout: 10_000 })
  const atEntry = await expectHeaderUsable(page, '进入模拟面试')

  await page.getByLabel('岗位', { exact: true }).fill('后端开发')
  await page.getByRole('button', { name: '开始模拟面试' }).click()
  await expect(page.getByText('会话已创建')).toBeVisible({ timeout: 10_000 })
  await expectHeaderUsable(page, '会话已创建')

  await page.getByRole('button', { name: '生成下一题' }).click()
  await expect(page.getByText(QUESTION.question_text)).toBeVisible({ timeout: 10_000 })
  await expectHeaderUsable(page, '已出题')

  await page.getByLabel('你的回答').fill(ANSWER_TEXT)
  await expectHeaderUsable(page, '已填写回答')

  // Tabbing on from the answer box reaches the voice-upload file input. If that
  // input is pulled out of the scroll pane, focusing it scrolls the document and
  // takes the toolbar with it.
  await page.getByLabel('你的回答').focus()
  await page.keyboard.press('Tab')
  await expectHeaderUsable(page, '从回答框 Tab 到下一个控件后')

  await page.getByRole('button', { name: '提交回答' }).click()
  await expect(page.getByRole('button', { name: '生成点评' })).toBeEnabled({ timeout: 10_000 })
  await expectHeaderUsable(page, '已提交回答')

  await page.getByRole('button', { name: '生成点评' }).click()
  await expect(page.getByText('事实正确性')).toBeVisible({ timeout: 10_000 })
  const afterFeedback = await expectHeaderUsable(page, '已生成点评')

  return { atEntry, afterFeedback }
}

const VIEWPORTS = [
  { label: '标准桌面', width: 1440, height: 900 },
  { label: '较矮桌面', width: 1024, height: 600 },
  { label: '窄屏', width: 390, height: 844 },
]

/** Column placement of the three panels inside the mock-interview grid. */
function readGridSections(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('[class*="lg:grid-cols-"]')
    if (!grid) return { found: false }
    return {
      found: true,
      templateColumns: getComputedStyle(grid).gridTemplateColumns,
      sections: [...grid.children].map((el) => {
        const box = el.getBoundingClientRect()
        return {
          title: el.querySelector('h2')?.textContent?.trim() ?? '',
          left: box.left,
          width: box.width,
        }
      }),
    }
  })
}

test.describe('mock interview layout', () => {
  for (const viewport of VIEWPORTS) {
    test(`keeps the header usable through the answer flow @ ${viewport.label}`, async ({ context, page }) => {
      await installMockInterviewMocks(context)
      await page.setViewportSize({ width: viewport.width, height: viewport.height })

      const { atEntry, afterFeedback } = await runMockInterviewFlow(page)

      // The header must not move or resize as the answer/feedback content grows.
      expect(afterFeedback.header.top).toBeCloseTo(atEntry.header.top, 0)
      expect(afterFeedback.header.height).toBeCloseTo(atEntry.header.height, 0)

      // Content that overflows must scroll inside the mock-interview pane only.
      const pane = await readPaneMetrics(page)
      expect(pane.found, '找不到模拟面试滚动容器').toBe(true)
      expect(pane.scrollHeight, '点评后内容未超出滚动容器，无法验证滚动归属').toBeGreaterThan(
        pane.clientHeight,
      )

      await page.evaluate(() => {
        const heading = [...document.querySelectorAll('h1')].find((el) => el.textContent.trim() === '模拟面试')
        let el = heading
        while (el && el !== document.body) {
          const style = getComputedStyle(el)
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') break
          el = el.parentElement
        }
        el.scrollTop = el.scrollHeight
      })

      const scrolled = await readPaneMetrics(page)
      expect(scrolled.scrollTop, '滚动容器未发生滚动').toBeGreaterThan(0)
      expect(scrolled.top).toBeCloseTo(pane.top, 0)
      await expectHeaderUsable(page, '滚动到底部后')
    })
  }

  test('当前会话 panel is not squeezed into the narrow settings column', async ({ context, page }) => {
    await installMockInterviewMocks(context)
    await page.setViewportSize({ width: 1440, height: 900 })
    await runMockInterviewFlow(page)

    const grid = await readGridSections(page)
    expect(grid.found, '找不到模拟面试栅格容器').toBe(true)

    const settings = grid.sections.find((s) => s.title === '面试设置')
    const current = grid.sections.find((s) => s.title === '当前会话')
    expect(settings, '找不到面试设置面板').toBeTruthy()
    expect(current, '找不到当前会话面板').toBeTruthy()

    // 当前会话 holds the question, the answer box and the full feedback report, so
    // it belongs in the wide column — not auto-placed below 面试设置 at its width.
    expect(
      current.width,
      `当前会话被挤进窄列（宽度 ${current.width}，与面试设置 ${settings.width} 相同），` +
        `栅格声明 ${grid.templateColumns} 只有两列却有 ${grid.sections.length} 个子项`,
    ).toBeGreaterThan(settings.width + 1)
  })
})
