// 屏幕捕获能力探测：把「隐身到底能不能真隐身」从猜测变成可查询的状态。
//
// Windows 10 2004 (build 19041) 起 SetWindowDisplayAffinity 支持
// WDA_EXCLUDEFROMCAPTURE —— 窗口直接从捕获画面里被排除，画面上根本没有它。
// 更老的系统只支持 WDA_MONITOR —— 捕获时窗口变成一块黑，这比不隐身更显眼，
// 所以在旧系统上要如实告诉用户「你现在的隐身是黑块回退」，而不是假装安全。
//
// 这里只做纯函数判断，方便单测覆盖各平台与版本边界。

const CAPTURE_EXCLUSION_MIN_WIN_BUILD = 19041;

/**
 * @param {string} platform process.platform
 * @param {string} release os.release()，如 "10.0.19045"
 * @returns {{platform:string, supported:boolean, mode:string, label:string, detail:string}}
 */
function detectCaptureCapability(platform, release) {
  if (platform === 'win32') {
    const build = Number(String(release || '').split('.')[2] || 0);
    const supported = Number.isFinite(build) && build >= CAPTURE_EXCLUSION_MIN_WIN_BUILD;
    return {
      platform: 'win32',
      supported,
      mode: supported ? 'exclude' : 'monitor',
      label: supported ? '窗口排除（真隐身）' : '黑块遮挡（旧系统回退）',
      detail: supported
        ? `Windows build ${build} 支持 WDA_EXCLUDEFROMCAPTURE，窗口会从录屏/屏幕共享画面中直接排除。`
        : `Windows build ${build || '未知'} 低于 ${CAPTURE_EXCLUSION_MIN_WIN_BUILD}，只能退化为黑块遮挡；建议改用无边框透明软隐身，避免反而暴露。`,
    };
  }
  if (platform === 'darwin') {
    return {
      platform: 'darwin',
      supported: true,
      mode: 'screencapturekit',
      label: 'ScreenCaptureKit 排除',
      detail: 'Electron 走 ScreenCaptureKit 捕获路径，会跳过设置过共享保护的窗口；macOS 15+ 个别第三方录屏仍需实测。',
    };
  }
  return {
    platform: String(platform || 'unknown'),
    supported: true,
    mode: 'native',
    label: '系统级窗口保护',
    detail: '当前平台使用 Electron 原生共享保护实现，效果取决于具体捕获工具。',
  };
}

module.exports = { CAPTURE_EXCLUSION_MIN_WIN_BUILD, detectCaptureCapability };