import { useState, useCallback, useEffect, useRef } from 'react';
import { FileCode, FolderOpen, BookOpen, Sparkles, Clock, Trash2 } from 'lucide-react';
import { fileSystem } from '@/services/fileSystem';
import { useAppDispatch } from '@/store/hooks';
import { useAppSelector } from '@/store/hooks';
import { addNotification } from '@/store/slices/notifications';
import { openWorkspace } from '@/store/slices/workspace';
import { clearWorkspace } from '@/store/slices/workspace';
import { resetTabsToWelcome } from '@/store/slices/editorTabs';
import { setActiveView } from '@/store/slices/sidebar';
import { setSidebarVisible } from '@/store/slices/layout';
import { resolveUnsavedTabs } from '@/services/unsavedChanges';
import type { RootState } from '@/store';
import { isElectron } from '@platform/index';

export function WelcomePage() {
  const dispatch = useAppDispatch();
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const [workspaces, setWorkspaces] = useState(fileSystem.getWorkspaces());
  const [dragging, setDragging] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = fileSystem.subscribe(() => {
      setWorkspaces([...fileSystem.getWorkspaces()]);
    });
    return () => { unsub(); };
  }, []);

  const handleNewCourse = useCallback(async () => {
    const ok = await resolveUnsavedTabs(tabs, '新建课程');
    if (!ok) return;
    const name = prompt('课程名称:');
    if (name) {
      const ws = fileSystem.createWorkspace(name);
      dispatch(resetTabsToWelcome());
      dispatch(openWorkspace({ path: ws.path, name: ws.name }));
      dispatch(setActiveView('explorer'));
      dispatch(setSidebarVisible(true));
      dispatch(addNotification({ type: 'success', title: '创建成功', message: `工作区 "${name}" 已创建` }));
    }
  }, [dispatch, tabs]);

  const handleSwitchWorkspace = useCallback(async (id: string) => {
    const ok = await resolveUnsavedTabs(tabs, '切换工作区');
    if (!ok) return;
    fileSystem.switchWorkspace(id);
    const ws = fileSystem.getWorkspaces().find(w => w.id === id);
    if (ws) {
      dispatch(resetTabsToWelcome());
      dispatch(openWorkspace({ path: ws.path, name: ws.name }));
      dispatch(setActiveView('explorer'));
      dispatch(setSidebarVisible(true));
    }
    dispatch(addNotification({ type: 'info', title: '切换工作区', message: ws?.name || '工作区已切换' }));
  }, [dispatch, tabs]);

  const handleOpenWorkspace = useCallback(async () => {
    const ok = await resolveUnsavedTabs(tabs, '打开工作区');
    if (!ok) return;
    if (isElectron && window.synapse?.workspace) {
      const ws = await window.synapse.workspace.open();
        if (ws) {
          fileSystem.openExternalWorkspace({ ...ws, lastOpened: Date.now() });
          dispatch(resetTabsToWelcome());
          dispatch(openWorkspace({ path: ws.path, name: ws.name }));
        dispatch(setActiveView('explorer'));
        dispatch(setSidebarVisible(true));
        dispatch(addNotification({ type: 'success', title: '打开工作区', message: ws.name }));
      }
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    (input as any).webkitdirectory = true;
    input.onchange = async (e: any) => {
      const files = Array.from(e.target?.files || []) as File[];
      if (files.length === 0) return;
      const firstRelative = (files[0] as any).webkitRelativePath as string | undefined;
      const name = firstRelative?.split('/')[0] || '导入工作区';
      const ws = fileSystem.createWorkspaceFromFiles(name, files);
      dispatch(resetTabsToWelcome());
      dispatch(openWorkspace({ path: ws.path, name: ws.name }));
      dispatch(setActiveView('explorer'));
      dispatch(setSidebarVisible(true));
      dispatch(addNotification({ type: 'success', title: '打开工作区', message: `已导入 ${files.length} 个文件` }));
    };
    input.click();
  }, [dispatch, tabs]);

  const handleDeleteWorkspace = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const ok = await resolveUnsavedTabs(tabs, '删除工作区记录');
    if (!ok) return;
    if (confirm('确定删除此工作区？')) {
      fileSystem.deleteWorkspace(id);
      dispatch(resetTabsToWelcome());
      const current = fileSystem.getWorkspaces().find(w => w.id === fileSystem.getCurrentWorkspace());
      if (current) {
        dispatch(openWorkspace({ path: current.path, name: current.name }));
      } else {
        dispatch(clearWorkspace());
      }
    }
  }, [dispatch, tabs]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.pptx,.docx,.md,.txt,.html,.htm';
    input.multiple = true;
    input.onchange = async (e: any) => {
      const files = Array.from(e.target?.files || []) as File[];
      if (files.length > 0) {
        await fileSystem.uploadFiles(files);
        dispatch(addNotification({ type: 'success', title: '导入成功', message: `已导入 ${files.length} 个文件` }));
      }
    };
    input.click();
  }, [dispatch]);

  // Drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await fileSystem.uploadFiles(files);
      dispatch(addNotification({ type: 'success', title: '上传成功', message: `已上传 ${files.length} 个文件` }));
    }
  }, [dispatch]);

  return (
    <div
      ref={dropRef}
      className={`welcome-page ${dragging ? 'dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="welcome-hero">
        <div className="welcome-logo">
          <span className="welcome-emoji">🧠</span>
          <h1 className="welcome-brand">
            <span className="gradient-text">Synapse</span>
          </h1>
          <p className="welcome-tagline">AI 驱动的交互式学习平台</p>
        </div>

        <div className="welcome-actions-grid">
          <WelcomeAction icon={FolderOpen} title="打开工作区" desc="选择文件夹开始学习" accent="var(--syn-accent)" onClick={handleOpenWorkspace} />
          <WelcomeAction icon={BookOpen} title="新建课程" desc="创建新的学习空间" accent="var(--syn-primary-light)" onClick={handleNewCourse} />
          <WelcomeAction icon={FileCode} title="导入课件" desc="拖拽 PDF / PPTX / DOCX" accent="#10b981" onClick={handleImport} />
          <WelcomeAction icon={Sparkles} title="AI 助手" desc="在右侧面板开始对话" accent="#f59e0b" onClick={() => {
            window.dispatchEvent(new CustomEvent('synapse:focus-agent-input'));
          }} />
        </div>

        <div className="welcome-recent">
          <h3 className="welcome-section-title">
            <Clock size={14} />
            <span>最近工作区</span>
          </h3>
          <div className="welcome-recent-list">
            {workspaces.length === 0 ? (
              <div className="welcome-recent-empty">
                <p>暂无最近打开的工作区</p>
              </div>
            ) : (
              workspaces
                .sort((a, b) => b.lastOpened - a.lastOpened)
                .slice(0, 5)
                .map(ws => (
                  <div
                    key={ws.id}
                    className="welcome-recent-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSwitchWorkspace(ws.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') handleSwitchWorkspace(ws.id);
                    }}
                  >
                    <FolderOpen size={16} />
                    <div className="recent-item-info">
                      <span className="recent-item-name">{ws.name}</span>
                      <span className="recent-item-time">{new Date(ws.lastOpened).toLocaleDateString()}</span>
                    </div>
                    <button className="recent-item-delete" onClick={(e) => handleDeleteWorkspace(e, ws.id)} title="删除">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
            )}
          </div>
        </div>

        <div className="welcome-tips">
          <p>💡 将文件拖入窗口以导入课件</p>
          <p>🔑 前往<strong>设置 → AI</strong>配置 API Key 开始对话</p>
          <p>⌨️ <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> 打开命令面板</p>
        </div>
      </div>

      {dragging && (
        <div className="welcome-drop-overlay">
          <div className="welcome-drop-icon">📂</div>
          <p>释放文件以导入</p>
        </div>
      )}
    </div>
  );
}

function WelcomeAction({ icon: Icon, title, desc, accent, onClick }: {
  icon: React.ElementType; title: string; desc: string; accent: string; onClick?: () => void;
}) {
  return (
    <button className="welcome-action-card" style={{ '--action-accent': accent } as React.CSSProperties} onClick={onClick}>
      <Icon size={24} strokeWidth={1.5} />
      <span className="action-title">{title}</span>
      <span className="action-desc">{desc}</span>
    </button>
  );
}
