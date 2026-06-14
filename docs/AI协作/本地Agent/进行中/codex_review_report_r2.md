**Findings**

`Critical`
- [src/platform/index.ts#L70](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/platform/index.ts#L70) 和 [src/platform/index.ts#L89](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/platform/index.ts#L89) 直接导致 `npm run build` 失败。当前主构建链路已断，项目不能产出正式前端包；这不是代码风格问题，而是发布阻断。
- [src/components/chat/MessageBubble.tsx#L3](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/chat/MessageBubble.tsx#L3) 与 [src/components/chat/MessageBubble.tsx#L63](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/chat/MessageBubble.tsx#L63) 启用了 `rehypeRaw`，但没有任何 sanitize。AI/工具输出是非可信输入，这里存在原始 HTML 注入风险。

`Major`
- [src/components/layout/AgentPanel.tsx#L27](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/AgentPanel.tsx#L27) 仍然是 `setTimeout + getDemoResponse()` 的 demo 逻辑，而 [src/services/agentLoop.ts#L32](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts#L32) 和 [src/services/toolRegistry.ts#L56](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/toolRegistry.ts#L56) 并未接入 UI。Stage 5-7 目前是模块存在、主链路未闭环。
- [electron/preload.ts#L17](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/preload.ts#L17) 暴露了 `file/mcp/terminal/config`，但 [electron/main.ts#L53](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/main.ts#L53) 只实现了窗口控制和 `platform:info`。再结合 [src/services/fileSystem.ts#L65](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/fileSystem.ts#L65)，Electron 模式下一旦走真实文件 API，就会命中未注册 IPC。
- [src/components/layout/AgentPanel.tsx#L16](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/AgentPanel.tsx#L16)、[src/components/layout/AgentPanel.tsx#L23](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/AgentPanel.tsx#L23)、[src/components/chat/MessageBubble.tsx#L63](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/chat/MessageBubble.tsx#L63) 这条渲染链在流式场景下会放大性能问题：每个 chunk 都会重绘消息列表、重新跑 Markdown 渲染，并触发一次平滑滚动。
- [src/main.tsx#L8](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/main.tsx#L8) 根树没有 Error Boundary。任意渲染异常都会直接打挂整个应用。
- [src/services/agentLoop.ts#L148](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts#L148) 工具失败时只写入本地 `messages` 数组，不 dispatch 到 Redux；[src/services/agentLoop.ts#L174](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts#L174) 的流式错误也只 `console.error`。用户侧会出现“模型上下文知道失败，UI 历史看不到失败”的不一致。
- [src/components/sidebar/FileTree.tsx#L13](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/sidebar/FileTree.tsx#L13) 和 [src/components/sidebar/FileTree.tsx#L98](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/sidebar/FileTree.tsx#L98) 同时踩中性能与 a11y：递归全量渲染、无虚拟化、无懒加载，且主体是 `div + onClick`，没有 tree 语义、键盘导航和 `aria-expanded`。

`Minor`
- [src/components/layout/Sidebar.tsx#L18](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/Sidebar.tsx#L18) 和 [src/components/layout/Sidebar.tsx#L28](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/Sidebar.tsx#L28) 首次进入会重复加载同一份 workspace tree；现在只是多一次 demo 读取，接真实文件系统后会变成重复 I/O。
- [src/components/layout/ActivityBar.tsx#L41](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/ActivityBar.tsx#L41)、[src/components/layout/AgentPanel.tsx#L64](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/AgentPanel.tsx#L64)、[src/components/layout/BottomPanel.tsx#L10](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/BottomPanel.tsx#L10) 缺少 tab/button 状态语义；[src/styles/chat.css#L78](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/styles/chat.css#L78) 的 copy 按钮只在 hover 时可见，键盘和触屏都不友好。
- [src/store/index.ts#L13](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/store/index.ts#L13) 注册了 10 个 slice，但当前主线实际接入的只有少数几个，状态面明显超前于功能面。
- [src/components/layout/AgentPanel.tsx#L8](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/components/layout/AgentPanel.tsx#L8)、[src/services/agentLoop.ts#L28](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts#L28)、[src/platform/index.ts#L14](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/platform/index.ts#L14)、[electron/preload.ts#L3](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/electron/preload.ts#L3) 已经出现公共逻辑重复，尤其是 `generateId` 和 IPC 契约双份维护，后面很容易继续漂移。

**Assumptions**
- 如果 Stage 5-7 的目标是“模块先写、集成后补”，那么“Agent 主链路未接通”的严重度可以下调半级；但从“已完成 Stage 1-7”的口径看，我按主线功能应可闭环来评估。
- 我没有发现自动化测试文件，所以这轮结论主要来自静态审查和构建验证。

**验证与报告**
- `npm run lint`：失败，35 个错误，主要是 `any` 和未使用变量。
- `npm run build`：失败，阻断点在 `src/platform/index.ts`。
- `npm run electron:build`：通过。

完整报告已写入 [报告_第二轮独立Review_Codex.md](/C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/报告_第二轮独立Review_Codex.md)。如果你要，我下一步可以直接按这个优先级出一版修复清单，或者先处理前两个 Critical。