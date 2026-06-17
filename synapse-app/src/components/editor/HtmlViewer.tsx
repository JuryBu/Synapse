import { useEffect, useState } from 'react';
import { Code2, Eye } from 'lucide-react';
import { useAppDispatch } from '@/store/hooks';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { fileSystem } from '@/services/fileSystem';
import { markTabSaved, setTabContent } from '@/store/slices/editorTabs';
import { addNotification } from '@/store/slices/notifications';

type HtmlMode = 'render' | 'source';

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
        // ★ FIX-6 安全收口（提权根治）：绝不同时给 allow-scripts 与 allow-same-origin——
        //   这正是 HTML 规范明确警告会使 sandbox 失效的组合。srcDoc 由父渲染进程提供，
        //   带 allow-same-origin 时 iframe 内脚本会继承父窗口同源（dev=http://localhost:5173 / prod=file://），
        //   可经 window.parent/window.top 触达 preload 经 contextBridge 暴露的全部 synapse IPC 桥
        //   （command.exec / file.write / file.delete / worktree.* / mcp.* …）。工作区 .html 常为 AI 生成或下载所得，
        //   并非可信内容，一旦点「渲染」即可执行宿主任意命令 / 任意读写删文件。
        //   收口方案：保留 allow-scripts（KaTeX/图表等脚本仍执行，CDN <script src> 照常加载），
        //   去掉 allow-same-origin——srcDoc 随之运行在 null/opaque origin，window.parent.synapse 不可达，提权面归零。
        //   注：iframe 的 csp 属性浏览器支持度不稳（Chromium 曾实验后撤回）且非标准，不靠它做防线；
        //   opaque origin 已从根上切断对父窗口同源资源/synapse 桥的访问，无需再叠不可靠的属性。
        <iframe
          className="html-preview-frame"
          srcDoc={content}
          sandbox="allow-scripts allow-popups"
          title={`HTML 预览: ${fileName}`}
        />
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
