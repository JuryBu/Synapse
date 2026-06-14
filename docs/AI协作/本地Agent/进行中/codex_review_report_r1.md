完整报告已写入 [报告_stage1-7_代码Review_Codex.md](C:\Users\Stardust\Desktop\VC工具包\Synapse\docs\AI协作\本地Agent\进行中\报告_stage1-7_代码Review_Codex.md)。

**Critical**
- [src/components/chat/MessageBubble.tsx:63](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\components\chat\MessageBubble.tsx:63) 启用了 `rehypeRaw`，AI/工具返回内容可直接进入原始 HTML 渲染，存在明确 XSS 面。
- [src/platform/index.ts:106](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\platform\index.ts:106) 把配置和 API Key 明文写入 `localStorage`；和上面的 XSS 组合后可直接泄露密钥。

**Major**
- [electron/main.ts:17](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\electron\main.ts:17) 关闭了 `sandbox`，而 [electron/preload.ts:17](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\electron\preload.ts:17) 又暴露了较大的高权限桥接面，Electron 安全边界偏弱。
- [electron/preload.ts:17](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\electron\preload.ts:17) 声明了 `file/mcp/terminal/config` API，但 [electron/main.ts:55](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\electron\main.ts:55) 只注册了窗口和平台 handler，IPC 契约已失配。
- [src/services/agentLoop.ts:129](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\services\agentLoop.ts:129) 工具执行失败只写入局部数组，不写 Redux；[src/services/agentLoop.ts:169](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\services\agentLoop.ts:169) 流错误只 `console.error`，UI 看不到真实失败状态。
- [src/services/fileSystem.ts:81](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\services\fileSystem.ts:81) 永远返回 demo 树，和 [src/components/layout/Sidebar.tsx:18](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\components\layout\Sidebar.tsx:18) 的工作区状态形成假闭环。
- 类型安全已经实际失守：`npm run lint` 报 35 个错误，代表性位置包括 [src/platform/index.ts:27](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\platform\index.ts:27)、[src/services/aiClient.ts:62](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\services\aiClient.ts:62)、[src/services/agentLoop.ts:18](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\services\agentLoop.ts:18)、[src/components/layout/AppLayout.tsx:32](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\components\layout\AppLayout.tsx:32)。
- Redux source of truth 有漂移风险：[src/store/slices/conversation.ts:20](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\store\slices\conversation.ts:20) 和 [src/store/slices/agentSettings.ts:5](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\store\slices\agentSettings.ts:5) 同时持有模型状态。

**Minor / Suggestion**
- [src/components/layout/AgentPanel.tsx:22](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\components\layout\AgentPanel.tsx:22) 在流式输出时每个 chunk 都触发平滑滚动，容易抖动。
- [src/styles/layout.css:330](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\styles\layout.css:330) 与 [src/styles/chat.css:6](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\styles\chat.css:6) 重复定义 `.agent-messages`；`blink` 动画也重复，样式行为依赖导入顺序。
- [src/styles/fileTree.css:59](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\styles\fileTree.css:59) 的 `display: contents` 配合 [src/components/sidebar/FileTree.tsx:32](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\components\sidebar\FileTree.tsx:32) 的点击 `div`，可访问性较差。
- [src/store/slices/layout.ts:3](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\store\slices\layout.ts:3) 已经出现未消费状态字段，slice 边界开始膨胀。

**验证**
- `npm run lint`：失败，35 个错误，主要是 `no-explicit-any`。
- `npx tsc -b --pretty false`：失败，报 [src/platform/index.ts:70](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\platform\index.ts:70) 和 [src/platform/index.ts:89](C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\src\platform\index.ts:89) 未使用变量。

如果你要，我下一步可以直接按这个报告继续做一版修复清单，或者先只处理 Critical/Major。