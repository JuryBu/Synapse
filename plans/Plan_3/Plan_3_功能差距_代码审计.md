# Plan_3 功能差距 — 代码级审计报告

> 基于 2026-04-26 用户实测 + 逐文件源码审计

---

## 一、AI 对话系统（AgentPanel.tsx: 464L）

### 🔴 输入框无法选中/输入
- **代码根因**: L419 `disabled={!hasApiKey}`
- `hasApiKey` = L182 `!!settings.apiKeys?.openai` — 未配 API Key 时 textarea 直接 disabled
- **修复**: 允许输入，仅在发送时检查 Key 是否存在

### 🔴 Token 计数虚假
- **代码根因**: L185-188 `useMemo` 调用 `estimateTokens()` — 仅按中/英字符粗估
- StatusBar.tsx L6-12 同样用 `estimateTokens()` — 无 API 真实用量回调
- 没有 API streaming 的 `usage` 字段解析
- **修复**: agentLoop streaming 完成后从 API response 的 `usage.total_tokens` 回写 Redux

### 🔴 连接状态硬编码
- **代码根因**: StatusBar.tsx L66 `<Wifi style={{ color: 'var(--syn-success)' }} /> 已连接`
- 永远绿色 + "已连接"，无任何真实检测逻辑
- **修复**: 新增 heartbeat/ping 检测 + Redux 状态 `connectionStatus`

### 🔴 模型选择器无交互
- **代码根因**: L447-457 `<span className="model-label clickable">` 有 cursor:pointer 但无 onClick
- 仅显示 `model || '未配置模型'`，点击无弹窗/下拉
- **修复**: onClick 展开模型选择下拉 → 从 Redux/API 获取可用模型列表

### 🟡 消息编辑/重试/删除 — 代码存在但依赖对话先可用
- AgentPanel L138-172: `handleEdit` / `handleRetry` / `handleDelete` 函数已实现
- L288-297: 正确传递 `onEdit={handleEdit}` `onRetry={handleRetry}` `onDelete={handleDelete}` 给 MessageBubble
- MessageBubble.tsx L123-162: 右键菜单正确构建：user 可编辑(L142-147)、assistant 可重试(L148-153)、可删除(L155-161)
- **结论**: 这些功能**代码完整**，但因为 AI 通信本身不可用所以无法测试

### 🔴 Stop/中断功能
- AgentPanel L133-135: `handleStop` 仅调 `agentLoopRef.current?.stop()`
- agentLoop.ts 的 `stop()` 实现需验证是否真正中止 streaming fetch

### 🟡 Plan/Context Tab — 代码存在但数据为空
- **Plan Tab** L314-338: 渲染 `messages.filter(m => m.toolCalls?.length > 0)` — 如果对话不可用则永远"暂无工具调用记录"
- **Context Tab** L341-370: 静态展示当前 mode/model/token/tools/messages.length/API端点 — 数据来自 Redux，均为初始值

### 🔴 文件/图片上传
- L375-401: 有 `input[type=file]` 但仅触发 toast "附件功能完善中"
- 无 base64 编码、无 vision API 注入、无文件缩略图

### 🔴 Fast/Plan 模式无差异
- L244-256: 仅切换 Redux `mode` 值
- systemPrompt.ts 读取 mode 但可能差异不足
- agentLoop 未根据 mode 调整 temperature/工具集/thinking 块显示

---

## 二、状态栏（StatusBar.tsx: 72L）

| 项目 | 代码行 | 状态 |
|------|--------|------|
| Token 计数 | L24-26 | 🔴 粗估，非 API 真实值 |
| 连接状态 | L66 | 🔴 硬编码 `已连接` (永绿) |
| Git 分支 | L55 | 🔴 硬编码 `main` |
| 版本号 | L68 | 🟢 显示 v0.1.0（可接受） |
| Streaming 指示 | L58-62 | 🟡 代码存在，依赖对话可用 |

---

## 三、终端（TerminalPanel.tsx: 166L）

### Web 模式 — 有基本模拟但存在问题
- L56-93: 实际实现了 help/clear/echo/ls/whoami/date/pwd/cat/history/env 命令
- 但用户反馈"无法输入" → 可能是 CSS 层叠遮挡或 `form.onSubmit` 未触发
- L159 `autoFocus` 可能在面板切换时失效

### Electron 模式 — 未实装
- L95-99: 仅追加 `$ {cmd}` + `执行中...` 到输出，无 IPC 调用
- 没有 `window.electron.command.exec()` 或 `node-pty` 集成

---

## 四、文件系统（fileSystem.ts: 375L）

### 全内存 + DEMO 假数据
- L30-70: `DEMO_FILE_TREE` 硬编码了课件/笔记/实验目录结构
- L71-77: `DEMO_FILES` 只有几个文件的假内容
- L155-162 `listDir`: 从内存树查找，不读磁盘
- L164-172 `readFile`: 先查 `memoryFiles` Map，再查 `DEMO_FILES`，无真实 fs
- L174-184 `writeFile`: 写入 `memoryFiles` Map + 更新内存树
- L186-220 `createFile/createDirectory`: 纯内存操作
- L222-226 `deleteFile`: 从内存树删除
- L228-246 `renameFile`: 内存重命名

### Electron 分支标注但未实现
- L1-7 注释说 `Electron 模式：通过 IPC 调用 Node.js fs`
- 但搜索全文件无 `window.electron` 或 IPC 调用
- `isElectron` 导入了但未使用

---

## 五、欢迎页（WelcomePage.tsx: 157L）

### 按钮有代码但效果受限
- L26 `handleNewCourse`: 用 `prompt()` 取名 → `fileSystem.createWorkspace()` → **纯内存**
- L33 `handleOpenWorkspace`: `fileSystem.switchWorkspace(id)` → **切换内存工作区**
- L98 打开工作区卡片: `onClick={() => handleOpenWorkspace('default')}` → 传硬编码 `'default'`，没有 dialog 选择文件夹
- L99 新建课程: `onClick={handleNewCourse}` → 有效但纯内存
- L100 导入课件: `onClick={handleImport}` → 创建 `input[type=file]` → `fileSystem.uploadFiles()` → **读取 File 对象到内存**
- L101 AI 助手: **无 onClick** → 点击无反应

---

## 六、设置面板（SettingsPanel.tsx）

### 通用设置 — 状态保存但不生效
- 字号/语言/主题/强调色：Redux 值变化但无 CSS 变量注入层
- 壁纸：选图到内存但无 DOM 背景层渲染

### AI 设置 — 部分可用
- API Key / 端点 保存到 Redux → localStorage → AIClient 读取 → **链路可能通**
- 测试连接：fetchModels 已修复空数组检查
- 获取模型：结果存 Redux 但下拉框未绑定

### 对话/安全/Synopsis/MultiAI/插件/数据 — 全部占位
- 所有 Toggle/Select 只改 Redux 状态，无后端逻辑
- 插件页：SKILL 列表硬编码 7 个 + workflow 2 个，MCP 服务器显示"Web 模式不可用"

### Tab 栏截断问题
- 容器无 `overflow-x: auto` 或 scroll buttons
- 窄屏下右侧 Tab 不可见不可选

---

## 七、知识概要（Synopsis）

- SynopsisPanel：从 DEMO_FILE_TREE 映射出课件文件列表
- 状态 (2已完成/3待处理) 硬编码
- "生成"按钮: synopsisEngine 仅定义了接口，未实现 RAG 管线

---

## 八、综合分级

### P0（阻塞使用）
1. AI 对话不可用（API Key → AIClient → streaming 全链路需验证修通）
2. 输入框 disabled 阻止用户操作
3. 文件查看器无法加载文件（虚拟路径 `/workspace/xxx`）

### P1（核心功能缺失）
4. 终端 Electron 模式不可用
5. 文件系统纯内存，不与磁盘同步
6. 设置不生效（字号/主题/强调色/壁纸）
7. 模型选择器不可用
8. Token/连接状态虚假

### P2（功能不完整）
9. Fast/Plan 模式无行为差异
10. 文件/图片上传仅 toast
11. 知识概要硬编码假数据
12. 欢迎页"打开工作区"传硬编码 'default' 无 dialog
13. 设置各 Tab 全占位
14. 设置 Tab 栏窄屏截断
15. 插件页 SKILL/workflow/MCP 全硬编码
