# Plan_8.md — M8 真机 P0 修复 + 并发治本 总纲

## 项目概述
消化 M8 真机第三批 13 点反馈（详见 `../../M8_真机交接/Task_第三批反馈.md`）+ 第二批 A/B/C/D。先清 P0 对话 bug（拔萝卜带出泥那批），再清中小渲染/diff bug，最后做最大的 byId 真并发隔离治本 + 对话状态色 + 右键菜单。整个体系为后续「子代理 browser use（仿 Codex）Stage G」预留扩展性。

工程：`../../synapse-app/`（Electron + React19 + Redux Toolkit），分支 main。
双编译：`cd synapse-app && node node_modules/typescript/bin/tsc -b`(renderer R=0) + `node node_modules/typescript/bin/tsc -p tsconfig.electron.json`(electron E=0)，**勿 vite build(OOM)**。
CDP 真机验证：dev(5173)+electron --remote-debugging-port=9222 → web-fetcher desktop_connect_cdp → register_window → web_interact evaluate；store=`window.__SYNAPSE_STORE__.getState()`；loop 埋点=`window.__SYNAPSE_AGENTLOOPS__.size`。AI 端点本地代理 127.0.0.1:54861 须开。⚠️ CDP 测试坑见 memory-store「Synapse CDP测试坑 autoApprove HMR假象」+ 本对话。

## 阶段划分与进度（2026-06-24 过夜批）

### ✅ 已完成 + CDP 真机验证 + push（本批 6 组）
| Stage | 内容 | commit | 验证 |
|---|---|---|---|
| P0-A | #5 双流 / #12 中止卡 — 全局 runningAgentLoops 登记表 + handleStop 停全部 + 摘 settings.safety 出 loop 工厂 | 648bcd2 | CDP：mid-run改设置无幽灵loop(30采样恒1)/UI插入不双流(20采样恒1+进插队队列)/点中止干净归0不卡 |
| 文件树 | 深层目录空 — maxDepth 硬编码3→默认8 + 设置项可调 | f22be9e | CDP直连IPC：maxDepth=8树深8/229目录(vs 3的122) |
| #7 | MarkdownViewer 预览渲染 Mermaid — 补 ReactMarkdown code 映射 | 8c5f275 | CDP DOM：1 MermaidDiagram/5 svg + 标准表格<table>带边框粗体；表格图七是源数据非渲染bug |
| #1 | review changes @@ -a,b +c,d @@ 翻人话(formatRangeHeader) | 3cea65e | 编译(视觉随#2/#6测时确认) |
| #4 | 打开文件AI改后实时同步 — 写盘后刷新已打开tab(openTabSync) | 6bf1e77 | CDP：AI write→tab.content自动刷新成新内容不重开 |
| #6/#10 | 同文件多次改合并成一条累积diff — 杜绝冗余堆叠+根治接受失败卡死 | e4e9085 | CDP：AI连写2次pendingDiff恒1条/点√accepted零「接受失败」错误 |

### 🔨 待执行（设计已固化，留新上下文/主人盯时做）
| Stage | 内容 | 细化文档 | 备注 |
|---|---|---|---|
| **byId 治本** | #8 串线 + #9 卡UI → byId 真并发隔离（A后台继续写A切回看到） | `Plan_8_byId真并发治本.md` | **最大重构(17+文件6步)**，过夜上下文已满未硬上(防botch)，待新上下文照设计执行+8步CDP双对话验证 |
| **#2 inline diff** | 文件本体红绿+√×(仿反重力)，废做偏的SingleDiffView | `Plan_8_inline_diff_#2.md` | CodeEditor按行渲染改造风险高，建议只读装饰层或主人盯时做；必Read图四/二/三核对 |
| **A 状态色** | 对话四态闪烁色点(蓝生成/绿完成未读/红错/黄其它异常) | 见 byId 文档七节 | 依赖 byId（非当前对话生成态判别）|
| **D 右键菜单** | 顶部对话栏+列表右键菜单(仿Codex) | `../../M8_真机交接/Task_第二批反馈.md` D | 部分功能(深链/新窗口/新工作树)需先补底座 |
| 文件树懒加载 | maxDepth治标已做，懒加载(展开按需listDir)是治本增强 | — | file:list IPC已就绪无调用点；超深/超大目录不卡 |
| browser use Stage G | 子代理仿Codex browser-use | `../Plan_6/`Stage G | 二期；调研结论待补(Codex对话019ef1f7) |

### ⏳ 待主人统一真机验收
- 本批 6 组虽都 CDP 单点验过，建议主人重启 app 走一遍完整流程复验（尤其 #5/#12 插入/中止、#6/#10 多写接受）。

## 待复核/小本本
- [ ] 文件树 maxDepth=8 兜底 + 设置项，懒加载治本待做。
- [ ] #6/#10 合并对【已存在多条同path旧pending diff】只合并进第一条（findIndex），遗留旧的不清；新场景(从0)正常。pre-existing堆叠靠用户全部拒绝清。byId步2要把合并迁进桶。
- [ ] autoApprove 同步在生产靠 AgentPanel mount 时 settings.safety effect；若主人反馈「设了autoApprove仍弹框」，考虑把 updateAutoApprove 加回 loop 工厂(读closure不入deps)增强韧性。
- [ ] M8_真机交接/ 里 3 处 `../Plan_7_M8...md` 链接在迁移后失效(Plan_7已移plans/Plan_7/)，待修(迁移子代理按指示没碰M8)。
- [ ] 后台桶内存保留策略（byId 步3 风险3）。
