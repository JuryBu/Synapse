# Codex 二次修复任务：Plan_3 残留问题

> 本文档基于第一轮 Codex 修复后用户实测发现的残留问题编写。

---

## 零、强制规则（继承自第一轮）

所有第一轮 `docs/Codex_Task_Plan3_修复.md` 第零节规则继续有效：
- 必须阅读原文件确认后再修改
- Plan 冲突以编号靠后的为准
- 持续更新 `Record/Record_codex_1.md`（追加到已有内容之后）和 `docs/报告_Plan3_Codex_Review.md`
- 不得扭曲设计意图
- 可以使用子代理

---

## 一、真实 API 测试信息

已验证可用的 API 配置：

| 项目 | 值 |
|------|-----|
| API 端点 | `https://ai.juguang.chat/v1` |
| API Key | `sk-7JBkZd4aVgceAqDN0EOKvUPdvhCREgDaJG74niKDCgoG1afj` |
| 可用模型数 | 83 个 |
| 已验证模型 | `gemini-2.0-flash`（回复正常，usage 字段有值） |
| 注意 | 此 API **不含** `gpt-4o-mini`，不要用它做默认 |

**推荐默认模型**: `gemini-2.0-flash`（响应快、免费）

**修复后必须用此 API 做真实对话测试**，验证：
1. 在设置面板填入 Key 和端点
2. 点击"获取模型"按钮，确认能拉到模型列表
3. 选择一个模型
4. 在对话面板发送消息，确认收到流式回复
5. 确认 Token 计数更新
6. 确认状态栏连接状态变为"已配置"

---

## 二、残留问题清单

### 🔴 R-1：模型名硬编码 `gpt-4o-mini`

**现象**: 对话面板底部和状态栏始终显示 `gpt-4o-mini`，这不是从 API 获取的，是代码硬编码的默认值。

**问题位置（需要自行查找确认）**:
- `src/store/slices/agentSettings.ts` 的 initialState 中 `currentModel` 默认值
- `src/store/slices/conversation.ts` 的 initialState 中 `model` 默认值  
- 可能还有 `src/components/layout/StatusBar.tsx` 某处兜底值

**修复要求**:
- 将所有硬编码的 `gpt-4o-mini` / `gpt-4o` 改为空字符串 `""`
- 未设模型时，界面显示"未选择模型"或"请在设置中选择模型"
- 用户通过"获取模型"拉到列表 → 选择模型 → 该选择被持久化 → AgentPanel 和 StatusBar 读取并显示真实模型名
- **绝对不能有任何模型名硬编码**

### 🔴 R-2：设置 Tab 滚动条视觉突兀

**现象**: 设置面板顶部 Tab 栏下方出现一个浅色/原生外观的水平滚动条，在深色主题下非常突兀，与整体设计不协调（用户截图图三可见）。

**修复要求**:
- 要么用 CSS 隐藏原生滚动条（`scrollbar-width: none; -ms-overflow-style: none; ::-webkit-scrollbar { display: none; }`）同时用其他方式（左右箭头按钮或拖动）实现导航
- 要么将滚动条样式适配深色主题（颜色设为 `var(--syn-bg-secondary)` 等暗色变量）
- 查看 `src/styles/settings.css` 或 `SettingsPanel.tsx` 中 Tab 容器的样式

### 🔴 R-3：左侧侧边栏内容窄屏截断

**现象**: 当侧边栏宽度较窄时，设置面板中的文本（Tab 名、设置项标签）被直接截断，没有自适应处理。顶部设置项的右边被截断不可见（用户截图图三图四可见）。

**修复要求**:
- 设置面板内容需要跟随侧边栏宽度自适应
- Tab 名过长时 `text-overflow: ellipsis` 或缩略显示
- 设置项 label 和控件用 flex wrap 或响应式布局避免溢出
- 检查 `src/styles/settings.css` 和 `SettingsPanel.tsx` 相关 CSS

### 🟡 R-4：工作区文件管理 UI 缺失

**现象**: 左侧文件树只有一个列表，没有右键菜单或工具栏来管理工作区文件。用户期望有打开/新建/删除/重命名等文件操作。

**当前状态**: 
- Codex 第一轮已在 Electron IPC 层添加了 `file:rename`、`file:delete`、`file:mkdir`
- 但前端 FileTree 组件的右键菜单可能没有接入这些 IPC

**修复要求**:
- 在 `src/components/sidebar/FileTree.tsx` 中实现右键菜单：
  - 文件右键：重命名、删除、复制路径
  - 文件夹右键：新建文件、新建文件夹、重命名、删除
  - 空白处右键：新建文件、新建文件夹、打开工作区
- Web 模式下的重命名/删除/新建操作使用 `fileSystem` 内存服务
- Electron 模式下走 IPC
- 使用已有的 `src/components/ui/ContextMenu.tsx` 组件

### 🟡 R-5：插件页面退化

**现象**: 第一轮修复将插件 Tab 的所有内容改为"即将推出"，使得原本至少有展示效果的插件列表变得毫无信息量。MCP 服务器、SKILL、WORKFLOW 都只显示"内置定义，管理 UI 即将推出"。

**修复要求**:
- 保留已有的插件/SKILL/WORKFLOW 展示列表（名称、图标、描述），它们本来就是有信息量的
- 仅将"安装/卸载/启用/禁用"这类需要后端的操作按钮标注为"即将推出"
- MCP 服务器列表保留展示，将状态改为"Web 模式不可用"即可
- 参考 `Plan/Plan_1/Plan_1_可扩展系统.md` 了解插件系统原始设计意图
- **原则：展示信息保留，仅操作按钮标注为即将推出**

### 🟢 R-6：真实 API 对话闭环测试

**要求**: 完成上述修复后，必须用真实 API 做完整闭环测试：

1. 启动 dev server: `npm run dev`
2. 打开 http://localhost:5173
3. 进入设置 → AI Tab
4. 填入 API 端点: `https://ai.juguang.chat/v1`
5. 填入 API Key: `sk-7JBkZd4aVgceAqDN0EOKvUPdvhCREgDaJG74niKDCgoG1afj`
6. 点击"获取模型" → 确认能拉到模型列表
7. 选择 `gemini-2.0-flash` 作为默认模型
8. 进入对话面板，发送 "你好"
9. 确认收到流式回复
10. 确认底部 Token 计数从 0 变为真实值
11. 确认状态栏显示"已配置"和真实模型名

---

## 三、文件参考

| 文件 | 用途 |
|------|------|
| `docs/Codex_Task_Plan3_修复.md` | 第一轮完整任务文档 |
| `Record/Record_codex_1.md` | 第一轮工作记录（追加到此文件） |
| `docs/报告_Plan3_Codex_Review.md` | 第一轮修复报告（更新此文件） |
| `Plan/Plan_1/Plan_1_可扩展系统.md` | 插件系统原始设计 |

---

## 四、验证方法

```bash
cd c:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app
npx tsc -b          # 必须 0 errors
npm run build        # 必须通过
npm run dev          # 启动后做真实 API 测试
```

---

## 五、输出要求

- 追加到 `Record/Record_codex_1.md`（新增 `## 二次修复` 小节）
- 更新 `docs/报告_Plan3_Codex_Review.md`（追加二次修复结果）
- 通过真实 API 闭环测试后在报告中记录测试结果（截图或文字描述）
