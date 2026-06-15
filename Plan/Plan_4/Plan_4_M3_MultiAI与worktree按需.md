# Plan_4_M3 — Multi-AI 重做 + M2-5 worktree 按需方案（2026-06-16 用户拍板）

> 现有基础（重做/升级，非从零）：`src/store/slices/multiAI.ts` + `src/services/agentOrchestrator.ts` + SettingsPanel 的 Multi-AI 设置区。

## 一、M2-5 worktree 改「按需」（推翻原「对话级强绑定」）

### 决策
- 教学场景小修小改为主，**不默认**给对话/agent 绑 worktree（原「对话级自动绑定 + fs 工具默认重定向」是过度设计，废弃）。
- **主/单 agent 默认在主工作区**；只有 agent（自己判断）或用户（明确要求）认为需要隔离时，agent 才**按需进入** worktree 在分支里改。
- **多子代理并行改文件**时例外：子代理**默认各自绑 worktree**（不然并行写同一文件必冲突），主模型可用字段关闭。这与「按需」不冲突——单 agent 按需、并行子代理默认隔离。

### 实现调整（比原方案更小）
- **保留** M2-4 worktree 管理（ipc 增删查 + 状态 + 归属校验 + SettingsPanel）——基础设施。
- 给 agent 工具集**新增 worktree 工具**（如 `enter_worktree`/`exit_worktree` 或 `use_worktree`）：agent 主动调用进入/退出；用户也能说「在 worktree 里改」让 agent 调。
- fs(`write_to_file`)/`run_command` 等工具**默认根路径=主工作区**；仅当当前对话/agent 处于「worktree 模式」时重定向到该 worktree 目录。
- 会话状态：标记「当前对话/agent 是否正处于某 worktree」+ 退出/合并接口。
- 退出语义（待实现时定）：改完留 worktree 给用户看 diff / 合并回主分支 / 由 agent 决策。

## 二、M3 Multi-AI 执行架构（三层）

1. **执行引擎层 = agentLoop 实例**：每个子代理 = 一个独立 AgentLoop 实例（自己的消息流 / 工具集 / 模型 / maxDepth）。**子代理对话复用 conversations 表**（带 `parent`=主对话 id + `isSubAgent` 标记，复用 M2-3 对话 tree/parentId 基础）。
2. **触发/编排层（两个入口，都落到 agentLoop 实例执行）**：
   - **`spawn_subagent` 工具**（动态）：主 AI 运行时自主调用派子代理，填 `{prompt, model?, maxDepth?, worktree?}`。
   - **固定工作流**（模板编排）：用户 `@MultiAI：<模板名>` 触发，workflow 运行器按模板节点（串行/并行/判断）起多个 agentLoop 实例。
3. **可视化层 = 卡片**：不论哪种触发，跑起来的子代理都在对话流卡片显示，点进中间视图看详情。

## 三、固定工作流（设置内可编辑模板）

- 设置区 UI 已有（multiAI 设置），编辑形态无需大规模重设计。
- **模板 = 保留命名的固定工作流**：用户编排好（如「找茬模式」= 1 推进子代理 + 3 找茬独立子代理(并行) + 1 修复子代理），保留模板+命名。
- **触发**：对话里 `@MultiAI：找茬模式` → AI 识别并按该模板运行。
- **节点能力**：每个节点 = 一个子代理任务（prompt + 模型 + 工具 + maxDepth + worktree 字段）；支持**串行 / 并行 / 条件分支**。
- **条件分支 = 判断节点**：需手动设置清晰语义；判断节点可要求**中止固定工作流并立即反馈「无法推进」**（而非硬塞下一步）。
- worktree 在并行节点（多子代理并行改文件）处用得上（各自绑定隔离）。

## 四、子代理规则

- **模型**：默认复用主对话模型，可单独配。
- **派发深度 maxDepth（递归层数控制）**：主模型派发子代理时可填正整数字段——
  - 不填 → auto default = **不允许子代理再派**（深度 1）。
  - 填 N → 允许 N 层（填 2 = 子代理可产孙代理、孙代理不能再派；填 1 = 不允许子代理派发）。
- **worktree 字段**：主模型派发时可填——**默认子代理各自绑定** worktree（并行隔离）；各自绑定时主模型最后需决策 worktree 情况（合并/取舍）。
- **工具集**：子代理除「是否能继续派发 subagent」受 maxDepth 限制外，其它工具不受限。

## 五、卡片可视化（中间视图）

- 子代理/工作流在**对话流里显示为可点击卡片**（不像 CC 在右侧栏——我们是 VS Code 布局、右侧本就是对话区）。
- **点击卡片 → 中间编辑器区开一个视图**（像打开文件 tab）：左列子代理列表、**点进每一个子代理能看其完整对话流/进度**（UI 量级比 CC 右栏卡片更详细，要能真进子代理对话）。
- **四色状态**：灰=完成、蓝=进行中、黄=retry/重连阻塞、红=failed，清晰可见。
- **实时更新**：运行时颜色 + token 统计 + 计时都实时刷新。

## 六、待实现时再定的细节
- worktree 退出/合并语义（留 diff / 合并 / agent 决策）。
- 条件分支是否一期就做（可先串+并行，判断节点二期）——但用户已明确要判断节点，倾向一期含。
- workflow 运行器：自研轻量编排器（参考 CC workflow 的 phase/parallel/pipeline 语义），跑在 Synapse 内。
- 卡片中间视图与现有 VS Code 式编辑器区如何共存（新 tab 类型）。

## 七、分 stage（待用户到校确认后开推）
- **M2-5**（worktree 按需）：worktree 工具 + 条件根路径重定向 + 会话状态。先做，给 M3 并行子代理隔离打底。
- **M3-1**：执行引擎 = agentLoop 递归实例 + spawn_subagent 工具 + 子代理对话存 conversations(parent+isSubAgent)。
- **M3-2**：workflow 运行器（串/并/判断节点）+ 固定工作流模板存储/编辑/`@`触发。
- **M3-3**：卡片可视化（对话流卡片 + 中间子代理视图 + 四色 + 实时）。
