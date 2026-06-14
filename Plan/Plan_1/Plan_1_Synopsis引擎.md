# Plan_1_Synopsis引擎: 多模态课件概要生成系统

> Synopsis 引擎是 Synapse 的灵魂——让 AI 真正"理解"工作区内的所有课件。
> 基于 Aether Reader 的 Map-Reduce 架构，扩展为支持全格式多模态的知识索引系统。

---

## 1. 设计目标

| 目标 | 描述 |
|---|---|
| **全格式覆盖** | PDF（含纯图扫描版）、PPTX、DOCX、Markdown、图片、视频、音频、纯文本 |
| **多模态感知** | 综合文字 + 图片 + 音频转写，生成统一的自然语言概要 |
| **Agentic 友好** | 概要索引让 AI 知道"去哪里找答案"，而不是把所有内容都塞进上下文 |
| **增量更新** | 新增/修改课件时只更新变化部分，不重新处理全部 |
| **并发高效** | 多模型 Worker Pool 并发，大文件预览优化 |

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    Synopsis Engine                        │
│                                                          │
│  ┌────────────┐   ┌─────────────┐   ┌────────────────┐  │
│  │  解析器层   │→  │  Map 阶段   │→  │  Reduce 阶段  │  │
│  │  (Parsers)  │   │  (并发摘要)  │   │  (聚合索引)   │  │
│  └────────────┘   └─────────────┘   └────────────────┘  │
│        ↑                 ↑                   ↓           │
│   文件类型检测      多模型 Worker Pool    知识索引存储     │
│        ↑                                     ↓           │
│   课件上传/变更                    系统提示上下文注入      │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 解析器层（Parsers）

每种文件格式有专门的解析器，输出统一的 **Chunk** 结构：

### 3.1 统一 Chunk 接口

```typescript
interface UnifiedChunk {
  index: number;
  range: string;           // "第1-5页" / "第3章" / "Slide 4-8" / "00:05:00-00:10:00"
  title?: string;
  
  // 多模态内容（至少有一种）
  textContent?: string;     // 文本内容
  imageBase64?: string[];   // 图片内容（base64）
  audioTranscript?: string; // 音频转写文本
  
  // 元信息
  sourceFile: string;       // 来源文件名
  sourceType: FileType;     // 文件类型枚举
  pageNumbers?: number[];   // 对应的页码
  timestamp?: string;       // 视频/音频的时间戳范围
  
  // 哈希值（增量更新用）
  contentHash: string;
}

enum FileType {
  PDF_TEXT = 'pdf_text',           // 文字版 PDF
  PDF_SCANNED = 'pdf_scanned',    // 扫描版 PDF（纯图）
  PDF_MIXED = 'pdf_mixed',        // 图文混合 PDF
  PPTX = 'pptx',
  DOCX = 'docx',
  MARKDOWN = 'markdown',
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  PLAINTEXT = 'plaintext',
  OTHER = 'other',                // 不生成概要，Agentic 自行读取
}
```

### 3.2 各格式解析器

#### PDF 解析器（`parsers/pdfParser.ts`）
- **依赖**：`pdfjs-dist`（Mozilla pdf.js）
- **策略**：
  1. 先尝试文字提取（`page.getTextContent()`）
  2. 如果某页文字量 < 阈值（如 50 字）→ 判定为扫描页
  3. 扫描页使用 Canvas 渲染为图片 → 走 Vision API
  4. 图文混合模式：文字 + 图片同时送给多模态模型
- **分块**：默认 20 页一块，可配置
- **Aether Reader 复用**：直接迁移 `chunkPdfText()` + 扫描检测逻辑
- **改进**：新增扫描页自动检测（通过文字密度判断），Aether Reader 原版需要用户手动选择模式
- **模型要求**：**默认要求多模态输入模型**（GPT-4o/Gemini/Claude 等主流模型均支持），这是 Synapse 正常运行的基本条件
- **TEXT MODE 开关**（设置中）：用户实在没有多模态 API 时可开启，此模式下：
  1. 扫描页使用 **Tesseract.js** 本地 OCR → 提取文字 → 走纯文本模型
  2. 图文混合页只提取文字部分，放弃图片理解
  3. PPTX 只提取 XML 文字 + Speaker Notes，放弃 slide 截图理解
  4. 可视化图表由 AI 写代码在 sandbox 生成，不依赖 Drawing 模型

#### PPTX 解析器（`parsers/pptxParser.ts`）
- **依赖**：`pptx-parser` 或 `officegen` / 自行解析 ZIP+XML
- **策略**：
  1. PPTX 本质是 ZIP 包含 XML + 图片
  2. 解析 `ppt/slides/slide{N}.xml` 提取文本
  3. 提取 `ppt/media/` 中的图片
  4. 每 5-8 张 slide 为一个 Chunk
  5. 每个 Chunk 包含 `textContent`（slide 文本）+ `imageBase64`（slide 截图/内嵌图）
- **增强**：将每张 slide 渲染为截图（用 LibreOffice headless 或 PPTX→图片），作为 Vision 输入
- **Speaker Notes**：提取演讲者备注作为额外文本上下文

#### DOCX 解析器（`parsers/docxParser.ts`）
- **依赖**：`mammoth`（HTML 转换）+ 自行 ZIP 解析（提取图片）
- **策略**：
  1. `mammoth.convertToHtml()` 获取结构化文本
  2. 按标题层级（h1/h2/h3）分章节
  3. 提取内嵌图片
  4. 每章/节为一个 Chunk
- **优势**：DOCX 通常结构清晰，分块效果好

#### Markdown 解析器（`parsers/markdownParser.ts`）
- **依赖**：`remark-parse`（已有）
- **策略**：
  1. 按 `##` 二级标题切分
  2. 提取图片引用（本地图片转 base64）
  3. 代码块保留（AI 理解代码内容有学习价值）

#### 图片解析器（`parsers/imageParser.ts`）
- **策略**：
  1. 单张图片 = 单个 Chunk
  2. 图片组按文件名排序，每 5 张一组
  3. 直接走 Vision API 获取描述

#### 视频解析器（`parsers/videoParser.ts`）
- **依赖**：`ffmpeg`（Node.js 绑定，如 `fluent-ffmpeg`）
- **策略**：
  1. **关键帧提取**：每 30 秒提取一帧作为视觉摘要
  2. **音频转写**：提取音轨 → Whisper API 转写为文本
  3. 每 5 分钟为一个 Chunk，包含：
     - `audioTranscript`：语音转写文本
     - `imageBase64`：该时段的关键帧截图
     - `timestamp`：时间范围
- **成本控制**：视频概要生成可选（消耗大量 API 调用），用户可以选择"仅提取关键帧"模式

#### 音频解析器（`parsers/audioParser.ts`）
- **依赖**：`ffmpeg` 分段 + Whisper API
- **策略**：
  1. 按 5 分钟分段
  2. 每段送 Whisper API → 得到文本
  3. 文本再送 LLM 生成摘要

#### 纯文本解析器（`parsers/textParser.ts`）
- **策略**：按固定字数（~6000字/块）或段落分块

---

## 4. Map 阶段（并发摘要生成）

### 4.1 多模型 Worker Pool（复用 Aether Reader 架构）

```typescript
interface WorkerPoolConfig {
  models: AIModelConfig[];        // 多个模型配置（用户可配多个 Fast Model）
  concurrencyPerModel: number;    // 每个模型的并发数（默认 1-3）
  totalConcurrency: number;       // 总并发 = models.length × concurrencyPerModel
}
```

**调度策略**：
1. 所有 Chunk 放入任务队列
2. 每个 Worker 从队列原子地取任务
3. 失败的 Chunk 标记错误信息，不阻塞其他 Chunk
4. 进度回调实时更新 UI

### 4.2 多模态 Prompt 策略

根据 Chunk 的内容类型选择不同的 Prompt：

| 内容类型 | Prompt 策略 | API 模式 |
|---|---|---|
| 纯文本 | `buildMapPrompt(text, range)` | Chat Completion |
| 纯图片 | `buildVisionMapPrompt(range)` + images | Vision API |
| 图文混合 | `buildMixedMapPrompt(text, range)` + images | Vision API |
| 音频转写 | `buildTranscriptMapPrompt(transcript, range)` | Chat Completion |
| 视频 | `buildVideoMapPrompt(transcript, range)` + keyframes | Vision API |

### 4.3 学习导向 Prompt（区别于 Aether Reader）

Aether Reader 的 Prompt 偏向"客观摘要，不评论"，但 Synapse 是**学习工具**，Prompt 应该调整为：

```
请分析以下课件内容（${range}），生成一段 200-300 字的学习导向概要。

要求：
1. 提取核心知识点和关键概念
2. 标注重要的定义、公式、定理
3. 记录关键的人名、术语、专有名词
4. 如有代码示例，提取核心逻辑和用途
5. 如有图表/图片，描述其展示的信息
6. 标记可能的考点或易混淆点

输出格式：
【核心知识点】...
【关键概念】...
【重要细节】...
```

---

## 5. Reduce 阶段（知识索引聚合）

### 5.1 两级 Reduce

与 Aether Reader 的单级 Reduce 不同，Synapse 使用**两级聚合**：

```
Chunk 摘要 ×N
    ↓
[Level-1 Reduce] 按文件聚合 → 每个课件文件的完整概要
    ↓  
[Level-2 Reduce] 跨文件聚合 → 整个工作区的知识大纲
```

**Level-1**：每个课件文件的所有 Chunk 摘要 → 聚合为 "课件概要"
**Level-2**：所有课件概要 → 聚合为 "课程知识大纲"（可选，大型工作区才需要）

### 5.2 索引存储结构

```typescript
interface WorkspaceSynopsis {
  workspaceId: string;
  courseName: string;
  lastUpdated: string;
  
  // Level-2: 工作区级大纲
  globalOutline?: string;
  
  // Level-1: 每个文件的概要
  fileSynopses: FileSynopsis[];
}

interface FileSynopsis {
  fileName: string;
  filePath: string;
  fileType: FileType;
  fileHash: string;          // 文件内容哈希（增量更新对比用）
  lastProcessed: string;
  
  // 文件级概要
  overview: string;           // Level-1 Reduce 生成
  
  // Chunk 级摘要（AI 检索时的细粒度索引）
  chunkSummaries: ChunkSummary[];
}

interface ChunkSummary {
  range: string;
  title?: string;
  summary: string;
  contentHash: string;        // 增量更新对比用
  keywords?: string[];        // 可选：提取的关键词（加速检索）
}
```

### 5.3 增量更新机制

```
文件变更检测
  → 对比 fileHash
    → 不变：跳过
    → 变化：
      → 重新解析为 Chunks
      → 对比每个 Chunk 的 contentHash
        → 不变的 Chunk：复用已有摘要
        → 变化的 Chunk：重新生成摘要
      → 重新 Level-1 Reduce（因为可能有新增/删除 Chunk）
      → 标记需要重新 Level-2 Reduce
```

---

## 6. 上下文注入策略

### 6.1 注入到系统提示的内容

```xml
<course_context>
## 当前工作区: 《机器学习导论》

### 课件概要
- chapter1_intro.pdf (32页): 机器学习基础概念，包括监督/无监督学习分类，损失函数定义...
- chapter2_regression.pptx (45张slide): 线性回归，梯度下降，正则化...
- lab1_code.md: Python sklearn 实践...
- lecture3_recording.mp4 (60min): 神经网络入门讲座...

### 知识大纲
本课程涵盖机器学习的核心理论与实践，从线性模型到深度学习...
</course_context>
```

### 6.2 Agentic 检索策略

当 AI 需要回答问题时：
1. AI 先看 `<course_context>` 中的概要
2. 判断答案可能在哪个文件的哪个 Chunk
3. 使用 `view_file` 等工具读取对应的课件原文
4. 基于原文生成精确回答

**这就是"Agentic RAG"**——不是简单的向量检索，而是 AI 自主决策去读哪些内容。

---

## 7. 对比 Aether Reader 的改进点

| 维度 | Aether Reader | Synapse |
|---|---|---|
| **支持格式** | PDF + EPUB + TXT | PDF/PPTX/DOCX/MD/图片/视频/音频/文本 |
| **扫描PDF** | 需用户手动选择图片模式 | 自动检测（文字密度阈值） |
| **视频/音频** | 不支持 | Whisper 转写 + 关键帧提取 |
| **Prompt 导向** | 客观摘要 | 学习导向（知识点/考点/关键概念） |
| **Reduce 层级** | 单级（全书大纲） | 两级（文件概要 + 工作区大纲） |
| **增量更新** | 不支持（全量重生成） | 基于 contentHash 增量更新 |
| **索引用途** | 展示大纲面板 | AI 上下文注入 + Agentic 检索导航 |
| **Speaker Notes** | 不适用 | 提取 PPTX 演讲者备注 |
| **多文件关联** | 单文件独立 | 跨文件知识大纲 |

---

## 8. 配置项

```typescript
interface SynopsisConfig {
  // 分块设置
  pdfChunkSize: number;           // PDF 每块页数，默认 20
  pptxChunkSize: number;          // PPTX 每块 slide 数，默认 6
  docxChunkByHeading: boolean;    // DOCX 按标题分块，默认 true
  textChunkChars: number;         // 纯文本每块字数，默认 6000
  videoSegmentSeconds: number;    // 视频分段秒数，默认 300 (5min)
  
  // 并发设置
  maxConcurrentWorkers: number;   // 最大总并发数，默认 3
  concurrencyPerModel: number;    // 每模型并发数，默认 1
  
  // 大文件优化
  largeFileSizeThreshold: number; // 大文件阈值（字节），默认 50MB
  largeFilePagesThreshold: number;// 大文件页数阈值，默认 500
  previewPercentage: number;      // 预览模式比例，默认 0.1
  
  // 视频/音频设置
  enableVideoSynopsis: boolean;   // 是否处理视频（消耗大），默认 false
  enableAudioSynopsis: boolean;   // 是否处理音频，默认 true
  whisperModel: string;           // Whisper 模型名，默认 "whisper-1"
  keyframeInterval: number;       // 关键帧提取间隔（秒），默认 30
  
  // 跳过设置
  skipExtensions: string[];       // 不处理的文件扩展名
  maxFileSize: number;            // 单文件大小上限，默认 200MB
}
```

---

## 9. UI 交互

### Synopsis 面板（Sidebar）
- 显示当前工作区所有课件的概要状态
- 每个文件：✅已完成 / ⏳处理中(进度%) / ❌失败(重试按钮)
- 点击文件展开查看 Chunk 级摘要
- 配置按钮：打开 Synopsis 设置

### 进度 Toast
- 上传课件后自动触发概要生成
- 底部 Toast 显示整体进度："正在生成概要 (3/8 文件, 45%)"
- 支持取消按钮
