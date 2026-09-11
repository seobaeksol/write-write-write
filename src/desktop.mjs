import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

let server;
let window;
let quitting = false;
const smoke = process.argv.includes('--smoke-test');
const icon = fileURLToPath(new URL('../build/icon.png', import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    server.close().catch(console.error).finally(() => app.quit());
  });
  // Do not await ready at ESM top level: Electron waits for module evaluation first.
  void app.whenReady().then(async () => {
   try {
    app.setAppUserModelId('local.writewritewrite.app');
    const models = app.isPackaged ? path.join(process.resourcesPath, 'models') : fileURLToPath(new URL('../models', import.meta.url));
    const config = JSON.parse(await readFile(path.join(models, 'model.json'), 'utf8'));
    const options = { port: 3211, modelPath: process.env.WRITE_MODEL_PATH || path.join(models, config.filename), dataDir: path.join(app.getPath('userData'), 'practice') };
    try { server = await startServer(options); }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; server = await startServer({ ...options, port: 0 }); }
    window = new BrowserWindow({
      width: 960, height: 820, minWidth: 360, minHeight: 520,
      title: 'write, write, write.', backgroundColor: '#f8f7f3',
      icon,
      autoHideMenuBar: true, show: !smoke,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== server.url) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    await window.loadURL(server.url);
    if (smoke) {
      await server.ready;
      const status = await fetch(`${server.url}/api/status`).then(r => r.json());
      const screen = { title: window.getTitle(), loaded: !window.webContents.isLoading() };
      console.log('DESKTOP_SMOKE', JSON.stringify({ packaged: app.isPackaged, status, screen }));
      const code = status.state === 'ready' && screen.loaded ? 0 : 1;
      await server.close();
      server = undefined;
      app.exit(code);
    }
   } catch (error) {
    console.error(error);
    if (!smoke) dialog.showErrorBox('앱을 열지 못했어요', '프로그램 파일을 확인하고 다시 실행해 주세요.\n' + error.message);
    app.exit(1);
   }
  });
}
