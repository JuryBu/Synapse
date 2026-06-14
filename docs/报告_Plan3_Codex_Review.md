# Synapse Plan_3 Codex 修复报告

## 当前状态

第一批核心对话、模型、Token、连接状态、设置视觉桥接已完成，并通过 TypeScript 与生产构建验证。

## 修复清单

| 问题ID | 文件 | 修改摘要 | 状态 |
|---|---|---|---|
| P0-1 | `src/components/layout/AgentPanel.tsx` | 输入框不再因未配置 API Key 被禁用；发送时提示配置 | 已修复 |
| P0-2 | AI 对话链路 | 确认 AIClient 本地创建链路，补全模型列表/连接状态全局化 | 已修复 |
| P0-3 | 文件查看链路 | 文件树刷新、文本/二进制导入、CodeEditor 读取保存、查看器提示修复 | 已修复 |
| P1-1 | 设置与全局样式 | 字号、主题、强调色变量桥接到 DOM/CSS | 已修复 |
| P1-2 | 壁纸系统 | 背景、磨砂、透明度与轮播变量接入 | 已修复 |
| P1-3 | 模型选择器 | AgentPanel 底部模型下拉已接 Redux 模型列表 | 已修复 |
| P1-4 | Token 计数 | API usage 写回 Redux，界面优先显示真实用量 | 已修复 |
| P1-5 | 连接状态 | StatusBar 根据配置和检测状态显示真实状态 | 已修复 |
| P1-6 | 终端 Web 模式 | 输入框主动聚焦、终端保持挂载、Electron 命令执行接入 | 已修复 |
| P2-1 | 设置 Tab 响应式 | Tab 栏支持横向滚动 | 已修复 |
| P2-2 | Fast/Plan 模式差异 | 系统提示强化 Plan 输出契约；Fast 既有禁用工具逻辑保留 | 已修复 |
| P2-3 | 欢迎页卡片 | 打开工作区、新建课程、最近工作区、AI 助手聚焦闭环 | 已修复 |
| P2-4 | 知识概要 | 改为工作区候选文件动态列表，删除模拟完成状态 | 已修复 |
| P2-5 | 设置占位清理 | agentSettings/multiAI 持久化；未闭环 Tab 标注即将推出 | 已修复 |
| P2-6 | 状态栏 Git 分支硬编码 | 移除 `main`，改为显示当前模型 | 已修复 |

## 编译验证

| 时间 | 命令 | 结果 |
|---|---|---|
| 第一批修复后 | `npx tsc -b` | 通过，0 errors |
| 第一批修复后 | `npm run build` | 通过，Vite 构建成功；仅有既有体积与 dynamic import 警告 |
| 第二批修复后 | `npx tsc -b` | 通过，0 errors |
| 第二批修复后 | `npm run build` | 通过，Vite 构建成功；仅有既有体积与 dynamic import 警告 |

## Web 联合验证

| 验证项 | 结果 |
|---|---|
| 对话输入框 | 未配置 API Key 时可输入，发送按钮保持禁用灰态 |
| 模型选择器 | 底部模型标签可展开；空列表显示“请在设置中获取模型列表” |
| 终端 | 输入 `help` 后输出 `Synapse Terminal` 帮助 |
| README 查看 | `/workspace/README.md` 可打开并显示 Markdown 内容 |
| 代码文件查看 | `/workspace/实验/排序算法比较.py` 可打开并显示在 `CodeEditor` |
| 设置字号 | 拖动字号滑块后 `--app-font-size` 从 `14px` 更新到 `19px` |
| 设置强调色 | `--syn-accent`、`--syn-primary`、`--syn-accent-rgb` 同步更新 |
| 浅色/深色主题 | `documentElement` 与 `body` 的 `data-theme` 正确切换 |
| 知识概要 | 动态列出工作区候选文件，不再显示假完成/假分片 |
| 控制台 | 仅有 `/favicon.ico` 404，与本轮修复无关 |

## Stage Guard

已调用 `stage_guard(action="check")`。Guard 未通过原因是 Flash 模型调用失败（提示可能 LS 未连接），不是编译或功能验证失败。按工具要求已记录，等待用户裁定。

## 未修复项及原因

暂无阻塞项。PDF/DOCX 在 Web 模式下需要用户导入真实文件后通过 object URL 查看；内置 demo 虚拟路径会显示明确提示，避免继续显示“无法加载文件”的误导空态。

## 后续改进建议

- 接入真实 Synopsis RAG 生成管线后，将当前“待生成”按钮替换为实际解析/分片/摘要流程。
- 补充 favicon，清掉浏览器默认 `/favicon.ico` 404。
- 后续可继续做 Electron 模式端到端实测，重点验证真实文件夹打开、磁盘文件重命名/删除/新建和命令执行。

## 二次修复进展

| 问题ID | 修改摘要 | 状态 |
|---|---|---|
| R-1 | 移除旧默认模型初始值与 AIClient 固定模型回退；未选模型统一显示“未选择模型”；旧缓存仅保留仍在模型列表中的选择 | 已修复，已通过搜索与浏览器空态验证 |
| R-2 | 设置 Tab 原生滚动条隐藏，保留左右滚动按钮 | 已修复，浏览器验证通过 |
| R-3 | 设置面板补齐 flex/min-width/wrap 响应式规则，窄屏不横向溢出 | 已修复，浏览器验证通过 |
| R-4 | FileTree 右键菜单接入文件/文件夹/空白区域文件操作；Electron 新建文件补齐 IPC 路径 | 已修复，Web 浏览器验证通过；Electron TypeScript 构建通过 |
| R-5 | 插件页恢复 MCP/SKILL/WORKFLOW/RULES 信息展示，仅操作按钮标注“即将推出” | 已修复，浏览器验证通过 |
| R-6 | 真实 API 对话闭环 | 已完成，直接 API 与浏览器前端闭环均通过 |

## 二次修复验证记录

| 验证项 | 结果 |
|---|---|
| `npx tsc -b` | 通过，0 errors |
| `npm run build` | 通过；仅保留既有 chunk size 与 dynamic import 警告 |
| 模型硬编码搜索 | `src` 下 `gpt-4o` 精确搜索 0 条 |
| 设置页视觉 | Tab 滚动条隐藏；设置面板无横向溢出 |
| 插件页 | 16 个信息项保留，16 个按钮显示“即将推出” |
| FileTree Web 操作 | 空白处新建文件/文件夹、文件重命名/删除、文件夹新建子文件/删除均通过 |
| 直接 API 冒烟 | `/models` 返回 83 个模型；`gemini-2.0-flash` 存在；非流式对话成功，`total_tokens=235` |
| 真实 API 浏览器闭环 | 设置页真实获取 83 个模型；未自动选择固定模型；显式选择 `gemini-2.0-flash` 后发送“你好”得到流式回复 |
| 状态栏与 Token | 浏览器验证显示 `gemini-2.0-flash`、连接状态“已配置”、Token 约 `1.4k / 128.0k` |
| `npm run electron:build` | 通过，Electron TypeScript 构建成功 |

## 二次修复结论

R-1 到 R-6 均已完成。R-4 的 Web 模式文件树交互已通过浏览器实测，Electron 侧已通过 `electron:build` 验证 IPC 类型链路可编译；后续若要做磁盘级破坏性删除实测，需要在用户确认具体测试目录后执行。
