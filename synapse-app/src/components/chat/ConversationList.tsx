/**
 * ConversationList — 对话历史侧边栏组件
 * 显示历史对话、新建对话、切换/删除对话、搜索过滤和批量管理。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import type { ConversationSummary } from '@/store/slices/conversationHistory';
import { removeConversation, setConversations, setSelectedId, updateConversation } from '@/store/slices/conversationHistory';
import { clearConversation, setConversation } from '@/store/slices/conversation';
import { addNotification } from '@/store/slices/notifications';
import {
  deleteConversationSnapshot,
  deleteConversationSnapshots,
  exportConversationSnapshot,
  exportConversationSnapshots,
  listConversationSummaries,
  loadConversationSnapshot,
  renameConversation,
  saveConversationSnapshot,
  updateConversationMetadata,
  updateConversationsMetadata,
  type ConversationListFilters,
} from '@/services/conversationPersistence';
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckSquare,
  Download,
  Edit3,
  MessageSquare,
  Plus,
  Search,
  Square,
  Tags,
  Trash2,
  X,
} from 'lucide-react';

type ArchiveFilter = 'active' | 'archived' | 'all';

function splitTags(value: string): string[] {
  return [...new Set(value
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean))]
    .slice(0, 12);
}

function joinTags(tags?: string[]): string {
  return (tags ?? []).join(', ');
}

function stop(event: MouseEvent): void {
  event.stopPropagation();
}

function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  URL.revokeObjectURL(url);
}

export function ConversationList() {
  const dispatch = useAppDispatch();
  const conversations = useAppSelector((s) => s.conversationHistory.conversations);
  const selectedId = useAppSelector((s) => s.conversationHistory.selectedId);
  const currentConversation = useAppSelector((s) => s.conversation);
  const [searchQuery, setSearchQuery] = useState('');
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('active');
  const [tagFilter, setTagFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [tagDraft, setTagDraft] = useState('');

  const activeFilters = useMemo<ConversationListFilters>(() => ({
    query: searchQuery,
    archived: archiveFilter,
    tags: splitTags(tagFilter),
    limit: 200,
  }), [archiveFilter, searchQuery, tagFilter]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allVisibleSelected = conversations.length > 0 && conversations.every(conv => selectedSet.has(conv.id));
  const selectedConversations = conversations.filter(conv => selectedSet.has(conv.id));

  const refreshConversations = useCallback(async (filters = activeFilters) => {
    setIsLoading(true);
    try {
      const summaries = await listConversationSummaries(filters);
      dispatch(setConversations(summaries));
    } catch {
      dispatch(addNotification({ type: 'error', title: '加载失败', message: '无法读取对话历史' }));
    } finally {
      setIsLoading(false);
    }
  }, [activeFilters, dispatch]);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setIsLoading(true);
      void listConversationSummaries(activeFilters)
        .then(summaries => {
          if (!cancelled) dispatch(setConversations(summaries));
        })
        .catch(() => {
          if (!cancelled) {
            dispatch(addNotification({ type: 'error', title: '搜索失败', message: '无法搜索对话历史' }));
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeFilters, dispatch]);

  useEffect(() => {
    setSelectedIds(prev => prev.filter(id => conversations.some(conv => conv.id === id)));
  }, [conversations]);

  const saveCurrentToHistory = useCallback(async () => {
    try {
      const summary = await saveConversationSnapshot({
        id: currentConversation.id,
        title: currentConversation.title,
        messages: currentConversation.messages,
        model: currentConversation.model,
        assistantRuns: currentConversation.assistantRuns,
        fileSnapshots: currentConversation.fileSnapshots,
        pendingDiffs: currentConversation.pendingDiffs,
        timestamp: Date.now(),
      });
      if (summary) dispatch(updateConversation(summary));
      return summary?.id ?? null;
    } catch {
      dispatch(addNotification({ type: 'warning', title: '自动保存失败', message: '当前对话保存失败，但仍会继续打开历史' }));
      return null;
    }
  }, [currentConversation, dispatch]);

  const handleNewConversation = useCallback(async () => {
    await saveCurrentToHistory();
    dispatch(clearConversation());
    dispatch(setSelectedId(null));
    setSelectedIds([]);
    setIsBulkMode(false);
    await refreshConversations({ ...activeFilters, query: '' });
    dispatch(addNotification({ type: 'info', title: '新对话', message: '已创建新对话' }));
  }, [activeFilters, saveCurrentToHistory, refreshConversations, dispatch]);

  const handleSwitchConversation = useCallback(async (id: string) => {
    await saveCurrentToHistory();
    try {
      const snapshot = await loadConversationSnapshot(id);
      if (!snapshot) throw new Error('missing conversation');
      dispatch(setConversation({
        id,
        title: snapshot.title || '对话',
        messages: snapshot.messages,
        model: snapshot.model,
        assistantRuns: snapshot.assistantRuns,
        fileSnapshots: snapshot.fileSnapshots,
        pendingDiffs: snapshot.pendingDiffs,
      }));
      dispatch(setSelectedId(id));
      await refreshConversations();
    } catch {
      dispatch(addNotification({ type: 'error', title: '加载失败', message: '无法加载对话历史' }));
    }
  }, [saveCurrentToHistory, refreshConversations, dispatch]);

  const handleItemClick = useCallback((conv: ConversationSummary) => {
    if (isBulkMode) {
      setSelectedIds(prev => prev.includes(conv.id) ? prev.filter(id => id !== conv.id) : [...prev, conv.id]);
      return;
    }
    void handleSwitchConversation(conv.id);
  }, [handleSwitchConversation, isBulkMode]);

  const toggleBulkMode = useCallback(() => {
    setIsBulkMode(prev => {
      const next = !prev;
      if (!next) setSelectedIds([]);
      return next;
    });
  }, []);

  const toggleSelected = useCallback((id: string, event: MouseEvent) => {
    stop(event);
    setSelectedIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  }, []);

  const toggleSelectVisible = useCallback(() => {
    setSelectedIds(allVisibleSelected ? [] : conversations.map(conv => conv.id));
  }, [allVisibleSelected, conversations]);

  const handleDeleteConversation = useCallback(async (id: string, event: MouseEvent) => {
    stop(event);
    const conv = conversations.find((item) => item.id === id);
    if (!window.confirm(`确定删除对话「${conv?.title || '未命名对话'}」吗？这不会删除工作区文件。`)) return;

    await deleteConversationSnapshot(id);
    dispatch(removeConversation(id));
    if (selectedId === id) {
      dispatch(setSelectedId(null));
      dispatch(clearConversation());
    }
    await refreshConversations();
    dispatch(addNotification({ type: 'info', title: '已删除', message: '对话已删除，工作区文件未受影响' }));
  }, [conversations, selectedId, refreshConversations, dispatch]);

  const handleBulkDelete = useCallback(async () => {
    if (!selectedIds.length) return;
    if (!window.confirm(`确定删除选中的 ${selectedIds.length} 条对话吗？这不会删除工作区文件。`)) return;
    setBulkBusy(true);
    try {
      await deleteConversationSnapshots(selectedIds);
      selectedIds.forEach(id => dispatch(removeConversation(id)));
      if (selectedId && selectedIds.includes(selectedId)) {
        dispatch(setSelectedId(null));
        dispatch(clearConversation());
      }
      setSelectedIds([]);
      await refreshConversations();
      dispatch(addNotification({ type: 'info', title: '批量删除完成', message: '已删除所选对话，工作区文件未受影响' }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '批量删除失败', message: '部分对话未能删除' }));
    } finally {
      setBulkBusy(false);
    }
  }, [dispatch, refreshConversations, selectedId, selectedIds]);

  const handleExportConversation = useCallback(async (id: string, event: MouseEvent) => {
    stop(event);
    try {
      const snapshot = await exportConversationSnapshot(id);
      if (!snapshot) throw new Error('missing conversation');
      const conv = conversations.find((item) => item.id === id);
      const exportData = {
        ...snapshot,
        title: snapshot.title || conv?.title || '对话',
        model: snapshot.model || conv?.model,
        exportedAt: new Date().toISOString(),
      };
      downloadJson(`synapse-${conv?.title || 'conversation'}-${Date.now()}.json`, exportData);
      dispatch(addNotification({ type: 'info', title: '导出成功', message: '对话已导出为 JSON' }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '导出失败', message: '无法导出对话' }));
    }
  }, [conversations, dispatch]);

  const handleBulkExport = useCallback(async () => {
    if (!selectedIds.length) return;
    setBulkBusy(true);
    try {
      const bundle = await exportConversationSnapshots(selectedIds, activeFilters);
      downloadJson(`synapse-conversations-${selectedIds.length}-${Date.now()}.json`, bundle);
      dispatch(addNotification({ type: 'info', title: '批量导出成功', message: `已导出 ${bundle.conversations.length} 条对话` }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '批量导出失败', message: '无法导出所选对话' }));
    } finally {
      setBulkBusy(false);
    }
  }, [activeFilters, dispatch, selectedIds]);

  const setArchivedForIds = useCallback(async (ids: string[], archived: boolean) => {
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      await updateConversationsMetadata(ids, { archived });
      ids.forEach(id => dispatch(updateConversation({ id, archived })));
      setSelectedIds([]);
      await refreshConversations();
      dispatch(addNotification({
        type: 'info',
        title: archived ? '已归档' : '已取消归档',
        message: `已更新 ${ids.length} 条对话`,
      }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '归档失败', message: '无法更新所选对话' }));
    } finally {
      setBulkBusy(false);
    }
  }, [dispatch, refreshConversations]);

  const editSingleTags = useCallback(async (conv: ConversationSummary, event: MouseEvent) => {
    stop(event);
    const next = window.prompt('输入标签，用英文逗号分隔', joinTags(conv.tags));
    if (next === null) return;
    const tags = splitTags(next);
    await updateConversationMetadata(conv.id, { tags });
    dispatch(updateConversation({ id: conv.id, tags }));
    await refreshConversations();
  }, [dispatch, refreshConversations]);

  const addTagToSelected = useCallback(async () => {
    const tagsToAdd = splitTags(tagDraft);
    if (!tagsToAdd.length || !selectedConversations.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(selectedConversations.map(async conv => {
        const tags = [...new Set([...(conv.tags ?? []), ...tagsToAdd])].slice(0, 12);
        await updateConversationMetadata(conv.id, { tags });
        dispatch(updateConversation({ id: conv.id, tags }));
      }));
      setTagDraft('');
      await refreshConversations();
      dispatch(addNotification({ type: 'info', title: '标签已添加', message: `已更新 ${selectedConversations.length} 条对话` }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '标签更新失败', message: '无法添加标签' }));
    } finally {
      setBulkBusy(false);
    }
  }, [dispatch, refreshConversations, selectedConversations, tagDraft]);

  const removeTagFromSelected = useCallback(async () => {
    const tagsToRemove = new Set(splitTags(tagDraft).map(tag => tag.toLowerCase()));
    if (!tagsToRemove.size || !selectedConversations.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(selectedConversations.map(async conv => {
        const tags = (conv.tags ?? []).filter(tag => !tagsToRemove.has(tag.toLowerCase()));
        await updateConversationMetadata(conv.id, { tags });
        dispatch(updateConversation({ id: conv.id, tags }));
      }));
      setTagDraft('');
      await refreshConversations();
      dispatch(addNotification({ type: 'info', title: '标签已移除', message: `已更新 ${selectedConversations.length} 条对话` }));
    } catch {
      dispatch(addNotification({ type: 'error', title: '标签更新失败', message: '无法移除标签' }));
    } finally {
      setBulkBusy(false);
    }
  }, [dispatch, refreshConversations, selectedConversations, tagDraft]);

  const startRename = useCallback((id: string, title: string, event: MouseEvent) => {
    stop(event);
    setEditingId(id);
    setEditingTitle(title);
  }, []);

  const commitRename = useCallback(async (id: string, event?: MouseEvent) => {
    if (event) stop(event);
    const title = editingTitle.trim();
    if (!title) return;

    await renameConversation(id, title);
    dispatch(updateConversation({ id, title }));
    if (currentConversation.id === id) {
      dispatch(setConversation({
        id,
        title,
        messages: currentConversation.messages,
        model: currentConversation.model,
        assistantRuns: currentConversation.assistantRuns,
        fileSnapshots: currentConversation.fileSnapshots,
        pendingDiffs: currentConversation.pendingDiffs,
      }));
    }
    setEditingId(null);
    await refreshConversations();
  }, [currentConversation, editingTitle, refreshConversations, dispatch]);

  return (
    <div className="conversation-list">
      <div className="conversation-list-header">
        <h3><MessageSquare size={14} /> 对话历史</h3>
        <div className="conv-header-actions">
          <button className={`conv-icon-btn glass-panel ${isBulkMode ? 'active' : ''}`} onClick={toggleBulkMode} title="批量管理">
            {isBulkMode ? <CheckSquare size={16} /> : <Square size={16} />}
          </button>
          <button className="conv-icon-btn glass-panel" onClick={() => void handleNewConversation()} title="新建对话">
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="conv-search-bar">
        <Search size={14} className="conv-search-icon" />
        <input
          type="text"
          className="conv-search-input"
          placeholder="搜索对话..."
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {searchQuery && (
          <button className="conv-search-clear" onClick={() => setSearchQuery('')} title="清空搜索">
            <X size={12} />
          </button>
        )}
      </div>

      <div className="conv-filter-row">
        <select className="conv-filter-select" value={archiveFilter} onChange={(event) => setArchiveFilter(event.target.value as ArchiveFilter)}>
          <option value="active">未归档</option>
          <option value="archived">已归档</option>
          <option value="all">全部</option>
        </select>
        <div className="conv-tag-filter">
          <Tags size={12} />
          <input
            value={tagFilter}
            onChange={(event) => setTagFilter(event.target.value)}
            placeholder="标签过滤"
          />
        </div>
      </div>

      {isBulkMode && (
        <div className="conv-bulk-toolbar glass-panel">
          <div className="conv-bulk-topline">
            <button className="conv-small-btn" onClick={toggleSelectVisible} disabled={conversations.length === 0}>
              {allVisibleSelected ? '取消全选' : '全选当前'}
            </button>
            <span>{selectedIds.length} 已选</span>
            <button className="conv-small-btn" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>清空</button>
          </div>
          <div className="conv-bulk-actions">
            <button className="conv-small-btn" onClick={() => void handleBulkExport()} disabled={!selectedIds.length || bulkBusy}>
              <Download size={12} /> 导出
            </button>
            <button className="conv-small-btn" onClick={() => void setArchivedForIds(selectedIds, true)} disabled={!selectedIds.length || bulkBusy}>
              <Archive size={12} /> 归档
            </button>
            <button className="conv-small-btn" onClick={() => void setArchivedForIds(selectedIds, false)} disabled={!selectedIds.length || bulkBusy}>
              <ArchiveRestore size={12} /> 还原
            </button>
            <button className="conv-small-btn danger" onClick={() => void handleBulkDelete()} disabled={!selectedIds.length || bulkBusy}>
              <Trash2 size={12} /> 删除
            </button>
          </div>
          <div className="conv-bulk-tags">
            <input
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              placeholder="标签，逗号分隔"
            />
            <button className="conv-small-btn" onClick={() => void addTagToSelected()} disabled={!selectedIds.length || !tagDraft.trim() || bulkBusy}>添加</button>
            <button className="conv-small-btn" onClick={() => void removeTagFromSelected()} disabled={!selectedIds.length || !tagDraft.trim() || bulkBusy}>移除</button>
          </div>
        </div>
      )}

      <div className="conversation-list-items">
        {conversations.length === 0 ? (
          <div className="conv-empty">
            <MessageSquare size={32} style={{ opacity: 0.3 }} />
            <p>{isLoading ? '正在读取对话...' : searchQuery || tagFilter ? '未找到匹配的对话' : '暂无历史对话'}</p>
            {!searchQuery && !tagFilter && <p className="conv-hint">发送消息后，对话将自动保存</p>}
          </div>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              className={`conv-item glass-panel ${selectedId === conv.id ? 'active' : ''} ${selectedSet.has(conv.id) ? 'selected' : ''}`}
              onClick={() => handleItemClick(conv)}
              onDoubleClick={() => !isBulkMode && void handleSwitchConversation(conv.id)}
            >
              {isBulkMode ? (
                <button
                  className="conv-select-btn"
                  onClick={(event) => toggleSelected(conv.id, event)}
                  title={selectedSet.has(conv.id) ? '取消选择' : '选择'}
                >
                  {selectedSet.has(conv.id) ? <CheckSquare size={15} /> : <Square size={15} />}
                </button>
              ) : (
                <div className="conv-item-icon">
                  <MessageSquare size={14} />
                </div>
              )}
              <div className="conv-item-info">
                {editingId === conv.id ? (
                  <input
                    className="conv-title-input"
                    value={editingTitle}
                    autoFocus
                    onClick={stop}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onBlur={() => void commitRename(conv.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void commitRename(conv.id);
                      if (event.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <div className="conv-item-title" title={conv.title}>{conv.title}</div>
                )}
                <div className="conv-item-preview">{conv.lastMessage}</div>
                {(conv.archived || Boolean(conv.tags?.length)) && (
                  <div className="conv-tags">
                    {conv.archived && <span className="conv-tag archived">已归档</span>}
                    {(conv.tags ?? []).slice(0, 3).map(tag => <span key={tag} className="conv-tag">{tag}</span>)}
                    {(conv.tags?.length ?? 0) > 3 && <span className="conv-tag muted">+{(conv.tags?.length ?? 0) - 3}</span>}
                  </div>
                )}
                <div className="conv-item-meta">
                  <span>{conv.messageCount} 条消息</span>
                  <span>{new Date(conv.timestamp).toLocaleDateString('zh-CN')}</span>
                </div>
              </div>
              <div className="conv-item-actions">
                <button
                  className="conv-item-action"
                  onClick={(event) => editingId === conv.id ? void commitRename(conv.id, event) : startRename(conv.id, conv.title, event)}
                  title={editingId === conv.id ? '保存标题' : '编辑标题'}
                >
                  {editingId === conv.id ? <Check size={12} /> : <Edit3 size={12} />}
                </button>
                <button
                  className="conv-item-action"
                  onClick={(event) => void editSingleTags(conv, event)}
                  title="编辑标签"
                >
                  <Tags size={12} />
                </button>
                <button
                  className="conv-item-action"
                  onClick={(event) => {
                    stop(event);
                    void setArchivedForIds([conv.id], !conv.archived);
                  }}
                  title={conv.archived ? '取消归档' : '归档'}
                >
                  {conv.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                </button>
                <button
                  className="conv-item-action"
                  onClick={(event) => void handleExportConversation(conv.id, event)}
                  title="导出"
                >
                  <Download size={12} />
                </button>
                <button
                  className="conv-item-action danger"
                  onClick={(event) => void handleDeleteConversation(conv.id, event)}
                  title="删除"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
