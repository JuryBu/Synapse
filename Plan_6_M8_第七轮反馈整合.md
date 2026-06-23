# Plan_6 — M8 第七轮真机反馈 + 历史未竟项整合

> M7 六轮收官后，主人第七轮真机反馈（13 点）+ 两路调研翻出的历史 Plan 未竟项，整合分模块/优先级施工。
> 工作方式：每 Stage 可并行的派 workflow/子代理；UI 改动 CDP（electron 9222）真机自验；分批 commit/push。

## 一、第七轮反馈分类（13 点）

| # | 反馈 | 归入 | 状态 |
|---|---|---|---|
| 1 | task_boundary 把开场白「我按流程来…」收进卡片 | Stage A | ✅ 已修（区间从 anchor 下一条） |
| 2 | 原生读 office/pdf 可用、效果极好 | — | ✅ 主人验收 |
| 3 | 标题变迁历史浮层太透、文字和底重合 | Stage B | ✅ 已修（0.97 不透+独立模糊+阴影） |
| 4 | MCP web-fetcher/sandbox AI 看不到、无系统引导 | Stage A | 🔧 子代理修中（事件驱动注册+引导） |
| 5 | AI 消息右下角也要操作按钮（长消息翻上去麻烦） | Stage B | ✅ 已修（底部按钮+handler 轮锚映射） |
| 6 | Enter 发送 / Ctrl+Enter 换行 设置里可切换 | Stage C | ⬜ |
| 7 | 原生沙盒 + 子代理 worktree/分支机制 | Stage E | ⬜（worktree 有、子代理自动隔离+原生沙盒缺） |
| 8 | 对话 ID 注入 + 顶部栏右键菜单 + 对话状态颜色 + 一批对话操作 | Stage C/D | ⬜（大功能） |
| 9 | 原生 browser-use（仿 Codex Chrome 插件） | Stage G | ⬜ 不急 |
| 10 | 切 Plan/Context 再切回 Chat 滚动位置丢失 | Stage B | ✅ 已修（scrollTop 记录/恢复） |
| 11 | 用户长消息可展开收叠（仿 CC） | Stage B | ✅ 已修（折叠+mask 渐隐+展开） |
| 12 | 预压缩（主人撤销，不成立） | — | ✅ 撤销 |
| 13 | 上传文件/图片冗余 → 统一加号小工具窗（附件/提及/工作流） | Stage C | ⬜ |

## 二、Stage 划分与优先级

### Stage A — 关键 bug（P0，根因已查，进行中）
- **A1 #4 MCP 工具注册竞态**：根因＝mcpBridge.refresh 只在启动跑一次、那刻 server 还 starting 被跳过、无事件订阅无重试 → 零 mcp__ 工具注册。修：MCPServerProcess status→running 时 emit → ipc webContents.send → preload onStatusChanged → mcpBridge 订阅自动 refresh + starting 兜底重试；systemPrompt 加条件式 MCP 引导。【子代理 a0a90d44 修中】
- **A2 #1 task_boundary 开场白归属**：区间从 anchor 下一条开始（startIdx=anchorIdx+1），开场白留卡片外。【✅ 已改，待双编译+CDP 验证】

### Stage B — UI bug / 小修（P1）
- B1 #3 历史浮层透明度【✅ 已修】
- B2 #10 切页滚动位置保持【✅ 已修：chatScrollTopRef 持续记录 + useLayoutEffect 切回 chat 恢复】
- B3 #5 AI 消息**右下角**操作按钮【✅ 已修：assistant 非流式渲染底部按钮；回溯/重试经 resolveRoundUserAnchor 把 AI id 映射到所在轮 user 锚，语义=重生成该轮/回到该轮前】
- B4 #11 用户长消息可展开收叠【✅ 已修：scrollHeight>200 测超高 + max-height 折叠 + mask-image 渐隐 + 展开/收起】

### Stage C — 交互/设置增强（P1）
- C1 #6 Enter/Ctrl+Enter 发送换行 设置开关（agentSettings + handleKeyDown 分支 + SettingsPanel）
- C2 #8a 当前对话 ID 注入系统提示【✅ 已修：systemPrompt 加 conversation_meta 段 + agentLoop 传 conversationId，草稿态标注未持久化；对话内 ID 恒定不破坏 prompt cache】
- C3 #13 上传入口统一：加号点击 → 小工具窗（上传附件 / 提及@ / 选择工作流），替代现冗余的上传文件+上传图片两按钮

### Stage D — 对话管理大功能（P2，#8 核心）
- D1 **对话状态颜色系统**：未查看完=绿 / 生成中=蓝 / 出错=红 / retry等异常未失败=黄；**闪烁**（非常驻，避免主题色撞色）。需 conversation slice 加 status 字段 + 左栏/顶部栏渲染状态点。
- D2 顶部对话栏（图九）**右键菜单**（参考 Codex 图十一）：把左栏对话操作搬到顶部栏右键
- D3 对话操作补全（左栏+顶部栏右键共用）：置顶 / 标记未读 / 标记未完成 / 复制会话ID / 复制工作目录 / 在新窗口打开 / fork对话（重命名已有）

### Stage E — worktree / 子代理隔离深化（P2，#7 + 历史未竟）
- E1 子代理并行**自动 worktree 隔离**（框架 byContext 已支持，加 spawnSubagent 自动 enter/exit 策略 + 审批）
- E2 worktree 退出/合并语义（diff 呈现给用户/AI、是否合回主分支）
- E3 **原生执行沙盒**（run_command 加超时/资源隔离）—— 评估：现裸跑主机无隔离，是明确空白；或继续靠 MCP sandbox

### Stage F — 工具占位补全（P2，历史未竟）
- search_web 接真 API（Serper/Tavily，需主人 key）/ read_url_content 修 / generate_summary 真解析 / memory_delete 工具
- ⚠️ 注意：现在有了 web-fetcher MCP（web_fetch_page 等），search_web/read_url_content 可考虑改为转发 MCP 而非自接 API

### Stage G — 不急 / 二期（P3）
- #9 原生 browser-use（仿 Codex 浏览器 Chrome 插件，参考 Codex 对话 019ef1f7-e978-7d11-b0b9-6f8a776404d9，插件透明可看）
- 性能降级项：#158 按消息缓存 token / 1-C 订阅隔离 / 定时器收敛
- xlsx@0.18.5 CVE（换 exceljs / 忽略，待拍板）
- MCP 路径硬编码（分发前必改）/ MCP 30s 超时（按需放宽）

### 真机验收欠账（单列，非开发）
- M6 12 项（IME/各类@/粘贴截图/Ctrl+Enter/D1往返/refCount）、M5-BPC 8 项、M7 待测（office-pdf端到端/MCP调用/中止后输入）

## 三、待主人拍板
- Stage D（对话状态系统）+ Stage E（worktree/沙盒深化）是大功能，确认要做的范围
- Stage F：search_web 自接 API 还是转发 web-fetcher MCP
- xlsx CVE：换库 / 忽略
- browser-use（Stage G）何时启动

## 四、当前进展（实时）
- ✅ Stage A：A1 #4 MCP 事件驱动注册（待重启 CDP 验证 AI 能看到 mcp__*）、A2 #1 开场白归属
- ✅ Stage B：B1 #3 浮层、B2 #10 切页滚动、B3 #5 AI 消息底部按钮、B4 #11 长消息折叠（双编译 EXIT 0）
- ✅ Stage C：C2 #8a 对话 ID 注入（双编译 EXIT 0）
- ⬜ Stage C：C1 #6 Enter/Ctrl+Enter 开关、C3 #13 上传统一加号小窗
- ⬜ Stage D/E/F/G：待主人拍板范围
- 🔬 下一步：重启 dev server（带 CDP 9222）真机验证 A1 MCP + B2/B3/B4 + C2
