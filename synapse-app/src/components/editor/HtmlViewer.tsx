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
        <iframe
          className="html-preview-frame"
          srcDoc={content}
          sandbox=""
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
