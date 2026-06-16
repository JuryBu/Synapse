/**
 * MCP Bridge — 桥接层（M4-7-S3）
 *
 * 职责：把 MCP stdio server（electron 主进程经 platform.mcp → ipc/mcp.ts → MCPServerProcess 拉起的
 * 真实子进程）发现的工具，桥接进 toolRegistry，使主 AI 与子代理能真实调用三个本地 MCP server 的工具。
 *
 * ★ 架构（方案 B，register 进 toolRegistry）：
 *   - mcpBridge 管「发现 → 注册/注销」生命周期（refresh / startServer / stopServer）。
 *   - toolRegistry 管「执行 / 审批 / 重试 / getSchemasForPermissions 权限闸门」——MCP 工具注册时带了
 *     permissionCategory（read/write/command），故 AgentPanel 的 registerTools(getSchemas) 自动含 MCP 工具，
 *     agentOrchestrator 子代理经 getSchemasForPermissions(['read',...]) 自动纳入读类 MCP 工具，二者几乎零改动。
 *
 * ★ transport：走 stdio（spawn node <server>/dist/index.js），【不走】HTTP Broker(127.0.0.1:14588)——
 *   那是别的体系。所有 MCP 调用经 platform.mcp.*（Web 模式天然空集，无需额外降级判断）。
 *
 * ★ 命名空间：MCP 工具名统一加前缀 mcp__<server>__<tool>，与四源体系命名习惯一致，且天然区分
 *   内置 memory_query 与外置 mcp__memory-store__memory_query。
 *
 * ★ 审批分类（决策：读为主但不全放行）：默认 read；sandbox 执行类 → command/dangerous、
 *   web-fetcher 写类 → write，强制审批（不全放行）。分类只决定审批，不阻止注册。
 */

import { platform } from '@/platform';
import { toolRegistry, type ToolSchema, type ToolPermissionCategory } from './toolRegistry';

const MCP_PREFIX = 'mcp__';

type ApprovalLevel = 'auto' | 'read' | 'write' | 'dangerous';

/** getStatus 返回的单条 server 状态（与 ipc/mcp.ts:status 结构对齐，字段宽松取用）。 */
interface McpServerStatus {
  name: string;
  status?: string;
  running?: boolean;
  configured?: boolean;
  enabled?: boolean;
  tools?: string[];
}

/** MCP listTools 返回的单个工具描述。 */
interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * 审批分类表（按 server + 工具名关键词识别「写/执行类」给更高审批等级，未命中默认 read）。
 *
 * 对应主人决策：sandbox 执行类（exec/session/launch/codex/batch）→ command/dangerous；
 * web-fetcher 写类（download/interact/login/desktop/record/convert/human_browser）→ write。
 * 读类（memory-store 全部读、web 抓取/截图/提取、sandbox 状态查询等）→ read。
 *
 * 返回 { approvalLevel, permissionCategory }——permissionCategory 决定子代理权限闸门归属，
 * approvalLevel 决定 needsApproval。read 工具在默认 autoApproveRead=true 下直放；write/command 需确认。
 */
function classifyMcpTool(server: string, tool: string): { approvalLevel: ApprovalLevel; permissionCategory: ToolPermissionCategory } {
  const t = tool.toLowerCase();

  if (server === 'sandbox') {
    // 执行类 / 代码执行 / 长任务托管 → 强制 command 审批（不全放行）。
    if (/(exec|session|launch|codex|council|batch|run)/.test(t)) {
      return { approvalLevel: 'dangerous', permissionCategory: 'command' };
    }
    // smart_search / status 等只读 → read。
    return { approvalLevel: 'read', permissionCategory: 'read' };
  }

  if (server === 'web-fetcher') {
    // 写类 / 有副作用类（下载到磁盘、交互点击输入、登录态、桌面控制、录屏、格式转换、人控浏览器、会话清理）→ write 审批。
    if (/(download|interact|login|desktop|record|convert|human_browser|close_sessions|pipeline)/.test(t)) {
      return { approvalLevel: 'write', permissionCategory: 'write' };
    }
    // fetch_page / screenshot / extract_* / rich / html / inspect / list_* 等只读抓取 → read。
    return { approvalLevel: 'read', permissionCategory: 'read' };
  }

  if (server === 'memory-store') {
    // 写类用【白名单写动作】精确匹配（写入 / 更新 / 删除 / 批量 / record 生成）→ write 审批（读为主、避免污染外置库）。
    // ★ M4-7 审查修复：原宽泛正则含 `extract` 关键词，会把读类 conversation_golden_extract（提取金句、不写库）
    //   误判为 write，每次调用多弹一次审批。改为白名单后纯读取/提取类（含 golden_extract）归 read 直放。
    if (/(memory_write|memory_update|memory_delete|memory_batch|record_manage)/.test(t)) {
      return { approvalLevel: 'write', permissionCategory: 'write' };
    }
    // query / read / stats / conversation_read_original / conversation_golden_extract 等 → read。
    return { approvalLevel: 'read', permissionCategory: 'read' };
  }

  // 未知 server：保守按通用关键词识别，命中写/执行给更高等级，否则默认 read。
  if (/(exec|run|launch|command|shell|kill)/.test(t)) {
    return { approvalLevel: 'dangerous', permissionCategory: 'command' };
  }
  if (/(write|create|update|delete|download|upload|interact|login)/.test(t)) {
    return { approvalLevel: 'write', permissionCategory: 'write' };
  }
  return { approvalLevel: 'read', permissionCategory: 'read' };
}

/** 组装命名空间工具名：mcp__<server>__<tool>。 */
function makeToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`;
}

/** 从命名空间工具名解析回 (server, tool)。非 MCP 名返回 null。 */
function parseToolName(fullName: string): { server: string; tool: string } | null {
  if (!fullName.startsWith(MCP_PREFIX)) return null;
  const rest = fullName.slice(MCP_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * 把 MCP callTool 返回的 { content: [{type:'text',text}|{type:'image',...}] } 扁平化为字符串
 * （读为主场景以文本为主；image / 资源类给占位说明）。兼容 server 直接返回字符串 / 其它结构的情况。
 */
function flattenMcpResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const obj = result as Record<string, unknown>;
  const content = obj.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const c = item as Record<string, unknown>;
      const type = c?.type;
      if (type === 'text' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (type === 'image') {
        const mime = typeof c.mimeType === 'string' ? c.mimeType : 'image';
        parts.push(`[图片内容 ${mime}（已省略二进制，读为主场景以文本为主）]`);
      } else if (type === 'resource') {
        const uri = (c.resource as Record<string, unknown>)?.uri ?? c.uri;
        parts.push(`[资源: ${typeof uri === 'string' ? uri : '未知'}]`);
      } else if (typeof c?.text === 'string') {
        parts.push(c.text);
      } else {
        parts.push(JSON.stringify(c));
      }
    }
    const joined = parts.join('\n');
    // MCP 协议：isError=true 时把内容标成错误（仍返回字符串给工具循环，让 AI 看到错误而非中断）。
    return obj.isError ? `⚠️ MCP 工具返回错误:\n${joined}` : joined;
  }
  // 非标准结构：整体序列化。
  return JSON.stringify(result);
}

class MCPBridge {
  /** 当前已注册进 toolRegistry 的 MCP 工具全名集合（用于 refresh 时增量注销已消失的工具）。 */
  private registered = new Set<string>();

  /**
   * 刷新：拉 getStatus → 对每个 running server listTools → 注册/更新工具进 toolRegistry，
   * 并注销「本轮不再出现」的旧 MCP 工具（server 停用 / 重启 / 工具列表变化）。
   *
   * Web 模式 getStatus 返回 { servers: [] } → 注销所有旧 MCP 工具、注册集为空（天然降级，不崩）。
   * 失败（IPC 异常等）catch 后保持现有注册集不变，不影响内置工具。
   */
  async refresh(): Promise<void> {
    let servers: McpServerStatus[] = [];
    try {
      const status = await platform.mcp.getStatus();
      servers = Array.isArray(status?.servers) ? status.servers : [];
    } catch (err) {
      console.error('[mcpBridge] getStatus failed:', (err as Error)?.message);
      return; // 拉状态失败：保持现有注册集，不动 toolRegistry。
    }

    const nextNames = new Set<string>();

    for (const server of servers) {
      if (!server?.name || !server.running) continue;
      let tools: McpToolDef[] = [];
      try {
        tools = (await platform.mcp.listTools(server.name)) as McpToolDef[];
      } catch (err) {
        // listTools 失败（主进程已 catch 成空集，这里再兜一层）→ 跳过该 server，不崩。
        console.error(`[mcpBridge] listTools(${server.name}) failed:`, (err as Error)?.message);
        continue;
      }
      if (!Array.isArray(tools)) continue;

      for (const tool of tools) {
        if (!tool?.name) continue;
        const fullName = makeToolName(server.name, tool.name);
        nextNames.add(fullName);
        this.registerOne(server.name, tool, fullName);
      }
    }

    // 注销本轮不再出现的旧 MCP 工具（server 停了 / 工具消失），避免悬空。
    for (const old of this.registered) {
      if (!nextNames.has(old)) {
        toolRegistry.unregister(old);
      }
    }
    this.registered = nextNames;
  }

  /** 把单个 MCP 工具注册（或覆盖更新）进 toolRegistry。 */
  private registerOne(server: string, tool: McpToolDef, fullName: string): void {
    const { approvalLevel, permissionCategory } = classifyMcpTool(server, tool.name);

    // MCP inputSchema 是完整 JSON Schema；ToolSchema.parameters 类型较窄，as any 透传给 OpenAI 兼容端
    // （流式请求体直接带 schema，网关接受完整 JSON Schema）。缺省给最小 object schema。
    const parameters = (tool.inputSchema && typeof tool.inputSchema === 'object')
      ? (tool.inputSchema as ToolSchema['function']['parameters'])
      : ({ type: 'object', properties: {} } as ToolSchema['function']['parameters']);

    const schema: ToolSchema = {
      type: 'function',
      function: {
        name: fullName,
        description: tool.description || `MCP 工具（来自 ${server}）：${tool.name}`,
        parameters,
      },
    };

    // handler 闭包：解析前缀 → platform.mcp.callTool(server, tool, args) → content[] 扁平化为字符串。
    // 错误 catch 成可读字符串（复用 toolRegistry.execute 已有透明重试）。
    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const parsed = parseToolName(fullName);
      if (!parsed) return `Error: 非法 MCP 工具名 ${fullName}`;
      try {
        const result = await platform.mcp.callTool(parsed.server, parsed.tool, args ?? {});
        const text = flattenMcpResult(result);
        return text || '[MCP 工具无返回内容]';
      } catch (err) {
        // 抛出让 toolRegistry.execute 的重试机制介入（server 临时未 running / 超时等可重试）。
        throw new Error(`MCP 调用失败 (${parsed.server}/${parsed.tool}): ${(err as Error)?.message ?? err}`);
      }
    };

    // category 用 'custom'（MCP 工具不属内置 file/search/command/web/learning 分类）；
    // permissionCategory 决定子代理闸门与审批 read/write/command 分桶。
    toolRegistry.register(schema, handler, 'custom', approvalLevel, permissionCategory);
  }

  /** 启动一个 MCP server 后刷新注册集（供 UI / 设置变化调用）。 */
  async startServer(name: string): Promise<void> {
    await platform.mcp.start(name);
    await this.refresh();
  }

  /** 停止一个 MCP server 后刷新注册集（清理该 server 的工具）。 */
  async stopServer(name: string): Promise<void> {
    await platform.mcp.stop(name);
    await this.refresh();
  }

  /** 当前已桥接进 toolRegistry 的 MCP 工具全名（调试 / 诊断用）。 */
  listRegistered(): string[] {
    return Array.from(this.registered);
  }
}

export const mcpBridge = new MCPBridge();
