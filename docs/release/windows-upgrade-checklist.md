# Windows 安装升级验收清单

用于首次发布 Windows EXE、验证静默更新和确认用户数据不会丢失。该清单需要在真实 Windows 环境执行；Linux 单元测试无法替代 NSIS 安装验证。

## 发布前

- [ ] `desktop/package.json` 的 `version` 是稳定的 `X.Y.Z` 版本。
- [ ] 发布 tag 使用完全匹配的 `vX.Y.Z`，没有 `-beta`、`-rc` 等预发布后缀。
- [ ] `build.appId` 保持 `com.interviewassistant.desktop`。
- [ ] `build.productName` 保持 `Interview Assistant`。
- [ ] `build.nsis.oneClick` 保持 `false`，`build.nsis.perMachine` 保持 `false`。
- [ ] Windows Release workflow 成功完成，GitHub Release 中存在且只有一个本次构建的 `.exe`。
- [ ] 安装包未签名的 SmartScreen 提示已记录并可接受。

## 覆盖安装验证

1. [ ] 安装上一稳定版本 EXE，记录安装目录（通常是 `%LOCALAPPDATA%\\Programs\\Interview Assistant`）。
2. [ ] 启动旧版本，修改一个快捷键或其他设置。
3. [ ] 记录 Electron `userData` 目录及其关键文件（例如 `%APPDATA%\\Interview Assistant\\shortcuts.json`）。
4. [ ] 退出旧版本，运行新版本 EXE；也可执行与更新器一致的静默命令：
   ```powershell
   & '.\\Interview.Assistant.Setup.X.Y.Z.exe' /S
   ```
5. [ ] 确认没有出现第二个并存安装目录，原安装位置中的应用文件已变为新版本。
6. [ ] 启动新版本，在应用中确认版本号为 `X.Y.Z`。
7. [ ] 确认此前的 `shortcuts.json` 和应用配置仍存在，快捷键设置仍然生效。
8. [ ] 确认安装过程没有要求管理员权限；若环境策略导致提示，记录实际结果。

## 自动更新验证

1. [ ] 在旧版本启动后等待启动检查完成，或通过设置页手动检查更新。
2. [ ] 当 GitHub 最新稳定 Release 高于当前版本且包含 EXE 时，确认出现一次“发现新版本”桌面 Toast。
3. [ ] 重启旧版本并再次等待检查，确认同一个 release tag 不会重复弹出 Toast。
4. [ ] 打开设置页，确认 `UpdateCard` 显示新版本，并由用户点击下载。
5. [ ] 下载完成后，由用户点击安装按钮；确认旧应用优雅退出，NSIS 安装器以静默模式启动。
6. [ ] 安装完成后重新启动应用，确认新版本运行且用户数据保留。
7. [ ] 发布更高的新版本后，确认只对新的 release tag 再次提示。

## 结果记录

- 旧版本：
- 新版本：
- 旧安装目录：
- userData 目录：
- GitHub Release URL：
- 是否覆盖原安装：
- 是否保留快捷键和配置：
- 是否出现 UAC/SmartScreen 提示：
- 测试日期与 Windows 版本：
- 备注：
