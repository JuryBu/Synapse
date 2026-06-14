主人，Stage 0 / 0.5 的 P0/P1 修复我审完了。结论：不能通过，Electron 主链路仍有 P0 阻断，部分 P1 只是标记完成但风险仍在。

**发现**

1. **P0：Electron 生产启动路径仍是错的**  
   [electron/main.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts:29) 仍加载 `path.join(__dirname, '../dist/index.html')`。但 [tsconfig.electron.json](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/tsconfig.electron.json:6) 的输出会让 `__dirname` 变成 `dist-electron/electron`，实际解析到 `dist-electron/dist/index.html`，该文件不存在。实际 Web 产物在 `dist/index.html`。  
   同时 [package.json](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/package.json:30) 仍引用不存在的 `public/icon.png`。

2. **P0：当前 Electron 构建已经失败**  
   `npm run electron:build` 失败，因为 [electron/database.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/database.ts:7) 引入了 `better-sqlite3`，但依赖和类型未安装。虽然这是 Stage 3 文件，但它已经进入 `electron/**/*.ts` 编译范围，直接破坏 Stage 0 的 Electron 验收。

3. **P0：IPC 契约仍不完整**  
   渲染侧类型要求 `mcp.start/stop`：[src/platform/index.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/platform/index.ts:36)，实际调用在 [src/services/mcpManager.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/mcpManager.ts:76)。但 [electron/preload.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/preload.ts:27) 只暴露 `callTool/listTools/getStatus/restart`，[electron/main.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts:139) 也只注册到 `mcp:restart`。Electron 模式下启动/停止 MCP 会运行时失败。

4. **P0/P1：API Key 的 Electron 安全持久化没有接入**  
   Web 侧只是用 `btoa` 写 localStorage：[src/store/index.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/store/index.ts:44)。`safeStorage` 版本在 [electron/ipc/config.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/ipc/config.ts:6)，但没有任何调用方注册 `registerConfigHandlers()`，渲染层也没有使用 `window.synapse.config`。所以 P0-3 只完成了 Web 持久化，没有完成计划要求的 Electron 加密持久化。

5. **P1：sandbox 安全问题没有修复**  
   [electron/main.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts:20) 仍是 `sandbox: false`，只是加了注释。这个不能算 P1-1 修复完成。

6. **P1/质量：Lint 目标未达成**  
   `npm run lint` 当前失败：`119 problems，118 errors，1 warning`。Stage 0.5 的“代码质量”目标还没有闭合。

**已确认有效的修复**

- P0-5 文件扩展名映射已修：[src/components/layout/Sidebar.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/Sidebar.tsx:41)。
- P1-2 DOCX 和 Mermaid 注入防护已有接入：[DocxViewer.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/editor/DocxViewer.tsx:31)、[MessageBubble.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/chat/MessageBubble.tsx:56)。
- P2-3 FirstUseWizard 已挂载：[App.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/App.tsx:24)。
- P0-4 纯 `tool_calls` 主分支已有修复迹象：[agentLoop.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts:152)。

**验证**

- `npm run build`：通过，但仍有大 chunk 和动态导入警告。
- `npm run electron:build`：失败，缺 `better-sqlite3`。
- `npm run lint`：失败，118 个错误。

审查结论已保存到 memory-store：`20260425-172928219-结论`。