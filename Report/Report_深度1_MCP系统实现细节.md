# Report 深度-1: MCP 系统实现细节

> 三个 MCP Server 的完整架构、工具注册、通信协议和生命周期管理。

---

## 1. MCP 通信协议

### JSON-RPC over stdio

所有 MCP Server 使用 `@modelcontextprotocol/sdk` 库，通过 **stdio** 传输层通信：

```
IDE (LS 进程)                     MCP Server (Node 子进程)
    │                                    │
    │── spawn("node", ["dist/index.js"]) │
    │                                    │
    │── stdin  → JSON-RPC Request  ──→   │ 处理请求
    │← stdout ← JSON-RPC Response ─←   │ 返回结果
    │                                    │
    │   stderr → 日志 (不影响协议)        │
```

### MCP SDK 架构

```javascript
// 标准 MCP Server 模式
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "server-name", version: "1.0.0" });

// 注册工具 (server.tool 方法)
registerExec(server);  // 每个工具在独立模块中注册

// 注册资源 (server.resource / server.registerResource)
server.resource("guide", "protocol://guide", { ... }, handler);

// 启动 stdio 传输
const transport = new StdioServerTransport();
await server.connect(transport);
```

### 工具注册模式

每个工具通过独立模块注册，模式统一：

```javascript
// tools/exec.js
export function registerExec(server) {
    server.tool(
        "sandbox_exec",          // 工具名称
        "执行代码或命令",         // 描述（注入到 AI 系统提示）
        {                         // Zod schema → 自动生成 JSON Schema
            code: z.string().optional(),
            command: z.string().optional(),
            language: z.enum(["python","node","powershell","cmd","bash"]),
            timeout: z.number().max(300000).default(30000),
            maxMemoryMB: z.number().max(1024).default(256),
            // ... 更多参数
        },
        async (params) => {       // 处理函数
            // 执行逻辑
            return { content: [{ type: "text", text: result }] };
        }
    );
}
```

---

## 2. 三个 MCP Server 详细对比

### Sandbox MCP v1.5.0

| 属性 | 值 |
|---|---|
| **入口** | `~/.gemini/antigravity/mcp-sandbox/dist/index.js` |
| **依赖** | `@modelcontextprotocol/sdk ^1.6.1`, `pidusage ^3.0.2`, `zod ^3.23.8` |
| **模块** | lifecycle.js, temp-store.js, env-detector.js, session-manager.js |
| **工具模块** | tools/exec.js, session.js, batch.js, status.js, codex.js, launch.js |

**6 个工具：**

| 工具 | 功能 | 关键特性 |
|---|---|---|
| `sandbox_exec` | 执行代码/命令 | 硬超时、内存限制、输出截断、GPU 支持 |
| `sandbox_session` | 持久 REPL | 跨调用变量保持、最多3并发、5min空闲关闭 |
| `sandbox_batch` | 并行批量 | 最多5任务、独立超时/内存、maxParallel=3 |
| `sandbox_status` | 系统状态 | overview/envs/gpu/gc 四种模式 |
| `sandbox_codex` | Codex CLI | 后台模式、进程树清理、stderr 过滤 |
| `sandbox_launch` | 长任务脱离 | 独立于 MCP 进程、日志持久化、waitSeconds |

### Web Fetcher MCP v5.2.0

| 属性 | 值 |
|---|---|
| **入口** | `~/.gemini/antigravity/mcp-web-fetcher/dist/index.js` |
| **核心依赖** | `playwright ^1.49.0`, `sharp ^0.34.5`, `@mozilla/readability`, `turndown`, `jsdom` |
| **模块** | browser.js(69KB), stealth.js(30KB), extractor.js(23KB), constants.js, converter.js, ls-client.js |

**14 个工具：**

| 工具 | 功能 |
|---|---|
| `web_fetch_page` | 网页文本提取 (Markdown) |
| `web_fetch_html` | 原始 HTML 获取 |
| `web_fetch_screenshot` | 网页/文件截图 (多页/分片) |
| `web_fetch_rich` | 截图+文本一体 |
| `web_list_cookies` | Cookie 列表 |
| `web_login_browser` | 手动登录窗口 |
| `web_interact` | 点击/输入/滚动/等待/截图/内容/搜索 |
| `web_extract_links` | 链接提取 |
| `web_record_video` | 视频录制/关键帧提取 |
| `web_pipeline` | 多步流水线 |
| `web_download` | 文件下载 |
| `web_convert` | 格式转换 (Office→PDF/HTML/TXT) |
| `web_batch_screenshot` | 批量截图 |
| `web_extract_tables` | 表格提取 |

**独有特性：**
- Playwright persistent context 复用 Cookie
- stealth.js (30KB) — 反检测/指纹伪装
- LS 客户端集成 — AI Summary 模式（调用 Gemini Flash 生成摘要）
- 浏览器空闲释放：20min 无活动自动关闭 Chromium
- 图片 5 级质量控制 (hd/clear/default/compact/fast)
- 临时 HTTP 服务器（local-server.js）用于多文件项目

### Memory Store MCP v1.6.0

| 属性 | 值 |
|---|---|
| **入口** | `~/.gemini/antigravity/mcp-memory-store/dist/index.js` |
| **核心依赖** | `fuse.js ^7.0.0`, `zod ^3.23.8` |
| **模块** | store.js, lifecycle.js, temp-store.js, ls-client.js, ls-registry.js |

**10 个工具：**

| 工具 | 功能 |
|---|---|
| `memory_write` | 写入记忆（去重检测 + autoSummary 异步生成）|
| `memory_query` | 查询记忆（fuse.js 模糊搜索 + grep 精确搜索）|
| `memory_read` | 读取单条（支持行范围）|
| `memory_update` | 更新/追加（content 变化自动重生成 autoSummary）|
| `memory_delete` | 删除 |
| `memory_batch` | 批量操作（最多20个）|
| `memory_stats` | 统计/归档/导出/导入/enhance |
| `conversation_read_original` | 对话原文读取（绕过 CHECKPOINT 压缩）|
| `conversation_golden_extract` | 黄金片段提取（关键信息 + 记忆去重）|

**独有特性：**
- fuse.js 搜索引擎（多词分词 + CJK 支持）
- Auto Summary 双轨制（searchSummary + autoSummary via Flash）
- 冷热分层（archive/unarchive + gzip 压缩）
- 置顶记忆（Pinned Memory, 17+1 模型）
- LS 注册表加速（ls-registry.js）
- 对话原文三步查找（fetch → search → read）

---

## 3. 共享生命周期模式

三个 MCP Server 使用**完全一致的生命周期管理模式**：

```javascript
// === 双层防线生命周期 ===

// 第一层：stdin 断开检测（秒级响应）
process.stdin.on("end",   () => cleanup + exit);
process.stdin.on("close", () => cleanup + exit);
process.stdin.on("error", () => cleanup + exit);

// 第二层：ppid 存活检测（30s 心跳）
setInterval(() => {
    if (!isParentAlive()) {  // 检测父 LS 进程是否消失
        cleanup + exit;
    }
}, 30000);

// 信号处理
process.on("SIGINT",  cleanup + exit);
process.on("SIGTERM", cleanup + exit);

// 防重复清理守卫
let isClosing = false;
```

**Synapse 关键参考：** 这个生命周期模式可以直接复用，确保 MCP 子进程不会成为孤儿进程。
