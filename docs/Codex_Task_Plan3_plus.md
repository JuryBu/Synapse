# Codex 任务文档：Plan_3_plus 重型 UI 组件实现

> **项目路径**: `c:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\`
> **API 端点**: `https://ai.juguang.chat/v1`
> **API Key**: `sk-7JBkZd4aVgceAqDN0EOKvUPdvhCREgDaJG74niKDCgoG1afj`
> **编译命令**: `npx tsc -b && npm run build`

---

## ⚠️ 严格要求（必读）

1. **禁止假占位**：不许写"即将推出"、"Web 模式不可用"等假文字来占位。如果功能没法完整实现，在 UI 上正常显示参数但标注 `(暂存本地)` 即可
2. **所有 UI 参数必须绑定到 Redux Store 并通过 localStorage 持久化**
3. **Electron 模式检测**：使用 `isElectron`（从 `@/platform` 导入），Electron 下走 IPC，Web 下走 localStorage
4. **编译必须通过**：每个任务完成后执行 `npx tsc -b`，0 error 才算完成
5. **不要修改无关文件**：只修改任务指定的文件
6. **原始设计文档参考路径**见下方每个任务的"Plan 来源"

---

## 关键文件索引

| 文件 | 用途 |
|------|------|
| `src/components/settings/SettingsPanel.tsx` | 设置面板主组件 (738行) |
| `src/store/slices/agentSettings.ts` | Agent 设置 Redux Store (69行) |
| `src/platform/index.ts` | 平台适配层，含 isElectron 和 IPC 接口 |
| `src/styles/settings.css` | 设置面板样式 |
| `src/services/extensionManager.ts` | 扩展管理服务 |

---

## 任务 A-1：壁纸系统完整实现

### Plan 来源
`Plan/Plan_1/Plan_1_设置系统.md` §2.4 和 §3.6（第 128-146 行和第 486-502 行）

### 当前问题
1. 上传壁纸后不生效（CSS 背景没实际应用）
2. 多图列表中点击图片会删除它，而不是切换选中
3. 缩略图右上角 × 删除按钮太小（不足 16px）

### 需要实现的完整功能

#### Store 扩展 (agentSettings.ts 或新建 backgroundSettings.ts)
```typescript
interface BackgroundSettings {
  enabled: boolean;
  images: string[];              // base64/URL 列表
  selectedIndex: number;         // 当前选中的壁纸索引
  displayMode: 'static' | 'carousel' | 'random';
  carouselInterval: number;      // 轮播间隔秒数，默认 300
  transitionEffect: 'fade' | 'slide';
  blur: number;                  // 0-30px
  opacity: number;               // 0.1-1.0（壁纸自身透明度）
  panelOpacity: number;          // 0.5-0.95（面板磨砂不透明度）
}
```

#### UI 交互逻辑
- **选择图片按钮**：点击后打开文件选择（`<input type="file" accept="image/*" multiple />`），选中的图片转 base64 存入 `images` 数组
- **缩略图列表**：每张图片显示为 80×50px 缩略图，**单击 = 切换选中**（蓝色边框高亮），而不是删除
- **每个缩略图右上角 × 按钮**：20×20px，hover 时背景 rgba(255,0,0,0.7)，点击后删除该图片
- **清除按钮**：一键清除所有壁纸
- **滑块**：模糊度 blur (0-30)、壁纸透明度 opacity (10%-100%)、面板透明度 panelOpacity (50%-95%)
- **轮播设置**：displayMode 下拉、carouselInterval 滑块 (10s-600s)

#### CSS 背景应用逻辑
在 `App.tsx` 或通过一个 `useBackgroundEffect` hook：
```typescript
// 当 enabled && images.length > 0 时
// 在 #app 或 body::before 创建一个 position:fixed 的背景层
// background-image: url(images[selectedIndex])
// background-size: cover
// filter: blur(${blur}px)
// opacity: ${opacity}
```

#### 持久化
所有参数存入 localStorage key `synapse:background`，页面加载时恢复。

### 验证标准
1. 上传一张图片 → 主界面背景实际改变
2. 上传 3 张图 → 点击不同缩略图 → 背景切换到对应图片
3. 点击缩略图右上角 × → 仅删除该图，不影响其他图
4. 拖动 blur 滑块 → 背景模糊度实时变化
5. 刷新页面 → 壁纸设置保持

---

## 任务 A-2：插件管理面板（Electron 模式适配）

### Plan 来源
`Plan/Plan_1/Plan_1_可扩展系统.md` §2 和 `Plan/Plan_1/Plan_1_设置系统.md` §2.7（第 208-238 行）

### 当前问题
1. MCP 服务器全部显示 "Web 模式不可用"，但用户是 Electron 启动的
2. SKILL 全部显示"即将推出"
3. 插件面板没有任何可交互按钮

### 需要实现的功能

#### MCP 服务器状态检测
```typescript
// 已有 IPC 接口（platform/index.ts 第 117-123 行）:
// mcp.getStatus() → Promise<{ servers: ServerInfo[] }>
// mcp.restart(server) → Promise<void>
// mcp.start(server) → Promise<void>
// mcp.stop(server) → Promise<void>

// Electron 模式下:
// 调用 platform.mcp.getStatus() 获取真实 MCP 状态
// Web 模式下:
// 显示 "Electron 模式可用" (不是"不可用")
```

#### MCP 服务器列表 UI
```
┌──────────────────────────────────────────┐
│  MCP 服务器                              │
├──────────────────────────────────────────┤
│  ✅ sandbox         运行中    [重启]     │
│  ✅ web-fetcher     运行中    [重启]     │
│  ✅ memory-store    运行中    [重启]     │
├──────────────────────────────────────────┤
│  Web 模式下显示:                         │
│  ℹ️ MCP 服务器在 Electron 模式下可用     │
└──────────────────────────────────────────┘
```

每个 MCP 条目：
- 名称 + 描述
- 状态指示灯（🟢运行中 / 🔴已停止 / 🟡启动中）
- Electron 模式：[重启] 按钮（调用 `platform.mcp.restart(name)`）
- Web 模式：灰色状态文字 "Electron 模式下可用"

#### SKILL 列表 UI
- 保留现有的名称、描述、图标、路径信息
- 移除"即将推出"文字
- Electron 模式下添加 [📂 打开目录] 按钮（调用 `platform.command.exec('explorer "${skillPath}"')`）
- 状态改为 "内置" 标签（绿色小 badge）

#### WORKFLOW 和 RULES 列表
- 同 SKILL 一样的处理方式

### 验证标准
1. Electron 启动 → 插件页 MCP 显示真实状态
2. Web 启动 → 插件页显示 "Electron 模式下可用"，不是"不可用"
3. [重启] 按钮可点击且不报错
4. `npx tsc -b` 编译通过

---

## 任务 A-3：Synopsis 设置面板功能绑定

### Plan 来源
`Plan/Plan_1/Plan_1_Synopsis引擎.md` §8（第 328-358 行）和 `Plan/Plan_1/Plan_1_设置系统.md` §2.5（第 148-169 行）

### 当前问题
Synopsis 设置面板只有静态文字和假数字，修改参数无任何效果。

### 需要实现的功能

#### Store 扩展
在 `agentSettings.ts` 中新增或新建 `synopsisSettings.ts`：
```typescript
interface SynopsisSettings {
  textModeEnabled: boolean;       // TEXT MODE 开关，默认 false
  chunkMaxTokens: number;         // 每块最大 Token，默认 2000
  mapConcurrency: number;         // Map 并发数，默认 3
  autoIndexEnabled: boolean;      // 索引自动更新，默认 true
  autoIndexMethod: 'contentHash' | 'timestamp';  // 默认 contentHash
}
```

#### UI 要求
```
┌──────────────────────────────────────────┐
│  📊 Synopsis 引擎                        │
│                                          │
│  文档解析与 RAG 生成管线正在接入。        │
│                                          │
│  TEXT MODE (纯文本模式)    [开关]         │
│  ℹ 没有多模态 API 时，开启 TEXT MODE     │
│    使用 OCR 提取文字后送入文本模型        │
│                                          │
│  每块最大 Token  [____2000____]          │
│  Map 并发数      [____3_______]          │
│  索引自动更新    [开关]                  │
│  更新策略        [▼ contentHash 对比   ] │
└──────────────────────────────────────────┘
```

- TEXT MODE 开关：toggle 组件，绑定 `textModeEnabled`
- 每块最大 Token：数字输入框 (100-8000)，绑定 `chunkMaxTokens`
- Map 并发数：数字输入框 (1-10)，绑定 `mapConcurrency`
- 索引自动更新：toggle 组件，绑定 `autoIndexEnabled`
- 更新策略：下拉选择 contentHash / timestamp

#### 持久化
通过 localStorage `synapse:synopsis` 存取。页面加载时从 localStorage 恢复到 store。

#### 交互
修改任何参数后：
- 立即 dispatch 更新 store
- 同步写入 localStorage
- Toast 提示 "Synopsis 设置已保存"

### 验证标准
1. 修改"每块最大 Token"为 4000 → 刷新 → 仍然是 4000
2. 切换 TEXT MODE → 刷新 → 状态保持
3. 所有输入框和开关不报控制台错误
4. `npx tsc -b` 编译通过

---

## 任务 A-4：Multi-AI 设置面板功能绑定

### Plan 来源
`Plan/Plan_1/Plan_1_MultiAI系统.md` §3（第 200-282 行）

### 当前问题
只有一个开关和一句"设置会持久化"的描述文字，没有任何实际参数。

### 需要实现的功能

#### Store 扩展
```typescript
interface MultiAISettings {
  enabled: boolean;               // 全局开关，默认 false
  activeMode: string;             // 当前激活模式名，默认 'solo'
  modes: MultiAIMode[];           // 已保存的模式列表
  defaultSubagentModel: string;   // 默认子代理模型，默认 ''（跟随主模型）
  defaultSubagentMaxTokens: number; // 默认 32000
  maxConcurrentSubagents: number; // 最大并行子代理数，默认 3
}

interface MultiAIMode {
  id: string;
  name: string;
  description: string;
  agentCount: number;  // 包含几个 agent（主+子）
  isBuiltin: boolean;  // 是否内置
}
```

#### UI 要求
```
┌──────────────────────────────────────────┐
│  🤝 Multi-AI 协作                        │
│                                          │
│  启用 Multi-AI    [开关]                 │
│  ℹ 启用后，主 Agent 可通过               │
│    spawn_subagent 创建子代理协助工作      │
│                                          │
│  ── 已保存模式 ──                        │
│  📋 Solo (单Agent)         仅主  [默认]  │
│  📋 对抗式vibe-coding  主+1子  [选择]    │
│  📋 深度研究           主+2子  [选择]    │
│  📋 教学协作           主+1子  [选择]    │
│                                          │
│  ── 默认 Subagent 配置 ──               │
│  子代理模型: [▼ 跟随主Agent模型       ]  │
│  Token 上限: [____32000___]              │
│  最大并行:   [____3_______]              │
└──────────────────────────────────────────┘
```

- 全局开关 toggle 绑定 `enabled`
- 模式列表用内置示例数据（不需要真实读文件系统）
- 每个模式行有 [选择] 按钮，点击设置 `activeMode`
- 当前激活模式显示 [默认] 标签
- 底部三个参数输入绑定对应字段

#### 注意
- 模式编辑弹窗暂不实现（工作量太大），但 [新建模式] 按钮要显示，点击后 Toast "模式编辑器即将推出"
- 已保存模式列表用硬编码的 4 个示例即可（Solo/对抗式/深度研究/教学协作）

#### 持久化
localStorage `synapse:multi-ai`

### 验证标准
1. 开关切换 → 刷新 → 状态保持
2. 选择不同模式 → [默认] 标签跟随移动
3. 修改 Token 上限 → 刷新 → 保持
4. `npx tsc -b` 编译通过

---

## 任务 A-5：数据管理面板功能实现

### Plan 来源
`Plan/Plan_1/Plan_1_设置系统.md` §2.9（第 258-266 行）

### 当前问题
"导出全部对话"按钮写"即将推出"，清除按钮存疑是否真的能清除。

### 需要实现的功能

#### UI 要求
```
┌──────────────────────────────────────────┐
│  📤 数据管理                             │
│                                          │
│  导出全部对话    [📥 导出为 JSON]        │
│  清除对话历史    [🗑 清除]    (红色按钮)  │
│  存储使用量      8500.2 KB / 5 MB        │
│  清除缓存        [🧹 清理]              │
│                                          │
│  ── 设置导入导出 ──                      │
│  导出设置        [📤 导出]               │
│  导入设置        [📥 导入]               │
└──────────────────────────────────────────┘
```

#### 功能实现

1. **导出全部对话**：
   - 从 localStorage 收集所有 `synapse:conversation:*` 键值
   - 打包为 JSON 文件
   - Web 模式用 `URL.createObjectURL` + `<a>` 下载
   - Electron 模式用 `dialog.showSaveDialog`（如果有 IPC）或同 Web 方式

2. **清除对话历史**：
   - 弹出确认对话框："确定要清除所有对话历史吗？此操作不可恢复。"
   - 确认后清除 localStorage 中所有对话相关键值
   - Toast "对话历史已清除"

3. **存储使用量**：
   - 真实计算 localStorage 使用量：遍历所有 key 计算 `key.length + value.length` 总和
   - 显示为 KB/MB

4. **清除缓存**：
   - 清除 localStorage 中的 Synopsis 缓存（`synapse:synopsis:*`）和临时数据
   - Toast "缓存已清理"

5. **导出设置**：
   - 收集所有 `synapse:config:*`、`synapse:background`、`synapse:synopsis`、`synapse:multi-ai` 键值
   - 导出为 JSON

6. **导入设置**：
   - 文件选择 → 读取 JSON → 写入对应 localStorage 键值 → 刷新页面
   - 错误处理：JSON 解析失败时 Toast 报错

### 验证标准
1. 点击"导出为 JSON" → 下载 conversations.json 文件
2. 点击"清除" → 确认 → 对话消失，存储使用量减小
3. 存储使用量数字是真实的（不是硬编码）
4. 导出设置 → 修改某参数 → 导入设置 → 参数恢复
5. `npx tsc -b` 编译通过

---

## 通用要求补充

### 样式规范
- 所有新增 UI 使用深色主题风格，与现有设置面板一致
- 输入框：`background: rgba(255,255,255,0.05)`, `border: 1px solid rgba(255,255,255,0.1)`
- 按钮：与现有"获取模型"、"测试连接"按钮风格一致
- Toggle 开关：复用现有 `ToggleItem` 组件
- 数字输入：使用 `<input type="number">`，min/max 约束

### 编译和提交
1. 每个任务完成后 `npx tsc -b`，确保 0 error
2. 全部完成后 `npm run build`，确保构建通过
3. 输出修改文件清单和每个文件的修改摘要

### 测试指引
完成所有任务后：
1. `npm run dev` 启动 Web 模式，检查所有设置面板
2. 如果可以的话 `npm run electron:dev` 启动 Electron 模式，检查 MCP 状态
3. 确保浏览器控制台无报红
