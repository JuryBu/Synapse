# Plan_4.md — Synapse Harness 升级（吸取成熟 agent harness 机制）

> 本轮总纲。承接 Plan_1 框架 + Codex Plan_3 / Stage 0-17 实装（真机验证整体可用）。
> 目标：吸取成熟 CC/Codex 式 agent harness 机制，补齐**对话上下文管理**与**消息状态能力**，重做 Multi-AI。
> ⚠️ **UI 壳子（VS Code 式布局：左课件树 / 中编辑器 / 右 AI 面板）保持不变**，不做布局重构。
> （用户那张 CC 式 UI 截图是**另一个项目**的，本轮只吸取其机制，不照搬 UI。）

## 一、范围

### 要做
1. **上下文 harness**：conversation-record-memory 三层压缩（核心重头）
2. **消息/对话状态能力**：worktree（对话分支 + 真 git worktree 都要）、回溯到某条消息、复制、附件、选模式、沙盒、选模型、选思考层级、API/KEY 填好后自动探测模型与参数
3. **Multi-AI 推倒重做**为 CC 式真子代理体系（现有 agentOrchestrator 不行）
4. **配置接入**：OfficeViewer 接本机 LibreOffice、默认 API 接本地端点
5. **真机 bug 修复**：终端中文乱码等

### 不做
- 打包 / 导出 / NSIS（只需 `启动Synapse.bat` 能本地启动即可）
- UI 布局重构（保持现状）

## 二、模块设计（方向，细节在 loop 探索后细化）

### M1 上下文 harness（核心）
- **conversation 原文**：完整本地存储（jsonl / db 均可），UI **永远显示完整对话**
- **record**：结构化过程日志（仿 CC/Codex record 机制）
- **memory**：模型主动记忆，**原生内置 `memory_store` 工具**（不像现在外置 MCP），参考实现 `C:\Users\Stardust\.gemini\antigravity\mcp-memory-store`
- **实际喂给 API 的 = 最近 N 条消息 + 之前的 record 内容 + system prompt**（为 hit cache，成熟压缩方式）
- 上下文达模型上限 **90% 触发压缩**；UI 标出压缩点，但展示的对话仍完整（本地完整文件支撑）
- `run_command` 等基础工具配套做好

### M2 消息 / 对话状态
- **worktree-A 对话/状态分支**：从某条消息分叉出独立副本（对话 + 文件状态一起快照/复制），类似 CC checkpoint / 对话分支
- **worktree-B 真 git worktree**：Synapse 管理代码项目时，给 agent 任务开独立 git 工作树隔离
- **回溯到某条消息**（回溯对话 + 文件状态；现有 Stage 3 已有基础，增强）
- 复制消息 / 对话
- 附件上传、选模式、沙盒、选模型、选思考层级（核对现状后增强）
- 模型在 API/KEY 填好后**自动探测**，参数也是

### M3 Multi-AI 真子代理
- 评估并推翻现有 `src/services/agentOrchestrator.ts`
- 做成 CC 式真子代理：spawn / 独立上下文 / 结果回插 / 进度可视化

### M4 配置接入
- OfficeViewer 的 `spawn soffice` 接 `C:\Program Files\LibreOffice`
- 默认 API：`http://localhost:54861/v1`（本地 GPT，key 见 memory-store 记忆 / 运行时配置，**不进 git**）

### M5 真机 bug 修复
- 终端中文乱码：`electron/ipc/command.ts` spawn shell 加 `chcp 65001` 或 stdout 按 GBK 解码（`help` 退出码异常一并查）
- 模型选择器弹层补 click-outside 关闭
- 窗口状态 IPC 直调与 UI 不同步：renderer 订阅主进程 maximize/unmaximize 事件

## 三、推进优先级
1. **M4 + M5**（配置接入 + bug，快、确定性高、打底）
2. **M1 上下文 harness**（核心）
3. **M2 消息状态能力**
4. **M3 Multi-AI**

详见 `Task_4.md` 执行清单与 loop 工作约定。
