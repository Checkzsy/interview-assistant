# Windows 安装升级验收清单

用于首次发布 Windows EXE、验证静默更新和确认用户数据不会丢失。该清单需要在真实 Windows 环境执行；Linux 单元测试无法替代 NSIS 安装验证。

## 发布前

- [ ] `desktop/package.json` 的 `version` 是稳定的 `X.Y.Z` 版本。
- [ ] 发布 tag 使用完全匹配的 `vX.Y.Z`，没有 `-beta`、`-rc` 等预发布后缀。
- [ ] `build.appId` 保持 `com.interviewassistant.desktop`。
- [ ] `build.productName` 保持 `Interview Assistant`。
- [ ] `build.nsis.oneClick` 保持 `false`，`build.nsis.perMachine` 保持 `false`。
- [ ] Windows Release workflow 成功完成，GitHub Release 中存在且只有一个本次构建的 `.exe`。
- [ ] Release workflow 的“Validate published update metadata against the installer”步骤通过；该步骤会用 EXE 实际字节重算 `latest.yml` 的 sha512 和 blockmap 每块校验。失败即不得发布。
- [ ] Release 同时包含同名 `.exe.blockmap` 与 `latest.yml`；缺任一文件时客户端只能全量下载，甚至看不到更新。
- [ ] workflow 日志中“Stage the bundled whisper-base model”“Smoke-test the bundled model offline”“Verify the installer contains the whisper model”三步均为成功；任一步失败都不应发布。
- [ ] 安装包体积符合预期（内置 base 模型后约 360MB）。
- [ ] 安装包未签名的 SmartScreen 提示已记录并可接受。

## 覆盖安装验证

1. [ ] 安装上一稳定版本 EXE，记录安装目录（通常是 `%LOCALAPPDATA%\\Programs\\Interview Assistant`）。
2. [ ] 启动旧版本，修改一个快捷键或其他设置。
3. [ ] 记录 Electron `userData` 目录及其关键文件（例如 `%APPDATA%\\Interview Assistant\\shortcuts.json`）。
4. [ ] 退出旧版本，运行新版本 EXE；也可执行与更新器一致的静默命令：
   ```powershell
   & '.\\Interview.Assistant.Setup.X.Y.Z.exe' /S --updated --force-run
   ```
5. [ ] 确认没有出现第二个并存安装目录，原安装位置中的应用文件已变为新版本。
6. [ ] 启动新版本，在应用中确认版本号为 `X.Y.Z`。
7. [ ] 确认此前的 `shortcuts.json` 和应用配置仍存在，快捷键设置仍然生效。
8. [ ] 确认安装过程没有要求管理员权限；若环境策略导致提示，记录实际结果。
9. [ ] 确认内置 Whisper 模型可用：设置 → 语音 → 点击“保存并测试”，应返回转写文本，且测试机 `~/.cache/huggingface/hub` 中不存在 `models--Systran--faster-whisper-base`。

## 换安装位置验证（静默安装关闭）

1. [ ] 在设置页关闭「静默安装」开关（`UpdateCard` 中显示为“打开安装向导”）。
2. [ ] 下载并点击安装按钮，确认出现 NSIS 安装向导而不是直接安装。
3. [ ] 确认向导的默认目录等于当前安装目录（来自注册表 `HK{CU,LM}\Software\<GUID>\InstallLocation`）。
4. [ ] 改选一个全新目录后继续安装，确认旧目录中的程序文件被卸载、新目录中出现新版本。
5. [ ] 启动新版本，确认快捷键、模型配置、五个 SQLite 库（复盘/知识库/求职看板/模拟面试/简历历史）全部仍在。
6. [ ] **v1.3.0 → v1.3.1 专项**：升级前确认 `%LOCALAPPDATA%\Programs\Interview Assistant\resources\backend\_internal\data\kb.sqlite` 存在；升级后该路径应消失，且 `%APPDATA%\interview-assistant-desktop\data\kb.sqlite` 存在、文档数与升级前一致。
7. [ ] 重新打开「静默安装」开关，确认后续更新回到就地静默升级。

## 自动更新验证

1. [ ] 在旧版本启动后等待启动检查完成，或通过设置页手动检查更新。
2. [ ] 当 GitHub 最新稳定 Release 高于当前版本且包含 EXE 时，确认出现一次“发现新版本”桌面 Toast。
3. [ ] 重启旧版本并再次等待检查，确认同一个 release tag 不会重复弹出 Toast。
4. [ ] 打开设置页，确认 `UpdateCard` 显示新版本，并由用户点击下载。
5. [ ] 静默安装开启时，点击安装按钮后确认旧应用优雅退出、NSIS 静默安装到原位置并自动重启。
6. [ ] 静默安装关闭时，确认打开安装向导，走完“换安装位置验证”流程。
7. [ ] 发布更高的新版本后，确认只对新的 release tag 再次提示。

## 差分升级验证（真实隔离 Windows 环境）

> 只用测试机/隔离 profile，不覆盖用户正在使用的安装。客户端侧无法从 UI 证明“少下载了多少”，以安装器缓存目录与服务端访问日志为准。

1. [ ] **R0 → R1（首个带 SDK 的版本）**：安装 R0，记录安装目录与 `%APPDATA%\interview-assistant-desktop` 下五库、`config.json`、`shortcuts.json`；升级到 R1 时按全量下载（R0 没有 latest.yml/blockmap，属预期）。
2. [ ] 确认缓存目录布局（`baseCachePath` = `%LOCALAPPDATA%`，子目录名 = `updaterCacheDirName`，本应用为 `interview-assistant-desktop-updater`）：
   - 根目录 `%LOCALAPPDATA%\interview-assistant-desktop-updater\installer.exe`：由 NSIS 安装成功时复制（缓存根，不是 `pending`）；
   - 根目录 `current.blockmap`：只有在客户端用 SDK 完成过一次下载后才会出现（完成后由 `pending` 复制上来），从旧版客户端升级到 R1 时可能不存在；
   - `pending\Interview.Assistant.Setup.X.Y.Z.exe`、`pending\update-info.json`、`pending\current.blockmap`：SDK 下载暂存区。
3. [ ] **R1 → R2**：记录下载进度总量。差分只会复用根目录 `installer.exe` 作为旧基线；旧 blockmap 优先读根目录 `current.blockmap`，缺失时改从发布端下载 `R1.exe.blockmap`。服务端支持 Range 且基线匹配时应走差分（进度总量明显小于 R2 安装包体积）；只记录实测值，不预设节省比例。
4. [ ] 确认基线复用：下载完成后不要立刻清理根目录 `installer.exe`；若基线被删、`current.blockmap` 损坏或旧 blockmap 404，升级应自动退回可信全量下载并成功。
5. [ ] 故意把 `current.blockmap` 改坏后再次升级：应退回全量下载，最终 EXE 的 sha512 与 `latest.yml` 一致，安装仍成功。
6. [ ] 下载完成后、点安装前，用编辑器破坏 SDK 暂存区里的安装包（`pending\Interview.Assistant.Setup.X.Y.Z.exe`）一个字节：点击安装应被拒绝并要求重新下载，安装器绝不能被启动。
7. [ ] 发布一个更高的新版本后，在下载中途点击“检查更新”：该请求会等当前下载结束后才执行（下载期间不并发检查）。等本次下载完成、排队检查返回后，旧包不得再显示为可安装，按钮应回到“点击下载更新”，安装按钮文案为“安装已下载的 vX”且 X 与当前显示的新版本一致。
8. [ ] 每次升级后确认五个 SQLite 库、`config.json`、`shortcuts.json`、内置 Whisper 模型均保留；未启用任何自动安装（关闭应用不应触发安装）。

## 结果记录

- 旧版本：
- 新版本：
- 旧安装目录：
- userData 目录：
- GitHub Release URL：
- 是否覆盖原安装：
- 是否保留快捷键和配置：
- 内置 Whisper 基座模型测试结果：
- 换安装位置时用户数据是否保留：
- 是否出现 UAC/SmartScreen 提示：
- 测试日期与 Windows 版本：
- 备注：
