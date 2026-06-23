# Plan_5 M4-7 — MCP 真接（读为主）：桥接 MCP 工具进 agentLoop 工具循环 + 默认配置 + /compact 手动入口与自动压缩并存

> 子代理（opus）逐文件读真实代码后的设计（2026-06-16）。实现时按此推进。
> 本里程碑把 Synapse 已内置但未接通的 MCP stdio client 桥接进工具循环，真接三个本地 MCP server（读为主），修掉「内置三条 entry 启动必失败」，并新增 `/compact` 手动压缩入口（与现有自动压缩并存，复用同一套逻辑）。
>
> ⚠️ **关键纠正（与设计稿冲突，以主人决策为准）**：原设计稿标题/Stage 写的「record 生成从自动转手动 /compact 触发、90% 水位自动触发改为只提示不压缩」是错的。主人最终决策：**Synapse 现有的自动压缩（~90% 水位自动生成 record）保持不变，不改成手动**；`/compact` 是**新增的手动压缩入口**，与自动压缩**并存**，二者**复用同一套压缩逻辑**。"生成转手动"那条只针对 MCP memory-store 自带的生成功能，不适用于 Synapse 自身的 record 自动压缩。本文档已据此把 S6 整体重写为「抽出可复用 compactNow + /compact 手动入口 + 自动压缩原样保留」。

---

## 一、目标

把 Synapse 已经写好但「悬空未接」的 MCP 能力真正打通，让主 AI 和子代理都能实际调用三个本地 MCP server 的工具（读为主）。具体三件事：

1. **桥接 MCP 工具进工具循环**：把现有 MCP stdio client（`electron/mcp/MCPServerProcess.ts` 已完整实现 JSON-RPC 2.0）发现的工具，桥接进 `toolRegistry`/`agentLoop`，使主 AI 与子代理能真实调用 `mcp-memory-store` / `mcp-sandbox` / `mcp-web-fetcher` 三个本地 server 的工具。当前 `AgentPanel.tsx` 只注册内置 `toolRegistry.getSchemas()`，AI 调不到任何 MCP 工具。
2. **默认配置 + 修 UI 启动失败**：首次运行自动生成默认 `~/.synapse/mcp_config.json`，指向三个 server 的 stdio 入口（`node <绝对路径>/dist/index.js`），修掉「设置面板三条内置 entry 点启动必报 `not found in config`」的现状。配套硬编码默认路径 + 可编辑 UI。
3. **`/compact` 手动入口（新增，与自动压缩并存）**：从 `agentLoop` 压缩分支抽出可复用的 `compactNow(conversationId)`，对接 M4-6 的 `/compact` 命令，让用户能**主动**触发一次「生成 record 批次 + 截断历史 + 刷新注入前缀」的压缩。**现有 ~90% 水位的自动压缩完全保留、行为不变**，手动与自动复用同一套压缩实现。

附带收尾：保留并明确「内置 memory」与「外置 MCP memory-store」两套独立记忆的读路径；删除 `mcpManager.ts` mock 死代码；补强 `MCPServerProcess` 健壮性（windowsHide / 快速失败 / capabilities）。

---

## 二、覆盖问题（对应用户问题编号）

- **现状-1**：MCP 工具未桥接进 `toolRegistry`/`agentLoop`。`AgentPanel.tsx:233-237` 只 `registerTools(toolRegistry.getSchemas(), ...toolRegistry.execute(...))`，注册的 schema 与 executor 全部来自内置 `toolRegistry`，纯内置工具，AI 调不到任何 MCP 工具。`agentOrchestrator.ts:245-246` 子代理同样只取 `toolRegistry`。
- **现状-2**：`~/.synapse/mcp_config.json` 缺失。`ipc/mcp.ts:21-37` 的 `loadMCPConfig` 读不到文件 → merged 为空 → `mcp:start` 抛 `MCP server "x" not found in config`；`SettingsPanel.tsx:104-126` 写死三条 entry 但配置文件不存在，点启动必失败。
- **现状-4**：`services/mcpManager.ts` 是 mock 死代码（构造里写死三个 server tools 数组，`loadConfig` 走 `file.read` 不解析 `servers` 包裹，与真实 IPC 路径并行但不被消费）。
- **主人决策（MCP）**：真接三个本地 MCP server（`C:\Users\Stardust\.gemini\antigravity` 下三目录），读为主；默认只开 memory-store，另两个默认关；MCP 工具审批 sandbox 执行 / web 写类强制审批（不全放行）；桥接 MCP `listTools` 进 `toolRegistry`/`agentLoop`；默认 `mcp_config.json` 硬编码路径 + 可编辑 UI；`mcpManager.ts`（mock 死代码）删除。
- **主人决策（record/compact）【重要纠正】**：保留自动压缩 + 新增 `/compact` 手动入口并存（详见文首纠正）。
- **内置 memory 与外置 MCP memory-store 关系**：数据不通，读功能多保留，设计读路径。

---

## 三、确认现状 / 真根因（逐文件读真实代码）

已逐文件读真实代码，确认并纠正如下。

### brief 准确处（已核实）

1. **MCP stdio client 完整存在**：`electron/mcp/MCPServerProcess.ts` 实现 spawn 子进程 + JSON-RPC 2.0 行分帧 + `initialize`（protocolVersion `2024-11-05`）+ `notifications/initialized` + `tools/list` + `tools/call`，30s 超时、pending Map、close 时 reject 全部 pending。`electron/ipc/mcp.ts` 暴露 `mcp:status/start/stop/restart/listTools/callTool`，`main.ts:12/110/119` 已 `registerMCPHandlers` + `shutdownAllMCP`。
2. **MCP 工具确实没接进工具循环**：`AgentPanel.tsx:232-237`：`new AgentLoop(aiClient); loop.registerTools(toolRegistry.getSchemas(), (name,args,ctx)=>toolRegistry.execute(...))` —— 注册的 schema 与 executor 全部来自内置 `toolRegistry`，`agentLoop.run` 里 `this.client.streamChat(apiMessages, this.tools)` 的 `this.tools` 即这批内置工具，无任何 MCP 来源。`agentOrchestrator.ts:245-246` 子代理同样只取 `toolRegistry`。
3. **`mcp_config.json` 缺失**：`ipc/mcp.ts:21-37` `loadMCPConfig` 读 `~/.synapse/mcp_config.json` 与 `cwd/.synapse/mcp_config.json`，文件不存在 → merged 为空 → `mcp:start` 抛 `MCP server "x" not found in config`；`SettingsPanel.tsx:104-126` `mcpEntries` 写死三条 entry（sandbox/web-fetcher/memory-store）但配置文件不存在，点启动必失败。
4. **`mcpManager.ts` 是 mock 死代码**：构造里写死三 server + tools 数组，`startServer` 在 Web 模式 `setTimeout` 假装启动；它与 `ipc/mcp.ts` 真实进程管理并存，但 `SettingsPanel` 走的是 `platform.mcp.*`（→`window.synapse.mcp`→`ipc/mcp.ts`），`mcpManager` 实际未被消费。
5. **内置 memory 真实可用**：`toolRegistry.ts:437-521` 注册 `memory_write`/`memory_query`（approval auto），后端 `memoryStore.ts`→`platform.memory`（Electron SQLite `memories` 表 `database.ts:85`，Web localStorage），含 `getMemory`/`listMemories`/`deleteMemory` 读路径，但仅 `write`/`query` 暴露为工具。
6. **record 自动触发确认**：`agentLoop.run` 在 `compressContext` 判定 `wasCompressed`（90% 水位 `COMPRESSION_THRESHOLD`）时才 `generateBatch`+`appendBatch`，全程无 `/compact` 入口；全仓 grep `compact` 只命中设置/workflow 命名，无 slash command 实现。→ 本里程碑要补的是**手动入口**，自动这条**原样保留**。

### brief 需纠正 / 补充的关键现状（真根因）

- **★1（transport 误解风险，最大坑）**：现有宿主（CC `~/.claude.json`、Codex `~/.codex/config.toml`）连这三个 server 用的是 **HTTP Broker**（`http://127.0.0.1:14588/<server>/mcp`），**不是 stdio**；但三个 server 的 `dist/index.js` 经 grep 确认都用 `StdioServerTransport` + `process.stdin`，原生支持 stdio。**结论**：Synapse 的 `MCPServerProcess`（stdio spawn）可直接拉起它们各自的 `dist/index.js`，**不需要也不应该走 HTTP Broker**（`MCPServerProcess` 只实现 stdio，没有 HTTP transport 代码，误试图接 Broker = 白做）。
- **★2（默认配置入口形态已坐实）**：三个 `package.json` 均 `type=module`、`main=dist/index.js`、`start='node dist/index.js'`、依赖 `@modelcontextprotocol/sdk ^1.6.1`；故默认配置 `command='node'`、`args=['<server 绝对路径>/dist/index.js']`。三个绝对路径分别为：
  - `C:\Users\Stardust\.gemini\antigravity\mcp-memory-store\dist\index.js`
  - `C:\Users\Stardust\.gemini\antigravity\mcp-sandbox\dist\index.js`
  - `C:\Users\Stardust\.gemini\antigravity\mcp-web-fetcher\dist\index.js`
- **★3（MCPServerProcess 健壮性缺口，桥接前必须处理）**：`initialize` 的 `capabilities` 传空 `{}`（不声明 tools），多数 server 不强校验客户端 capability 故 `listTools` 可用，但需实测兜底；spawn 失败 / ENOENT 时 `process.on('error')` 置 error，但 `start()` 的 `initialize` 仍会先 `await`（request 里 `this.process?.stdin` 存在但子进程已崩）→ 靠 30s timeout 才 reject，体验差。桥接拉起时要并行监听 error 事件快速失败。
- **★4**：`MCPServerProcess.spawn` 未传 `windowsHide:true`，Windows 下拉起 node 子进程会闪黑框，需补。
- **★5**：`platform.mcp` Web mock（`platform/index.ts:277-284`）`listTools` 返回 `[]`、`callTool` 返回占位文本，桥接在 Web 模式天然空集，无需额外降级判断。

---

## 四、详细设计

> 总体架构：在 renderer 侧新建一个 `mcpBridge` 服务，作为「MCP server 工具」与「`toolRegistry`/`agentLoop`」之间的适配层；桥接产物（MCP 工具的 OpenAI function schema + 调用闭包）在构建 `AgentLoop` 时通过注册进 `toolRegistry` 自动并入工具集。所有 MCP 调用经 `platform.mcp`（→`window.synapse.mcp`→`ipc/mcp.ts`→`MCPServerProcess`）走真实 stdio 子进程，读为主。

### 一、桥接层 mcpBridge（核心）

新建 `src/services/mcpBridge.ts`。职责：

- **(a) 启动协调**：`refresh()` 调 `platform.mcp.getStatus()` 拿到配置里所有 server，对 `enabled` 且未 `running` 的按需 `platform.mcp.start(name)`。首屏可懒启动：仅在用户在设置里启用或首次需要工具时启动，避免冷启动拉起 playwright 等重 server。
- **(b) 工具发现**：对每个 running server 调 `platform.mcp.listTools(name)` 拿到 `{name,description,inputSchema}[]`，转换为 `toolRegistry` 的 `ToolSchema`（`type:'function'`，`function.name` 做命名空间前缀，`parameters` 用 `inputSchema`，`inputSchema` 缺省时给 `{type:'object',properties:{}}`）。
- **(c) 命名空间与冲突**：MCP 工具名统一加前缀 `mcp__<server>__<tool>`（与四源体系既有命名习惯一致，且天然避开与内置 `view_file`/`memory_query` 等冲突——尤其外置 memory-store 也有 `memory_write`/`memory_query`，前缀后变 `mcp__memory-store__memory_query`，与内置 `memory_query` 清晰区分）。同 server 内重名不可能；跨 server 因带 server 段也不会撞。
- **(d) 调用路由**：为每个 MCP 工具生成 `ToolHandler` 闭包：解析前缀得到 `(server,tool)`，调 `platform.mcp.callTool(server,tool,args)`，把 MCP 返回的 `{content:[{type:'text',text}|{type:'image',...}]}` 结构**扁平化成字符串**（text 拼接；image/资源类给占位说明，读为主场景以文本为主）返回给工具循环。错误（server 未 running、超时）catch 成可读错误字符串，复用 `toolRegistry.execute` 已有的透明重试。
- **(e) 审批分类**：MCP 工具默认归入 `approvalLevel='read'`、`permissionCategory='read'`（读为主，符合主人决策），让默认 `autoApproveRead=true` 路径直接放行；但对「明显写/执行类」做关键词识别给更高等级：
  - **sandbox** 的 `exec`/`session`/`launch`/`codex` 类 → `'dangerous'`（command）
  - **web-fetcher** 的 `download`/`interact`/`login`/`desktop` 写类 → `'write'`
  - 识别用 server+tool 名前缀白/黑名单表（在 `mcpBridge` 内维护一张分类表），未命中默认 read。该分类**只决定审批，不阻止注册**。
  - 这条直接对应主人决策「MCP 工具审批 sandbox 执行 / web 写类强制审批（不全放行）」。

### 二、注入点改造（推荐方案 B：register 进 toolRegistry）

两处接线，**采用方案 B（把 MCP 工具 register 进 toolRegistry）**，这样 `getSchemas`/`execute`/审批/重试/子代理权限过滤全部自动复用，`AgentPanel` 与 `agentOrchestrator` 几乎零改动即可拿到 MCP 工具：

- **(1) `AgentPanel.tsx:233-237`**：构建 `AgentLoop` 时（挂载 / 设置变化后）调 `mcpBridge.refresh()` 把 MCP 工具注册进 `toolRegistry`；`registerTools` 仍用 `toolRegistry.getSchemas()`（此时已含 MCP 工具）+ `toolRegistry.execute`（前缀工具的 handler 自动路由到 mcp）。`mcpBridge` 负责「发现 → 注册/注销」生命周期，`toolRegistry` 负责「执行/审批」。需在 `toolRegistry` 加一个 `unregister(name)` 以支持 server 停用/重启时清理旧工具。
  - 对比方案 A（在 AgentPanel 里按 `mcp__` 前缀分流 executor）：方案 B 复用既有审批回调（含子代理来源文案）、透明重试、`getSchemasForPermissions` 权限闸门，改动面最小、与 M3 子代理体系无缝，故采用 B。
- **(2) `agentOrchestrator.ts:245-246`**：子代理 `getSchemasForPermissions(['read','search',...])` 已基于 `permissionCategory` 过滤；MCP 工具注册时带了 category（read/write/command），自动被纳入子代理权限闸门，读类 MCP 工具默认进子代理（符合读为主），**无需改 orchestrator**。

### 三、默认 mcp_config.json 生成

在 `main.ts` 启动序列（`registerMCPHandlers` 之前或之内）加 `ensureDefaultMCPConfig()`：若 `~/.synapse/mcp_config.json` 不存在则写入默认配置（**仅首次，存在则绝不覆盖用户编辑**）。默认内容形态：

```json
{
  "servers": {
    "memory-store": { "command": "node", "args": ["C:\\Users\\Stardust\\.gemini\\antigravity\\mcp-memory-store\\dist\\index.js"], "enabled": true },
    "sandbox":      { "command": "node", "args": ["C:\\Users\\Stardust\\.gemini\\antigravity\\mcp-sandbox\\dist\\index.js"], "enabled": false },
    "web-fetcher":  { "command": "node", "args": ["C:\\Users\\Stardust\\.gemini\\antigravity\\mcp-web-fetcher\\dist\\index.js"], "enabled": false }
  }
}
```

- **enabled 默认值（已决，见 openQuestions）**：按主人决策「默认只开 memory-store，另两个默认关」——`memory-store.enabled=true`、`sandbox`/`web-fetcher`=`false`。memory-store 最轻、读记忆最常用，默认开启即可让首屏就有跨源读记忆能力；sandbox/web-fetcher 依赖重（playwright/sharp/tree-sitter），首启动不自动 spawn，由用户在设置里显式开启。
- **路径硬编码**到主人机器绝对路径是务实选择（本项目单机自用），但要在设置 UI 给「打开 mcp_config.json / 编辑配置」入口让用户改路径（见下 UI）。
- `loadMCPConfig` 现已支持 `servers` 包裹与裸对象两种形态，生成用 `{servers:{}}` 形态最规范。

### 四、UI 修复（现状-2 / -4）

SettingsPanel 插件页：

- **(a)** 删静态 `mcpEntries` 三条 entry，全部走 `getStatus` 动态结果（状态/工具数/enabled 真实）。配置生成后 `getStatus` 会返回这三条真实 entry。
- **(b)** 每条 server 展示从 `listTools` 拿到的工具数与名称列表。现状 `ipc/mcp.ts:status` 的 `tools` 永远返回 `[]`，需补：status handler 对 running server 调 `proc.listTools()` 填 `tools`，或前端按需 `listTools`。
- **(c)** 加「打开 mcp_config.json」按钮（用既有 file/desktop 能力打开配置文件目录）让用户改路径 / 增删 server。
- **(d)** `mcpManager.ts` 死代码：确认无 import 引用后**删除**（SettingsPanel 实走 `platform.mcp`，`mcpManager` 无消费者），消除「两套并行 MCP 管理」的认知负担。

### 五、/compact 手动入口 + 自动压缩并存【按主人决策重写】

> 原设计稿这一节写的是「record 自动转手动 / 90% 水位改为只提示不压缩」，**已按主人决策推翻**。最终方案如下：

- **(a) 抽出可复用的 `compactNow(conversationId)`**：从 `agentLoop.run` 压缩分支里把「生成批次 record + 截断 `apiHistory` + 刷新注入前缀 + 通知」这段逻辑**下沉为一个可复用方法** `compactNow(conversationId)`。抽出后：
  - **自动压缩路径**（现有 ~90% 水位 `compressContext` 判定 `wasCompressed` 后）改为调用同一个 `compactNow`——**行为与现状完全一致**（仍在水位到达时自动生成 record 批次、截断历史），只是实现复用同一函数。
  - **手动压缩路径**（M4-6 的 `/compact` 命令解析后）也调用 `compactNow`——用户主动触发立即压缩当前对话历史为 record 批次并刷新注入前缀。
  - **核心**：自动与手动**共用一套压缩实现**，二者**并存**。自动压缩不被删除、不降级、不改成「只提示不压缩」。
- **(b) 与 M4-1 / M4-6 的边界**：
  - **M4-1** 负责压缩算法 / 阈值 / 触发判定（`compressContext`、`COMPRESSION_THRESHOLD`、token 保护性截断）——本里程碑不动这些。
  - **M4-6** 负责 `/compact` slash 命令的解析与分发——本里程碑只提供 `compactNow(conversationId)` API 供其调用。
  - **M4-7（本里程碑）** 只做「把 record 批次生成逻辑抽成 `compactNow` 可复用函数 + 把自动路径切到调用它 + 暴露给手动 `/compact`」这一层接线。`compressContext` 的水位判定与保护性截断仍由 M4-1 负责，自动触发逻辑保持原样，二者职责不重叠。
- **(c) record 生成模型**：复用 `recordGenerator.resolveClient`（现在跟随主模型）；全局决策「系统模型独立配置（留跟随主模型选项）」属 M4 其它里程碑，本里程碑只在 `resolveClient` 留 **TODO 钩子**，不实装系统模型拆分。

### 六、内置 memory 与外置 MCP memory-store 读路径

两套独立、数据不通，均保留：

- **(a) 内置 memory**（`toolRegistry` `memory_write`/`memory_query` → `memoryStore` → SQLite `memories` 表）：保持现状，是 AI 沉淀本应用相关长期记忆的**默认通道**。读功能「多保留」——补暴露 `memory_read(id)` / `memory_list` 为**只读工具**（`memoryStore` 已有 `getMemory`/`listMemories`，仅未注册为工具），让 AI 能列举/精读，不仅关键词检索。
- **(b) 外置 MCP memory-store**：桥接后以 `mcp__memory-store__memory_query` / `memory_read` / `conversation_read_original` 等**只读工具**形式出现（读为主），让 AI 跨源读其它宿主沉淀的记忆与对话原文。写类（`memory_write`）虽桥接但归 **write 审批等级**，默认需确认（读为主、避免污染外置库）。
- **(c)** 在 systemPrompt 或工具描述里明确两套区别（内置 = 本应用记忆默认写入处；`mcp__memory-store__*` = 跨源只读为主），避免 AI 混淆该往哪写。`toolRegistry.ts` 内置 memory 工具描述已写明「独立于外置 MCP，数据不互通」，桥接的外置工具描述沿用 server 自带 description 即可。

### 七、健壮性补强（MCPServerProcess）

- **(a)** spawn 加 `windowsHide:true` 去黑框。
- **(b)** `start()` 的 `initialize` 与 `process.on('error')` **竞速**：spawn 后若立刻 error（ENOENT / 路径错）应让 `start()` 快速 reject 而非等 30s timeout——在 start 里用 `Promise.race(initialize, errorEvent)` 或在 error handler 里 reject 进行中的 initialize。
- **(c)** `listTools` 失败（server 不支持 / 未声明 capability）catch 成空集，桥接跳过该 server 不崩。
- **(d)** `initialize` 的 `capabilities` 补 `{tools:{}}` 声明客户端支持工具（更规范）。

---

## 五、Stage 拆分

> 共 7 个 stage，全部搬运、无删减。S6 已按主人决策重写为「抽 compactNow + /compact 手动入口 + 自动压缩并存」。

### M4-7-S1 — MCPServerProcess 健壮性补强（effort: small）

- **做什么**：spawn 加 `windowsHide:true`；`start()` 的 `initialize` 与 process error 事件竞速快速失败（ENOENT / 路径错不再等 30s timeout）；`initialize` capabilities 补 `{tools:{}}`；`listTools` 失败 catch 成空集。为后续桥接拉起真实 server 打稳地基。
- **改动文件**：
  - `synapse-app/electron/mcp/MCPServerProcess.ts`
- **验收**：手工用一个不存在的 command 配置 start 时秒级返回 error（非 30s）；正常 server start 后 `listTools` 返回非空；Windows 下拉起无黑框（真机 Electron 启动一个 server 观察）。

### M4-7-S2 — 首次运行生成默认 mcp_config.json + status 填真实 tools（effort: small）

- **做什么**：`main.ts` 启动序列加 `ensureDefaultMCPConfig()`，文件不存在时写入 `{servers:{memory-store/sandbox/web-fetcher}}`，`command='node'`、`args=[三个 dist/index.js 绝对路径]`，enabled 按主人决策（memory-store=true、另两 false）；**存在则绝不覆盖**。修 `ipc/mcp.ts:status` handler 对 running server 填充真实 tools（调 `proc.listTools()`）。
- **改动文件**：
  - `synapse-app/electron/main.ts`
  - `synapse-app/electron/ipc/mcp.ts`
- **验收**：删除现有 `~/.synapse/mcp_config.json` 后启动 Electron，文件被生成且内容指向三个真实 `dist/index.js`；SettingsPanel 插件页能在该 server enabled 后点启动成功（status→running），不再报 `not found in config`。

### M4-7-S3 — 新建 mcpBridge.ts 桥接层 + toolRegistry.unregister（effort: medium）

- **做什么**：新建 `src/services/mcpBridge.ts` 桥接层：`refresh()` 拉取 `getStatus` → 对 running server `listTools` → 把每个 MCP 工具转 `ToolSchema`（名字加 `mcp__<server>__<tool>` 前缀，`inputSchema`→`parameters`）→ 按分类表定审批等级（read/write/command）与 `permissionCategory` → `register` 进 `toolRegistry`（handler 闭包路由到 `platform.mcp.callTool`，结果 `content[]` 扁平化为字符串）。`toolRegistry` 加 `unregister(name)` 支持 server 停用/重启清理旧工具。提供 `startServer`/`stopServer` 包装，在状态变化后重新 `refresh` 注册集。
- **改动文件**：
  - `synapse-app/src/services/mcpBridge.ts`（新建）
  - `synapse-app/src/services/toolRegistry.ts`
- **验收**：单测/手测：mock `platform.mcp.listTools` 返回若干工具后调 `mcpBridge.refresh()`，`toolRegistry.getSchemas()` 含 `mcp__` 前缀工具且审批等级符合分类表；`unregister` 后消失；`callTool` 路由参数正确。

### M4-7-S4 — 注入点接线 + SettingsPanel 动态列表（effort: medium）

- **做什么**：注入点接线——`AgentPanel.tsx` 构建 `AgentLoop` 时在挂载/设置变化后调 `mcpBridge.refresh()` 使 MCP 工具进 `toolRegistry`，`registerTools` 仍用 `toolRegistry.getSchemas()`（已含 MCP 工具）+ `toolRegistry.execute`（前缀工具自动走 mcp handler）。验证 `agentOrchestrator` 子代理经 `getSchemasForPermissions` 自动纳入读类 MCP 工具。SettingsPanel：删静态 `mcpEntries` 改全用 `getStatus` 动态列表，展示真实 tools 数；加「打开 mcp_config.json」入口。
- **改动文件**：
  - `synapse-app/src/components/layout/AgentPanel.tsx`
  - `synapse-app/src/components/settings/SettingsPanel.tsx`
- **验收**：真机：在设置启用 memory-store server，发一条让 AI 用 `mcp__memory-store__memory_query` 跨源读记忆的消息，AI 实际调用并返回外置库内容；子代理任务里读类 MCP 工具可用；插件页显示真实工具列表与状态。

### M4-7-S5 — 删 mcpManager.ts 死代码 + 补内置 memory 只读工具（effort: small）

- **做什么**：删除 `mcpManager.ts` 死代码（确认全仓无消费 import 后移除，消除两套并行 MCP 管理）。补内置 memory 只读工具：注册 `memory_read(id)` / `memory_list`（复用 `memoryStore.getMemory`/`listMemories`），approval auto / category read，完善内置记忆读路径。
- **改动文件**：
  - `synapse-app/src/services/mcpManager.ts`（删除）
  - `synapse-app/src/services/toolRegistry.ts`
- **验收**：grep 确认无 `import mcpManager` 残留；构建通过；AI 可用 `memory_list` 列举内置记忆、`memory_read` 精读单条。

### M4-7-S6 — 抽出 compactNow + /compact 手动入口（自动压缩并存）（effort: medium）【按主人决策重写】

- **做什么**：从 `agentLoop.run` 压缩分支抽出可复用的 `compactNow(conversationId)` 方法（生成批次 record + 截断历史 + 刷新注入前缀 + 通知）。**自动压缩路径**（现有 ~90% 水位 `compressContext` 判定后）改为调用同一个 `compactNow`，**行为与现状完全一致、不删不降级**；**手动压缩路径**（M4-6 的 `/compact` 命令）也调用 `compactNow`，二者**并存、复用同一套压缩逻辑**。暴露 `compactNow` 供 M4-6 `/compact` 命令调用。在 `recordGenerator.resolveClient` 留系统模型钩子 TODO。需与 M4-1（压缩算法/阈值）、M4-6（slash 命令解析）owner 对齐接口边界。
- **改动文件**：
  - `synapse-app/src/services/agentLoop.ts`
  - `synapse-app/src/services/recordGenerator.ts`
- **验收**：真机：(1) 手动触发 `compactNow`（或经 `/compact`）后当前对话历史被压缩为 record 批次并注入；(2) **现有 ~90% 水位自动压缩照常工作**（到水位时仍自动生成 record 批次、不撑爆窗口），与现状一致；(3) 自动与手动两条路径走的是同一套 `compactNow` 实现，结果一致。

### M4-7-S7 — 全量验证（effort: medium）

- **做什么**：全量验证——`npm run build` + `npm run electron:build` 通过；真机回归三 server 启停、AI 调 MCP 读工具（memory-store 读记忆 / sandbox 读 / web-fetcher 抓取）、审批分类正确（read 工具直放、write/command 工具弹审批）、子代理可用读类 MCP 工具、`/compact` 手动压缩正常 + ~90% 水位自动压缩照常工作。
- **改动文件**（回归覆盖面）：
  - `synapse-app/src/services/mcpBridge.ts`
  - `synapse-app/electron/mcp/MCPServerProcess.ts`
  - `synapse-app/electron/ipc/mcp.ts`
  - `synapse-app/src/components/layout/AgentPanel.tsx`
- **验收**：两条构建命令零错误；上述真机清单逐项通过并留证据（截图/日志）。

---

## 六、风险

1. **transport 误区（最大坑）**：现有宿主用 HTTP Broker（`127.0.0.1:14588`）连这三 server，但 Synapse `MCPServerProcess` 只实现 stdio spawn。设计明确走 **stdio 拉 `dist/index.js`**（已确认 server 原生支持 `StdioServerTransport`），**切勿误试图接 HTTP Broker**（无对应 transport 代码，会白做）。
2. **重进程冷启动**：web-fetcher 依赖 playwright/sharp、sandbox 依赖 tree-sitter，stdio 拉起较重且首次可能触发浏览器下载/原生编译。默认 `enabled:false`（仅这两个）+ 懒启动缓解；但用户启用后首启可能慢/失败，需 UI 给 starting/error 可见反馈与 stderr 日志。
3. **路径硬编码**：默认 `mcp_config.json` 写死主人机器绝对路径（`C:\Users\Stardust\.gemini\antigravity\...`）。换机/换用户即失效。本项目单机自用可接受，但必须给「编辑配置/改路径」UI 入口，且生成逻辑**绝不覆盖**已存在的用户配置。
4. **外置 memory-store 双写污染**：桥接后 AI 可能把本应往内置 memory 写的内容写进外置 `mcp__memory-store__memory_write`。靠 **write 审批等级** + 工具描述区分缓解；读为主决策下外置写默认需确认。
5. **手动/自动压缩接口一致性**：S6 抽 `compactNow` 后，自动压缩路径切到调用它——必须保证**抽出后自动压缩行为与现状逐字节一致**（生成时机、record 批次内容、截断点都不变），不能因为重构引入回归。手动 `/compact`（M4-6）落地前，自动压缩这条始终在，不会出现历史无人压缩撑爆窗口的问题。上线顺序无强约束（自动一直保兜底），但建议 S6 与 M4-6 联调验证手动路径。
6. **stdout 污染破坏 JSON-RPC 行分帧**：server 若往 stdout 打非 JSON 日志会让 `MCPServerProcess.processBuffer` 解析失败（现 catch 忽略，但会吞掉真正响应行）。需实测三 server 是否干净走 stdout，stderr 才打日志。
7. **MCP 工具 schema 兼容性**：MCP `inputSchema` 是完整 JSON Schema，可能含 `toolRegistry.ToolSchema` 不支持的结构（嵌套 object、array items、anyOf）。当前 `ToolSchema.parameters.properties` 值类型较窄，注入给 OpenAI 兼容端时需保证 schema 能被网关接受，可能要做一层 schema 规整/透传。

---

## 七、openQuestions 决议（均已决）

1. **默认 enabled**：~~三 server 默认 false 还是 memory-store 默认 true？~~
   → **已决：memory-store 默认 `enabled:true`，sandbox / web-fetcher 默认 `false`**。对应主人决策「默认只开 memory-store，另两个默认关」。memory-store 最轻、读记忆最常用，默认开启；另两个依赖重，用户显式开启。
2. **路径来源**：~~硬编码 vs 首次运行让用户选目录？~~
   → **已决：硬编码主人机器绝对路径 + 可编辑 UI**（设置面板「打开 mcp_config.json / 编辑配置」入口）。对应主人决策「默认 `mcp_config.json` 硬编码路径 + 可编辑 UI」。
3. **MCP 工具审批默认等级**：~~一律默认 read（含 sandbox_exec）还是执行/写类强制审批？~~
   → **已决：采纳后者——sandbox 执行类 / web 写类强制 write/command 审批（不全放行），其余默认 read**。对应主人决策「MCP 工具审批 sandbox 执行 / web 写类强制审批（不全放行）」。分类表口径见设计「一、(e) 审批分类」。
4. **`compactNow` 与 M4-6 `/compact` 的接口契约**：~~直接调 service 函数 / Redux action / 事件总线？~~
   → **已决：本里程碑提供 `compactNow(conversationId)` service 函数为主接口**，M4-6 `/compact` 命令解析后直接调用该函数（最直接、改动面最小）。若 M4-6 实现时确需经 Redux action / 事件总线，则在 `compactNow` 外再包一层 thunk/事件即可，核心实现保持 service 函数形态。具体由 S6 与 M4-6 owner 联调确认。
5. **~~90% 自动触发降级程度~~【本条已被主人决策推翻，不再适用】**：原问题问「自动触发改为只提示不压缩 vs 仍压缩+提示」。
   → **已决：不降级、不改自动触发**。Synapse 现有 ~90% 水位自动压缩**保持不变**；`/compact` 是**新增手动入口**，与自动**并存**，复用同一套 `compactNow` 逻辑。原设计稿「自动转手动 / 只提示不压缩」整体作废。
6. **`mcpManager.ts` 删除 vs 保留废弃**：~~删除还是标注废弃保留？~~
   → **已决：删除**。对应主人决策「`mcpManager.ts`（mock 死代码）删除」。确认全仓无 import 引用后移除，消除两套并行 MCP 管理的认知负担。

---

## 八、该里程碑技术决策小结

- **transport = stdio，不走 HTTP Broker**：`MCPServerProcess` 直接 spawn `node <server>/dist/index.js`，三 server 原生支持 `StdioServerTransport`。这是本里程碑最容易踩错的点，单独标红。
- **桥接走方案 B（register 进 toolRegistry）**：MCP 工具发现后注册进 `toolRegistry`，自动复用 `getSchemas`/`execute`/审批/重试/`getSchemasForPermissions` 权限闸门；`AgentPanel`/`agentOrchestrator` 几乎零改动，子代理读类 MCP 工具自动可用。`mcpBridge` 管「发现→注册/注销」，`toolRegistry` 管「执行/审批」，新增 `toolRegistry.unregister(name)`。
- **命名空间前缀 `mcp__<server>__<tool>`**：与四源体系命名一致，天然区分内置 `memory_query` 与外置 `mcp__memory-store__memory_query`。
- **审批分类只决定审批不阻止注册**：默认 read 直放；sandbox 执行类 → command/dangerous、web 写类 → write，强制审批（不全放行）。分类表维护在 `mcpBridge` 内。
- **默认配置硬编码 + 不覆盖用户编辑 + 可编辑 UI**：`ensureDefaultMCPConfig` 仅首次写入；memory-store 默认开、另两默认关；设置面板提供「打开配置文件」入口。
- **record/compact = 自动 + 手动并存（核心纠正）**：抽出 `compactNow(conversationId)` 同时服务自动（~90% 水位，行为不变）与手动（`/compact`，M4-6 调用）两条路径，复用同一套逻辑。**绝不把自动压缩改成手动或只提示**。M4-1 管算法/阈值，M4-6 管命令解析，M4-7 只做 `compactNow` 抽取与接线。
- **系统模型不在本里程碑实装**：`recordGenerator.resolveClient` 仅留 TODO 钩子，系统模型独立配置属 M4 其它里程碑。
- **内置 memory 与外置 memory-store 双轨**：内置 = 本应用记忆默认写入处（补 `memory_read`/`memory_list` 只读工具完善读路径）；外置 `mcp__memory-store__*` = 跨源只读为主（写类归 write 审批）。两套数据不通，工具描述明确区分。
- **健壮性补强先行（S1）**：windowsHide 去黑框、initialize/error 竞速快速失败、capabilities 补 `{tools:{}}`、listTools 失败容错，是桥接拉真实 server 的地基。
- **死代码清理**：删除 `mcpManager.ts`（无消费者的 mock），收敛到单一 `platform.mcp`→`ipc/mcp.ts`→`MCPServerProcess` 真实路径。
