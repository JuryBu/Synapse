# Plan_2_代码审计: 双轮 Review 整合报告

> **审计方式**：自主代码审计 + Codex 5.4 独立 Review
> **审计日期**：2026-04-25
> **报告分级**：🔴 P0 紧急 | 🟡 P1 重要 | 🟢 P2 建议

---

## 🔴 P0 紧急（5项）

### P0-1: Electron 打包后无法启动
- **来源**：Codex #1
- **文件**：`electron/main.ts:6,29` + `package.json:30`
- **问题**：NODE_ENV 判断不可靠 + 生产路径指向 `dist-electron/dist/index.html`（应为 `dist/index.html`）+ `public/icon.png` 不存在
- **修复**：使用 `app.isPackaged` 判断 + 修正路径 + 补充图标文件

### P0-2: IPC 契约完全断裂
- **来源**：Codex #2 + 自主审计 A-1
- **文件**：`electron/preload.ts:17` vs `electron/main.ts:67`
- **问题**：preload 暴露了 file/mcp/terminal/config 四类 API，main 只实现 `platform:info`
- **修复**：逐步实现各 IPC handler，或标记为 TODO 避免运行时 crash

### P0-3: API Key 明文无持久化
- **来源**：Codex #6 + 自主审计 A-3
- **文件**：`store/slices/settings.ts:25` + `store/index.ts:14`
- **问题**：API Key 存 Redux 内存，无持久化中间件，刷新即丢失
- **修复**：Web 模式用 localStorage 中间件；Electron 用 safeStorage 加密

### P0-4: Agent 工具调用会丢失纯 tool_calls 响应
- **来源**：Codex #4
- **文件**：`services/agentLoop.ts:148-184`
- **问题**：模型只返回 tool_calls 无文本时，走"空响应"分支跳过工具执行
- **修复**：`fullContent` 为空但 `pendingToolCalls` 非空时仍应进入工具执行循环

### P0-5: 文件树扩展名映射 bug
- **来源**：Codex #5
- **文件**：`components/layout/Sidebar.tsx:41-42`
- **问题**：`node.extension` 是 `pdf`，`typeMap` 用 `.pdf`，导致文件打开全落到占位页
- **修复**：统一扩展名格式（去掉点号或加上点号）

---

## 🟡 P1 重要（5项）

### P1-1: Electron sandbox: false 安全隐患
- **来源**：Codex #3
- **文件**：`electron/main.ts:21`
- **问题**：关闭了 Node 集成但又 `sandbox: false`，预加载层暴露大量能力

### P1-2: DOCX/Mermaid HTML 注入风险
- **来源**：Codex #7
- **文件**：`components/editor/DocxViewer.tsx:61` + `chat/MessageBubble.tsx:78`
- **问题**：mammoth 输出的 HTML 直接 `dangerouslySetInnerHTML`，Mermaid SVG 直接注入

### P1-3: 工具审批设置未接入执行链路
- **来源**：Codex #8
- **文件**：`services/toolRegistry.ts:66,73`
- **问题**：setApprovalCallback 和 updateAutoApprove 有方法但全仓无调用方

### P1-4: AgentPanel 448 行大组件需拆分
- **来源**：自主审计 A-6
- **文件**：`components/layout/AgentPanel.tsx`
- **问题**：输入框、消息列表、模式切换、导出全耦合在同一组件

### P1-5: CHECKPOINT 压缩非 AI 摘要
- **来源**：自主审计 A-5
- **文件**：`services/systemPrompt.ts:114-151`
- **问题**：只截取消息前 200 字拼接，非调用模型生成高质量摘要

---

## 🟢 P2 建议（4项）

### P2-1: Lint 115 个错误
- **来源**：Codex #9
- **问题**：大量 `any` 绕开类型保护 + React Hooks 规则错误
- **建议**：逐步替换 `any` 为具体类型，修复 Hooks 依赖

### P2-2: npm audit 10 个漏洞
- **来源**：Codex #10
- **问题**：3 moderate + 7 high，涉及 xmldom/dompurify/lodash-es/uuid
- **建议**：更新 mammoth/mermaid 等依赖到安全版本

### P2-3: FirstUseWizard 未挂载
- **来源**：Codex #6 附
- **问题**：组件存在但无任何地方引用，`synapse_onboarded` 只写不读
- **建议**：在 App.tsx 中按条件挂载

### P2-4: Vite build 大 chunk 警告
- **来源**：Codex 验证
- **问题**：构建产物有大 chunk + fileSystem.ts 动态导入无效
- **建议**：拆分代码 + 修复动态 import 路径

---

## 总结：问题清单一览

| 编号 | 严重度 | 问题 | 来源 |
|---|---|---|---|
| P0-1 | 🔴 | Electron 打包启动失败 | Codex |
| P0-2 | 🔴 | IPC 契约断裂 | Codex + 自主 |
| P0-3 | 🔴 | API Key 无持久化 | Codex + 自主 |
| P0-4 | 🔴 | 工具调用丢失纯 tool_calls | Codex |
| P0-5 | 🔴 | 文件树扩展名映射 bug | Codex |
| P1-1 | 🟡 | sandbox: false 安全隐患 | Codex |
| P1-2 | 🟡 | HTML 注入风险 | Codex |
| P1-3 | 🟡 | 审批设置未接入 | Codex |
| P1-4 | 🟡 | AgentPanel 大组件 | 自主 |
| P1-5 | 🟡 | CHECKPOINT 非 AI 摘要 | 自主 |
| P2-1 | 🟢 | Lint 115 errors | Codex |
| P2-2 | 🟢 | npm audit 10 漏洞 | Codex |
| P2-3 | 🟢 | FirstUseWizard 未挂载 | Codex |
| P2-4 | 🟢 | Vite 大 chunk 警告 | Codex |

> 详细 Codex 原始报告见：`synapse-app/报告_Plan2全面审计_Codex.md`

