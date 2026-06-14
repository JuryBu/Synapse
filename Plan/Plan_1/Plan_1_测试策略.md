# Plan_1_测试策略: 双模式运行与 Stage 验收体系

> **核心问题**：AI 无法直接操作 Electron 窗口，只能通过 MCP web-fetcher 截图/交互来测试。
> **解决方案**：所有功能同时在 Web 端实现，AI 通过 `localhost` 完成每个 Stage 的自动化验收。

---

## 1. 双模式架构

### 1.1 设计原则

```
         共享代码 (95%+)
  ┌─────────────────────────┐
  │   React 应用 (src/)      │
  │   组件、Store、服务层     │
  └────────┬────────┬───────┘
           │        │
     ┌─────┴──┐  ┌──┴──────┐
     │Electron│  │  Vite   │
     │  模式  │  │ Web 模式 │
     │main.ts │  │localhost │
     └────────┘  └─────────┘
```

- **Electron 模式**：完整桌面应用，含文件系统、终端、MCP 等原生能力
- **Web 模式**：`npm run dev` 浏览器运行，原生 API 通过 Mock/降级处理
- **共享率 95%+**：UI 组件、Redux Store、AI 通信层完全共享

### 1.2 原生 API 适配层

```typescript
// src/platform/index.ts
// 统一接口，根据运行环境选择实现

export const platform = {
  isElectron: typeof window !== 'undefined' && !!window.synapse,
  
  file: window.synapse?.file ?? webFileMock,
  mcp: window.synapse?.mcp ?? webMcpMock,
  terminal: window.synapse?.terminal ?? webTerminalMock,
  server: window.synapse?.server ?? webServerMock,
  config: window.synapse?.config ?? webConfigMock,
};
```

```typescript
// src/platform/webMocks.ts
// Web 模式下的 Mock 实现

const webFileMock = {
  // 使用 IndexedDB 或 localStorage 模拟文件系统
  read: async (path: string) => localStorage.getItem(`file:${path}`) ?? '',
  write: async (path: string, content: string) => localStorage.setItem(`file:${path}`, content),
  list: async (dir: string) => JSON.parse(localStorage.getItem(`dir:${dir}`) ?? '[]'),
  search: async () => [],
  grep: async () => [],
  watch: () => {},
};

const webTerminalMock = {
  // Web 模式下终端显示提示信息
  create: async () => ({ id: 'mock', message: '终端仅在 Electron 模式可用' }),
  write: async () => {},
  resize: async () => {},
  onData: () => {},
  kill: async () => {},
};

const webMcpMock = {
  callTool: async () => ({ content: [{ type: 'text', text: 'MCP 仅在 Electron 模式可用' }] }),
  listTools: async () => [],
  getStatus: async () => ({ servers: [] }),
  restart: async () => {},
};
```

### 1.3 Web 模式下可完整测试的功能

| 功能 | Web 模式支持 | 说明 |
|---|---|---|
| 布局/面板拖拽 | ✅ 完整 | 纯前端 |
| 主题/背景/磨砂 | ✅ 完整 | 纯 CSS |
| AI 对话 | ✅ 完整 | SSE 直连 API（浏览器原生 fetch） |
| 消息渲染（MD/KaTeX/Mermaid） | ✅ 完整 | 纯前端 |
| 设置面板 | ✅ 完整 | localStorage 持久化 |
| Toast/右键菜单/快捷键 | ✅ 完整 | 纯前端 |
| 欢迎页/引导 | ✅ 完整 | 纯前端 |
| 文件树 | ⚠️ Mock | IndexedDB 模拟 |
| Synopsis 引擎 | ⚠️ 部分 | 可测试 UI + Worker Pool，文件来源用上传 |
| 嵌入查看器 | ✅ 完整 | pdf.js / mammoth 均为浏览器库 |
| Showcase iframe | ✅ 完整 | localhost 服务 |
| 终端 | ❌ Mock | 显示提示信息 |
| MCP 系统 | ❌ Mock | 仅 Electron |

---

## 2. BAT 启动器脚本

### 2.1 `启动Synapse.bat`

放置在 `Synapse/` 根目录下，用户双击即可选择模式：

```bat
@echo off
chcp 65001 >nul
title Synapse 启动器
echo.
echo   ╔══════════════════════════════════╗
echo   ║       Synapse 学习平台           ║
echo   ╠══════════════════════════════════╣
echo   ║  [1] 🖥 桌面应用模式 (Electron)  ║
echo   ║  [2] 🌐 Web 开发模式 (浏览器)    ║
echo   ║  [3] 📦 构建生产包               ║
echo   ║  [0] 退出                        ║
echo   ╚══════════════════════════════════╝
echo.
set /p choice=请选择 (1/2/3/0): 

if "%choice%"=="1" (
    echo 正在启动 Electron 桌面应用...
    cd /d "%~dp0synapse-app"
    npm run electron:dev
) else if "%choice%"=="2" (
    echo 正在启动 Vite 开发服务器...
    cd /d "%~dp0synapse-app"
    npm run dev
    echo.
    echo 浏览器打开 http://localhost:5173
) else if "%choice%"=="3" (
    echo 正在构建生产包...
    cd /d "%~dp0synapse-app"
    npm run build
    npm run electron:build
) else if "%choice%"=="0" (
    exit
) else (
    echo 无效选择
    pause
)
pause
```

### 2.2 package.json scripts 对应

```json
{
  "scripts": {
    "dev": "vite",                              // Web 模式
    "build": "tsc -b && vite build",            // 构建前端
    "electron:dev": "vite build && electron .",  // Electron 模式
    "electron:start": "electron .",             // 纯启动 Electron
    "electron:build": "electron-builder"         // 打包安装包
  }
}
```

---

## 3. AI 自动化测试流程

### 3.1 每个 Stage 的验收流程

```
Stage 完成编码
    ↓
[1] 启动 Web 模式 (npm run dev → localhost:5173)
    ↓
[2] MCP web_fetch_screenshot 截图主界面
    ↓
[3] MCP web_interact 对各功能点逐一操作验证
    ↓
[4] MCP web_pipeline 执行多步交互流程测试
    ↓
[5] 截图记录 → 对比预期 → 发现问题 → 修复
    ↓
[6] 确认无问题 → 标记 Stage 完成
```

### 3.2 测试工具使用规范

| 工具 | 用途 |
|---|---|
| `web_fetch_screenshot` | 截图验证 UI 布局、样式、组件渲染 |
| `web_interact(click/type)` | 模拟用户交互（点击按钮、输入文字） |
| `web_interact(find)` | 验证页面是否包含特定文本 |
| `web_pipeline` | 多步交互流程测试 |
| `web_fetch_rich` | 截图 + 文本同时获取 |
| `sandbox_exec` | 运行单元测试、lint 检查 |

---

## 4. 各 Stage 测试验收标准

### Stage 1: 项目初始化
- 📷 截图验证：空白 React 页面正常渲染
- ✅ Web 模式：`localhost:5173` 可访问
- ✅ Electron 模式：窗口正常打开
- ✅ BAT 启动器：两种模式都能启动

### Stage 2: 布局引擎
- 📷 截图验证：三栏布局（AB + SB + Editor + Agent Panel）比例正确
- 🖱 交互测试：拖拽分割线调整面板大小
- 🖱 交互测试：Sidebar 折叠/展开
- 🖱 交互测试：底部面板折叠/展开
- 📷 截图验证：磨砂玻璃效果 + 背景图叠加
- 📷 截图验证：暗色主题 CSS 变量生效
- ✅ 刷新后面板大小恢复（持久化验证）

### Stage 3: Redux Store
- ✅ Redux DevTools 中可见所有 Slice
- ✅ 状态变更正确响应
- ✅ SQLite 数据库文件已创建（Electron 模式检查）
- ✅ ConversationManager CRUD 操作

### Stage 4: 文件系统
- 📷 截图验证：文件树正常渲染（层级缩进、图标）
- 🖱 交互测试：展开/折叠目录
- 🖱 交互测试：右键菜单弹出
- 📷 截图验证：欢迎页（新建课程按钮、最近工作区列表）
- ✅ 文件搜索功能返回结果

### Stage 5: AI 通信层
- 📷 截图验证：AI 面板输入框存在、可输入
- 🖱 交互测试：发送一条消息 → 收到流式回复
- 📷 截图验证：流式打字动画
- ✅ 连续对话上下文保持
- ✅ 多模型切换（Fast/Plan 模式按钮）
- ✅ Token 计数正确显示
- ✅ 错误处理：断网 → Toast 提示 → 恢复后重试

### Stage 6: Agent Panel
- 📷 截图验证：Markdown 渲染效果（标题/列表/表格/代码块）
- 📷 截图验证：KaTeX 公式渲染（行内 `$...$` + 块级 `$$...$$`）
- 📷 截图验证：Mermaid 图表渲染
- 📷 截图验证：代码高亮 + 复制按钮
- 🖱 交互测试：点击代码块复制按钮
- 🖱 交互测试：消息右键菜单
- 📷 截图验证：Chat/Plan/Context 标签切换
- ✅ 长消息列表不卡顿（虚拟滚动验证）

### Stage 7: 工具系统
- 📷 截图验证：工具调用折叠卡片（AI 调用了工具 → UI 展示）
- ✅ AI 请求文件读取 → 工具执行 → 结果返回 → AI 继续回复
- 🖱 交互测试：用户审批弹窗（危险操作时弹出确认）
- ✅ 工具调用错误 → 自动重试 → 失败反馈给 AI

### Stage 8-9: MCP + 插件系统
- 📷 截图验证：设置面板 MCP 列表
- 📷 截图验证：SKILL 列表展示
- ✅ MCP 服务器启动/停止/重启

### Stage 10: Synopsis 引擎
- 📷 截图验证：Sidebar Synopsis 面板（文件列表 + 进度状态）
- ✅ 上传 PDF → 触发概要生成 → 进度更新 → 完成
- 📷 截图验证：完成后展开查看 Chunk 摘要
- ✅ AI 对话中引用课件概要回答问题

### Stage 11: 展示模式
- 📷 截图验证：PDF 渲染（多页导航、缩放）
- 📷 截图验证：DOCX 渲染（标题层级、表格）
- 📷 截图验证：Showcase iframe（AI 生成的 HTML 页面）
- 🖱 交互测试：标签页切换、关闭
- 🖱 交互测试：PDF 页面导航（上页/下页）

### Stage 12: 设置系统
- 📷 截图验证：设置面板所有 7 大分类
- 🖱 交互测试：切换主题色 → 实时预览
- 🖱 交互测试：修改背景图 → 实时预览
- 🖱 交互测试：API Key 输入 + 测试连接
- ✅ 设置持久化（刷新后保持）

### Stage 13: 终端
- ✅ Electron 终端正常工作（需要用户确认）
- 📷 截图验证：Web 模式终端区域显示提示信息

### Stage 14: 通知与交互
- 📷 截图验证：Toast 弹出效果
- 🖱 交互测试：命令面板打开（Ctrl+Shift+P 模拟）
- 🖱 交互测试：快捷键触发

### Stage 15: 打包发布
- ✅ electron-builder 输出安装包
- ✅ 安装包可双击安装运行
