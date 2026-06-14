主人，Review 完成。结论先说：当前代码已经能跑通 Web 构建，但还不适合视为可交付桌面应用；最大风险集中在 Electron 生产启动、IPC 契约漂移、Agent 工具调用闭环、设置持久化和安全边界。

**严重问题**
1. Electron 打包后大概率无法正常启动  
   [electron/main.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts:6) 用 `NODE_ENV !== 'production'` 判断开发环境，打包环境不一定设置 `NODE_ENV=production`，可能继续加载 `http://localhost:5173`。即使进入生产分支，[electron/main.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts:29) 会找 `dist-electron/dist/index.html`，实际构建产物在 `dist/index.html`。另外 [package.json](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/package.json:30) 引用的 `public/icon.png` 不存在。

2. Electron IPC 契约是断的  
   [electron/preload.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/preload.ts:17) 暴露了 `file/mcp/terminal/config`，但 [electron/main.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts:67) 只实现了 `platform:info`。所以 Electron 模式下文件读取、写入、MCP、终端、配置 API 都会运行时失败。

3. 桌面端安全边界不足  
   [electron/main.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts:17) 关闭了 Node 集成和开启了上下文隔离，但 [electron/main.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts:21) 又设置 `sandbox: false`。考虑到预加载层计划暴露文件、终端、MCP 和配置能力，这个边界偏危险。

4. Agent 工具调用协议会丢合法响应  
   [src/services/agentLoop.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts:148) 只有在 `fullContent` 非空时才写入 assistant 消息；如果模型只返回 `tool_calls` 且没有文本，这是 OpenAI 兼容接口的合法情况，但当前会走 [src/services/agentLoop.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts:184) 的“空响应”分支，工具不会执行。

5. 文件树点击打开文件的主链路有类型映射 bug  
   [src/components/layout/Sidebar.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/Sidebar.tsx:41) 取到的 `node.extension` 是 `pdf/md/docx` 这种无点扩展名，但 [src/components/layout/Sidebar.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/Sidebar.tsx:42) 的 `typeMap` 用的是 `.pdf/.md/.docx`。结果是侧栏里点击 PDF、Markdown、DOCX、PPTX 大多会落到代码占位页。

**高优先级问题**
6. API Key 和设置没有真正持久化  
   [src/store/slices/settings.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/store/slices/settings.ts:25) 把 API Key 放在 Redux 内存状态里，[src/store/index.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/store/index.ts:14) 没有持久化中间件或加载逻辑。刷新后设置会丢，AI 面板会回到未配置状态。`FirstUseWizard` 也没有被任何地方引用，`synapse_onboarded` 只写不读。

7. DOCX 渲染存在 HTML 注入风险  
   [src/components/editor/DocxViewer.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/editor/DocxViewer.tsx:28) 用 mammoth 转 HTML 后，[src/components/editor/DocxViewer.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/editor/DocxViewer.tsx:61) 直接 `dangerouslySetInnerHTML`。这里需要净化 HTML。Mermaid 渲染的 SVG 也在 [src/components/chat/MessageBubble.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/chat/MessageBubble.tsx:78) 直接注入，建议显式收紧 Mermaid 安全配置。

8. 工具审批设置没有接入执行链路  
   [src/services/toolRegistry.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/toolRegistry.ts:66) 有审批回调入口，[src/services/toolRegistry.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/toolRegistry.ts:73) 也有自动批准设置，但全仓搜索没有调用方。当前设置页的安全开关不会影响真实工具执行。

9. Lint 当前是红的  
   `npm run lint` 失败：116 个问题，其中 115 个错误。核心不是格式，而是大量 `any` 把 `RootState`、IPC、工具参数、消息协议的类型保护绕开了；还包含 React Hooks 规则错误，比如 [src/hooks/useShortcuts.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/hooks/useShortcuts.ts:18)。

10. 生产依赖有安全告警  
   `npm audit --omit=dev` 报 10 个漏洞，3 个 moderate、7 个 high，涉及 `@xmldom/xmldom`、`dompurify`、`lodash-es`、`uuid` 等传递依赖。主要来源是 `mammoth`、`mermaid`、`electron-builder` 链路。

**验证结果**
`npm run build` 通过，但 Vite 提示大 chunk 和 `fileSystem.ts` 动态导入无效。`npm run electron:build` 通过。仓库内没有找到测试文件，也没有找到 `Plan_*.md` 或 `Task.md`。本次没有修改项目文件；Review 结论已写入 memory-store，ID 是 `20260425-162919890-深度结论`。