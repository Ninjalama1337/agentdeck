// Entry for the headless smoke test (scripts/smoke.mjs): answers native message boxes from a file
// and records them, then starts the real app (dist/main.js). Nothing of this ships in the package.
const fs = require('node:fs');
const { BrowserWindow, dialog } = require('electron');

const logFile = process.env.SMOKE_DIALOG_LOG;
const answerFile = process.env.SMOKE_DIALOG_ANSWERS;

dialog.showMessageBox = async (...args) => {
  const options = args[args.length - 1];
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(options)}\n`);
  let queue = [];
  try {
    queue = JSON.parse(fs.readFileSync(answerFile, 'utf8'));
  } catch {}
  const next = queue.shift();
  if (answerFile) fs.writeFileSync(answerFile, JSON.stringify(queue));
  return next ?? { response: options.cancelId ?? 0, checkboxChecked: false };
};
dialog.showErrorBox = (title, content) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ errorBox: title, content })}\n`);
};

// Test hooks for window geometry: apply bounds from a command file, publish the current ones.
const cmdFile = process.env.SMOKE_CMD_FILE;
const boundsFile = process.env.SMOKE_BOUNDS_FILE;
setInterval(() => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (cmdFile && fs.existsSync(cmdFile)) {
    try {
      const cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
      if (cmd.bounds) win.setBounds(cmd.bounds);
      if (cmd.close) win.close(); // same event as the title bar's close button
      if (cmd.reload) win.webContents.reload(); // the menu's "Neu laden"
    } catch {}
    fs.rmSync(cmdFile, { force: true });
  }
  if (boundsFile) {
    fs.writeFileSync(boundsFile, JSON.stringify({ bounds: win.getBounds(), visible: win.isVisible(), maximized: win.isMaximized() }));
  }
}, 150);

require('../dist/main.js');
