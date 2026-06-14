---
trigger: always_on
---

# Synapse 项目工作规范

## Stage 执行规范
- 每个 Stage 开始前必须 `stage_guard(action="start", taskFiles=["Task.md"], planFiles=[相关Plan文件])`
- 每个 Stage 完成后必须 `stage_guard(action="check")` 且通过后才能标记完成
- **每个 Stage 必须独立 start/check**，不要跨多个 Stage 再一起 check（上下文压缩会导致 Flash 看不到早期代码块，误判为虚标）
- Guard 连续 3 次不通过时记录到 Task.md 底部「小本本」区域，不中断工作，自行解决或和 Codex 协商
- Guard 误判（如上下文压缩导致）时，cancel 后直接继续推进，不必等用户裁定
- 仅方向性/整体性设计问题才通知用户，其他问题自行 Multi-Agent 协作解决

## 每个 Stage 开始时必做
1. 重温 Task.md 当前 Stage 的详细任务项
2. 读取对应的 Plan_1_xxx.md 中的原始设计
3. 检查 Plan_2_代码审计.md 是否有该 Stage 相关的 P0/P1 问题
4. 确认上一个 Stage 的 Guard 已通过

## Codex 协作规范
- 每 2-3 个 Stage 启动一次 Codex 独立 Review
- 使用 GPT-5.5 模型，尝试开启 fast speed tier
- 启动时必须提供：项目背景、当前 Stage 上下文、要审查的内容、输出位置
- 输出位置统一为 `synapse-app/报告_StageX_Review_Codex.md`
- 如果 Codex 输出位置错误，审阅后移动到正确位置

## 代码编写规范
- 不偷懒，不用"差不多了"搪塞，每个功能必须完整实现
- 设计疑问时主动咨询 Codex 和 Guard 综合意见
- 追求最充分的设计，而非最小可用
- TypeScript 严格类型，避免 any
- 组件解耦，服务分层

## 测试验收规范
- 每个 Stage 必须设计丰富的测试标准
- 需要前后端联合验证时，必须真实启动 dev server
- 使用 MCP web-fetcher 截图/交互验证 UI
- 使用浏览器子代理做探索性测试
- Web 模式：`npm run dev` 后通过 localhost 验证
- Electron 模式：`npm run electron:dev` 验证

## 输出规范
- IDE 单次输出有长度限制，必须分段增量输出
- 大文件用多次 replace_file_content 增量写入
- write_to_file 一次不超过 150 行

## Task.md 维护
- 实施过程中实时更新 Task.md 进度标记
- 发现新问题时追加到对应 Stage 或「小本本」区域
- 不中断告知用户，除非不得不请示的方向问题