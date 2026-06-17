import { app, BrowserWindow, ipcMain, Menu } from 'electron';
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
