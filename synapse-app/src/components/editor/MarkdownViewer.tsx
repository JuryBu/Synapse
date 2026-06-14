import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Eye, Columns2, Pencil } from 'lucide-react';
import { useAppDispatch } from '@/store/hooks';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { fileSystem } from '@/services/fileSystem';
import { markTabSaved, setTabContent } from '@/store/slices/editorTabs';
import { addNotification } from '@/store/slices/notifications';

type MarkdownMode = 'preview' | 'source' | 'split';

interface MarkdownViewerProps {
  tabId: string;
  filePath: string;
  fileName: string;
  tabContent?: string;
  savedContent?: string;
  dirty: boolean;
}

export function MarkdownViewer({
  tabId,
  filePath,
  fileName,
  tabContent,
  savedContent,
  dirty,
}: MarkdownViewerProps) {
  const dispatch = useAppDispatch();
  const [content, setContent] = useState<string>('');
  const [mode, setMode] = useState<MarkdownMode>('preview');
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
      } catch {
        if (!cancelled) {
          const fallback = `# 无法加载文件\n\n文件路径: ${filePath}`;
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
    return <div className="markdown-viewer-loading">📝 加载 Markdown 中...</div>;
  }

  return (
    <div className="markdown-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-filename">📝 {fileName}</span>
        {dirty && <span className="dirty-indicator" title="未保存">●</span>}
        <div className="viewer-mode-tabs" role="tablist" aria-label="Markdown 查看模式">
          <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')} title="预览">
            <Eye size={14} /> 预览
          </button>
          <button className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')} title="源码">
            <Pencil size={14} /> 源码
          </button>
          <button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')} title="分屏">
            <Columns2 size={14} /> 分屏
          </button>
        </div>
      </div>

      {mode === 'preview' && <MarkdownPreview content={content} />}
      {mode === 'source' && (
        <CodeEditor
          filename={fileName}
          content={content}
          language="markdown"
          dirty={dirty}
          savedContent={savedContent}
          readOnly={false}
          onChange={handleChange}
          onSave={handleSave}
        />
      )}
      {mode === 'split' && (
        <div className="split-viewer">
          <div className="split-pane">
            <CodeEditor
              filename={fileName}
              content={content}
              language="markdown"
              dirty={dirty}
              savedContent={savedContent}
              readOnly={false}
              onChange={handleChange}
              onSave={handleSave}
            />
          </div>
          <div className="split-pane">
            <MarkdownPreview content={content} />
          </div>
        </div>
      )}
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
