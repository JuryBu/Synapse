import { useState, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Copy, FolderOpen, Edit, Trash2, FilePlus, FolderPlus } from 'lucide-react';
import type { FileNode } from '@/services/fileSystem';
import { fileSystem } from '@/services/fileSystem';
import { ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { useAppDispatch } from '@/store/hooks';
import { useAppSelector } from '@/store/hooks';
import { addNotification } from '@/store/slices/notifications';
import { closeTab } from '@/store/slices/editorTabs';
import { resolveUnsavedTabs } from '@/services/unsavedChanges';
import type { RootState } from '@/store';
import { isElectron } from '@platform/index';

interface ContextMenuState {
  x: number;
  y: number;
  mode: 'node' | 'blank';
  node: FileNode;
}

function findTreeNode(node: FileNode, path: string): FileNode | null {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const found = findTreeNode(child, path);
    if (found) return found;
  }
  return null;
}

function collectDescendantFilePaths(node: FileNode): string[] {
  if (node.type === 'file') return [node.path];
  const paths: string[] = [];
  for (const child of node.children ?? []) {
    paths.push(...collectDescendantFilePaths(child));
  }
  return paths;
}

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
  onFileClick?: (node: FileNode) => void;
  onContextMenu?: (e: React.MouseEvent, node: FileNode) => void;
  editingPath?: string | null;
  editingName?: string;
  onEditNameChange?: (name: string) => void;
  onEditSubmit?: () => void;
  onEditCancel?: () => void;
}

function FileTreeItem({ node, depth, onFileClick, onContextMenu, editingPath, editingName, onEditNameChange, onEditSubmit, onEditCancel }: FileTreeItemProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDir = node.type === 'directory';
  const isEditing = editingPath === node.path;
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (isDir) {
      setExpanded(prev => !prev);
    } else {
      onFileClick?.(node);
    }
  }, [isDir, node, onFileClick]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(e, node);
  }, [node, onContextMenu]);

  return (
    <>
      <div
        className={`file-tree-item ${isDir ? 'is-dir' : 'is-file'}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={node.path}
      >
        <span className="tree-chevron">
          {isDir ? (
            expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span style={{ width: 14 }} />
          )}
        </span>
        <span className="tree-icon">
          {isDir ? (expanded ? '📂' : '📁') : fileSystem.getFileIcon(node.extension)}
        </span>
        {isEditing ? (
          <input
            ref={inputRef}
            className="tree-rename-input"
            value={editingName || ''}
            onChange={e => onEditNameChange?.(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onEditSubmit?.();
              if (e.key === 'Escape') onEditCancel?.();
            }}
            onBlur={() => onEditCancel?.()}
            autoFocus
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="tree-name">{node.name}</span>
        )}
        {!isDir && node.size && !isEditing && (
          <span className="tree-size">{fileSystem.formatFileSize(node.size)}</span>
        )}
      </div>
      {isDir && expanded && node.children && (
        <div className="tree-children">
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
              editingPath={editingPath}
              editingName={editingName}
              onEditNameChange={onEditNameChange}
              onEditSubmit={onEditSubmit}
              onEditCancel={onEditCancel}
            />
          ))}
        </div>
      )}
    </>
  );
}

interface FileTreeProps {
  root: FileNode;
  onFileClick?: (node: FileNode) => void;
  onRefresh?: () => void;
  onOpenWorkspace?: () => Promise<void> | void;
  onClearWorkspace?: () => Promise<void> | void;
}

export function FileTree({ root, onFileClick, onRefresh, onOpenWorkspace, onClearWorkspace }: FileTreeProps) {
  const dispatch = useAppDispatch();
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    setContextMenu({ x: e.clientX, y: e.clientY, mode: 'node', node });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const notify = useCallback((type: 'success' | 'error' | 'info', title: string, message: string) => {
    dispatch(addNotification({ type, title, message }));
  }, [dispatch]);

  const validateName = useCallback((rawName: string, label: string) => {
    const name = rawName.trim();
    if (!name) {
      notify('error', '名称无效', `${label}不能为空`);
      return null;
    }
    if (/[\\/]/.test(name)) {
      notify('error', '名称无效', `${label}不能包含斜杠`);
      return null;
    }
    return name;
  }, [notify]);

  const moveWebFileEntries = useCallback((oldPaths: string[], oldPrefix: string, newPrefix: string) => {
    const service = fileSystem as any;
    const memoryFiles = service.memoryFiles as Map<string, string> | undefined;
    const memoryFileUrls = service.memoryFileUrls as Map<string, string> | undefined;

    for (const oldPath of oldPaths) {
      const nextPath = `${newPrefix}${oldPath.slice(oldPrefix.length)}`;
      if (memoryFiles?.has(oldPath)) {
        const content = memoryFiles.get(oldPath);
        memoryFiles.delete(oldPath);
        if (content !== undefined) {
          memoryFiles.set(nextPath, content);
        }
      }
      if (memoryFileUrls?.has(oldPath)) {
        const url = memoryFileUrls.get(oldPath);
        memoryFileUrls.delete(oldPath);
        if (url) {
          memoryFileUrls.set(nextPath, url);
        }
      }
    }
  }, []);

  const removeWebFileEntries = useCallback((paths: string[]) => {
    const service = fileSystem as any;
    const memoryFiles = service.memoryFiles as Map<string, string> | undefined;
    const memoryFileUrls = service.memoryFileUrls as Map<string, string> | undefined;

    for (const path of paths) {
      memoryFiles?.delete(path);
      const url = memoryFileUrls?.get(path);
      if (url) {
        URL.revokeObjectURL(url);
        memoryFileUrls?.delete(path);
      }
    }
  }, []);

  const createFileAt = useCallback(async (parentPath: string, fileName: string) => {
    const filePath = `${parentPath}/${fileName}`;
    if (isElectron && window.synapse) {
      await fileSystem.writeFile(filePath, '');
      return filePath;
    }
    return fileSystem.createFile(parentPath, fileName, '');
  }, []);

  // 重命名
  const startRename = useCallback((node: FileNode) => {
    setEditingPath(node.path);
    setEditingName(node.name);
    closeContextMenu();
  }, [closeContextMenu]);

  const submitRename = useCallback(async () => {
    if (!editingPath) {
      setEditingPath(null);
      return;
    }

    const currentNode = findTreeNode(root, editingPath);
    const nextName = validateName(editingName, currentNode?.type === 'directory' ? '文件夹名' : '文件名');
    if (!currentNode || !nextName) {
      setEditingPath(null);
      return;
    }

    const descendantPaths = currentNode.type === 'directory'
      ? collectDescendantFilePaths(currentNode)
      : [];
    const affectedPaths = currentNode.type === 'directory' ? descendantPaths : [currentNode.path];
    const affectedTabs = tabs.filter(tab => affectedPaths.includes(tab.filePath));
    const affectedDirtyTabs = affectedTabs.filter(tab => tab.isDirty);
    if (affectedDirtyTabs.length > 0) {
      const ok = await resolveUnsavedTabs(affectedDirtyTabs, '重命名');
      if (!ok) {
        setEditingPath(null);
        return;
      }
    }

    try {
      const nextPath = await fileSystem.renameFile(editingPath, nextName);
      if (!isElectron && currentNode.type === 'directory' && descendantPaths.length > 0) {
        moveWebFileEntries(descendantPaths, editingPath, nextPath);
      }
      affectedTabs.forEach(tab => dispatch(closeTab(tab.id)));
      onRefresh?.();
      notify('success', '重命名成功', `"${nextName}" 已更新`);
    } catch (err: any) {
      console.error('重命名失败:', err);
      notify('error', '重命名失败', err?.message || '无法完成重命名');
    }
    setEditingPath(null);
  }, [dispatch, editingPath, editingName, moveWebFileEntries, notify, onRefresh, root, tabs, validateName]);

  const cancelRename = useCallback(() => {
    setEditingPath(null);
  }, []);

  // 删除
  const handleDelete = useCallback(async (node: FileNode) => {
    const affectedPaths = node.type === 'directory' ? collectDescendantFilePaths(node) : [node.path];
    const affectedTabs = tabs.filter(tab => affectedPaths.includes(tab.filePath));
    const affectedDirtyTabs = affectedTabs.filter(tab => tab.isDirty);
    const confirmed = window.confirm(`确定删除 ${node.type === 'directory' ? '文件夹' : '文件'} "${node.name}"？`);
    if (!confirmed) return;
    if (affectedDirtyTabs.length > 0) {
      const ok = await resolveUnsavedTabs(affectedDirtyTabs, '删除文件');
      if (!ok) return;
    }

    const descendantPaths = !isElectron && node.type === 'directory'
      ? collectDescendantFilePaths(node)
      : [];

    try {
      if (!isElectron && descendantPaths.length > 0) {
        removeWebFileEntries(descendantPaths);
      }
      await fileSystem.deleteFile(node.path);
      affectedTabs.forEach(tab => dispatch(closeTab(tab.id)));
      onRefresh?.();
      notify('success', '删除成功', `"${node.name}" 已删除`);
    } catch (err: any) {
      console.error('删除失败:', err);
      notify('error', '删除失败', err?.message || '无法删除该项');
    }
    closeContextMenu();
  }, [closeContextMenu, dispatch, notify, onRefresh, removeWebFileEntries, tabs]);

  // 新建文件
  const handleNewFile = useCallback(async (parentNode: FileNode) => {
    const inputName = window.prompt('新文件名:');
    if (inputName === null) return;
    const name = validateName(inputName, '文件名');
    if (!name) return;
    try {
      await createFileAt(parentNode.path, name);
      onRefresh?.();
      notify('success', '创建成功', `已新建文件 "${name}"`);
    } catch (err: any) {
      console.error('创建文件失败:', err);
      notify('error', '创建文件失败', err?.message || '无法创建文件');
    }
    closeContextMenu();
  }, [closeContextMenu, createFileAt, notify, onRefresh, validateName]);

  // 新建文件夹
  const handleNewFolder = useCallback(async (parentNode: FileNode) => {
    const inputName = window.prompt('新文件夹名:');
    if (inputName === null) return;
    const name = validateName(inputName, '文件夹名');
    if (!name) return;
    try {
      await fileSystem.createDirectory(parentNode.path, name);
      onRefresh?.();
      notify('success', '创建成功', `已新建文件夹 "${name}"`);
    } catch (err: any) {
      console.error('创建文件夹失败:', err);
      notify('error', '创建文件夹失败', err?.message || '无法创建文件夹');
    }
    closeContextMenu();
  }, [closeContextMenu, notify, onRefresh, validateName]);

  const handleTreeContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.file-tree-item')) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, mode: 'blank', node: root });
  }, [root]);

  const buildNodeMenuItems = useCallback((node: FileNode): MenuItem[] => {
    const isDir = node.type === 'directory';
    if (isDir) {
      return [
        {
          label: '新建文件',
          icon: <FilePlus size={14} />,
          onClick: () => handleNewFile(node),
        },
        {
          label: '新建文件夹',
          icon: <FolderPlus size={14} />,
          onClick: () => handleNewFolder(node),
        },
        { label: '', onClick: () => { }, separator: true },
        {
          label: '重命名',
          icon: <Edit size={14} />,
          shortcut: 'F2',
          onClick: () => startRename(node),
        },
        {
          label: '删除',
          icon: <Trash2 size={14} />,
          onClick: () => handleDelete(node),
          danger: true,
        },
      ];
    }

    return [
      {
        label: '复制路径',
        icon: <Copy size={14} />,
        onClick: async () => {
          try {
            if (!navigator.clipboard?.writeText) {
              throw new Error('当前环境不支持剪贴板');
            }
            await navigator.clipboard.writeText(node.path);
            notify('success', '复制成功', '文件路径已复制到剪贴板');
          } catch (err: any) {
            notify('error', '复制失败', err?.message || '无法访问剪贴板');
          }
        },
      },
      { label: '', onClick: () => { }, separator: true },
      {
        label: '重命名',
        icon: <Edit size={14} />,
        shortcut: 'F2',
        onClick: () => startRename(node),
      },
      {
        label: '删除',
        icon: <Trash2 size={14} />,
        onClick: () => handleDelete(node),
        danger: true,
      },
    ];
  }, [handleDelete, handleNewFile, handleNewFolder, notify, startRename]);

  const buildBlankMenuItems = useCallback((): MenuItem[] => ([
    {
      label: '新建文件',
      icon: <FilePlus size={14} />,
      onClick: () => handleNewFile(root),
    },
    {
      label: '新建文件夹',
      icon: <FolderPlus size={14} />,
      onClick: () => handleNewFolder(root),
    },
    { label: '', onClick: () => { }, separator: true },
    {
      label: '打开工作区',
      icon: <FolderOpen size={14} />,
      onClick: () => {
        void onOpenWorkspace?.();
      },
    },
    {
      label: '清空工作区',
      icon: <FolderOpen size={14} />,
      onClick: () => {
        void onClearWorkspace?.();
      },
      danger: true,
    },
  ]), [handleNewFile, handleNewFolder, onClearWorkspace, onOpenWorkspace, root]);

  // 拖拽上传
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    await fileSystem.uploadFiles(files, root.path);
    onRefresh?.();
  }, [root.path, onRefresh]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  return (
    <div
      className="file-tree"
      onClick={closeContextMenu}
      onContextMenu={handleTreeContextMenu}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {root.children?.map((child) => (
        <FileTreeItem
          key={child.path}
          node={child}
          depth={0}
          onFileClick={onFileClick}
          onContextMenu={handleContextMenu}
          editingPath={editingPath}
          editingName={editingName}
          onEditNameChange={setEditingName}
          onEditSubmit={submitRename}
          onEditCancel={cancelRename}
        />
      ))}

      {(!root.children || root.children.length === 0) && (
        <div className="file-tree-empty">
          <p>📂 拖拽文件到此处上传</p>
          <p style={{ fontSize: 11, color: 'var(--syn-text-muted)' }}>或右键新建文件</p>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          items={contextMenu.mode === 'blank' ? buildBlankMenuItems() : buildNodeMenuItems(contextMenu.node)}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
