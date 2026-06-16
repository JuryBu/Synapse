# Plan_5 M4-4 — 文件查看器：图片协议根治 / 代码只读高亮 / Office 走 LibreOffice 版式预览

> 子代理（opus）深度探索现有代码后的设计（2026-06-16）。本里程碑全部为只读核对 + 设计产出，实现阶段不触产品代码以外的架构。三条子线相互独立、可分别落地与回归。
>
> 标题：**文件查看器：图片协议根治 / 代码只读高亮 / Office 走 LibreOffice 版式预览**

---

## ① 目标

让编辑器三类文件查看器达到「真版式 / 真渲染」水准：

1. **图片**：在 Electron 下正常显示，消除「黑屏只剩文件名」的现象。
2. **只读代码**：带语法高亮（复用现有 `detectLanguage` 产出的 lang），可编辑路径的 `textarea` 完全不动。
3. **PPTX / DOCX**：不再走 jszip/mammoth 文本抽取，而是经**已就绪**的 LibreOffice headless → PDF 链路，走 `OfficeViewer` → `PdfViewer` 真版式只读预览，保留冷启动 loading 与 60s 超时。

落地难度从低到高：**②（纯前端装库）→ ③（两行改归类）→ ①（主进程加协议）**。三条无相互依赖，可并行设计、分 stage 验收。

---

## ② 覆盖问题（对应用户问题编号）

| 编号 | 问题 | 性质 |
|---|---|---|
| 问题3① | 编辑器打开图片黑屏只剩文件名 | high bug |
| 问题3② | 只读代码无语法高亮 | 主人倾向 |
| 问题3③ | PPTX/DOCX 走文本提取而非 LibreOffice 版式预览 | 主人决策（headless PDF） |

---

## ③ 确认现状 / 真根因（currentStateVerified）

逐条核实 brief 诊断，结论如下。

### 问题3① 图片黑屏 — brief 准确

- **触发点**：`EditorArea.tsx:81` `src={fileSystem.getFileUrl(activeTab.filePath) || activeTab.filePath}`。
- **根因链**：
  - `fileSystem.ts:551-553` `getFileUrl` 只 `return this.memoryFileUrls.get(filePath)`。
  - 该 map 仅在 **Web 模式** `uploadFile`（`fileSystem.ts:576-578` `URL.createObjectURL`）时写入；**Electron 恒空** → fallback 到裸 Windows 绝对路径 → 渲染 `<img src="C:\...\x.png">`。
  - `main.ts:29-34` webPreferences 未设 `webSecurity`（默认 `true`），dev 走 `mainWindow.loadURL('http://localhost:5173')`（`main.ts:41`）；**http(s) 源下浏览器无法加载本地 `file` 资源**。
  - `index.html` 无 CSP meta（Grep 无命中），故**拦截源是 webSecurity + 协议来源，非 CSP**。
- **对照（不要被误导）**：对话内附件能显示是**另一套**——走 base64 data URL，与 editor 这条路无关。
- **唯一可仿照的范本**：全项目自定义协议仅 wallpaper 一处（`wallpaper.ts:31-58`）：顶层 `registerSchemesAsPrivileged({scheme:'synapse-wallpaper', standard:true, secure:true})` + `app.whenReady` 内 `registerWallpaperProtocol()` → `registerFileProtocol` 带路径白名单 `callback({path})`。结构正确、可复用。

### 问题3② 只读无高亮 — brief 准确

- **只读分支**：`CodeEditor.tsx:69-72` 为裸 `<pre className="code-editor-pre"><code>{value}</code></pre>`。
- **可编辑分支**：`CodeEditor.tsx:74-98` 为 `textarea`，含 Ctrl+S / Tab 处理。
- **lang 已现成**：`detectLanguage`（`CodeEditor.tsx:105-114`）已产出 prism/shiki 通用 lang 串（`typescript` / `python` / ...）。
- **依赖状态**：`package.json` 依赖中**无** `react-syntax-highlighter`、**无** `shiki`；`package-lock.json` 中二者均无命中（确认未安装，需新增直接依赖）。
- **注意**：`jszip` / `dompurify` / `pdfjs-dist` 在 lock 里只是**传递依赖**（由 mammoth/pptxgenjs/react-pdf 带入），未在 `package.json` dependencies 直接声明。

### 问题3③ Office — brief 需纠正一处（链路其实已完整）

brief 说「链路已就绪」偏保守：实际 LibreOffice → PDF **已完整实现且已接好**，不是半成品。

- `electron/ipc/file.ts:23-98`：`findLibreOffice`（候选含 `C:\Program Files\LibreOffice\program\soffice.exe` 等）、`convertOfficeToPdf`（`spawn --headless --convert-to pdf`，`:66-69` 内置 **60s `setTimeout` kill** 超时）、`file:convertOffice`（`:145-157`，`OFFICE_EXTENSIONS` 含 `.pptx`/`.docx`）、`file:cleanupTemp`（`:159-172` 限 `synapse-office-` 前缀）。
- `fileSystem.ts:370-386`：`convertOfficeToPdf` / `cleanupTempPath` 前端封装齐全。
- `components/editor/OfficeViewer.tsx`：已实现「转 PDF → readBinary → `<PdfViewer>`」，有 loading 态（`:42-50`）+ error 态。
- `EditorArea.tsx:211-217`：已有 `case 'office'` → `<OfficeViewer>`。

**真正「绕开」点只在两行**：`services/editorFileTypes.ts:12-13`

```
if (ext === 'pptx') return 'pptx';
if (ext === 'docx') return 'docx';
```

把 pptx/docx 特判成独立类型，命中 `EditorArea` `case 'pptx'`（`:203` PptxViewer/jszip 抽文本）、`case 'docx'`（`:70` DocxViewer/mammoth）。故 ③ 是**两行改归类的小修**，不是新建链路。

### tab type 入口链路 — 已查清

`resolveEditorType` 调用方仅两处：

- `AppLayout.tsx:145`（QuickOpen）
- `Sidebar.tsx:127`（文件树点击）

均 `dispatch(openTab({type: resolveEditorType(...)}))`。改 `editorFileTypes` 把 pptx/docx 归 `'office'` 后，这两入口**自动**走 office 路径，**无需改它们**。

### 不可误删项 — 关键约束

- `PptxViewer` / `DocxViewer` 组件**不能删**：
  - `SynopsisPanel.tsx:16` `SUPPORTED_EXTENSIONS` 含 pptx/docx。
  - `synopsisEngine.ts:22/199` 仍以 `'pptx'` 类型做课件大纲文本抽取。
  - 那是独立的「知识概要」功能，与 editor 查看器**两套体系**，不依赖这两个 React 组件，但说明 pptx/docx 概念在别处仍活跃。
- `EditorArea` 的 `case 'pptx'` / `case 'docx'` 改归类后变为**死分支**，可保留（防御）或删除（需同步 `editorTabs.ts:9` 联合类型），建议**保留分支 + 加注释**，联合类型不动以免牵连面。

### dev / prod 双源

- dev = `http://localhost:5173`（`loadURL`），prod = `loadFile(dist/index.html，file://` 源）。
- 自定义 standard + secure 协议在两种源下都能被 `img.src` / pdf.js url 加载（wallpaper 已在 dev 验证可用），故新协议方案对 **dev/prod 均成立**。

---

## ④ 详细设计（design，已按主人决策修正）

> 主人决策相关项：图片协议=注册 `synapse-file://`（`registerFileProtocol` 同 wallpaper 风格），video/PDF 顺手一起修；代码高亮=`react-syntax-highlighter` 只读路（编辑 textarea 不动），大文件 > 2000 行降级裸 pre；图片协议安全采放宽 + 扩展名白名单。下文已据此把 openQuestions 的「倾向」固化为默认。

总体策略：三条子线相互独立、可分别落地与回归，风险从低到高排序为 **②（纯前端装库）→ ③（两行改类型）→ ①（主进程加协议）**。

### 子线 A：图片黑屏根治（自定义 `synapse-file://` 协议，仿 wallpaper）

推荐方案：新增 `electron/ipc/fileProtocol.ts`，对称 `wallpaper.ts` 的两段式结构。

1. **顶层注册 scheme**：`protocol.registerSchemesAsPrivileged([{scheme:'synapse-file', privileges:{standard:true, secure:true, supportFetchAPI:true, corsEnabled:false, stream:true}}])`。`supportFetchAPI` / `stream` 置 `true` 以便 pdf.js 等可 fetch（图片用 `img.src` 走 standard 即可，但开 fetch 无害且利于后续 video/PDF 复用）。
2. **导出 `registerFileProtocol()`**：
   - **API 选型（已决，见 ⑦）**：与 wallpaper 一致的 `registerFileProtocol` `callback({path})` 旧 API，降低认知差。（Electron 41 推荐的 `protocol.handle`（Response/net.fetch）是官方未来方向，本里程碑不采用以保持范本一致。）
   - **URL 形态约定**：`synapse-file://local/<URL编码的绝对路径>`（或 `synapse-file:///<盘符路径>`）。
   - **解析流程**：`decodeURIComponent` → `path.normalize` → 安全校验 → `callback({path: resolved})` 或 `callback({error: -6})`。
3. **安全校验（关键）**：
   - 默认实现「**规范化 + 存在性 + 是文件 + 扩展名白名单**（图片 / 常见可视类型）」。
   - **是否再叠加「必须落在当前工作区根下」=（已决，见 ⑦）放宽到任意本地存在文件，不做根约束**。理由：工作区根在主进程不易拿到（当前主进程无全局 `currentWorkspace` 状态），若要做根约束需新增机制；放宽口径与 `file:read`/`readBinary` 现有口径（`file.ts:resolveFilePath` 已接受任意绝对路径）**保持一致**，安全基线不低于现状。
   - **防穿越**：必须 `decodeURIComponent` 后再 `path.normalize`，再做校验，防 `..\` 与**二次 URL 编码**绕过；盘符大小写归一。
4. **`main.ts` 接线**：`import registerFileProtocol`，在 `app.whenReady().then` 内（`registerWallpaperProtocol` 之后、`createWindow` 之前同一处）调用 `registerFileProtocol()`。scheme 注册靠模块 `import` 触发顶层副作用（同 wallpaper：`main.ts:13` import 即注册 scheme）。
5. **前端取 url**：在 `fileSystem.ts` **新增 `getDisplayUrl(filePath)`**（不改 `getFileUrl` 语义）：
   - Electron 模式 → `synapse-file://local/${encodeURIComponent(absPath)}`。
   - Web 模式 → 仍返回 `memoryFileUrls`（object url）。
   - 兜底 → 优雅占位，**去掉裸路径 fallback**。
   - `EditorArea.tsx:79-83` image case 改为 `src={fileSystem.getDisplayUrl(activeTab.filePath)}`。
   - **为何新增而非改 `getFileUrl`**：`getFileUrl` 调用方在 `EditorArea.tsx:81`、`:259` PdfFileViewer；PdfFileViewer 走的是 `objectUrl || readBinary` 二段式，Web object url 仍需保留，故 `getFileUrl` 不动，新增 `getDisplayUrl` 只服务 image（与后续 video/PDF 复用时同口径扩展）。
6. **preload 无需改**：协议是渲染进程直接 url 访问，不走 IPC。

**备选方案**（若不想加主进程协议）：新增 IPC `file:readDataUrl(filePath)`，主进程读文件转 base64 data URL 返回，前端 `img.src=dataUrl`。优点零协议、最简；缺点大图内存翻 1.33 倍且占 IPC 带宽。鉴于查看器图片通常不大且只读，此备选可作为 fallback，但**首选协议方案**（与 wallpaper 一致、零拷贝、支持 pdf.js 复用）。

**video / PDF 顺手修（主人已决纳入）**：`MediaPlayer src=` 裸 filePath（`EditorArea:89`）在 Electron 下有同样黑屏隐患，PdfFileViewer 亦同源问题。本里程碑按主人决策**顺手一起修**——video / PDF 复用 `synapse-file://` 协议（`getDisplayUrl` 扩展支持对应扩展名白名单：常见视频格式 + pdf），与图片同一套协议路径，避免遗留同类 bug。具体接入放在 S3 一并完成（见 ⑤ S3 增量说明）。

### 子线 B：只读代码语法高亮

1. **选型（已决，见 ⑦）**：`react-syntax-highlighter`（Prism 内核，与 `detectLanguage` 现有 lang 串天然对齐，按需 `PrismAsyncLight` 动态注册语言，体积可控）。
   - 不选 shiki：渲染更精细但需 wasm / 异步主题加载，集成更重。
   - 新增直接依赖：`react-syntax-highlighter` + `@types/react-syntax-highlighter`。
   - 与 MarkdownViewer 代码块风格统一为后续事项（需另查 MarkdownViewer 现状，本里程碑不强绑）。
2. **`CodeEditor.tsx` 只读分支（69-72）替换**：lang 已由 `detectLanguage(filename)` 得到（`:47`），把裸 pre/code 换成：

   ```
   <SyntaxHighlighter
     language={mapToPrismLang(lang)}
     style={暗色主题}
     customStyle={背景透明 / 沿用 .code-editor-pre 容器}
     wrapLongLines={false}>
   ```

   需一个 **lang 映射表 `mapToPrismLang`**：`detectLanguage` 产 `'typescript'` / `'python'` / `'c++'` 等，Prism 语言名多数一致但 `'c++'`→`'cpp'`、`'text'`→纯文本（无高亮降级）。**可编辑分支（74-98 textarea）完全不动。**
3. **主题与暗黑模式**：项目是暗色背景（`#0a0a0f`），选 `oneDark` / `vscDarkPlus` 之类；用 `PrismAsyncLight` 仅注册 `langMap` 覆盖的语言，避免全量 bundle。容器沿用现有 `.code-editor-content` / `.code-editor-pre` CSS，必要时微调（长行不换行 + 横向滚动条，符合全局「宽内容横向滚动」决策）。
4. **性能护栏（阈值已决，见 ⑦）**：超大文件高亮会卡。**> 2000 行降级为裸 `pre`**（保留现状），避免高亮组件冻结 UI。

### 子线 C：Office 归类到 LibreOffice 链路

1. **`editorFileTypes.ts`**：删 `:12-13` 两行 pptx/docx 特判，并在 `OFFICE_EXTENSIONS`（`:5`）集合补 `'pptx'`,`'docx'`（当前集合无 pptx/docx）。改后 `resolveEditorType('pptx'|'docx')` → 命中 `:14` `OFFICE_EXTENSIONS` → 返回 `'office'`。
2. **`EditorArea.tsx`**：`case 'office'`（`:211`）已正确接 `OfficeViewer`，无需改。`case 'pptx'`（`:203`）/ `case 'docx'`（`:70`）变死分支：**保留并加注释**「pptx/docx 现归 office 路径，本分支保留作显式 `openTab(type:'pptx')` 的兼容兜底」。联合类型（`editorTabs.ts:9`）不动（`synopsisEngine` 用 `'pptx'` 是另一套类型，editorTabs 的联合类型仅 editor 用，删除不影响 synopsis；为降风险首选「保留分支 + 注释」）。
3. **`OfficeViewer`**：已含 loading（转换首启数秒）/ error / 60s 超时（IPC 侧 timer），无需新增；可顺手核对 loading 文案是否提示「首次转换较慢」。冷启动 LibreOffice 首次可能 > 数秒，60s 超时足够。
4. **回归点**：pptx/docx 打开后应渲染真实版式 PDF（而非文本大纲/HTML）。`PptxViewer` / `DocxViewer` 组件因不再被 editor 命中而「闲置」，但 synopsis 仍可能间接需要——**故不删组件文件**。

### 落地顺序建议

先 **B**（纯前端、零主进程风险、立即可视）→ 再 **C**（两行 + 注释，零依赖）→ 最后 **A**（主进程协议，需 `electron:build` + 真机验证 dev/prod 双源加载）。三者无相互依赖，可并行设计、分 stage 验收。

---

## ⑤ Stage 拆分

> 完整搬运里程碑全部 4 个 stage，逐个列：编号 / 做什么 / 改动文件 / 验收 / 工作量。

### M4-4-S1（子线 B：只读代码语法高亮）— small

- **做什么**：装 `react-syntax-highlighter`，`CodeEditor` 只读分支换高亮组件，复用 `detectLanguage` 的 lang 加 Prism 映射（`c++`→`cpp` 等）；可编辑 `textarea` 不动；加 **> 2000 行降级裸 pre** 阈值；暗色主题对齐 `#0a0a0f`。可编辑路径与现状逐字节一致。
- **改动文件**：
  - `synapse-app/package.json`
  - `synapse-app/src/components/editor/CodeEditor.tsx`
- **验收**：`npm run build` 通过；打开 `.ts`/`.py`/`.json`/`.cpp` 只读代码有正确语法高亮且暗色协调，长行横向滚动；可编辑文件（`CodeFileViewer readOnly=false`）仍为 `textarea`，Ctrl+S / Tab 行为不变；超阈值大文件降级为裸 `pre` 不卡顿。
- **工作量**：small

### M4-4-S2（子线 C：Office 归类到 LibreOffice 链路）— small

- **做什么**：`editorFileTypes.ts` 删 `:12-13` pptx/docx 特判、把 `'pptx'`/`'docx'` 并入 `OFFICE_EXTENSIONS`，使其归 `'office'`；`EditorArea` `case 'pptx'`/`'docx'` 加保留注释（死分支兜底）；联合类型与 synopsis 相关代码不动。
- **改动文件**：
  - `synapse-app/src/services/editorFileTypes.ts`
  - `synapse-app/src/components/layout/EditorArea.tsx`
- **验收**：`npm run build` 通过；从课件栏 / QuickOpen 打开 `.pptx`/`.docx` → 走 `OfficeViewer`，显示 LibreOffice 转出的真版式 PDF（分页 / 缩放可用），首启有 loading、转换失败有 error；知识概要（Synopsis）对 pptx 的大纲功能不受影响。
- **工作量**：small

### M4-4-S3（子线 A：图片协议根治）— medium

- **做什么**：新建 `electron/ipc/fileProtocol.ts`（仿 wallpaper）注册 `synapse-file://` standard + secure 协议 + 路径规范化 / 存在性 / 扩展名白名单校验；`main.ts` import 触发 scheme 注册并在 `whenReady` 调 `registerFileProtocol()`；`fileSystem` 新增 `getDisplayUrl`（Electron → 协议 url / Web → object url）；`EditorArea` image case 改用 `getDisplayUrl`，去掉裸路径 fallback。
  - **增量（主人已决纳入）**：协议 `supportFetchAPI`/`stream=true`，`getDisplayUrl` 的扩展名白名单一并覆盖**常见视频格式 + pdf**；video（`EditorArea:89` MediaPlayer）与 PdfFileViewer 同步切到 `synapse-file://`，消除同源黑屏隐患。
- **改动文件**：
  - `synapse-app/electron/ipc/fileProtocol.ts`（新建）
  - `synapse-app/electron/main.ts`
  - `synapse-app/src/services/fileSystem.ts`
  - `synapse-app/src/components/layout/EditorArea.tsx`
- **验收**：`npm run build` + `npm run electron:build` 通过；`electron:dev` 下打开工作区内 `.png`/`.jpg`/`.svg` 图片正常显示（可缩放 / 旋转），不再黑屏只剩文件名；打包（prod `file://` 源）同样可显示；非法 / 越界 / 不存在路径不报错崩溃而是优雅占位；Web 模式上传图片仍走 object url 正常。（video/PDF 顺手修部分一并真机过一眼。）
- **工作量**：medium

### M4-4-S4（自测与对抗审查）— small

- **做什么**：三子线合并后 `npm run build` + `npm run electron:build` 全过；真机验证图片（dev + prod）/ 只读高亮 / pptx + docx 版式三类；Codex 独立 review 协议安全（路径穿越 / `decodeURIComponent` 二次解码 / 盘符大小写）与高亮性能；修 high/med。
- **改动文件**：
  - `synapse-app/electron/ipc/fileProtocol.ts`
  - `synapse-app/src/components/editor/CodeEditor.tsx`
  - `synapse-app/src/services/editorFileTypes.ts`
- **验收**：两条 build 命令均通过；三类查看器真机截图无异常；协议无路径穿越（`..\`、URL 编码绕过）漏洞；Codex review 0 个 high/med 未修。
- **工作量**：small

---

## ⑥ 风险

1. **子线 A 协议安全**：`synapse-file://` 若不限制根目录，等于把任意本地文件暴露给渲染进程加载——虽与现有 `file:read`/`readBinary` 口径一致（已可读任意绝对路径），但 URL 形态更易被构造，**必须做 `path.normalize` + `decodeURIComponent` 后再校验**（防 `..\` 与二次 URL 编码绕过），并加扩展名白名单（仅图片等可视类型）。
2. **子线 A dev/prod 双源**：standard + secure 协议在 http（dev）与 file（prod）源下表现需双机验证；若 `index.html` 后续加了 CSP，`img-src`/`default-src` 需补 `synapse-file:`。当前无 CSP，但属隐性约束。
3. **子线 B 性能**：`react-syntax-highlighter` 对超大文件（数千行）高亮会阻塞主线程，**必须加行数 / 字节阈值降级为裸 pre**（已定 > 2000 行），否则打开大日志 / 大代码文件会卡死编辑器。
4. **子线 B bundle 体积**：若误用全量 `PrismLight` / 默认全语言注册，会显著增大产物；**须用 Async + 按 langMap 按需注册**。
5. **子线 C 死分支**：`editorTabs.ts:9` 联合类型仍保留 `'pptx'`/`'docx'`，若未来有人显式 `openTab(type:'pptx')` 仍会命中 `PptxViewer`——保留分支是兼容也是隐患，**需注释说明**；若选择删分支则要同步联合类型并确认无其它入口。
6. **LibreOffice 依赖**：③ 真版式预览依赖用户机装了 LibreOffice（`findLibreOffice` 候选含标准安装路径）；未装则 `OfficeViewer` 显示 error。这是既有现状（office 类型本就如此），pptx/docx 归类后从「能看文本」退化为「未装则报错」——属决策代价，**需 error 文案引导安装**。

---

## ⑦ openQuestions 决议（采纳子代理倾向 + 主人决策）

1. **子线 A 路径白名单范围**
   - 问：允许加载任意本地存在文件（同 `file:read` 现状口径，最省事），还是必须约束在当前工作区根下？
   - **已决：放宽到任意本地存在文件 + 扩展名白名单**，不做工作区根约束（根约束需主进程新增 `currentWorkspace` 状态同步机制，留后续）。口径与 `file:read` 一致，安全基线不低于现状。

2. **子线 A 协议 API 选型**
   - 问：用 Electron 41 推荐的 `protocol.handle`（Response/net.fetch 新 API），还是与 wallpaper 一致的 `registerFileProtocol` `callback({path})` 旧 API？
   - **已决：与 wallpaper 同风格 `registerFileProtocol` `callback({path})`**（主人决策明确「`registerFileProtocol` 同 wallpaper 风格」），降低认知差。`handle` 是官方未来方向，本里程碑不采用。

3. **子线 B 高亮库**
   - 问：`react-syntax-highlighter`（Prism，与 `detectLanguage` 对齐、集成轻）vs shiki（渲染更精细、需 wasm 异步）？
   - **已决：`react-syntax-highlighter`**（主人决策明确）。与 MarkdownViewer 代码块风格统一为后续事项（需另查 MarkdownViewer 现状），本里程碑不强绑。

4. **子线 B 大文件降级阈值**
   - 问：高亮降级为裸 pre 的触发阈值定多少？
   - **已决：> 2000 行降级裸 pre**（主人决策明确「大文件 > 2000 行降级裸 pre」）。

5. **子线 C 死分支处置**
   - 问：`EditorArea` `case 'pptx'`/`'docx'` 是保留（兜底 + 注释）还是删除（连带 `editorTabs` 联合类型清理）？
   - **已决：保留分支 + 加注释**（兜底，降风险），联合类型不动。

6. **子线 A 图片以外是否复用协议**
   - 问：`synapse-file://` 是否也给 video（`MediaPlayer src=` 裸 filePath，`EditorArea:89` 同样有 Electron 黑屏隐患）与 PdfFileViewer 复用？
   - **已决：纳入本里程碑，顺手一起修**（主人决策明确「video/PDF 顺手一起修」）。video/PDF 复用同一套 `synapse-file://` 协议，扩展名白名单覆盖常见视频格式 + pdf，于 S3 一并完成。

---

## ⑧ 技术决策小结

| 维度 | 决策 | 关键依据 / 落点 |
|---|---|---|
| 图片黑屏根因 | webSecurity + 协议来源拦截（非 CSP） | `EditorArea.tsx:81` 裸路径 fallback、`main.ts:29-34/41` http 源、`index.html` 无 CSP |
| 图片修法 | 新增 `synapse-file://` 自定义协议（仿 wallpaper） | `electron/ipc/fileProtocol.ts`（新建）+ `main.ts` 接线 + `fileSystem.getDisplayUrl` |
| 协议 API | `registerFileProtocol` `callback({path})` 旧 API（同 wallpaper） | 降认知差；非 `protocol.handle` |
| 协议安全 | 放宽到任意本地文件 + 扩展名白名单；`decodeURIComponent`→`normalize`→校验 | 与 `file:read` 口径一致；防 `..\` 与二次编码穿越 |
| video / PDF | 同协议顺手修，白名单覆盖视频 + pdf | `EditorArea:89` MediaPlayer + PdfFileViewer |
| 代码高亮库 | `react-syntax-highlighter`（Prism，`PrismAsyncLight` 按需注册） | 与 `detectLanguage` lang 对齐、体积可控 |
| 高亮范围 | 仅只读分支（`CodeEditor.tsx:69-72`）；可编辑 textarea 不动 | 保证 Ctrl+S/Tab 与逐字节一致 |
| lang 映射 | `mapToPrismLang`（`c++`→`cpp`、`text`→无高亮） | `detectLanguage` 产串与 Prism 名差异归一 |
| 高亮性能护栏 | > 2000 行降级裸 pre | 防大文件冻结 UI |
| Office 归类 | 删 `editorFileTypes.ts:12-13` + 补 `OFFICE_EXTENSIONS` | 两行改归类，复用已就绪的 LibreOffice→PDF 链路 |
| Office 死分支 | 保留 `case 'pptx'`/`'docx'` + 注释；联合类型不动 | 降风险；不牵连 synopsis 体系 |
| 不可删组件 | `PptxViewer`/`DocxViewer` 保留 | `SynopsisPanel.tsx:16` / `synopsisEngine.ts:22/199` 仍用 pptx 概念 |
| 落地顺序 | B（前端）→ C（两行）→ A（主进程协议） | 风险从低到高；三线无依赖可并行 |

**一句话总览**：M4-4 = 一个 high bug（图片协议）+ 两个体验升级（只读高亮、Office 真版式），核心是「新增 `synapse-file://` 协议根治本地资源加载 + 装 `react-syntax-highlighter` 点亮只读代码 + 两行改归类把 Office 接回已就绪的 LibreOffice 版式链路」，全程只读核对 + 设计，不引入新架构，复用 wallpaper 协议范本与既有 OfficeViewer/PdfViewer 链路。
