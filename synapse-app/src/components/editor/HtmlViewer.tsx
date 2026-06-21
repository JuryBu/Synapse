import { useEffect, useState } from 'react';
import { Code2, Eye, Loader2 } from 'lucide-react';
import { useAppDispatch } from '@/store/hooks';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { fileSystem } from '@/services/fileSystem';
import { markTabSaved, setTabContent } from '@/store/slices/editorTabs';
import { addNotification } from '@/store/slices/notifications';

type HtmlMode = 'render' | 'source';

// ★ UI-9：给渲染 iframe 注入统一滚动条样式。iframe srcDoc 是独立文档（opaque origin），app 全局
//   ::-webkit-scrollbar 样式进不去，默认是浏览器原生粗白滚动条——与 app 风格不一致、突兀。
// ★ 回归真因（playwright 真机定位）：Electron 41 = Chromium 138，与开发机新版 Chromium 渲染不一致。
//   iframe【视口主滚动条】(html root) 用 ::-webkit-scrollbar 样式化跨版本不可靠；改用标准 scrollbar-width:thin
//   又会随 Chromium 版本漂移（某些版本渲染成偏粗 + 可见 track，正是这次回归看到的样子）。
//   根治 = 换滚动层：让 html 不滚、body 滚——body::-webkit-scrollbar 作用于【非 root 元素】，在所有 Chromium 版本
//   都稳定可控 → 细圆角中性灰条，深浅底都协调、跨版本一致。通用 ::-webkit 再统一内部 overflow 容器（代码块/表格）。
//   注：body{margin:0} 防 height:100% 下默认 margin 撑出被 html overflow:hidden 裁底；居中布局多用 container margin:auto，不受影响。
const HTML_SCROLLBAR_STYLE = '<style>'
  + 'html{overflow:hidden !important;height:100% !important;}'
  + 'body{height:100% !important;overflow:auto !important;margin:0 !important;box-sizing:border-box !important;}'
  + 'body::-webkit-scrollbar{width:10px !important;height:10px !important;}'
  + 'body::-webkit-scrollbar-track{background:transparent !important;}'
  + 'body::-webkit-scrollbar-thumb{background:rgba(140,140,160,0.45) !important;border-radius:6px !important;border:2px solid transparent !important;background-clip:padding-box !important;}'
  + 'body::-webkit-scrollbar-thumb:hover{background:rgba(140,140,160,0.7) !important;background-clip:padding-box !important;}'
  + 'body::-webkit-scrollbar-corner{background:transparent !important;}'
  + '::-webkit-scrollbar{width:10px !important;height:10px !important;}'
  + '::-webkit-scrollbar-track{background:transparent !important;}'
  + '::-webkit-scrollbar-thumb{background:rgba(140,140,160,0.45) !important;border-radius:6px !important;border:2px solid transparent !important;background-clip:padding-box !important;}'
  + '::-webkit-scrollbar-thumb:hover{background:rgba(140,140,160,0.7) !important;background-clip:padding-box !important;}'
  + '::-webkit-scrollbar-corner{background:transparent !important;}'
  + '</style>';

/**
 * 把滚动条样式注入 HTML——★ 必须注入 <head> 内，绝不前置到 <!DOCTYPE>/<html> 之前
 * （前置非空内容会触发 quirks mode、破坏用户 HTML 的渲染）。按 head→html→body→片段前置 兜底。
 */
function injectHtmlScrollbar(html: string): string {
  // ★ UI-9 修订（修「注入了但不生效」）：之前注入到 <head> 开头，排在用户自有 ::-webkit-scrollbar 样式【之前】，
  //   被 CSS「同特异性后定义赢」覆盖。改为注入到 </body> 前（文档最末，排在所有用户样式之后），fallback </head> 前 /
  //   片段追加末尾。配合样式 !important，确保覆盖精美 HTML 自带滚动条。注入末尾不影响 DOCTYPE/渲染模式。
  const bodyClose = html.search(/<\/body>/i);
  if (bodyClose >= 0) return html.slice(0, bodyClose) + HTML_SCROLLBAR_STYLE + html.slice(bodyClose);
  const headClose = html.search(/<\/head>/i);
  if (headClose >= 0) return html.slice(0, headClose) + HTML_SCROLLBAR_STYLE + html.slice(headClose);
  // 纯片段（无 body/head 闭合）→ 追加末尾（无 DOCTYPE，不影响渲染模式）。
  return html + HTML_SCROLLBAR_STYLE;
}

interface HtmlViewerProps {
  tabId: string;
  filePath: string;
  fileName: string;
  tabContent?: string;
  savedContent?: string;
  dirty: boolean;
}

export function HtmlViewer({
  tabId,
  filePath,
  fileName,
  tabContent,
  savedContent,
  dirty,
}: HtmlViewerProps) {
  const dispatch = useAppDispatch();
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<HtmlMode>('source');
  const [loading, setLoading] = useState(true);
  // ★ 渲染模式 iframe 加载态：onLoad（文档解析 + 脚本执行就绪）之前显示加载动画，
  //   之后淡出，消除「iframe 加载 + 脚本执行前的突兀白屏」。
  const [frameLoading, setFrameLoading] = useState(true);

  useEffect(() => {
    if (tabContent !== undefined) {
      setContent(tabContent);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const text = await fileSystem.readFile(filePath);
        if (!cancelled) {
          setContent(text);
          dispatch(setTabContent({ id: tabId, content: text, markSaved: true }));
        }
      } catch (err: any) {
        if (!cancelled) {
          const fallback = `<!-- 无法加载文件: ${filePath}\n${err?.message || ''} -->`;
          setContent(fallback);
          dispatch(setTabContent({ id: tabId, content: fallback, markSaved: true }));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dispatch, filePath, tabContent, tabId]);

  // 进入渲染模式 / srcDoc 内容变化时，重新进入「加载中」状态，等 iframe onLoad 再淡出。
  useEffect(() => {
    if (mode === 'render') setFrameLoading(true);
  }, [mode, content]);

  const handleChange = (nextContent: string) => {
    setContent(nextContent);
    dispatch(setTabContent({ id: tabId, content: nextContent }));
  };

  const handleSave = async (nextContent: string) => {
    await fileSystem.writeFile(filePath, nextContent);
    setContent(nextContent);
    dispatch(markTabSaved({ id: tabId, content: nextContent }));
    dispatch(addNotification({ type: 'success', title: '已保存', message: fileName, duration: 2000 }));
  };

  if (loading) {
    return <div className="markdown-viewer-loading">🌐 加载 HTML 中...</div>;
  }

  return (
    <div className="html-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-filename">🌐 {fileName}</span>
        {dirty && <span className="dirty-indicator" title="未保存">●</span>}
        <div className="viewer-mode-tabs" role="tablist" aria-label="HTML 查看模式">
          <button className={mode === 'render' ? 'active' : ''} onClick={() => setMode('render')} title="渲染">
            <Eye size={14} /> 渲染
          </button>
          <button className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')} title="源码">
            <Code2 size={14} /> 源码
          </button>
        </div>
      </div>
      {mode === 'render' ? (
        // 渲染区：iframe + 加载遮罩（onLoad 前显示 spinner，之后淡出，消除白屏突兀）。
        <div className="html-preview-stage">
          {/* ★ FIX-6 安全收口（提权根治）：绝不同时给 allow-scripts 与 allow-same-origin——
              这正是 HTML 规范明确警告会使 sandbox 失效的组合。srcDoc 由父渲染进程提供，
              带 allow-same-origin 时 iframe 内脚本会继承父窗口同源（dev=http://localhost:5173 / prod=file://），
              可经 window.parent/window.top 触达 preload 经 contextBridge 暴露的全部 synapse IPC 桥
              （command.exec / file.write / file.delete / worktree.* / mcp.* …）。工作区 .html 常为 AI 生成或下载所得，
              并非可信内容，一旦点「渲染」即可执行宿主任意命令 / 任意读写删文件。
              收口方案：保留 allow-scripts（KaTeX/图表等脚本仍执行，CDN <script src> 照常加载），
              去掉 allow-same-origin——srcDoc 随之运行在 null/opaque origin，window.parent.synapse 不可达，提权面归零。
              注：iframe 的 csp 属性浏览器支持度不稳（Chromium 曾实验后撤回）且非标准，不靠它做防线；
              opaque origin 已从根上切断对父窗口同源资源/synapse 桥的访问，无需再叠不可靠的属性。 */}
          <iframe
            className="html-preview-frame"
            srcDoc={injectHtmlScrollbar(content)}
            sandbox="allow-scripts allow-popups"
            title={`HTML 预览: ${fileName}`}
            onLoad={() => setFrameLoading(false)}
          />
          <div
            className={`html-preview-loading${frameLoading ? '' : ' is-hidden'}`}
            aria-hidden={!frameLoading}
          >
            <Loader2 className="html-preview-spinner" size={28} />
            <p>正在渲染 HTML...</p>
            <small>{fileName}</small>
          </div>
        </div>
      ) : (
        <CodeEditor
          filename={fileName}
          content={content}
          language="html"
          dirty={dirty}
          savedContent={savedContent}
          readOnly={false}
          onChange={handleChange}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
