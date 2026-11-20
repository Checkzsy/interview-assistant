'use strict';

const { app } = require('electron');
const { installBootstrap } = require('./singleInstance');

// 锁失败者不会加载 main、日志模块或运行时路径，也不会注册清理/快捷键。
installBootstrap({
  app,
  userDataPath: () => app.getPath('userData'),
  setPath: (name, value) => app.setPath(name, value),
  installFatal: (userDataPath) => {
    require('./log-redact').createConsoleRedactor({ target: console });
    require('./fatal-log').installFatalHandlers({ userDataPath, app });
  },
  loadMain: () => require('./main'),
});
