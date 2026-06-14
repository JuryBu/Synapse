# Plan_1_设置系统: 设置面板与用户配置完整设计

> 参考 Levitate 的设置齿轮图标 + Aether Reader 的沉浸式设置体验。

---

## 1. 设置面板架构

### 1.1 入口方式

- Activity Bar 底部齿轮图标（参考 Levitate 截图左下角）
- 快捷键 `Ctrl+,`
- 命令面板 `Ctrl+Shift+P` → "打开设置"

### 1.2 面板布局

设置面板作为 Sidebar 的一个视图，不占用编辑器区域：

```
┌──────────────────────────────────────┐
│  ⚙ 设置                    × 关闭   │
├──────────────────────────────────────┤
│  🔍 搜索设置...                      │
├──────────────────────────────────────┤
│  📂 分类导航 (16 项)                  │
│  ├─ 🤖 AI 模型                       │
│  ├─ 🔑 API 配置                       │
│  ├─ 🤝 Multi-AI 协作                  │  ← NEW
│  ├─ 💬 对话管理                        │
│  ├─ 📌 系统提示注入                    │  ← NEW
│  ├─ 🛡 安全与审批                      │  ← NEW
│  ├─ 🎨 外观与主题                     │
│  ├─ 🖼 背景管理                        │
│  ├─ 📊 Synopsis 引擎                  │
│  ├─ 🧩 插件与 MCP                     │
│  ├─ 🔌 VSCode 扩展                    │  ← NEW
│  ├─ 🐛 调试器                          │  ← NEW
│  ├─ ⌨ 快捷键                          │
│  ├─ 📁 工作区                         │
│  ├─ 📤 数据管理                       │
│  └─ ℹ 关于                            │
├──────────────────────────────────────┤
│                                      │
│    [ 当前分类的详细设置表单 ]         │
│                                      │
└──────────────────────────────────────┘
```

---

## 2. 各设置分类详细设计

### 2.1 🤖 AI 模型配置

```typescript
interface ModelSettings {
  // 模型分组
  thinkingModel: string;     // Planning 模式模型 (如 "gpt-4o")
  fastModel: string;         // Fast 模式模型 (如 "gpt-4o-mini")
  synopsisModel: string;     // Synopsis 引擎模型 (速度优先)
  visionModel?: string;      // 多模态输入模型 (可选，默认同 thinkingModel)
  drawingModel?: string;     // 图像生成模型 (如 "dall-e-3"，可选)
  whisperModel?: string;     // 语音转写模型 (如 "whisper-1")
  
  // 参数调节
  temperature: number;       // 0.0 - 2.0 滑块
  maxTokens: number;         // 最大输出 token
  topP: number;              // 可选高级参数
  
  // 模型能力自动检测
  autoDetectCapabilities: boolean;  // 自动检测 vision/tool_call 支持
}
```

**UI 要素**：
- 每个模型位用下拉选择器（自动获取模型列表）
- "测试连接" 按钮
- 模型能力标签（✅工具调用 ✅视觉 ✅思考链 ✅图像生成）
- 图像生成模型可单独配置 API Base/Key（可能和文本模型不同提供商）

### 2.2 🔑 API 配置

```typescript
interface APISettings {
  providers: APIProvider[];  // 支持多个提供商
  activeProvider: string;    // 当前使用的提供商
}

interface APIProvider {
  id: string;
  name: string;              // "OpenAI" / "DeepSeek" / "自定义"
  baseUrl: string;           // API Base URL
  apiKey: string;            // 加密存储
  headers?: Record<string, string>;  // 自定义请求头
}
```

**UI 要素**：
- 提供商列表（可添加/删除/编辑）
- 预设按钮：OpenAI / DeepSeek / OpenRouter / Ollama 本地
- API Key 输入框（密码类型 + 显示/隐藏切换）
- "获取模型列表" 按钮

### 2.3 🎨 外观与主题

```typescript
interface AppearanceSettings {
  theme: 'dark' | 'light' | 'auto';
  accentColor: string;       // 主题色 HSL 值
  fontFamily: string;        // 界面字体
  codeFontFamily: string;    // 代码字体
  fontSize: number;          // 界面字号
  codeFontSize: number;      // 代码字号
  uiScale: number;           // UI 缩放 (0.8 - 1.5)
}
```

**预设主题色**：
| 名称 | 色值 | 预览 |
|---|---|---|
| 星空紫 (Violet) | `hsl(250, 87%, 65%)` | 默认 |
| 天空蓝 (Sky) | `hsl(200, 85%, 55%)` | |
| 翡翠绿 (Emerald) | `hsl(150, 80%, 45%)` | |
| 樱花粉 (Sakura) | `hsl(340, 80%, 65%)` | |
| 琥珀橙 (Amber) | `hsl(35, 90%, 55%)` | |
| 赛博青 (Cyber) | `hsl(180, 80%, 50%)` | Levitate 风格 |

### 2.4 🖼 背景管理

```typescript
interface BackgroundSettings {
  enabled: boolean;
  type: 'image' | 'gradient' | 'solid' | 'video';
  imagePath?: string;         // 本地图片路径
  gradientCSS?: string;       // CSS 渐变
  opacity: number;            // 0.1 - 1.0
  blur: number;               // 0 - 30px
  panelOpacity: number;       // 面板磨砂不透明度 0.5 - 0.95
}
```

**UI 要素**：
- 背景图拖拽上传区域
- 预设背景图库（几张内置壁纸）
- 实时预览滑块（模糊度、不透明度）
- 面板磨砂强度调节

### 2.5 📊 Synopsis 引擎设置

```typescript
interface SynopsisSettings {
  autoGenerate: boolean;       // 上传课件后自动生成概要
  textModeEnabled: boolean;    // TEXT MODE 开关（无多模态 API 时开启）
  chunkSizes: {
    pdf: number;               // PDF 每块页数
    pptx: number;              // PPTX 每块 slide 数
    video: number;             // 视频分段秒数
    text: number;              // 纯文本每块字数
  };
  concurrency: number;         // 并发 worker 数
  enableVideoSynopsis: boolean; // 处理视频（消耗大）
  enableAudioSynopsis: boolean; // 处理音频
  ocrFallback: boolean;        // TEXT MODE 下用 Tesseract.js OCR
  
  // 大文件优化
  largeFileThreshold: number;  // 大文件阈值(MB)
  previewMode: boolean;        // 超大文件只处理前后部分
}
```

### 2.6 💬 对话管理（高级设置）

> **设计哲学**：**所有参数对用户透明可调**，不像反重力把一切藏在 LS 里。

```typescript
interface ConversationSettings {
  // 上下文窗口管理
  contextWindowSize: number;         // 上下文窗口 token 上限（默认跟随模型，可手动覆盖）
  contextReserveRatio: number;       // 留给回复的比例 (默认 0.25 = 25%)
  autoCompressThreshold: number;     // 触发自动压缩的 token 占比 (默认 0.80 = 80%)
  
  // 存储与清理
  maxConversationsPerWorkspace: number;  // 每个工作区最多保留对话数 (默认 100，0=无限)
  maxMessageStorageSize: number;         // 单对话最大存储大小 MB (默认 50)
  autoArchiveDays: number;               // N天未活跃自动归档 (默认 30，0=不归档)
  autoDeleteArchivedDays: number;        // 归档N天后自动删除 (默认 0=不删除)
  
  // CHECKPOINT 压缩策略
  checkpointStrategy: 'auto' | 'manual' | 'never';  // 压缩模式
  checkpointSummaryModel: string;    // 用哪个模型生成摘要 (默认 fastModel)
  keepRecentRounds: number;          // 压缩时保留最近几轮 (默认 5)
  
  // 对话行为
  autoTitle: boolean;                // AI 自动生成对话标题 (默认 true)
  streamingEnabled: boolean;         // 流式输出 (默认 true)
  showThinking: boolean;             // 展示 AI 思考过程 (默认 true)
  showTokenCount: boolean;           // 展示 Token 计数 (默认 true)
  
  // 导出默认格式
  defaultExportFormat: 'markdown' | 'pdf' | 'json';
}
```

**UI 设计**：设置面板中分为"基础"和"高级"两个标签页：
- **基础**：contextWindowSize、autoCompressThreshold、autoTitle、streamingEnabled
- **高级**：其余所有参数（带说明提示 tooltip）

### 2.7 🧩 插件与 MCP 管理

**MCP 服务器列表**：
```
┌──────────────────────────────────────────┐
│  MCP 服务器                              │
├──────────────────────────────────────────┤
│  ✅ sandbox         运行中    [重启][删除]│
│  ✅ web-fetcher     运行中    [重启][删除]│
│  ✅ memory-store    运行中    [重启][删除]│
│  ❌ custom-server   已停止    [启动][删除]│
├──────────────────────────────────────────┤
│  [+ 添加 MCP 服务器]                     │
│  [📁 编辑 mcp_config.json]               │
└──────────────────────────────────────────┘
```

**SKILL/WORKFLOW/RULES 管理**：
```
┌──────────────────────────────────────────┐
│  已安装技能 (7)                          │
├──────────────────────────────────────────┤
│  📝 quiz-generator    自动出题     [禁用]│
│  📋 note-taker        笔记整理     [禁用]│
│  🗺 concept-mapper    概念图       [禁用]│
│  ...                                     │
├──────────────────────────────────────────┤
│  [📂 打开 Skills 目录]                   │
│  [📂 打开 Workflows 目录]                │
│  [📂 编辑全局规则 SYNAPSE.md]            │
└──────────────────────────────────────────┘
```

### 2.8 ⌨ 快捷键设置

| 快捷键 | 功能 | 可自定义 |
|---|---|---|
| `Ctrl+,` | 打开设置 | ✅ |
| `Ctrl+Shift+P` | 命令面板 | ❌ |
| `Ctrl+B` | 切换侧边栏 | ✅ |
| `Ctrl+J` | 切换底部面板 | ✅ |
| `Ctrl+Shift+A` | 切换 AI 面板 | ✅ |
| `Ctrl+Enter` | 发送消息 | ✅ |
| `Ctrl+N` | 新建对话 | ✅ |
| `Ctrl+O` | 打开文件 | ✅ |
| `Ctrl+P` | 快速打开 | ✅ |
| `Ctrl+Shift+F` | 全局搜索 | ✅ |
| `F11` | 全屏 | ❌ |
| `Ctrl+Shift+N` | 新建工作区 | ✅ |

### 2.9 📤 数据管理

- 导出对话历史（选择格式：JSON / Markdown / PDF）
- 导出所有设置
- 导入设置
- 清除对话历史
- 清除 Synopsis 缓存
- 数据存储位置显示

---

## 3. 通知 / Toast 系统

### 3.1 Toast 类型

| 类型 | 图标 | 颜色 | 自动消失 |
|---|---|---|---|
| `info` | ℹ️ | 蓝色 | 3s |
| `success` | ✅ | 绿色 | 3s |
| `warning` | ⚠️ | 橙色 | 5s |
| `error` | ❌ | 红色 | 不消失 |
| `progress` | ⏳ | 紫色 | 完成后消失 |

### 3.2 Toast 组件

```typescript
// 使用方式
toast.info('工作区已创建');
toast.success('课件概要生成完成');
toast.error('API 连接失败，请检查设置');
toast.progress('正在生成概要...', { progress: 45, total: 100 });
```

### 3.3 位置

右下角堆叠，最多同时显示 3 条，其余排队。

---

## 4. 右键菜单 / 上下文菜单

### 文件树右键菜单
- 打开
- 在新标签页打开
- 重命名
- 删除
- 复制路径
- ──分割线──
- 生成概要（Synopsis）
- 发送到 AI 对话

### 对话消息右键菜单
- 复制消息
- 复制代码块
- 重新生成回复
- 编辑消息（用户消息）
- ──分割线──
- 导出为 Markdown
- 删除消息

### 编辑器标签右键菜单
- 关闭
- 关闭其他
- 关闭所有
- 固定标签
- ──分割线──
- 复制路径
- 发送到 AI 对话

---

## 5. 欢迎页 / 首次使用引导

### 5.1 首次启动向导（4步）

1. **欢迎页**：Synapse logo + 简介动画
2. **API 配置**：输入 API Base + Key → 测试连接
3. **选择主题**：展示 6 种预设主题色 + 背景图选择
4. **创建第一个工作区**：输入课程名 → 拖拽上传课件

### 5.2 空状态页（无工作区时）

```
┌──────────────────────────────────────────┐
│                                          │
│         🧠 Synapse                       │
│         连接知识的每一个突触              │
│                                          │
│    ┌────────────┐  ┌────────────┐       │
│    │ + 新建课程  │  │ 📂 打开目录 │       │
│    └────────────┘  └────────────┘       │
│                                          │
│    最近工作区                            │
│    📘 机器学习导论       3天前           │
│    📗 操作系统           1周前           │
│    📕 数据结构           2周前           │
│                                          │
└──────────────────────────────────────────┘
```

---

## 3. 新增设置分类详设

### 3.1 🤝 Multi-AI 协作

> 详见 `Plan_1_MultiAI系统.md` §3

设置面板入口含：全局开关、模式列表、模式编辑器、Subagent 默认配置。
全局和工作区两级：全局模式库 + 工作区可覆盖/禁用。

### 3.2 📌 系统提示注入

```typescript
interface PromptInjectionSettings {
  preset: 'teaching' | 'ide' | 'research' | 'custom';
  
  injectIdentity: boolean;          // AI 身份说明    (默认 true)
  injectToolSchemas: boolean;       // 工具定义        (默认 true)
  injectSkillList: boolean;         // 技能列表        (默认 true)
  injectCourseContext: boolean;     // Synopsis 概要   (默认 true)
  injectUserRules: boolean;         // SYNAPSE.md      (默认 true)
  injectWorkflowList: boolean;      // 工作流列表      (默认 true)
  injectExtensionInfo: boolean;     // 扩展信息        (默认 false)
  customSystemPrompt: string;       // 追加自定义提示
}
```

**UI**：
```
┌──────────────────────────────────────────┐
│  📌 系统提示注入                          │
├──────────────────────────────────────────┤
│  预设模式: [▼ 📚 教学模式              ] │
│                                          │
│  注入组件:                               │
│  ☑ AI 身份说明                           │
│  ☑ 工具定义 (Schema)                     │
│  ☑ 技能列表                              │
│  ☑ 课件概要 (Synopsis)                   │
│  ☑ 用户规则 (SYNAPSE.md)                 │
│  ☑ 工作流列表                            │
│  ☐ VSCode 扩展信息                       │
│                                          │
│  追加自定义提示:                          │
│  ┌────────────────────────────────┐      │
│  │ (文本区域，Markdown 编辑)       │      │
│  └────────────────────────────────┘      │
│                                          │
│  [预览完整系统提示] [重置为默认]          │
└──────────────────────────────────────────┘
```

### 3.3 🛡 安全与审批

```typescript
interface SafetySettings {
  fileReadApproval: 'always' | 'ask' | 'never';
  fileWriteApproval: 'always' | 'ask' | 'never';
  commandApproval: 'always' | 'ask' | 'never';
  networkApproval: 'always' | 'ask' | 'never';
  globalAutoApprove: boolean;
  sandboxTimeout: number;          // 默认 30
  sandboxMaxMemoryMB: number;      // 默认 256
  sandboxMaxConcurrent: number;    // 默认 5
}
```

**UI**：
```
┌──────────────────────────────────────────┐
│  🛡 安全与审批                            │
├──────────────────────────────────────────┤
│  ⚠️ 全局自动审批: [关]                   │
│  (开启后 AI 所有操作自动执行，不再询问)   │
│                                          │
│  操作        自动  询问  禁止            │
│  文件读取    (●)   ( )   ( )             │
│  文件写入    ( )   (●)   ( )             │
│  命令执行    ( )   (●)   ( )             │
│  网络请求    ( )   (●)   ( )             │
│                                          │
│  沙箱限制:                               │
│  命令超时: [30     ] 秒                  │
│  内存限制: [256    ] MB                  │
│  最大并发: [5      ] 个                  │
└──────────────────────────────────────────┘
```

### 3.4 🔌 VSCode 扩展

```
┌──────────────────────────────────────────┐
│  🔌 VSCode 扩展                          │
├──────────────────────────────────────────┤
│  扩展源: ~/.vscode/extensions/ (46个)     │
│  ☑ 自动同步 VSCode 扩展变更              │
│                                          │
│  ✅ One Dark Pro          Theme   [启用] │
│  ✅ Python                Grammar [启用] │
│  ✅ Material Icon Theme   Icons   [启用] │
│  ✅ Python Debugger       DAP     [启用] │
│  ⚠️ GitLens              Partial [详情] │
│  ❌ Thunder Client        Incompat       │
│                                          │
│  [🔄 重新扫描]  [📂 打开扩展目录]        │
└──────────────────────────────────────────┘
```

### 3.5 🐛 调试器

```
┌──────────────────────────────────────────┐
│  🐛 调试器                                │
├──────────────────────────────────────────┤
│  来自 VSCode 扩展的调试适配器:            │
│  ✅ Python (debugpy)             [默认]  │
│  ✅ Node.js (built-in)           [可用]  │
│  ✅ C/C++ (cppvsdbg)             [可用]  │
│                                          │
│  调试设置:                               │
│  启动文件: [▼ 使用当前文件             ] │
│  调试控制台字体: [▼ Cascadia Code      ] │
│  断点颜色: [🔴]                          │
│  自动保存断点: ☑                         │
└──────────────────────────────────────────┘
```

### 3.6 🖼 背景管理（更新）

在原有基础上增加多图和轮播功能：

```typescript
interface BackgroundSettings {
  enabled: boolean;
  images: string[];                     // 多张图路径
  displayMode: 'static' | 'carousel' | 'random';
  carouselInterval: number;             // 轮播间隔秒数 (默认 300)
  transitionDuration: number;           // 切换动画 ms (默认 1000)
  transitionEffect: 'fade' | 'slide';
  blur: number;                         // 0-30px
  opacity: number;                      // 0.1-1.0
  panelOpacity: number;                 // 0.5-0.95
}
```
