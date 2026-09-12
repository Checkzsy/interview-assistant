# interview-assistant 技术栈与架构分析

- 分析日期：2026-09-08（Asia/Shanghai）。
- 本地目录：`E:\Project\interview_assistant`。
- 用户指定仓库：`Checkzsy/interview-assistant`；已通过 git clone 克隆到当前目录。
- 分支：`main`；提交：`57936d6aec89a6844ee9b980acff6aaba7077ceb`。
- 提交时间：2026-08-12 22:39:02 +08:00。
- GitHub 第一方 API 元数据确认该仓库是 `powAu3/interview-assistant` 的 fork。本文只针对用户指定 fork 的上述提交，不把上游状态混为一谈。
- 范围：源码、依赖清单和锁文件、桌面纯逻辑测试、Python 语法检查。不包含完整部署、真实语音/模型 API 压测、屏幕共享兼容性验证。

## 1. 核心结论

这是一个“本地 Python 服务 + React Web 界面 + Electron 桌面容器”的个人面试辅助工作台，不是自行训练大模型的项目，也不是只有几页 UI 的聊天包装。它把音频采集、转写、问句处理、模型调度、截图、个人材料、复盘和求职管理串在一起。核心 AI 生成通过用户配置的 OpenAI-compatible 服务提供；本地可运行的是 Whisper 语音识别路径，不能据此称整个应用默认离线。[S1][S2][S3][S4][S5]

桌面端与浏览器端复用同一套前端及后端。主要页面为实时辅助、面试复盘、能力分析、简历优化、求职看板；当前主导航没有单独的 AI 模拟面试官页面，不把“面试复盘”或“真实面试辅助”自动视为“模拟面试”。[S6]

## 2. 技术栈（优先以锁文件/源码而非宣传为准）

| 层次 | 已确认技术 | 作用与注意点 |
|---|---|---|
| UI | React 18.3.1、TypeScript 5.9.3 | React 组件化界面；TS 版本来自 package-lock，不是 package.json 中的最低范围 |
| 构建 | Vite 6.4.2 | 开发服务器、生产静态资源构建 |
| 状态 | Zustand 5.0.11 | 配置、转录、回答、UI 状态；有按 slice 拆分和局部订阅 |
| 样式 | Tailwind CSS 3.4.19、PostCSS、lucide-react | 样式和图标；未看到使用 Semi Design、Ant Design 等整套 UI 库的依赖 |
| 专项 UI | react-markdown、react-syntax-highlighter、TanStack Table、dnd-kit、qrcode | Markdown/代码答案、表格、拖拽和局域网二维码 |
| 桌面 | Electron 41.3.0、Node.js JavaScript | 窗口、托盘、快捷键、悬浮窗、IPC；不是 Rust/Tauri 客户端 |
| API | Python、FastAPI、Uvicorn、Pydantic 2 | REST 配置/文件/记录接口、输入验证、生命周期管理 |
| 实时通信 | WebSocket | 向前端推送转录、答案片段、状态；不是只靠 HTTP 轮询 |
| 并发 | asyncio + threading + 队列/调度器 | 音频、转写、回答工作线程、广播队列、任务取消/过期处理 |
| 音频 | sounddevice/PortAudio、NumPy；Windows 可选 soundcard/WASAPI | 麦克风和系统音频、重采样、能量/VAD 处理 |
| ASR | faster-whisper、豆包 STT、通用 HTTP ASR | 本地识别或云端服务；通用接口使用 `/audio/transcriptions` |
| LLM | Python openai SDK、requests、OpenAI-compatible API | 可配置多个供应商/模型、并行调度、流式回答、Think、Vision |
| 截图/文档 | mss、Pillow、PyMuPDF、pypdf、python-docx | 截图、PDF/DOCX/文本材料、识图辅助；OCR 有可选依赖 |
| 持久化 | SQLite + JSON + 本地文件目录 | 复盘、知识点、简历历史、求职记录、配置与知识库 |
| 知识库 | SQLite FTS5 + BM25 + 中文 bigram | 关键词/全文检索式增强，不是向量数据库/Embedding 检索 |
| 工程验证 | pytest、Ruff、Vitest、Testing Library、Playwright、node:test、GitHub Actions | 单元、接口、UI、E2E 与部分视觉回归；有测试不等于本轮全部通过 |

依赖依据：[S2][S3][S7][S8][S9][S10][S11]。Python 依赖使用版本范围且未见 Python 锁文件，因此不能给出“本机已安装的精确后端版本”。`three` 虽在依赖中，但本次没有在 `frontend/src` 找到直接使用证据，不应把 3D 渲染列为主架构能力。

## 3. 运行架构和核心路径

```text
start.py
  ├─ 桌面模式：Electron（main.js / preload.js）
  │                └─ 加载本地 HTTP 服务上的 React 页面
  └─ 网络模式：浏览器/同局域网手机访问页面
                         │ REST + WebSocket
                   FastAPI / Uvicorn
                         │
     系统音频/麦克风 → 分段/VAD → ASR → 文本清理/问句分组
                                            │
                                调度器：优先级、取消、并发限制
                                            │
         本地简历 + 相关历史 + FTS5 知识片段 + 可选截图
                                            │
                              OpenAI-compatible LLM
                                            │
                         流式回答 → WebSocket → UI
                                            │
                      SQLite / JSON / 本地文件持久化
```

入口默认服务端口为 18080；开发阶段可用 Vite 代理。生产前端构建产物由 Python 服务提供。[S1][S4][S5][S12]

### 3.1 真正有工程量的是实时流水线

代码不只是“录音后调用一次 API”。存在音频分段、ASR 确认/合并窗口、候选人麦克风上下文、正在生成回答的中断/过期处理、模型并行槽位、追问上下文和停止时清理等实现。它们主要分布在 `pipeline.py`、`asr_state.py`、`scheduler.py`、`answer_worker.py`。这是延迟、连贯性和稳定性的关键，但源码存在这些机制不能证明实际延迟数值。[S13]

### 3.2 知识库是轻量全文检索，不是完整向量 RAG

导入文件后进行文本提取和分块，写入 SQLite FTS5；查询按中文 bigram/词项组成 MATCH 表达式，经 BM25 排序，取 Top-K 片段注入模型提示词。可选 OCR/视觉补充属于文档提取链路，不等于有 Embedding 模型或 reranker。[S10]

优点是依赖轻、索引本地化、部署简单；同义词、跨语言或纯语义关联的召回不能直接等同于向量检索效果。后半句是基于检索机制的工程判断，不是本轮效果评测。

### 3.3 桌面特性来自 Electron/平台能力

`main.js` 使用 `BrowserWindow`、`globalShortcut`、`Tray`，通过 `preload.js` 暴露 IPC。代码启用了 `contextIsolation: true`、`nodeIntegration: false`，并调用 `setContentProtection(true)`，实现桌面主窗/悬浮窗等逻辑。[S5]

代码和 README 自身均提示屏幕捕获保护存在平台/会议软件差异。没有对腾讯会议、飞书、Zoom 等做本轮实测，不能把这类能力写成“绝对不可检测/共享必定不可见”。[S1][S5]

### 3.4 本地存储不等于不出网

配置写入 `backend/config.json`，多个 SQLite 数据库统一放在 `backend/data`，知识库路径在配置中可改。模型 API key 等由 JSON 配置持久化，未见系统凭据库加密存储流程。调用远端 ASR 会发送音频，调用远端 LLM/Vision 会发送相应文本/材料/图像上下文；使用本地 Whisper 只减少转写链路的外发。[S3][S9][S14]

网络模式会启用局域网 token 机制，但这是个人/局域网应用鉴权，不是面向公网多租户的账号、角色和配额体系。不要直接把本地服务端口裸露到公网。[S12][S15]

## 4. 工程成熟度与实际门槛

### 有价值的已有基础

- 模块不止实时答题：有复盘、能力分析、简历优化、求职看板和 Offer 数据管理。[S6][S14]
- 有 51 个后端 `test_*.py`、41 个前端单测文件、6 个前端 E2E spec（按当前提交的文件清单统计；数量不是通过率）。
- GitHub Actions 包含后端检查、前端类型检查/测试/构建、桌面测试、Playwright 功能/视觉测试等任务。[S11]
- 源码可本地检查和修改，供应商 API 可替换。[S3][S9]

### 需要注意的不足/工作量

1. **部署不是单一成品安装包**：本仓库桌面 package.json 仅声明 `electron .` 启动，需准备 Python/Node、构建前端、安装桌面依赖；未见 electron-builder/自动更新配置。[S1][S5][S7]
2. **Windows 系统音频有额外依赖**：`soundcard` 在源码中可选导入，但未列入 `backend/requirements.txt`；音频文档明确要求另行安装。默认装完 requirements 不代表系统音频一定可采集。[S8]
3. **本地 Whisper 模型需要准备**：代码会加载 WhisperModel，本轮未下载模型权重，也未测 CPU/GPU 转写效果。[S9]
4. **模型/语音服务通常仍有费用**：源码本身没有发现订阅收费逻辑，但远端 API 使用和额度需由用户管理。是否免费取决于所选服务，不能把软件源码免费等同于无限免费推理。[S3][S9]
5. **维护复杂度已不低**：例如 `pipeline.py` 1933 行、`answer_worker.py` 1270 行、`desktop/main.js` 1260 行（含注释）；实时并发状态与大型组件会增加改动回归风险。此为源码结构判断，不是已证明的线上故障。
6. **版本要求需以工具链为准**：README 标注 Node 18+，但 lockfile 中实际工具链已较新；安装时应核对 package-lock 的 engines。此次本机 Node 24.16.0 仅用于无依赖桌面逻辑测试，尚未验证完整构建兼容性。[S1][S7]

## 5. 许可证：不能忽略的差异

LICENSE 明确为 **CC BY-NC 4.0**，包含署名和非商业使用条件，不是 MIT/Apache 这类宽松软件许可。可见源码不等于可以直接拿来做收费 SaaS/客户端；如果计划商业化，应先与权利人确认可获得的商用授权及范围。本段是仓库许可文字的提示，不构成对具体商业模式的法律结论。[S16]

## 6. 本轮验证结果

- Git 克隆、origin、分支和提交信息已核查。
- `node --test multiScreenBatch.test.js windowOptions.test.js shortcuts.test.js`：**13 通过、0 失败**。日志：`.research-artifacts/desktop-unit-tests.txt`。
- 本次复核对仓库 `backend/` 的 141 个 Python 文件和安装包 `backend/` 的 84 个 Python 文件进行 AST 解析，共 225 个文件通过；没有执行模块导入，不代表第三方依赖或运行时通过。
- 未安装完整项目依赖；未构建前端；未运行完整后端/前端/Electron 测试集。`preload.test.js` 依赖 Electron 模块，本轮未执行。
- 未启动助手、未访问个人音频/屏幕、未填入 API key、未产生付费模型调用。
- 未修改业务代码、未提交或推送 Git。新增的分析文档位于 `docs/research`；临时证据放在 git 忽略的 `.research-artifacts`。

## 7. 第一方源码索引

以下相对链接均指向本地已克隆的固定提交快照；GitHub 仓库/提交信息另外由 git 和 GitHub API 验证。

- [S1] [README](../../README.md)
- [S2] [前端依赖声明](../../frontend/package.json)、[前端锁文件](../../frontend/package-lock.json)
- [S3] [配置示例](../../backend/config.example.json)、[LLM 客户端及流式生成](../../backend/services/llm/streaming.py)
- [S4] [FastAPI 主入口](../../backend/main.py)、[WebSocket](../../backend/api/realtime/ws.py)
- [S5] [Electron 主进程](../../desktop/main.js)、[preload](../../desktop/preload.js)、[桌面依赖](../../desktop/package.json)、[桌面锁文件](../../desktop/package-lock.json)
- [S6] [主导航和模块](../../frontend/src/App.tsx)
- [S7] [前端锁文件](../../frontend/package-lock.json)、[启动器](../../start.py)
- [S8] [音频采集](../../backend/services/audio.py)、[后端依赖](../../backend/requirements.txt)、[音频配置说明](../音频配置.md)
- [S9] [ASR 引擎](../../backend/services/stt/engines.py)、[ASR 工厂与 fallback](../../backend/services/stt/factory.py)、[LLM](../../backend/services/llm/streaming.py)
- [S10] [知识库 store](../../backend/services/kb/store.py)、[retriever](../../backend/services/kb/retriever.py)、[indexer](../../backend/services/kb/indexer.py)、[PDF loader](../../backend/services/kb/loaders/pdf.py)
- [S11] [GitHub Actions CI](../../.github/workflows/ci.yml)、[前端测试脚本](../../frontend/package.json)、[Ruff 配置](../../backend/pyproject.toml)
- [S12] [启动器](../../start.py)、[Vite 配置](../../frontend/vite.config.ts)
- [S13] [实时流水线](../../backend/api/assist/pipeline.py)、[调度器](../../backend/api/assist/scheduler.py)、[ASR 状态](../../backend/api/assist/asr_state.py)、[回答 worker](../../backend/api/assist/answer_worker.py)
- [S14] [存储路径](../../backend/services/storage/paths.py)、[简历历史](../../backend/services/storage/resume_history.py)、[求职数据库](../../backend/services/storage/job_tracker.py)、[配置持久化](../../backend/core/config.py)
- [S15] [鉴权](../../backend/core/auth.py)
- [S16] [LICENSE](../../LICENSE)

