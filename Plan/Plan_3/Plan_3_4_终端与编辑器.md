# Plan_3_4：终端、编辑器与文件查看器实装

## 问题描述

### P1：终端完全虚假（多次反馈确认）
**现象**：
- 底部终端面板显示 `synapse $` 提示符
- 输入命令后无任何响应
- 「输出」标签页也完全空白
- `+` 按钮新建标签页无效果

**根因**：TerminalPanel 是纯 UI 组件，command 输入只做了 CSS 样式，未连接 IPC `command:exec` 或 Web 模式的模拟执行。

### P2：文件查看器无法加载文件（第三批反馈-图四）
**现象**：
- 双击文件树中的文件（如 README.md），编辑区打开标签页但显示「无法加载文件」
- 文件路径显示为 `/workspace/README.md` — 这是虚拟路径，不是真实磁盘路径
- PDF/DOCX/PPTX 同样无法打开查看

**根因**：
- 文件打开时使用的是内存文件树的虚拟路径，而非 Electron IPC 读取真实文件
- CodeEditor 组件未通过 IPC `file:read` 获取真实文件内容
- PdfViewer/DocxViewer 用 `fetch(绝对路径)` 在 Electron 下不可用

### P3：代码编辑器功能不完整
**现象**：即使文件能加载，编辑后也无法保存回磁盘（write 操作可能也是内存）。

## 目标

### 终端实装
1. **Web 模式**：基本命令模拟（ls/cd/cat/echo），输出实时显示
2. **Electron 模式**：通过 IPC → `child_process.exec` 或 `node-pty` 真实执行命令
3. 支持多标签页
4. 命令历史（上下箭头切换）

### 文件查看器闭环
1. 双击文件 → 通过 IPC `file:read` 读取真实磁盘文件内容
2. CodeEditor 真实加载 + 编辑 + 通过 IPC `file:write` 保存
3. PdfViewer：通过 IPC 读取文件为 ArrayBuffer → pdf.js 渲染
4. DocxViewer：通过 IPC 读取文件 → mammoth.js 转 HTML

### 编辑器增强
1. 语法高亮（Monaco 已有）
2. 保存快捷键 Ctrl+S → IPC 写回
3. 修改标记（标签页显示 ● 未保存标记）
