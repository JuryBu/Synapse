# Plan_1_展示模式: 编辑器区域、嵌入查看器与 Showcase 模式

> 中间区域不止是代码编辑器——还有课件预览、AI 生成内容展示、交互式应用运行。

---

## 1. 编辑器区域功能矩阵

中间区域根据打开的内容类型自动选择渲染器：

| 文件类型 | 渲染器 | 技术实现 | 功能 |
|---|---|---|---|
| `.ts/.js/.py` 等 | MonacoEditor | @monaco-editor/react | 语法高亮、智能补全、行号、搜索 |
| `.md` | MarkdownPreview | react-markdown + KaTeX + Mermaid | 实时渲染预览 |
| `.pdf` | PdfViewer | pdfjs-dist (pdf.js) | 页面导航、缩放、文字选择 |
| `.pptx` | PptxViewer | slide 截图序列 | 幻灯片浏览、全屏模式 |
| `.docx` | DocxViewer | mammoth → HTML | 结构化渲染 |
| 图片 | ImageViewer | 原生 `<img>` + 手势库 | 缩放、拖拽、旋转 |
| 视频/音频 | MediaPlayer | HTML5 `<video>`/`<audio>` | 播放控制、进度条、倍速 |
| Showcase | ShowcaseFrame | 沙箱 iframe | AI 生成的交互式应用 |

---

## 2. PDF 嵌入查看器

### 2.1 技术方案

```typescript
// components/editor/viewers/PdfViewer.tsx
import * as pdfjsLib from 'pdfjs-dist';

interface PdfViewerProps {
  filePath: string;
  onPageChange?: (page: number, total: number) => void;
}

// 使用 Canvas 渲染每一页
// pdf.js worker 单独加载（避免阻塞主线程）
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
```

### 2.2 功能清单

- 📄 页面导航（上/下页、跳转页码、缩略图侧栏）
- 🔍 缩放（适应宽度、适应页面、手动缩放、Ctrl+滚轮缩放）
- 📝 文字选择和复制
- 🔎 文内搜索（Ctrl+F 高亮匹配）
- 📑 大纲/书签侧栏（从 PDF outline 提取）
- 🌙 暗色模式（CSS filter 反色）
- ➡️ "发送到 AI" 按钮（选中文字 → 填入对话输入框）

### 2.3 与 Synopsis 联动

PDF 查看器底部状态栏显示当前页所属的 Synopsis Chunk：
```
第 15 页 / 共 120 页    |    📊 Chunk 3: "线性回归与梯度下降"    |    ✅ 已生成概要
```

---

## 3. PPTX 查看器

### 3.1 技术方案

PPTX 不像 PDF 有成熟的浏览器渲染库，采用 **截图序列** 方案：

```
PPTX 文件 → LibreOffice headless 转 PDF → pdf.js 渲染
                  或
PPTX 文件 → LibreOffice headless 每页转 PNG → 图片轮播
                  或
PPTX 文件 → 解析 XML 提取文字 + 图片 → 简化渲染
```

**推荐方案**：LibreOffice headless 转 PDF → 复用 PdfViewer。这样一套代码两用。

### 3.2 备选：Web 原生渲染

如果不想依赖 LibreOffice：
- 解析 PPTX ZIP → 提取每张 slide 的 XML
- 渲染为简化的 HTML（文字 + 图片定位）
- 缺点：复杂动画和排版无法完美还原

### 3.3 Speaker Notes 面板

底部可折叠面板显示当前 slide 的 Speaker Notes。

---

## 4. DOCX 查看器

### 4.1 技术方案

```typescript
import mammoth from 'mammoth';

// DOCX → HTML → 渲染
const result = await mammoth.convertToHtml({ path: filePath });
// result.value = HTML 字符串
// 渲染到 <div dangerouslySetInnerHTML={{ __html: result.value }} />
```

### 4.2 样式增强

mammoth 输出的 HTML 比较裸，需要额外 CSS：
- 标题层级样式（h1-h6）
- 表格边框和条纹
- 图片自适应宽度
- 代码块样式
- 列表缩进

---

## 5. Showcase 模式（核心差异化功能）

### 5.1 概念

AI 在教学过程中可能生成：
- 交互式 HTML 页面（如可视化数据图表）
- 代码演示（如算法动画）
- 小型 Web 应用（如在线计算器、模拟器）
- Mermaid 图表的独立查看

这些内容需要一个**安全的运行环境**在中间区域展示。

### 5.2 沙箱 iframe 安全策略

```typescript
// components/editor/viewers/ShowcaseFrame.tsx
<iframe
  src={showcaseUrl}
  sandbox="allow-scripts allow-same-origin"
  // CSP 策略
  // 禁止: 外部网络请求、文件系统访问、弹窗
  // 允许: JS 执行、Canvas、WebGL、CSS 动画
  style={{ width: '100%', height: '100%', border: 'none' }}
  title="Showcase"
/>
```

### 5.3 CSP (Content Security Policy) 配置

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  connect-src 'none';          # 禁止外部网络请求
  font-src 'self' data:;
  media-src 'self' blob:;
  frame-src 'none';            # 禁止嵌套 iframe
```

### 5.4 本地服务器管理

AI 生成的 HTML/JS 项目需要本地服务器来运行：

```typescript
// electron/servers/showcaseServer.ts
class ShowcaseServerManager {
  private servers: Map<string, ShowcaseServer> = new Map();
  
  // AI 生成文件后，启动本地服务
  async start(directory: string): Promise<{ port: number; url: string }> {
    const port = await findAvailablePort(8100, 8199);  // 8100-8199 端口段
    const server = http.createServer((req, res) => {
      // 静态文件服务 + CSP 头注入
      res.setHeader('Content-Security-Policy', CSP_POLICY);
      serveStatic(directory, req, res);
    });
    server.listen(port);
    this.servers.set(directory, { server, port });
    return { port, url: `http://localhost:${port}` };
  }
  
  // 关闭服务
  async stop(directory: string): Promise<void>;
  
  // 列出运行中的服务
  list(): { directory: string; port: number; url: string }[];
}
```

### 5.5 Showcase 工具栏

```
┌────────────────────────────────────────────────────────┐
│  🖥 Showcase: data-chart.html    🔄 刷新  📐 全屏  ✕  │
├────────────────────────────────────────────────────────┤
│                                                        │
│           [ iframe 沙箱内容 ]                          │
│                                                        │
│           交互式图表 / 动画 / 应用                     │
│                                                        │
└────────────────────────────────────────────────────────┘
```

工具栏功能：
- 🔄 刷新（重新加载 iframe）
- 📐 全屏（iframe 占满编辑器区域）
- 🔗 在外部浏览器打开（`shell.openExternal`）
- 📋 查看源码（跳转到对应文件的 Monaco 编辑器）
- ⚙ 开发者工具（打开 Chrome DevTools for iframe）

### 5.6 AI 触发展示的交互流程

```
1. 用户: "帮我可视化二叉树的遍历过程"
2. AI: 编写 HTML + JS 文件到工作区 .synapse/showcase/
3. AI: 调用 server:start 工具启动本地服务
4. AI: 返回消息 "我已经为你创建了一个交互式可视化，点击查看 →"
5. 消息中包含 [打开展示] 按钮
6. 用户点击 → 中间区域切换到 ShowcaseFrame → 加载 iframe
```

---

## 6. 标签页管理

### 6.1 标签页类型

```typescript
type TabType = 
  | { type: 'editor'; filePath: string; language: string }    // Monaco
  | { type: 'pdf'; filePath: string }                          // PDF 查看器
  | { type: 'pptx'; filePath: string }                         // PPT 查看器
  | { type: 'docx'; filePath: string }                         // Word 查看器
  | { type: 'image'; filePath: string }                        // 图片
  | { type: 'media'; filePath: string }                        // 视频/音频
  | { type: 'markdown'; filePath: string }                     // Markdown 预览
  | { type: 'showcase'; url: string; title: string }           // 展示模式
  | { type: 'welcome' }                                        // 欢迎页
  | { type: 'settings' };                                      // 设置页

interface Tab {
  id: string;
  type: TabType;
  title: string;
  icon: string;         // lucide 图标名
  isDirty: boolean;      // 是否有未保存修改
  isPinned: boolean;     // 是否固定
}
```

### 6.2 标签栏行为

- 拖拽排序
- 双击固定/取消固定
- 中键关闭
- 滚轮切换（标签过多时）
- 右键菜单（关闭/关闭其他/关闭所有/固定）
- 脏标记（文件修改未保存时标签名旁显示 ●）
- 预览模式（单击文件树 = 预览标签[斜体]，双击 = 持久标签）

---

## 7. 底部面板

### 7.1 终端面板

```typescript
// 使用 xterm.js + node-pty
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';

// 每个终端实例对应一个 node-pty 伪终端
// 通过 IPC 与主进程的 TerminalManager 通信
```

支持：
- 多终端标签（`+` 新建、`×` 关闭）
- PowerShell / Bash / 自定义 shell
- 自动适配面板大小
- 链接点击（URL → 外部浏览器）

### 7.2 输出面板

显示 Synopsis 引擎日志、MCP 服务器日志、工具执行输出等结构化信息。

### 7.3 面板折叠/展开

- 默认折叠
- `Ctrl+J` 切换
- 拖拽调高度
- 标签切换（终端 | 输出 | Synopsis 日志）
