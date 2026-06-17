import { app, BrowserWindow, ipcMain, Menu, dialog } from 'electron';
import * as path from 'path';
import { initDatabase, closeDatabase } from './database';
import { registerConfigHandlers } from './ipc/config';
import { registerConversationHandlers } from './ipc/conversation';
import { registerMemoryHandlers } from './ipc/memory';
import { registerWorkspaceHandlers } from './ipc/workspace';
import { registerFileHandlers } from './ipc/file';
import { registerCommandHandlers } from './ipc/command';
import { registerWorktreeHandlers } from './ipc/worktree';
import { registerAttachmentHandlers } from './ipc/attachment';
import { registerMCPHandlers, shutdownAllMCP, ensureDefaultMCPConfig, startEnabledMCPServers } from './ipc/mcp';
import { registerWallpaperHandlers, registerWallpaperProtocol } from './ipc/wallpaper';
// ★ M4-4-S3：import 触发顶层 registerSchemesAsPrivileged 副作用（必须在 app.whenReady 前），
//   registerFileProtocol 在 whenReady 内调用。根治图片/视频/PDF 本地资源加载黑屏。
import { registerFileProtocol } from './ipc/fileProtocol';

let mainWindow: BrowserWindow | null = null;
const devServerUrl = process.env.SYNAPSE_DEV_SERVER_URL || 'http://localhost:5173';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Synapse',
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0f',
    // icon: path.join(__dirname, '../public/icon.png'), // TODO: 添加图标文件后启用
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // P1-1: 后续评估改为 true
    },
  });

  mainWindow.setMenuBarVisibility(false);

  if (!app.isPackaged) {
    // 开发模式：加载 Vite dev server
    mainWindow.loadURL(devServerUrl);
  } else {
    // 生产模式：加载打包后的 HTML
    // __dirname = dist-electron/electron/, 向上两级到项目根再进 dist/
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // ★ FIX-12/FIX-12b：恢复刷新快捷键。app.whenReady 里 Menu.setApplicationMenu(null) 移除了默认菜单，
  //   连带 Ctrl+R / F5 / Ctrl+Shift+R 这些默认 reload accelerator 一并失效——开发时改了前端代码
  //   无法自助刷新（此前只能整进程重启 electron）。这里监听键盘输入补回，不恢复菜单 UI。
  //   ★ 仅开发模式启用（!isPackaged）：正式版给终端用户绑「整页 reload」是脚枪——F5 是肌肉记忆，
  //   误触即无提示重载、丢失未保存编辑/打断进行中的 agent run/清空非持久运行态，开发便利不应以
  //   正式用户的数据安全为代价。
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      const key = (input.key || '').toLowerCase();
      const ctrlOrCmd = input.control || input.meta;
      const isReload = key === 'f5' || (ctrlOrCmd && key === 'r');
      if (!isReload) return;
      // 强刷（忽略缓存）只在 Ctrl+Shift+R 或 Ctrl+F5 触发；单 F5 / Shift+F5 / Ctrl+R 走普通刷新。
      //   （旧写法 input.shift 单独成立会把无 Ctrl 的 Shift+F5 也误判成强刷，这里收紧为与 Ctrl/Cmd 绑定。）
      const forceReload = (ctrlOrCmd && input.shift && key === 'r') || (ctrlOrCmd && key === 'f5');
      if (forceReload) {
        mainWindow?.webContents.reloadIgnoringCache();
      } else {
        mainWindow?.webContents.reload();
      }
    });
  }

  // ★ FIX-12b：未保存修改守卫。渲染进程 App.tsx 在有脏 tab 时用 beforeunload event.preventDefault()
  //   阻止离开，但 Electron 的 reload()/关窗默认不尊重该取消——必须主进程监听 will-prevent-unload
  //   才会真正拦下并弹确认。这里接回：有未保存内容时（含 reload 快捷键触发的重载、点关闭窗口）弹原生
  //   确认框，避免静默丢数据。无脏数据时渲染进程不阻止 unload，本回调不触发，刷新/关窗照常直通。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'question',
      buttons: ['仍然离开', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '未保存的修改',
      message: '存在未保存的修改，确定要继续吗？未保存的内容将丢失。',
    });
    if (choice === 0) event.preventDefault(); // 选「仍然离开」→ 放行 unload（reload/关窗继续）
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerWallpaperProtocol();
  registerFileProtocol(); // ★ M4-4-S3：注册 synapse-file:// 文件协议（图片/视频/PDF 本地资源）。
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ---- IPC Handlers ----

// 窗口操作
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

// 平台信息
ipcMain.handle('platform:info', () => ({
  isElectron: true,
  platform: process.platform,
  version: app.getVersion(),
  userDataPath: app.getPath('userData'),
  appPath: app.getAppPath(),
  locale: app.getLocale(),
}));

// ---- Stage 3: 数据库 + IPC Handler 集成 ----

// 数据库初始化 + IPC 注册
app.whenReady().then(() => {
  try {
    initDatabase();
    registerConfigHandlers();
    registerConversationHandlers();
    registerMemoryHandlers();
    registerWorkspaceHandlers();
    registerFileHandlers();
    registerWallpaperHandlers();
    registerCommandHandlers();
    registerWorktreeHandlers();
    registerAttachmentHandlers();
    // ★ M4-7-S2：注册 MCP handlers 前先确保默认 mcp_config.json 存在（文件不存在才写，存在绝不覆盖）。
    ensureDefaultMCPConfig();
    registerMCPHandlers();
    // ★ FIX-5：注册 handlers 后 fire-and-forget 自动拉起 enabled 的 MCP server（不阻塞创窗）。
    //   默认 memory-store（enabled=true）随应用自动启动，无需用户手动逐个点启动。
    void startEnabledMCPServers();
    console.log('[main] All IPC handlers registered');
  } catch (err) {
    console.error('[main] IPC init failed:', err);
  }
});

// 应用退出时关闭数据库
app.on('will-quit', async () => {
  await shutdownAllMCP();
  closeDatabase();
});

// ---- 仍未实现的 IPC Stub ----
const notImplemented = (channel: string) => {
  return () => ({ error: true, message: `[${channel}] 尚未实现，将在后续 Stage 中完成` });
};

// 终端 stub (Stage 13)
ipcMain.handle('terminal:create', notImplemented('terminal:create'));
ipcMain.handle('terminal:write', notImplemented('terminal:write'));
ipcMain.handle('terminal:resize', notImplemented('terminal:resize'));
ipcMain.handle('terminal:kill', notImplemented('terminal:kill'));
