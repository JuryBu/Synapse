# Plan_3_1：工作区管理实装

## 问题描述

### P1：文件树右键菜单功能未实装（图一）
**现象**：右键弹出菜单有「展开文件夹、复制路径、重命名、新建文件、新建文件夹、发送到 AI 对话、删除」等选项，但大部分仅改内存状态，不与真实磁盘同步。
**根因**：`fileSystem.ts` 的 rename/delete/createDirectory 只操作内存树，未经 IPC 调用 Electron 主进程的 `fs` API。

### P2：工作区生命周期管理 UI 缺失
**现象**：左侧栏只有一个文件列表，没有「管理工作区」的入口——无法打开新工作区、新建空工作区、从列表中移除/关闭工作区、删除工作区。只能通过 WelcomePage 的「打开工作区」按钮。
**根因**：未设计工作区管理面板组件。

## 目标

1. **文件树右键全部功能实装**
   - 新建文件/文件夹 → Electron IPC `fs.mkdir` / `fs.writeFile`
   - 重命名 → Electron IPC `fs.rename`
   - 删除 → Electron IPC `fs.rm` + 确认对话框
   - 复制路径 → `clipboard.writeText`
   - 发送到 AI 对话 → 读取文件内容 → 追加到对话输入框
   - 操作后刷新文件树

2. **工作区管理面板**
   - 侧边栏顶部「课件管理」旁添加工作区下拉菜单
   - 支持：打开文件夹（dialog）、新建空工作区、切换已打开工作区、关闭工作区
   - 持久化最近工作区列表到 localStorage / Electron store

## 技术方案

### 文件操作 IPC 补全
```
electron/ipc/file.ts 需新增：
- file:rename (oldPath, newPath) → fs.rename
- file:delete (path) → fs.rm (recursive for dirs)
- file:mkdir (path) → fs.mkdir (recursive)
- file:copy-path (path) → clipboard.writeText

electron/preload.ts 需暴露对应 bridge 方法
src/services/platform.ts 需添加对应桥接
src/services/fileSystem.ts 需调用桥接而非内存操作
```

### 工作区管理 UI
```
新建组件：src/components/sidebar/WorkspaceManager.tsx
- 下拉菜单：最近工作区列表 + 打开/新建按钮
- 切换工作区时更新 Redux workspace state + 刷新文件树
```
