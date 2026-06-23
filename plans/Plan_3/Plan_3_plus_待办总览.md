# Plan_3_plus: 二次修复后残留问题总览与分工

> 本文档基于 Codex 两轮修复后、用户实测反馈整理。
> 所有需求均有 Plan_1 系列原始设计文档支撑，不是新增需求。

---

## 一、分工原则

| 执行者 | 适合的任务类型 |
|--------|--------------|
| **Codex** | 重型 UI 组件实现、跨多文件重构、需要耐心的大量代码编写 |
| **Antigravity** | 快速 Bug 修复、CSS 调整、逻辑微调、需要实时 UI 验证的修复 |

---

## 二、待办清单

### 🔴 A 类：Codex 负责（重型 UI 组件）

#### A-1 壁纸系统完整实现
- **Plan 来源**: `Plan_1_设置系统.md §2.4 + §3.6`
- **现状**: 壁纸上传后不生效；多图点击会删除而非切换；×按钮太小
- **需实现**:
  - 多图管理（点击切换预览，而非删除）
  - 图片实际应用为 CSS 背景（opacity/blur/panelOpacity 参数生效）
  - 轮播模式（carousel/random/static）
  - 切换动画（fade/slide）
  - ×删除按钮尺寸修复
- **涉及文件**: `SettingsPanel.tsx`, `useThemeEffect.ts`, `index.css`, `settings.css`
- **验证**: 上传图片后主界面背景实际改变，轮播切换正常

#### A-2 插件管理面板（Electron 模式）
- **Plan 来源**: `Plan_1_可扩展系统.md §2 + Plan_1_设置系统.md §2.7`
- **现状**: Electron 模式也显示"Web模式不可用"，MCP 服务器全是假占位
- **需实现**:
  - MCP 服务器：检测运行环境（isElectron），Electron 下显示状态 + [重启][停止] 按钮
  - SKILL 列表：显示名称/描述/路径，Electron 下有 [打开目录] 按钮
  - WORKFLOW 列表：同上
  - Web 模式下标注"Electron 模式可用"而非"不可用"
- **涉及文件**: `SettingsPanel.tsx`, `extensionManager.ts`, `platform/index.ts`
- **验证**: Electron 启动时 MCP 状态正确显示

#### A-3 Synopsis 设置面板
- **Plan 来源**: `Plan_1_Synopsis引擎.md §8 + Plan_1_设置系统.md §2.5`
- **现状**: 只有静态文字和假数字
- **需实现**:
  - TEXT MODE 开关 → 绑定到 store 并持久化
  - 每块最大 Token 输入 → 绑定到 store
  - Map 并发数 输入 → 绑定到 store
  - 索引自动更新开关 → 绑定到 store
  - 所有参数通过 `localStorage`/`electron-store` 持久化
  - 参数变更后 Toast 提示
- **涉及文件**: `SettingsPanel.tsx`, `store/slices/agentSettings.ts`, `settings.css`
- **验证**: 修改参数 → 刷新页面 → 参数保持

#### A-4 Multi-AI 设置面板
- **Plan 来源**: `Plan_1_MultiAI系统.md §3`
- **现状**: 只有一个开关和一句话描述
- **需实现**:
  - 全局开关 → 绑定 store
  - 已保存模式列表（从 mode.json 读取，暂用内置示例数据）
  - "新建模式" / "编辑模式" 按钮（打开模式编辑弹窗）
  - 默认 Subagent 配置（模型选择、Token 上限、最大并行数）
  - 所有参数持久化
- **涉及文件**: `SettingsPanel.tsx`, `store/slices/agentSettings.ts`, `settings.css`
- **验证**: 开关切换、模式列表显示正常、参数持久化

#### A-5 数据管理面板
- **Plan 来源**: `Plan_1_设置系统.md §2.9`
- **现状**: "导出全部对话"按钮写"即将推出"，清除按钮存疑
- **需实现**:
  - 导出全部对话 → Electron 下调用 IPC 导出 JSON
  - 清除对话历史 → 清除 localStorage/数据库中的对话数据
  - 存储使用量 → 真实计算 localStorage 或 IndexedDB 大小
  - 清除缓存 → 清除 Synopsis 缓存和临时文件
  - Web 模式下操作 localStorage，Electron 模式下走 IPC
- **涉及文件**: `SettingsPanel.tsx`, `store/index.ts`
- **验证**: 清除后对话确实消失，存储量更新

---

### 🟡 B 类：Antigravity 负责（快速修复）

#### B-1 连接状态显示修复
- **现状**: 联网了仍显示"未连接"
- **原因**: `StatusBar.tsx` 中连接检测逻辑不正确或未触发
- **修复**: 检查 `navigator.onLine` + API Key 已配置 = "已配置"

#### B-2 文件显示宽度修复
- **现状**: HTML 文件只占中间 1/3 宽度，图片显示 alt 文字
- **原因**: `EditorArea.tsx` / `CodeEditor.tsx` 的容器样式问题
- **修复**: 编辑器/预览器 width: 100%，图片 URL 加载修复

#### B-3 附件上传标注
- **现状**: 显示"附件功能完善中"
- **修复**: 改为更友好的提示 + 至少支持将文件路径传入对话上下文

#### B-4 壁纸缩略图 × 按钮尺寸
- **现状**: 右上角 × 太小
- **修复**: CSS 调大 + hover 效果

#### B-5 对话消息模型来源显示
- **现状**: 选择模型后底部和状态栏能显示，但消息气泡是否标注模型？
- **修复**: 确认消息发送时 model 字段正确传入

### 2026-04-29 Codex 接手状态

- B-1：已复核，`StatusBar.tsx` 当前按在线状态、API Key、连接状态显示“未配置 API / 已配置 / 连接失败 / 检测中…”，没有旧“未连接”文案。
- B-2：已复核，主要编辑器与查看器容器为全宽全高；图片 viewer 使用 object URL 和 `object-fit: contain`。
- B-3：已补齐，附件/图片选择后会把文件名、路径、类型、大小写入输入框上下文。
- B-4：已复核，壁纸缩略图删除按钮为 20x20，带 hover/focus。
- B-5：已补齐，消息结构新增 `model` 字段，发送与回复消息会记录当前模型，消息气泡头部显示模型标签。
- 验证：`npx tsc -b` 通过，`npm run build` 通过；Playwright 主界面与附件输入验证通过，控制台 0 errors / 0 warnings。

---

## 三、执行顺序

```
Phase 1 (并行):
  Codex → A-1~A-5 (重型组件)
  Antigravity → B-1~B-5 (快速修复)

Phase 2 (整合):
  Antigravity 审核 Codex 成果
  联合 UI 测试
  收尾修复
```

---

## 四、参考文件索引

| Plan 文件 | 覆盖范围 |
|-----------|---------|
| `Plan_1/Plan_1_设置系统.md` | 所有设置面板 UI 设计、壁纸、数据管理、快捷键 |
| `Plan_1/Plan_1_可扩展系统.md` | MCP/SKILL/WORKFLOW/RULES/VSCode扩展/DAP |
| `Plan_1/Plan_1_Synopsis引擎.md` | Synopsis 引擎配置、解析器、Map-Reduce |
| `Plan_1/Plan_1_MultiAI系统.md` | Multi-AI 模式编辑器、AgentOrchestrator |
| `Plan_1/Plan_1_AI交互层.md` | 对话系统、工具调用、附件处理 |
| `Plan_1/Plan_1_前端架构.md` | 整体布局、EditorArea、文件预览 |
