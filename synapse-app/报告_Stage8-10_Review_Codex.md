主人，Stage 8-10 Review 完成。结论：目前不建议合入，核心问题是 Electron IPC、前端平台类型、设置页宣称能力之间没有闭合，喵~

**严重问题**

1. `window.synapse` 实际暴露内容和前端类型不一致  
   [src/platform/index.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/platform/index.ts:31) 声明了 `mcp.start`、`mcp.stop` 和 [command.exec](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/platform/index.ts:51)，但 [electron/preload.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/preload.ts:27) 只暴露 `callTool/listTools/getStatus/restart`，也没有暴露 `command`。  
   结果是 [src/services/mcpManager.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/mcpManager.ts:76) 调用 `window.synapse.mcp.start()` 会运行时失败，[src/services/toolRegistry.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/toolRegistry.ts:384) 的 `run_command` 在 Electron 模式下也会直接炸。

2. 文件 IPC 返回契约和前端消费方式冲突  
   [electron/ipc/file.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/ipc/file.ts:12) 的 `file:read` 返回 `{ content, size, path }`，但 [src/services/fileSystem.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/fileSystem.ts:164) 声明并按 `string` 使用。  
   这会影响 Markdown 预览、`view_file`、RULES 加载和 MCP 配置读取。例如 [src/services/mcpManager.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/mcpManager.ts:56) 会对对象执行 `JSON.parse(raw)`。

3. Stage 10 Multi-AI 没有接入主 Agent 工具链  
   [src/services/agentOrchestrator.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentOrchestrator.ts:240) 定义了 `spawn_subagent`，但 [src/components/layout/AgentPanel.tsx](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/AgentPanel.tsx:51) 只注册 `toolRegistry.getSchemas()`。  
   `spawn_subagent` 没有注册成工具，也没有 handler；[shouldAutoSpawn](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentOrchestrator.ts:55) 全仓没有调用方。设置页启用 Multi-AI 后，主 Agent 实际仍不能创建子代理。

**高优先级问题**

4. Stage 9 RULES 加载没有入口，且文案和实现路径不一致  
   [src/services/extensionManager.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/extensionManager.ts:151) 定义了 `loadRulesFromFS()`，但全仓没有调用。系统提示只在 [src/services/systemPrompt.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/systemPrompt.ts:62) 读取内存里的扩展提示。  
   另外设置页说全局规则是 `~/.synapse/SYNAPSE.md`，实现读取的是 [~/.synapse/rules.md](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/extensionManager.ts:156)。

5. `file:grep` 是空实现  
   [electron/ipc/file.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/ipc/file.ts:87) 注册了 `file:grep`，但 [line 89-91](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/ipc/file.ts:89) 直接返回空数组。前端或工具层以为 grep 可用时，会得到稳定的假阴性结果。

6. 命令执行 IPC 缺少主进程侧安全边界  
   [electron/ipc/command.ts](c:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/ipc/command.ts:14) 直接把任意字符串交给 `cmd.exe /c` 或 `/bin/sh -c`。审批目前只在前端 `toolRegistry` 层，IPC 本身没有工作区边界、命令白名单或主进程二次确认。渲染层一旦被注入或插件误触达，就可以绕过预期审批。

**验证结果**

`npm run build` 通过。  
`npm run electron:build` 通过。  
`npm run lint` 失败：129 个问题，128 个错误。  
`npm run electron:pack` 失败：electron-builder 在 Windows 解压 `winCodeSign` 时无法创建符号链接，同时提示使用默认 Electron 图标。  

本次只做审查，没有修改项目文件。结论已写入 memory-store：`20260425-185012011-结论`。