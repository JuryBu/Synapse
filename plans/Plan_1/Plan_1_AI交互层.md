# Plan_1_AI交互层: Agent 循环、API 通信与模型管理

> Synapse 的 AI 交互层——从 API 调用到完整的 Agentic 循环。

---

## 1. AI 通信架构

### 1.1 API 通信服务

```typescript
// services/ai/apiClient.ts
class AIClient {
  private config: ModelConfig;
  
  constructor(config: ModelConfig) {
    this.config = config;
  }
  
  // SSE 流式请求
  async *streamChat(messages: Message[], tools: ToolSchema[]): AsyncGenerator<StreamChunk> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        tools: tools.map(t => ({ type: 'function', function: t })),
        stream: true,
        // Thinking Model 支持
        ...(this.config.supportsThinking ? {
          thinking: { type: 'enabled', budget_tokens: 10000 }
        } : {}),
      }),
    });
    
    // 解析 SSE 流
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 解析 "data: {...}\n\n" 格式
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          yield JSON.parse(line.slice(6));
        }
      }
    }
  }
  
  // 获取可用模型列表
  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.config.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
    });
    return (await response.json()).data;
  }
}
```

### 1.2 模型配置体系

```typescript
interface ModelConfig {
  // API 连接
  baseUrl: string;        // 如 "https://api.openai.com/v1"
  apiKey: string;         // 加密存储的 API Key
  
  // 模型选择
  thinkingModel: string;  // Planning 模式用（如 "gpt-4o", "claude-3.5-sonnet"）
  fastModel: string;      // Fast 模式用（如 "gpt-4o-mini"）
  drawingModel: string;   // 图片生成（如 "dall-e-3"）
  synopsisModel: string;  // Synopsis 引擎用（如 "gpt-4o-mini"）—— 速度优先
  whisperModel: string;   // 语音转写（如 "whisper-1"）
  
  // 模型能力
  supportsThinking: boolean;   // 是否支持 Thinking 模式
  supportsVision: boolean;     // 是否支持图片输入
  supportsToolCalls: boolean;  // 是否支持工具调用
  
  // 参数
  maxTokens: number;
  temperature: number;
}
```

---

## 2. Agent 循环引擎

### 2.1 核心循环

```typescript
// services/ai/agentLoop.ts
class AgentLoop {
  private client: AIClient;
  private toolRegistry: ToolRegistry;
  private promptBuilder: SystemPromptBuilder;
  
  async run(
    userMessage: string,
    attachments: Attachment[],
    mode: 'planning' | 'fast',
    onStream: (chunk: StreamEvent) => void,
  ): Promise<void> {
    
    const systemPrompt = this.promptBuilder.build(mode);
    const messages = this.buildMessages(systemPrompt, userMessage, attachments);
    const tools = this.toolRegistry.getAllSchemas();
    const model = mode === 'planning' ? this.config.thinkingModel : this.config.fastModel;
    
    let loopCount = 0;
    const MAX_LOOPS = 25;  // 防止无限循环
    
    while (loopCount < MAX_LOOPS) {
      loopCount++;
      
      // 流式 AI 调用
      let responseText = '';
      let toolCalls: ToolCall[] = [];
      
      for await (const chunk of this.client.streamChat(messages, tools)) {
        // 区分文本内容和工具调用
        if (chunk.choices[0].delta.content) {
          responseText += chunk.choices[0].delta.content;
          onStream({ type: 'text', content: chunk.choices[0].delta.content });
        }
        if (chunk.choices[0].delta.tool_calls) {
          // 积累工具调用参数
          this.accumulateToolCalls(toolCalls, chunk.choices[0].delta.tool_calls);
        }
      }
      
      // 添加 AI 消息到历史
      messages.push({ role: 'assistant', content: responseText, tool_calls: toolCalls });
      
      // 如果没有工具调用 → 最终回复，循环结束
      if (toolCalls.length === 0) {
        onStream({ type: 'done', content: responseText });
        break;
      }
      
      // 执行工具调用
      onStream({ type: 'tool_start', tools: toolCalls });
      
      for (const call of toolCalls) {
        const result = await this.toolRegistry.execute(call.function.name, call.function.arguments);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.content),
        });
        onStream({ type: 'tool_result', callId: call.id, result });
      }
      
      // 继续循环（AI 可能还要调用更多工具）
    }
    
    // Token 统计
    onStream({ type: 'usage', tokens: this.countTokens(messages) });
  }
}
```

### 2.2 Planning vs Fast 模式差异

| 维度 | Planning 模式 | Fast 模式 |
|---|---|---|
| **模型** | thinkingModel (高能力) | fastModel (低延迟) |
| **系统提示** | 完整提示 + Agentic 指令 | 精简提示 |
| **Temperature** | 0.3 (稳定) | 0.7 (灵活) |
| **工具调用** | 支持多轮循环 | 单轮或少量循环 |
| **Thinking** | 启用（如支持） | 关闭 |
| **用途** | 复杂学习任务、深度分析 | 快速问答、简单查询 |

---

## 3. 上下文管理

### 3.1 消息历史压缩

```typescript
// 上下文窗口管理（类似 IDE 的 CHECKPOINT）
class ContextManager {
  private maxTokens: number;
  
  // 当消息历史超过上下文窗口时进行压缩
  compress(messages: Message[]): Message[] {
    const totalTokens = this.countTokens(messages);
    if (totalTokens < this.maxTokens * 0.8) return messages; // 还有余量
    
    // 策略：保留系统提示 + 最近 N 轮 + 压缩中间部分
    const systemMsg = messages[0]; // 系统提示
    const recentMessages = messages.slice(-10); // 最近 5 轮对话
    const middleMessages = messages.slice(1, -10); // 中间部分
    
    // 对中间部分生成摘要
    const summary = this.summarize(middleMessages);
    
    return [
      systemMsg,
      { role: 'system', content: `[CHECKPOINT] 之前的对话摘要: ${summary}` },
      ...recentMessages,
    ];
  }
}
```

### 3.2 EPHEMERAL 注入

每次用户发送消息时，自动注入当前上下文：

```typescript
function buildEphemeral(state: AppState): string {
  const parts = [];
  
  // 当前时间
  parts.push(`当前时间: ${new Date().toLocaleString()}`);
  
  // 当前查看的课件
  if (state.activeEditor) {
    parts.push(`当前查看: ${state.activeEditor.fileName} (${state.activeEditor.type})`);
    if (state.activeEditor.currentPage) {
      parts.push(`当前页: 第${state.activeEditor.currentPage}页`);
    }
  }
  
  // 其他打开的标签页
  if (state.openTabs.length > 0) {
    parts.push(`打开的文件: ${state.openTabs.map(t => t.name).join(', ')}`);
  }
  
  return parts.join('\n');
}
```

---

## 4. 多模型兼容层

Synapse 需要兼容多家 AI 提供商，核心是 OpenAI 兼容 API：

| 提供商 | Base URL | 兼容性 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | 原生 ✅ |
| DeepSeek | `https://api.deepseek.com/v1` | 兼容 ✅ |
| Claude (通过 OpenRouter) | `https://openrouter.ai/api/v1` | 兼容 ✅ |
| Gemini (通过 OpenRouter) | `https://openrouter.ai/api/v1` | 兼容 ✅ |
| 本地 Ollama | `http://localhost:11434/v1` | 兼容 ✅ |
| 其他兼容端点 | 自定义 URL | 兼容 ✅ |

**注意**：Anthropic 原生 API 格式不同，需要适配层或通过 OpenRouter 桥接。

---

## 5. Token 追踪与用量展示

```typescript
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;  // 基于已知的模型定价
}
```

UI 展示：对话底部小字显示 `Tokens: 1,234 / $0.02`

---

## 6. ConversationManager 服务（替代 LS 的会话管理）

> 不需要独立的 LS 进程。ConversationManager 作为内嵌服务运行在渲染进程中。

### 6.1 架构定位

```
IDE 的做法                        Synapse 的做法
─────────                        ──────────
LS 独立进程                       内嵌 ConversationManager 服务
ConnectRPC/Protobuf 通信          直接函数调用（同进程）
.pb 文件存储对话                  SQLite 存储对话
LS 做上下文压缩                   ConversationManager 做压缩
LS 做工具调度                     AgentLoop 做工具调度
```

### 6.2 SQLite 数据库 Schema

```sql
-- 对话表
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,              -- UUID
  workspace_id TEXT,                -- 关联工作区
  title TEXT,                       -- 对话标题（AI 自动生成或用户编辑）
  model TEXT,                       -- 使用的模型
  mode TEXT DEFAULT 'fast',         -- 'planning' | 'fast'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_archived BOOLEAN DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0
);

-- 消息表
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,               -- 'user' | 'assistant' | 'tool' | 'system'
  content TEXT,                     -- 文本内容
  tool_calls TEXT,                  -- JSON: 工具调用数据
  tool_call_id TEXT,                -- 工具结果关联
  attachments TEXT,                 -- JSON: 附件列表（图片、文件）
  thinking TEXT,                    -- 思考链内容（如模型支持）
  token_count INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- 上下文压缩快照表（CHECKPOINT）
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  summary TEXT NOT NULL,            -- 压缩后的摘要
  truncated_before_message_id TEXT, -- 从哪条消息开始被压缩
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- 工作区表
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  last_opened DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  synopsis_status TEXT DEFAULT 'pending' -- 'pending' | 'processing' | 'complete' | 'error'
);

-- 学习记录表（未来扩展）
CREATE TABLE learning_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  session_start DATETIME,
  session_end DATETIME,
  duration_minutes INTEGER,
  topics_covered TEXT,              -- JSON: 讨论过的知识点
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- 索引
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_conversations_workspace ON conversations(workspace_id, updated_at DESC);
CREATE INDEX idx_workspaces_last_opened ON workspaces(last_opened DESC);
CREATE FTS5 TABLE messages_fts(content, conversation_id) -- 全文搜索
```

### 6.3 ConversationManager 接口

```typescript
class ConversationManager {
  private db: BetterSqlite3.Database;
  
  // 对话 CRUD
  createConversation(workspaceId: string, mode: 'planning' | 'fast'): Conversation;
  getConversation(id: string): Conversation | null;
  listConversations(workspaceId?: string, limit?: number): Conversation[];
  deleteConversation(id: string): void;
  archiveConversation(id: string): void;
  
  // 消息管理
  addMessage(conversationId: string, message: Message): void;
  getMessages(conversationId: string, limit?: number): Message[];
  updateMessage(id: string, content: string): void;
  deleteMessage(id: string): void;
  
  // 上下文管理
  getContextWindow(conversationId: string, maxTokens: number): Message[];
  createCheckpoint(conversationId: string, summary: string): void;
  
  // 搜索
  searchConversations(query: string): Conversation[];
  searchMessages(query: string, conversationId?: string): Message[];
  
  // 导出
  exportAsMarkdown(conversationId: string): string;
  exportAsPDF(conversationId: string): Buffer;
  exportAsJSON(conversationId: string): object;
  
  // Token 统计
  updateTokenCount(conversationId: string, delta: number): void;
  getUsageStats(period: 'day' | 'week' | 'month'): UsageStats;
}
```

### 6.4 上下文压缩策略（CHECKPOINT）

```typescript
class ContextWindowManager {
  private maxTokens: number;  // 根据模型上下文窗口设置
  
  // 构建发送给 API 的消息列表
  buildContextWindow(conversationId: string): Message[] {
    const allMessages = this.db.getMessages(conversationId);
    const systemPrompt = this.promptBuilder.build();
    const systemTokens = this.countTokens(systemPrompt);
    
    const budget = this.maxTokens * 0.75; // 留 25% 给回复
    let currentTokens = systemTokens;
    
    // 从最新消息向回取，直到达到预算
    const result: Message[] = [{ role: 'system', content: systemPrompt }];
    const recentMessages: Message[] = [];
    
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msgTokens = this.countTokens(allMessages[i]);
      if (currentTokens + msgTokens > budget) {
        // 预算不够了，对之前的消息做压缩
        const olderMessages = allMessages.slice(0, i + 1);
        const checkpoint = this.createCheckpoint(olderMessages);
        result.push({ 
          role: 'system', 
          content: `[CHECKPOINT] 之前 ${olderMessages.length} 条消息的摘要:\n${checkpoint}` 
        });
        break;
      }
      currentTokens += msgTokens;
      recentMessages.unshift(allMessages[i]);
    }
    
    result.push(...recentMessages);
    return result;
  }
}
```

---

## 7. 错误处理与自动重试

### 7.1 API 错误分类与策略

| 错误类型 | HTTP 状态码 | 策略 | 最大重试 |
|---|---|---|---|
| 速率限制 | 429 | 指数退避重试 (1s,2s,4s,8s) | 5 |
| 服务器错误 | 500/502/503 | 指数退避重试 | 3 |
| 超时 | timeout | 重试 + 增加超时 | 3 |
| 认证失败 | 401/403 | 不重试，提示用户检查 API Key | 0 |
| 模型不存在 | 404 | 不重试，提示用户切换模型 | 0 |
| 上下文过长 | 400 (ctx_length) | 自动压缩上下文后重试 | 1 |
| 网络断开 | ERR_NETWORK | 等待网络恢复后重试 | ∞ |

### 7.2 工具调用错误处理

```typescript
async function executeToolWithRetry(tool: string, params: any): Promise<ToolResult> {
  const MAX_RETRY = 3;
  let lastError: Error;
  
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const result = await toolRegistry.execute(tool, params);
      return result;
    } catch (error) {
      lastError = error;
      
      // 内部重试不告知 AI，透明处理
      if (attempt < MAX_RETRY - 1 && isRetryable(error)) {
        await delay(1000 * (attempt + 1));
        continue;
      }
    }
  }
  
  // 最终失败，返回错误信息给 AI，让 AI 自行决定下一步
  return {
    content: [{ type: 'text', text: `工具 ${tool} 执行失败: ${lastError.message}` }],
    isError: true,
  };
}
```

### 7.3 网络状态监控

```typescript
// 渲染进程中监控网络状态
window.addEventListener('online', () => toast.info('网络已恢复'));
window.addEventListener('offline', () => toast.warning('网络已断开，对话功能暂停'));
```

---

## 8. 对话导出功能

### 8.1 Markdown 导出

```typescript
function exportAsMarkdown(conversation: Conversation, messages: Message[]): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push(`> ${conversation.model} | ${conversation.mode} 模式 | ${conversation.created_at}`);
  lines.push('');
  
  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`## 🙋 用户`);
      lines.push(msg.content);
    } else if (msg.role === 'assistant') {
      lines.push(`## 🤖 Synapse`);
      lines.push(msg.content);
    }
    // tool 消息折叠或跳过
    lines.push('');
  }
  
  return lines.join('\n');
}
```

### 8.2 PDF 导出

使用 Markdown → HTML → PDF 管线（可复用 MCP web-fetcher 的 web_convert 逻辑）。

---

## 9. AgentLoop 原子性保护与切换队列

> 防止用户在 AI 生成过程中切换模型/模式导致状态不一致。

### 9.1 原子单位定义

```
一次 AgentLoop.run() = 原子操作
从用户消息发送 → AI 回复完成 + 所有工具调用结束 = 不可中断的完整循环
```

### 9.2 切换保护机制

```typescript
class AgentLoop {
  private isRunning: boolean = false;
  
  // 排队的切换请求
  pendingModelSwitch: string | null = null;
  pendingModeSwitch: 'planning' | 'fast' | null = null;
  pendingMultiAISwitch: string | null = null;

  get canSwitchNow(): boolean { return !this.isRunning; }
  
  requestModelSwitch(model: string) {
    if (this.isRunning) {
      this.pendingModelSwitch = model;
      toast.info(`模型将在当前回复完成后切换为 ${model}`);
    } else {
      this.applyModelSwitch(model);
    }
  }
  
  async run(message: string, ...args: any[]) {
    this.isRunning = true;
    try {
      // ... 完整 Agent 循环 ...
    } finally {
      this.isRunning = false;
      // 循环结束后应用排队的切换
      this.applyPendingSwitches();
    }
  }
  
  private applyPendingSwitches() {
    if (this.pendingModelSwitch) {
      this.applyModelSwitch(this.pendingModelSwitch);
      this.pendingModelSwitch = null;
    }
    if (this.pendingModeSwitch) {
      this.applyModeSwitch(this.pendingModeSwitch);
      this.pendingModeSwitch = null;
    }
    if (this.pendingMultiAISwitch) {
      this.applyMultiAISwitch(this.pendingMultiAISwitch);
      this.pendingMultiAISwitch = null;
    }
  }
}
```

### 9.3 UI 状态

| 状态 | 模型选择器 | Fast/Plan 切换 | Multi-AI 模式 |
|---|---|---|---|
| 空闲 | 正常可用 | 正常可用 | 正常可用 |
| 生成中 | 可选（排队生效） | 可选（排队生效） | 禁用（等全部 Agent 完成） |
| 停止生成后 | 立即可用 | 立即可用 | 立即可用 |

---

## 10. 流式持久化与崩溃恢复

### 10.1 保存时机（增量写入）

```
1. 用户消息发送时 → 立即 sync 写入 SQLite
2. AI SSE 流每 3 秒 → 自动 flush 已生成的部分到 SQLite
3. 工具调用开始 → 写入 tool_call 记录 (status='running')
4. 工具调用完成 → 更新 tool_result (status='done')
5. AI 回复 SSE 结束 → 最终完整消息写入 (status='complete')
6. 回复中断(用户停止/错误) → 标记 status='interrupted'
```

### 10.2 实现

```typescript
class StreamingPersistence {
  private buffer: string = '';
  private messageId: string;
  private flushTimer: NodeJS.Timer;
  
  constructor(messageId: string) {
    this.messageId = messageId;
    // 每 3 秒自动保存
    this.flushTimer = setInterval(() => this.flush(), 3000);
  }
  
  onChunk(chunk: string) {
    this.buffer += chunk;
  }
  
  flush() {
    if (this.buffer.length > 0) {
      db.run(
        'UPDATE messages SET content = ?, status = "streaming" WHERE id = ?',
        [this.buffer, this.messageId]
      );
    }
  }
  
  onComplete() {
    clearInterval(this.flushTimer);
    this.flush();
    db.run('UPDATE messages SET status = "complete" WHERE id = ?', [this.messageId]);
  }
  
  onInterrupt() {
    clearInterval(this.flushTimer);
    this.flush();
    db.run('UPDATE messages SET status = "interrupted" WHERE id = ?', [this.messageId]);
  }
}
```

### 10.3 SQLite WAL 模式

```typescript
// 启动时配置
db.pragma('journal_mode = WAL');    // Write-Ahead Logging: 崩溃安全
db.pragma('synchronous = NORMAL');  // 平衡性能和安全
db.pragma('wal_autocheckpoint = 100'); // 每 100 页自动 checkpoint
```

### 10.4 崩溃检测与恢复

```typescript
class CrashRecovery {
  private lockFile = path.join(appDataDir, '.running.lock');
  
  onAppStart() {
    if (fs.existsSync(this.lockFile)) {
      // 上次没有正常退出
      const lastPid = fs.readFileSync(this.lockFile, 'utf8');
      
      // 检查 streaming 状态的消息（非正常结束）
      const incompleteMessages = db.all(
        "SELECT * FROM messages WHERE status = 'streaming'"
      );
      for (const msg of incompleteMessages) {
        db.run("UPDATE messages SET status = 'interrupted' WHERE id = ?", [msg.id]);
      }
      
      toast.warning('上次异常退出，部分 AI 回复可能不完整');
    }
    fs.writeFileSync(this.lockFile, String(process.pid));
  }
  
  onAppQuit() {
    fs.unlinkSync(this.lockFile);
  }
}
```

### 10.5 messages 表 status 字段

在 Schema 中补充 status 列：

```sql
ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'complete';
-- 'complete' | 'streaming' | 'interrupted' | 'error'
```

---

## 11. KV Cache 前缀缓存优化

> 降低 API 调用成本，利用提供商的 prompt caching 机制。

### 11.1 原理

```
部分 API (OpenAI, Anthropic, DeepSeek) 支持前缀缓存：
- 请求中与上次请求相同的前缀部分 → 命中 KV Cache
- 命中部分不重新计算注意力 → 延迟降低、费用减半

Synapse 的系统提示（identity + tools + skills + synopsis）每次相同
→ 天然的缓存友好前缀
```

### 11.2 优化策略

```typescript
class SystemPromptBuilder {
  build(mode: 'planning' | 'fast'): string {
    // 关键：保持构建顺序稳定！
    // 每次相同顺序 → 前缀连续 → 缓存命中
    const parts: string[] = [];
    
    // 1. 身份（最稳定，永不变化）
    parts.push(this.buildIdentity(mode));
    // 2. 工具 Schema（几乎不变，除非新增工具）
    parts.push(this.buildToolSchemas());
    // 3. 技能列表（很少变化）
    parts.push(this.buildSkillList());
    // 4. 课件概要（工作区级别稳定）
    parts.push(this.buildCourseContext());
    // 5. 用户规则（用户修改才变化）
    parts.push(this.buildUserRules());
    // 6. Mode.md 指令（切换 Multi-AI 时才变）
    parts.push(this.buildModeInstructions());
    
    // 不要在这里放动态内容（时间、光标位置等）
    // 动态内容放在 EPHEMERAL 消息中（在历史消息之后）
    return parts.join('\n\n---\n\n');
  }
}
```

### 11.3 Token 用量展示

```typescript
interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;        // API 返回的缓存命中数
  total_cost: number;            // 估算费用
}

// 状态栏: Token: 3.2k/128k | 缓存: 72% | ¥0.03
```

---

## 12. 对话回溯与消息管理

### 12.1 消息级操作

```typescript
interface MessageAction {
  // 编辑用户消息：修改后从该消息重发
  editMessage(messageId: string, newContent: string): Promise<void>;
  
  // 重新生成：删除该 AI 回复，重新请求
  regenerate(messageId: string): Promise<void>;
  
  // 回溯到某轮：删除该轮之后所有消息
  rollbackTo(messageId: string, rollbackFiles: boolean): Promise<void>;
  
  // 分支对话：从该消息分叉出新对话
  branchFrom(messageId: string): Promise<string>; // 返回新对话 ID
}
```

### 12.2 文件修改快照

```typescript
// 每次 AI 写文件前自动创建 snapshot
interface FileSnapshot {
  id: string;
  messageId: string;          // 关联的消息 ID
  filePath: string;
  contentBefore: string;      // 修改前内容
  timestamp: Date;
}

// 存储在 SQLite
CREATE TABLE file_snapshots (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_before TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
```

### 12.3 回溯弹窗

```
回溯对话时如果涉及文件修改：
┌──────────────────────────────┐
│  回溯对话                     │
│                              │
│  将删除最近 8 条消息。         │
│  期间 AI 修改了 3 个文件：    │
│  · sort.js (2次修改)          │
│  · index.html (1次修改)       │
│  · style.css (1次修改)        │
│                              │
│  ☑ 同时回滚文件修改           │
│                              │
│  [回溯] [取消]               │
└──────────────────────────────┘
```

---

## 13. Fast/Planning 教学风格差异

### Fast 模式系统提示注入

```markdown
你是速通助手。回答简洁直接，使用 Markdown 基础格式。
不主动生成复杂可视化或长篇讲解。只在用户要求时调用工具。
多用公式、代码片段、简表来快速传达知识。
```

### Planning 模式系统提示注入

```markdown
你是深度教学助手。主动使用丰富的教学手段：
- 用 Mermaid 画概念关系图和流程图
- 用代码生成交互式可视化（写 HTML → Showcase 展示）
- 用 KaTeX 展示完整公式推导过程
- 每个知识点后出练习题检验理解
- 必要时 spawn_subagent 深入研究课件细节
- 主动创建 .synapse/ai_plan.md 教学计划并跟踪进度
注意教学节奏，不要因为工具调用让学生等太久。
```
