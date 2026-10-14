# 修复日志

## 2026-10-14 - 单模型瞬时失败重试（同模型，用户无感）

### ✨ 新增能力

- **问题**：答题链路 `chat_stream_single_model` 此前无任何重试。一旦底层 SDK/HTTP 出现瞬时失败（限流抖动、连接重置、5xx），会直接抛 `LLMError`，前端弹「答案生成失败」toast、该题被判失败。但实际中这类失败往往重试一次就能成功。
- **解决方案**：为单模型流式请求增加**同模型瞬时失败重试**——
  - 最多重试 **2 次**，退避 `0.6s → 1.8s`（最坏额外等待约 2.4s）
  - **只在「首个 chunk 产出之前」重试**：一旦开始输出正文，重试会导致答案文本重复，因此进入流式阶段后照常失败（行为与之前完全一致）
  - 覆盖 SDK 建流失败与 HTTP 退回路径（`_stream_via_http` 的 503 也发生在首块之前，同样可重试）
  - 重试期间走到成功时**不广播任何错误消息**，用户只感受到回答略慢，全程无感；用户取消在中途会立即中止退避
  - 内置固定策略，不做配置项，不改变任何 WS 消息协议
- **验证**：新增 `tests/test_llm_retry.py` 7 个用例（瞬时失败重试、首块前 503 重试、非可重试错误不重试、重试耗尽、首块后失败不重试回归防护、HTTP 503 重试、退避期间取消）全部通过；`test_think_params.py`（56）、`test_assist_answer_worker.py`+`test_pipeline_p0.py`（81）全量回归通过

### 📝 修改的文件

- **backend/services/llm/streaming.py** — 新增 `_LLM_RETRY_MAX_ATTEMPTS`/`_LLM_RETRY_BACKOFF_SEC` 常量、`_sleep_before_retry` 退避辅助；重构 `chat_stream_single_model`，用闭包 + 首块 `next()` 捕获构造阶段失败
- **backend/tests/test_llm_retry.py** — 新增重试行为测试
- **.github/workflows/ci.yml** — 测试列表加入 `tests/test_llm_retry.py`

## 2026-10-12 - 桌面版内置 soundcard（系统音频采集）修复

### 🐛 修复的问题

- **问题**：安装桌面版后，音频页提示「⚠️ 未检测到系统音频输出设备！请安装 soundcard：pip install soundcard」。`soundcard`（Windows WASAPI 系统音频采集）在源码中是可选导入、未列入 `requirements.txt`，PyInstaller 打包时不会将其打进 exe，导致桌面版 `_HAS_SC=False`、无 loopback 设备。该提示对源码开发者是可行指引，但对桌面版用户是**无效指引**（打包的 exe 里没有 pip，无法手动安装）。
- **解决方案**：将 `soundcard` 内置进桌面版——
  - `backend/requirements.txt` 新增 `soundcard>=0.4.6,<1.0`
  - `desktop/package.json` 的 PyInstaller 命令新增 `--collect-all soundcard --collect-all comtypes`（soundcard 依赖 comtypes，需一并打包）
- **验证**：`soundcard` 能识别本机 6 个扬声器设备；`AudioCapture.get_platform_info()` 返回 `has_loopback: True`、`needs_virtual_device: False`，警告消失；54 个音频相关后端测试全部通过

### 📝 修改的文件

- **backend/requirements.txt** — 新增 `soundcard` 依赖
- **desktop/package.json** — PyInstaller 打包命令新增 `--collect-all soundcard --collect-all comtypes`

## 2026-10-12 - 桌面端启动端口保留段修复

### 🐛 修复的问题

#### 1. 安装后桌面端无法启动
- **问题**：安装（或升级）桌面版后，应用启动后窗口一闪即退，无法进入主界面
- **根因**：桌面端默认把后端端口写死为 `18080`。当 `18080` 落在 Windows「Hyper-V 管理的端口排除范围」内（常见于装有 Docker Desktop / WSL2 / Hyper-V 的机器，动态保留如 `18021-18120`）时，后端 `bind` 报 `Errno 13 (WSAEACCES)`，任何进程都无法监听该端口。后端一启动即退出，Electron 主进程探测不到 `/api/options`，40 秒后超时退出，窗口从不显示
- **解决方案**：桌面端在启动时**扫描空闲端口**——优先用户显式 `PORT` 环境变量，否则从默认 `18080` 起逐个真实绑定探测（跳过被占用/保留的端口），自动回退到可用端口（如 `9090`）再启动后端；后端通过 `PORT` 环境变量接收端口。所有引用端口处（服务探测、窗口加载、API 请求、退出时 graceful stop）均读取运行时解析值
- **验证**：在 `18080` 落在保留段的机器上，自动回退到 `9090` 并成功监听，`/api/options` 返回 200；桌面单元测试 59 个全部通过

### 📝 修改的文件

- **desktop/runtimePaths.js**
  - 新增 `resolveServerPort`：异步解析可用端口（显式 `PORT` → `18080` → `9090` → `18122` → `9091`）
  - 新增 `probePort`：真实 `net` 绑定探测，识别 `EADDRINUSE`/`EACCES` 端口
- **desktop/main.js**
  - `PORT`/`SERVER_URL` 改为异步解析，`whenReady` 中解析端口后启动后端
  - 后端子进程通过 `PORT` 环境变量接收端口
- **desktop/runtimePaths.test.js**
  - 追加端口解析用例（默认端口、保留段回退、显式 `PORT` 优先、显式不可用回退、全不可用回首选、真实探测）
- **desktop/package.json**
  - 版本 `1.2.1` → `1.2.2`

## 2026-09-13 - 语音识别设备选择修复

### 🐛 修复的问题

#### 1. AMD/ROCm 环境下 Whisper 加载失败
- **问题**：在 AMD GPU（如 Radeon RX 7800 XT）+ ROCm 版 torch 的机器上，语音识别（faster-whisper）加载模型报错 `CUDA driver version is insufficient for CUDA runtime version`，导致本地 ASR 完全不可用
- **根因**：`STTEngine._best_device()` 用 `torch.cuda.is_available()` 判断设备。ROCm 版 torch 会把 AMD GPU 映射为 `cuda` 并返回 `True`，但 faster-whisper 底层的 ctranslate2 只支持真正的 NVIDIA CUDA，加载时必然失败
- **解决方案**：改用 ctranslate2 自身的 `get_cuda_device_count()` 探测真实 CUDA 设备。ctranslate2 是真正加载模型的运行时，它知道 CUDA 是否可用。无真实 CUDA 设备时正确回退到 `cpu` + `int8`
- **验证**：真实中文语音端到端转写成功（"请介绍一下你最近做过的项目"），40 个 STT 相关测试全部通过

### 📝 修改的文件

- **backend/services/stt/engines.py** (`_best_device`)
  - 用 `ctranslate2.get_cuda_device_count()` 替代 `torch.cuda.is_available()` 判断设备
  - 修复 AMD/ROCm 环境假阳性导致的模型加载失败

## 2026-06-23 - 面试复盘与启动优化

### 🐛 修复的问题

#### 1. Windows 启动问题
- **问题**：命令行窗口不隐藏，桌面应用不自动打开
- **根因**：`start.py` 在 Windows 上启动时，初始的 Python 进程持有控制台窗口
- **解决方案**：
  - 实现自动重启机制：首次启动显示信息后，以 `CREATE_NO_WINDOW` 标志重启自己
  - 使用 `IA_HIDE_CONSOLE` 环境变量防止无限重启
  - 1 秒延迟确保用户看到启动信息

#### 2. 面试复盘候选人语音记录为空
- **问题**：所有复盘记录中的 `candidate_answer_text` 字段都是空的
- **根因**：`answer_worker.py` 中的 `if not images` 条件阻止了带图片问题打开候选人回答窗口
- **影响**：实际面试中大多数问题都带截图，导致候选人语音转录无法关联到 `qa_id`
- **解决方案**：
  - 移除 `not images` 条件限制
  - 分离关注点：语音记录（总是开启）vs LLM 上下文注入（仅无图片时）
  - 确保所有问题都打开候选人回答窗口

#### 3. 语音识别精确度提升
- **功能**：实现 LLM 驱动的 ASR 纠错
- **实现**：
  - `correct_asr_errors()` 函数使用 LLM 纠正语音识别错误（温度 0.1）
  - 纠正类型：同音字、专业术语、标点符号、语气词
  - 增强验证：
    - 长度检查（不能少于原文 70%）
    - 相似度检查（SequenceMatcher ratio ≥ 0.4）
    - 防止过度修改或幻觉
  - 纠正后的文本保存到数据库，替换原始 ASR 输出

### 📝 修改的文件

#### 启动相关
- **start.py** (行 333-360)
  - 添加 Windows 自动重启逻辑
  - 环境变量守护防止无限循环
  
- **启动.bat** (新增)
  - 简化启动脚本，UTF-8 编码支持

#### 后端核心修复
- **backend/api/assist/answer_worker.py** (行 442-447)
  - 移除 `not images` 限制
  - 添加清晰的注释说明分离的关注点

- **backend/services/storage/review.py** (行 339-380)
  - `update_turn_analysis()` 新增 `corrected_answer` 参数
  - 动态 SQL 构建，减少代码重复

- **backend/services/review_analysis.py** (行 31-99)
  - `correct_asr_errors()` 函数增强验证
  - 添加相似度检查和长度阈值
  - 改进日志记录

- **backend/services/review_async_analysis.py** (行 69-84)
  - 传递纠正后的回答到数据库更新
  - 整场总结使用纠正文本

### ✅ 测试结果

#### 模拟测试
```
✓ 候选人语音记录：从 0 字节 → 30 字节
✓ ASR 纠错：
  - 原始：red地址主要有两种持久化方式，一个是rb地址，一个是AOF
  - 纠正：Redis主要有两种持久化方式，一个是RDB，一个是AOF。
✓ 数据库保存：纠正后文本成功保存
✓ 端到端验证：完整流程通过
```

#### 验证改进
- ✅ 长度阈值从 50% 提升到 70%
- ✅ 新增相似度检查（0.4 阈值）
- ✅ 代码重复减少（SQL 动态构建）
- ✅ 移除冗余的 if-pass 块

### 🎯 使用方法

#### 启动应用
```bash
# Windows: 双击启动脚本
启动.bat

# 或直接运行
python start.py --mode desktop
```

命令行窗口会在 1 秒后自动隐藏，Electron 桌面窗口自动打开。

#### 测试面试复盘
1. 启动实时辅助，开启面试官和候选人双音轨
2. 提问（带截图或纯文本都可以）
3. 候选人语音回答
4. 停止面试，查看复盘
5. 验证：
   - ✓ 候选人回答已记录
   - ✓ 语音识别错误已自动纠正

### 📊 代码审查反馈

**优点**：
- ✅ 核心修复正确解决了问题
- ✅ Windows 启动逻辑符合标准实践
- ✅ 关注点分离清晰（记录 vs LLM 注入）
- ✅ ASR 纠错验证健壮

**改进**：
- ✅ 移除了冗余代码块
- ✅ 增强了 ASR 纠错验证
- ✅ 减少了 SQL 代码重复
- ✅ 改进了日志记录

### 🔮 未来考虑

1. **启动错误日志**：考虑添加日志文件记录隐藏进程的错误
2. **UI 透明度**：在界面上显示"已纠正"标记，让用户知道 ASR 做了修改
3. **纠错指标**：添加纠错成功率统计和监控
4. **成本优化**：每个 turn 都调用 LLM 纠错会产生额外成本，考虑批处理或缓存

### 📈 影响范围

- **后端**：4 个核心文件修改
- **启动**：2 个文件修改
- **测试**：完整端到端验证通过
- **向后兼容**：✅ 不影响现有数据

---

**修复人员**：Claude Code  
**审查**：Agent review passed  
**测试状态**：✅ 所有测试通过
