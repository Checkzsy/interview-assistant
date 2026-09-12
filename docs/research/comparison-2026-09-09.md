# interview-assistant 与 mianxiaozhu／面小助综合对比报告

- **报告日期：** 2026-09-09（Asia/Shanghai）
- **分析目录：** `E:\Project\interview_assistant`
- **GitHub 对象：** `https://github.com/Checkzsy/interview-assistant`
- **固定源码快照：** `main`，commit `57936d6aec89a6844ee9b980acff6aaba7077ceb`
- **安装包对象：** 用户提供的 `exe\mianxiaozhu-setup.exe`
- **分析方式：** Git 源码、依赖清单、归档内容、ASAR、Python 源码和官网公开页面的静态／只读分析。
- **安全边界：** 未安装、未启动或执行安装包内的 Electron、Python、JavaScript；未调用真实 ASR/LLM/API；未接触用户个人音频、屏幕或账号。

> 本报告回答的是“技术和功能上有什么差异”，不是对产品归属、侵权、商业授权或隐私承诺作法律结论。

## 1. 执行摘要

### 1.1 两个对象分别是什么

GitHub 项目是一个偏源码／开发者形态的本地面试辅助工作台：React 前端通过 Vite 构建，Electron 提供桌面容器，Python/FastAPI 提供本地 API 和实时服务，AI 能力通过用户配置的 OpenAI-compatible 服务接入。它覆盖实时辅助、面试复盘、能力分析、简历优化和求职看板，但在本次固定 commit 中没有独立的 AI 模拟面试官模块。

用户提供的安装包则是一个产品化桌面发行物：包含 Electron 壳、打包好的 React 前端、内置 Python runtime 和 FastAPI 后端。相对 GitHub 当前 commit，安装包相对该固定 commit 多出账号／远程服务代理、模拟面试、SVIP 实时翻译和 Chroma 向量检索等静态代码与构建资源，并带有套餐、身份等级和面试时长消耗相关代码。

### 1.2 最重要的差异

1. **工程形态：** GitHub 项目需要自行准备运行环境；安装包已经把桌面壳、前端和 Python runtime 集成在一起。
2. **产品化：** GitHub 当前版本以本地配置和本地使用为主；安装包有登录、JWT、心跳、身份等级和远程服务代理逻辑。
3. **模拟面试：** GitHub 当前 commit 没有独立模拟面试模块；安装包有会话、出题、提交回答、回答点评、参考答案和整场报告接口。
4. **知识库：** GitHub 使用 SQLite FTS5/BM25 和中文 bigram 检索；安装包采用 BM25 + Chroma + Embedding，并使用 RRF 融合，失败或超时可降级到 BM25。
5. **商业成本：** GitHub 源码没有发现套餐／订阅扣时逻辑，但模型和语音服务费用由使用者承担；官网页面展示免费试用、时长包和买断档。
6. **授权风险：** GitHub 仓库许可证为 CC BY-NC 4.0；源码可见不等于可以直接复制后做收费客户端、SaaS 或商业分发。
7. **代码关系：** GitHub 源码与安装包后端存在大量逐文件完全相同或高度相似的实现，但这只是静态相似性发现，不能单独证明盗用、侵权或未经授权。

## 2. 证据范围与对象身份

### 2.1 GitHub 源码

分析的是用户指定 fork 的固定 commit，而不是上游仓库或未来版本。GitHub API 元数据表明该仓库是 `powAu3/interview-assistant` 的 fork；本报告不据此推断两个仓库或产品之间的权利关系。

### 2.2 官网

用户指定域名 `mianxiaozhu.com.cn` 在 2026-09-08 的只读 HTTP 页面实际显示的品牌是 **“面小助”**。域名、安装包文件名和官网品牌并不完全一致，因此以下使用“mianxiaozhu／面小助”作为技术对比对象，不擅自断言“面小猪”是正式产品名、旧名或同一运营主体。

官网材料属于产品宣传和公开文档证据。官网宣称的本地加密、数据不传云端、不用于模型训练和防录屏，本次没有通过运行客户端、抓包、磁盘检查或录屏兼容性测试独立验证。

### 2.3 安装包

样本路径与摘要：

```text
E:\Project\interview_assistant\exe\mianxiaozhu-setup.exe
size:   189,814,932 bytes
SHA256: cbc221a82228abbccb751ae5ce256b0c60dd224e20a5f2f57b93dd43186878ae
```

静态归档中可见：

```text
resources/backend/
resources/frontend/
resources/python-runtime/
resources/app.asar
resources/start.py
mianxiaozhu.exe
```

PE 容器的 Machine 标记为 `IMAGE_FILE_MACHINE_I386`。这只能说明安装器容器的 PE 标记，不能据此断言实际 Electron／Python 应用是 32 位。当前也没有完成 Authenticode 数字签名信任验证，因此不应声称该安装包已通过官方签名认证。

## 3. GitHub 项目的技术栈与架构

### 3.1 技术栈

| 层次 | 技术 | 主要用途 |
|---|---|---|
| 前端 | React 18.3.1、TypeScript 5.9.3 | 页面、组件和类型约束 |
| 构建 | Vite 6.4.2 | 开发服务器和生产构建 |
| 状态 | Zustand 5.0.11 | 配置、转录、回答和 UI 状态 |
| 样式 | Tailwind CSS 3.4.19、PostCSS、lucide-react | 样式与图标 |
| 桌面 | Electron 41.3.0、Node.js | 窗口、托盘、快捷键、浮窗和 IPC |
| 后端 | Python、FastAPI、Uvicorn、Pydantic 2 | REST API、校验和生命周期管理 |
| 通信 | REST + WebSocket | 配置／文件接口和实时推送 |
| 音频 | sounddevice/PortAudio、NumPy；Windows 可选 SoundCard/WASAPI | 麦克风及系统音频采集、重采样、VAD |
| ASR | faster-whisper、本地 Whisper、豆包 ASR、OpenAI-compatible transcription | 语音转写 |
| LLM | Python openai SDK、requests、OpenAI-compatible API | 多模型、流式回答、Think、Vision |
| 截图与文档 | mss、Pillow、PyMuPDF、pypdf、python-docx | 截图、PDF/DOCX/文本读取和识图上下文 |
| 存储 | SQLite、JSON、本地文件目录 | 配置、简历、复盘、知识点和求职记录 |
| 检索 | SQLite FTS5/BM25、中文 bigram | 本地关键词／全文知识库检索 |
| 测试 | pytest、Ruff、Vitest、Testing Library、Playwright、node:test | 后端、前端、桌面逻辑和 E2E 验证 |

`three` 虽然出现在依赖中，但本次没有在 `frontend/src` 找到直接使用证据，因此不把 3D 渲染称为核心技术。

### 3.2 核心实时链路

```text
麦克风／系统音频
    → 分段与 VAD
    → ASR
    → 文本清理、问句合并与分组
    → 任务调度、取消和并发控制
    → 简历、历史记录、BM25 知识片段、可选截图
    → OpenAI-compatible LLM
    → 流式答案
    → WebSocket 推送到 React UI
    → 本地记录与复盘
```

桌面端和浏览器／局域网模式复用同一套前端与后端。Electron 主进程负责启动本地 Python 服务、创建窗口和浮层；`preload` 使用 `contextIsolation: true`、`nodeIntegration: false` 等安全配置。代码还尝试使用 always-on-top、透明窗口和 content protection 等机制保护浮窗，但没有经过动态测试，不能声称在所有会议软件、录屏软件或截图 API 中隐身。

### 3.3 GitHub 版本的产品模块

本次固定 commit 的主导航包含：

- 实时辅助
- 面试复盘
- 能力分析
- 简历优化
- 求职看板

其中“真实面试辅助”和“面试复盘”不等于独立的 AI 模拟面试官页面。仓库没有独立的模拟面试 API／存储模块这一事实，是后面与安装包比较的关键。

## 4. 安装包静态分析结果

### 4.1 打包技术

安装包使用 Electron 桌面壳，ASAR 中可提取 `main.js`、`preload.js`、`package.json`、快捷键和窗口配置；`resources/frontend/dist` 中是已构建的 React 静态资源；`resources/backend` 中是 Python 源码；`resources/python-runtime` 中包含内置 Python 运行时及第三方包元数据。

静态 metadata 中确认的代表性版本包括：

```text
fastapi==0.141.1       uvicorn==0.52.3       openai==1.109.1
pydantic==2.13.4       numpy==1.26.4         pymupdf==1.28.2
pypdf==5.9.0           python-docx==1.2.0   sounddevice==0.5.5
SoundCard==0.4.6       mss==9.0.2           pillow==11.3.0
requests==2.34.2       websockets==14.2     chromadb==0.6.3
```

版本号来自归档内 `.dist-info/METADATA`，是样本打包时的依赖版本，不等于目标服务端版本或当前官网最新版本。

### 4.2 账号、远程服务和身份等级

安装包后端存在 `MIANXIAOZHU_SERVICE_URL` 环境变量和远程服务客户端，代码路径包括：

```text
/v1/chat/completions
/v1/vision/chat/completions
/v1/audio/transcriptions
/v1/embeddings
/auth/presence
/auth/login
/auth/logout
/auth/me
/auth/time/consume
```

本地 `/api/auth/login` 会把登录请求代理到远程服务；成功响应中保存 JWT access token，后续请求可使用 Bearer token；登录后启动 presence heartbeat，代码还处理身份等级、被其他设备踢下线和面试分钟数消耗。

因此，**从静态实现看，安装包不是纯离线版本**。更准确的说法是：核心桌面和部分本地能力在本机，但账号、身份、官方模型代理、在线心跳或时长核算存在远程服务路径。是否每个用户、每种模式都会实际触发这些路径，需要动态网络测试才能确定。

代码还保留普通用户配置自有 OpenAI-compatible LLM／STT／Vision／Embedding 的路径；VIP/SVIP 分支则可能通过服务端代理选择模型和凭据。不能把配置文件中出现的 key 字段当成可公开使用的真实密钥，报告不展示任何原文密钥。

### 4.3 安装包新增的模拟面试模块

安装包新增：

```text
api/mock_interview/router.py
services/mock_interview_llm.py
services/storage/mock_interview.py
frontend/dist/assets/MockInterview-*.js
```

静态接口显示其工作流为：

```text
创建会话
  → 选择岗位、语言、简历快照、题目来源（ai/kb/mixed）
  → 生成下一道题
  → 提交文字或 WAV 语音回答
  → LLM 点评，返回分数、优点和风险
  → 按题目生成参考答案
  → 生成整场报告，返回平均分、优势和弱点
```

题目数默认 5，代码限制在 1–50；会话、题目和答案写入 SQLite。这个模块是安装包与 GitHub 当前 commit 的直接功能差异，而不是仅凭官网宣传推断。

### 4.4 实时翻译

`api/assist/translate_worker.py` 在 ASR 结果广播后，把文本放入后台队列，再调用服务端翻译；成功广播 `transcription_translated`，失败广播 `transcription_translate_error`，翻译失败不会阻塞转录和回答主流程。身份逻辑与注释显示该能力面向 SVIP，但是否对某个账号开放仍需真实服务端验证。

### 4.5 知识库升级

GitHub 当前版本的核心知识库是 SQLite FTS5/BM25；安装包新增：

```text
services/kb/_bm25.py
services/kb/chroma_store.py
```

安装包的检索结构为：

```text
本地 BM25 关键词检索
        +
Chroma PersistentClient cosine 向量检索
        +
RRF（Reciprocal Rank Fusion）融合
```

Embedding 不可用、调用失败或实时 deadline 到期时，会降级到 BM25-only。这种设计的优势是语义召回更强、实时链路仍有低延迟兜底；代价是需要 Embedding 配置、Chroma 存储和额外依赖，且向量维度或模型变化可能需要重新索引。

## 5. 官网公开功能与价格（证据等级：官网宣传）

对 `mianxiaozhu.com.cn` 的公开页面记录显示，实际品牌为“面小助”。官网宣称：

- Windows／macOS 桌面 AI 面试辅助
- 实时语音转写和回答建议
- 悬浮窗
- 截图识题
- 简历、JD、项目资料知识库
- 技能卡和准备快照
- 面试后对话沉淀
- 套餐页面列出模拟面试

在 2026-09-08 采集到的价格为：

| 套餐 | 页面显示 |
|---|---|
| 免费试用 | 15 分钟 |
| 时长包 | ¥9.9／30 分钟 |
| 时长包 | ¥99／6 小时 |
| 买断档 | ¥199，一次性买断、无限面试时长；明确要求自行配置 API Key |

价格、功能和隐私文案都是指定日期的网页观察，可能随时变化；不能把它们当作当前付款、退款、有效期、设备数、发票或模型调用成本的实测结果。

## 6. 功能对比表

| 维度 | GitHub 当前 commit | 安装包／官网公开信息 | 判断 |
|---|---|---|---|
| 产品形态 | 源码项目，需要自行搭建 | Electron 安装包，内置 Python runtime 和前端构建物 | 安装包更接近可交付产品 |
| 实时面试辅助 | 有音频、ASR、截图、上下文、流式答案 | 有，并在安装包中叠加账号／服务代理 | 核心能力相近，产品化不同 |
| 面试复盘 | 有独立复盘和分析链路 | 保留同类后端实现 | 安装包不是完全不同的技术体系 |
| 能力分析 | 有 | 前端构建物／后端保留相关路径 | 需动态体验确认界面差异 |
| 简历优化 | 有 | 保留相关能力 | 功能方向相近 |
| 求职看板 | 有 `api/jobs` 和 `job_tracker` | 本次安装包对应 Python 文件中未发现同名模块 | 可能是安装包裁剪、改版或未打包，需动态确认 |
| 独立模拟面试 | 当前 commit 未发现 | 有会话、出题、点评、参考答案和报告 | 安装包新增明确能力 |
| 实时翻译 | 当前 commit 未发现对应 worker | 有，静态逻辑显示 SVIP 取向 | 安装包新增能力 |
| 知识库 | SQLite FTS5/BM25 + 中文 bigram | BM25 + Chroma + Embedding + RRF，可降级 | 安装包检索能力更复杂 |
| API 调用 | 用户配置 OpenAI-compatible 服务 | 自有 Key 路径 + 官方远程 service proxy 路径 | 安装包有更强的产品服务耦合 |
| 登录 | 当前源码未见产品订阅登录链路 | JWT、presence、身份等级、踢下线 | 安装包新增产品化控制面 |
| 计时／收费 | 源码未发现套餐扣时 | 官网有时长包／买断；后端有 `time/consume` | 商业模式明显不同 |
| 离线属性 | 可本地运行部分能力，但 LLM 常需外部服务 | 有本地组件，但静态代码存在远程服务路径 | 两者都不能简单称为完全离线 |
| 发行方式 | Node/Python/依赖／模型需要自行准备 | 单一 Windows 安装器，另有官网 macOS 下载入口 | 安装包部署成本更低 |
| 许可证 | CC BY-NC 4.0 | 安装包授权文本与官网商业条款未做完整核验 | 商用前必须单独确认 |

## 7. 数据流、成本和隐私差异

### 7.1 数据流

GitHub 项目以本地 FastAPI 为中枢：音频、截图、简历和知识库先进入本地流程，再根据配置调用 ASR／LLM／Vision 服务。安装包同样有本地后端，但额外包含登录、JWT、presence heartbeat、官方服务代理和分钟消耗路径。

所以从架构风险角度，不能只看“数据是否先落本地”。还要区分：

- 本地是否保存原始音频、截图和完整对话；
- 调用自有 API 时，哪些上下文会离开电脑；
- 登录、心跳和计时接口发送哪些账户或使用信息；
- VIP/SVIP 的服务端是否接触提示词、转录和图片；
- API key 是保存在本地配置、系统凭据还是远程服务端。

这些问题仅凭本轮静态分析没有完全闭环；官网的“数据不传云端”宣传不能直接覆盖服务代理代码所代表的所有网络路径。

### 7.2 成本

GitHub 源码免费可读不等于模型推理免费。用户仍可能承担 OpenAI-compatible LLM、云端 ASR 或 Vision 的费用，并需要自己管理额度和密钥；实际使用的服务若另有收费，以供应商规则为准。

安装包把成本产品化为免费试用、时长包、买断档和身份等级；但买断档要求自带 API Key，意味着“买断软件使用权”和“模型调用成本”可能是两笔不同的成本。实际扣时规则、是否按真实使用分钟、退款、有效期和设备限制，未做交易实测。

### 7.3 隐私与防录屏

官网宣称本地加密保存简历、JD 和对话，数据不传云端，不用于模型训练，并提供屏幕共享／录屏防护。安装包 Electron 代码确实包含 content protection、always-on-top、透明浮层以及 Windows/macOS 相关保护尝试。

但这不能等同于已证明：

- 所有数据都不出本机；
- 本地文件确实使用强加密；
- 第三方模型服务不会保存请求；
- 所有会议软件和录屏工具都无法捕获浮窗。

需要动态抓包、文件落盘检查和不同录屏软件矩阵测试才能下结论。

## 8. 源码相似性与可能的授权问题

本次比较范围是：仓库和安装包 `backend/**/*.py`，排除 tests、scripts、`__pycache__`，按相对路径匹配，并仅做 UTF-8 BOM/CRLF 归一化，不做语义侵权判定。

其中“≥200 bytes”是比较脚本用于排除空文件或极小初始化文件的统计阈值，不代表已完成语义级代码抄袭判定。

统计结果：

```text
仓库 Python 文件：77
安装包 Python 文件：84
共同相对路径：74
共同路径中原始字节完全相同：39
共同路径中仓库侧文件大小≥200 bytes：67
上述阈值文件归一化后完全相同：32
```

安装包独有的代表性文件：

```text
api/auth/router.py
api/mock_interview/router.py
api/assist/translate_worker.py
services/service_client.py
services/mock_interview_llm.py
services/storage/mock_interview.py
services/kb/_bm25.py
services/kb/chroma_store.py
```

仓库独有的代表性文件：

```text
api/jobs/router.py
services/storage/job_tracker.py
```

代表性高相似文件包括 `answer_worker.py`、`pipeline.py`、`routes.py`、`scheduler.py`、`main.py`、`audio.py` 和 `text_utils.py`；另有多个存储、简历、知识库 loader、认证和后台基础文件完全相同。

正确结论是：

> 两个代码包存在大量逐文件完全相同或高度相似的后端实现；从静态结构看，安装包更像是在共同代码基础上形成的另一份产品化构建，但这只是代码关系的技术推断。

不应据此直接说“已经证明盗用”“已经证明侵权”“已经证明谁复制谁”，也不能把 39/74 或 32/67 误写成“整个软件有某个百分比被复制”。授权关系仍需结合发布历史、提交时间、权利人声明、贡献记录、许可证和商业授权材料确认。

## 9. 许可证与商业化建议

GitHub 仓库 `LICENSE` 为 **CC BY-NC 4.0**，至少需要注意署名和非商业限制。若目标是：

- 直接销售改版客户端；
- 将其打包进收费桌面软件；
- 提供收费 SaaS 或 API；
- 使用安装包或其后端代码作为商业产品基础；
- 对外提供“官方版／授权版”表述；

则不能只依据“仓库公开可见”或“代码相似”作决定。建议先取得权利人明确的商业授权，明确允许的代码范围、二次开发、分发、商标使用、服务端部署和模型代理方式；同时保留源码快照、下载包哈希、公开页面采集日期和授权沟通记录。

这部分是风险提示，不是对具体主体或具体行为的法律意见。

## 10. 结论：如果你的目标是选择、二次开发或商业化

### 10.1 只想快速使用

如果只比较部署门槛，安装包形态更低，因为它内置运行时、前端和后端；但应先确认账号登录、网络访问、套餐扣时、API Key 配置、隐私政策和数字签名。不要在主力电脑上直接运行来源和签名尚未独立核验的安装包，建议先在隔离的 Windows 虚拟机或测试机中进行动态验证。

### 10.2 想学习技术或自定义功能

优先研究 GitHub 源码。它的架构更透明，适合修改 ASR、LLM、知识库、提示词、实时调度和 UI；但要准备 Python/Node 依赖、音频设备、Whisper 模型和外部 API，并遵守 CC BY-NC 4.0。

### 10.3 想做商业产品

不要直接把 GitHub 当前版本或安装包拆包代码作为可商业化底座。第一步应是确认版权和商业授权；第二步是重构服务端、账号、计费、密钥管理、隐私和防录屏方案；第三步才是评估是否复用功能思路或部分代码。仅把名称、颜色或文件名改掉不构成授权，也不能自动消除相似代码风险。

## 11. 当前已验证与未验证事项

### 已验证／已观察

- 仓库已克隆到 `E:\Project\interview_assistant`，固定 commit 已记录。
- 已完成 GitHub 源码、依赖和架构静态分析。
- 安装包已在不执行的前提下完成 PE、归档、ASAR、Python 源码和依赖 metadata 静态分析。
- 已确认安装包有模拟面试、翻译、账号服务代理和 Chroma 相关代码。
- 本次复核对仓库 `backend/` 的 141 个 Python 文件和安装包 `backend/` 的 84 个 Python 文件进行 AST 解析，共 225 个文件通过；只做语法解析，不代表依赖或运行时通过。
- 已完成桌面纯逻辑测试：13 通过、0 失败。
- 官网公开页面曾取得首页、Swagger 文档和 OpenAPI 文档；官网品牌实际显示为“面小助”。

### 未验证

- 未安装、未启动和未执行安装包。
- 未做完整前端构建、完整依赖安装和全量测试。
- 未调用真实 ASR、LLM、Vision、Embedding 或翻译接口。
- 未测试真实音频、系统音频、麦克风、截图、录屏、会议软件和浮窗隐身效果。
- 未验证 Authenticode 数字签名、包体官方下载对应关系和 macOS 包。
- 未验证登录、计时扣费、VIP/SVIP 权限、退款、设备限制和模型服务端行为。
- 未验证官网的本地加密、数据不出云、不训练及防录屏承诺。
- 未依据源码相似性作侵权或产品归属结论。

## 12. 证据索引

### GitHub 源码与分析报告

- [GitHub 技术分析报告](interview-assistant-technical-analysis-2026-09-08.md)
- [README](../../README.md)
- [前端依赖与锁文件](../../frontend/package.json)／[package-lock](../../frontend/package-lock.json)
- [FastAPI 主入口](../../backend/main.py)／[WebSocket](../../backend/api/realtime/ws.py)
- [Electron 主进程](../../desktop/main.js)／[preload](../../desktop/preload.js)
- [前端主导航](../../frontend/src/App.tsx)
- [配置示例](../../backend/config.example.json)／[LLM 流式实现](../../backend/services/llm/streaming.py)
- [知识库 store](../../backend/services/kb/store.py)／[retriever](../../backend/services/kb/retriever.py)
- [LICENSE](../../LICENSE)

### 官网公开资料

- [官网公开资料报告](mianxiaozhu-official-review-2026-09-08.md)
- 目标域名首页：`http://mianxiaozhu.com.cn/`
- 公开文档：`http://mianxiaozhu.com.cn/docs`
- OpenAPI：`http://mianxiaozhu.com.cn/openapi.json`

### 安装包静态证据

- [PE triage 摘要](../../.research-artifacts/mianxiaozhu/pe-triage.json)
- [源码相似性比较结果](../../.research-artifacts/mianxiaozhu/source-comparison.json)
- [ASAR 提取目录](../../.research-artifacts/mianxiaozhu/asar/)
- [归档后的后端目录](../../.research-artifacts/mianxiaozhu/unpacked/resources/backend/)
- [归档列表](../../.research-artifacts/mianxiaozhu/archive-list-verbose.txt)
- [桌面逻辑测试日志](../../.research-artifacts/desktop-unit-tests.txt)

> `.research-artifacts` 是临时研究证据目录，若被清理，报告中的相对证据链接可能失效；安装包本体仍在 `exe\` 目录。


