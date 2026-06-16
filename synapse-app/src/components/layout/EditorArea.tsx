import { useAppSelector } from '@/store/hooks';
import { useAppDispatch } from '@/store/hooks';
import type { RootState } from '@/store';
import { TabBar } from '@/components/editor/TabBar';
import { WelcomePage } from '@/components/editor/WelcomePage';
import { ImageViewer } from '@/components/editor/ImageViewer';
import { MarkdownViewer } from '@/components/editor/MarkdownViewer';
import { HtmlViewer } from '@/components/editor/HtmlViewer';
import { MediaPlayer } from '@/components/editor/MediaPlayer';
import { ShowcaseFrame } from '@/components/editor/ShowcaseFrame';
import { PdfViewer } from '@/components/editor/PdfViewer';
import { DocxViewer } from '@/components/editor/DocxViewer';
import { PptxViewer } from '@/components/editor/PptxViewer';
import { OfficeViewer } from '@/components/editor/OfficeViewer';
import { CodeEditor } from '@/components/editor/CodeEditor';
import { ReviewChangesView } from '@/components/editor/ReviewChangesView';
import { WorkflowView } from '@/components/editor/WorkflowView';
import { fileSystem } from '@/services/fileSystem';
import { applyBlockReview, applyDiffReview, applyHunkReview } from '@/services/fileRollback';
import { markTabSaved, setTabContent } from '@/store/slices/editorTabs';
import { updateDiffBlockStatus, updateDiffStatus, updateHunkStatus } from '@/store/slices/conversation';
import { addNotification } from '@/store/slices/notifications';
import { useEffect, useState } from 'react';

export function EditorArea() {
  const dispatch = useAppDispatch();
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const activeTabId = useAppSelector((s: RootState) => s.editorTabs.activeTabId);
  const conversation = useAppSelector((s: RootState) => s.conversation);
  const activeTab = tabs.find((t: { id: string }) => t.id === activeTabId);

  const renderContent = () => {
    if (!activeTab || activeTab.type === 'welcome') {
      return <WelcomePage />;
    }

    switch (activeTab.type) {
      case 'pdf':
        return (
          <PdfFileViewer
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      case 'markdown':
        return (
          <MarkdownViewer
            tabId={activeTab.id}
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
            tabContent={activeTab.content}
            savedContent={activeTab.savedContent}
            dirty={activeTab.isDirty}
          />
        );

      case 'html':
        return (
          <HtmlViewer
            tabId={activeTab.id}
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
            tabContent={activeTab.content}
            savedContent={activeTab.savedContent}
            dirty={activeTab.isDirty}
          />
        );

      case 'docx':
        return (
          <DocxViewer
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      case 'image':
        return (
          <ImageViewer
            src={fileSystem.getFileUrl(activeTab.filePath) || activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      case 'video':
        return (
          <MediaPlayer
            src={activeTab.filePath}
            fileName={activeTab.fileName}
            type="video"
          />
        );

      case 'showcase':
        return (
          <ShowcaseFrame
            url={activeTab.filePath}
            title={activeTab.fileName}
          />
        );

      case 'code':
        return (
          <CodeFileViewer
            tabId={activeTab.id}
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
            tabContent={activeTab.content}
            savedContent={activeTab.savedContent}
            dirty={activeTab.isDirty}
            dispatch={dispatch}
          />
        );

      case 'review':
        return (
          <ReviewChangesView
            diffs={conversation.pendingDiffs}
            snapshots={conversation.fileSnapshots}
            onAccept={async (diffId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              const snapshot = diff?.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
              if (!diff) return;
              try {
                await applyDiffReview(diff, snapshot, 'accepted');
                dispatch(updateDiffStatus({ diffId, status: 'accepted' }));
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '接受失败', message: err?.message || diff.path }));
              }
            }}
            onReject={async (diffId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              const snapshot = diff?.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
              if (!diff) return;
              try {
                await applyDiffReview(diff, snapshot, 'rejected');
                dispatch(updateDiffStatus({ diffId, status: 'rejected' }));
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '回退失败', message: err?.message || diff.path }));
              }
            }}
            onAcceptHunk={async (diffId, hunkId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              const snapshot = diff?.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
              if (!diff) return;
              try {
                await applyHunkReview(diff, snapshot, hunkId, 'accepted');
                dispatch(updateHunkStatus({ diffId, hunkId, status: 'accepted' }));
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '局部接受失败', message: err?.message || diff.path }));
              }
            }}
            onRejectHunk={async (diffId, hunkId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              const snapshot = diff?.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
              if (!diff) return;
              try {
                await applyHunkReview(diff, snapshot, hunkId, 'rejected');
                dispatch(updateHunkStatus({ diffId, hunkId, status: 'rejected' }));
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: '局部回退失败', message: err?.message || diff.path }));
              }
            }}
            onAcceptBlock={async (diffId, hunkId, blockId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              const snapshot = diff?.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
              if (!diff) return;
              try {
                await applyBlockReview(diff, snapshot, hunkId, blockId, 'accepted');
                dispatch(updateDiffBlockStatus({ diffId, hunkId, blockId, status: 'accepted' }));
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: 'inline 接受失败', message: err?.message || diff.path }));
              }
            }}
            onRejectBlock={async (diffId, hunkId, blockId) => {
              const diff = conversation.pendingDiffs.find(item => item.id === diffId);
              const snapshot = diff?.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
              if (!diff) return;
              try {
                await applyBlockReview(diff, snapshot, hunkId, blockId, 'rejected');
                dispatch(updateDiffBlockStatus({ diffId, hunkId, blockId, status: 'rejected' }));
              } catch (err: any) {
                dispatch(addNotification({ type: 'error', title: 'inline 回退失败', message: err?.message || diff.path }));
              }
            }}
          />
        );

      // ★ M3-3b：子代理中间视图（点击对话流 WorkflowCard 打开的 tab）。
      case 'workflow':
        return activeTab.workflowRunId
          ? <WorkflowView runId={activeTab.workflowRunId} />
          : (
            <div className="editor-placeholder">
              <div className="placeholder-content">
                <span style={{ fontSize: 32, opacity: 0.3 }}>🧩</span>
                <p>缺少工作流运行实例</p>
              </div>
            </div>
          );

      case 'pptx':
        return (
          <PptxViewer
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      case 'office':
        return (
          <OfficeViewer
            filePath={activeTab.filePath}
            fileName={activeTab.fileName}
          />
        );

      case 'unsupported':
        return (
          <UnsupportedViewer
            fileName={activeTab.fileName}
            filePath={activeTab.filePath}
          />
        );

      default:
        return (
          <div className="editor-placeholder">
            <div className="placeholder-content">
              <span style={{ fontSize: 32, opacity: 0.3 }}>📄</span>
              <p>{activeTab.fileName}</p>
              <p className="placeholder-hint">{activeTab.type} 类型查看器开发中</p>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="editor-area glass-panel">
      <TabBar />
      <div className="editor-content">
        {renderContent()}
      </div>
    </div>
  );
}

function PdfFileViewer({ filePath, fileName }: { filePath: string; fileName: string }) {
  const [data, setData] = useState<ArrayBuffer | string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError('');
        const objectUrl = fileSystem.getFileUrl(filePath);
        if (objectUrl) {
          if (!cancelled) setData(objectUrl);
          return;
        }
        const binary = await fileSystem.readBinary(filePath);
        if (!cancelled) setData(binary);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'PDF 加载失败');
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  if (error) {
    return (
      <div className="pdf-viewer-loading">
        ⚠️ {fileName}: {error}
      </div>
    );
  }

  if (!data) {
    return <div className="pdf-viewer-loading">📄 加载 PDF 中...</div>;
  }

  return <PdfViewer data={data} currentPage={1} />;
}

function UnsupportedViewer({ fileName, filePath }: { fileName: string; filePath: string }) {
  return (
    <div className="editor-placeholder">
      <div className="placeholder-content unsupported-viewer">
        <span style={{ fontSize: 32, opacity: 0.5 }}>📄</span>
        <p>{fileName}</p>
        <p className="placeholder-hint">当前版本暂不支持内置预览，请用系统应用打开。</p>
        <p className="placeholder-hint">{filePath}</p>
      </div>
    </div>
  );
}

function CodeFileViewer({
  tabId,
  filePath,
  fileName,
  tabContent,
  savedContent,
  dirty,
  dispatch,
}: {
  tabId: string;
  filePath: string;
  fileName: string;
  tabContent?: string;
  savedContent?: string;
  dirty: boolean;
  dispatch: ReturnType<typeof useAppDispatch>;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (tabContent !== undefined) {
      setContent(tabContent);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const text = await fileSystem.readFile(filePath);
        if (!cancelled) {
          setContent(text);
          dispatch(setTabContent({ id: tabId, content: text, markSaved: true }));
        }
      } catch (err: any) {
        if (!cancelled) setContent(`无法加载文件: ${filePath}\n${err?.message || ''}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dispatch, filePath, tabContent, tabId]);

  if (loading) {
    return <div className="markdown-viewer-loading">📄 加载文件中...</div>;
  }

  return (
    <CodeEditor
      filename={fileName}
      content={content}
      dirty={dirty}
      savedContent={savedContent}
      readOnly={false}
      onChange={(nextContent) => {
        dispatch(setTabContent({ id: tabId, content: nextContent }));
      }}
      onSave={async (nextContent) => {
        await fileSystem.writeFile(filePath, nextContent);
        setContent(nextContent);
        dispatch(markTabSaved({ id: tabId, content: nextContent }));
        dispatch(addNotification({ type: 'success', title: '已保存', message: fileName, duration: 2000 }));
      }}
    />
  );
}
