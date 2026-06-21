/**
 * useAtMention —— Plan_5_M6 C6：把 AgentPanel 底部输入框的整套两级 @ 菜单逻辑抽成可复用 hook，
 * 让「底部主输入框」与「编辑历史消息的输入框」共用同一套 @ 体验（富文本 + 两级类型菜单 + 内联 atomic token），
 * 消除两套输入框分叉。
 *
 * 封装：menu 两级状态机 + 候选取数(竞态守卫) + 键盘交互(导航/回退/提交) + AtTypeMenu 受控渲染 + atConvCache 预热。
 * 调用方各自配一个 RichTextInput（richRef）+ 提交回调；提交键可配（底部 Ctrl+Enter / 编辑框 Enter）。
 *
 * 对抗审查修正全部沿用（HIGH-1/2 重锚定 / P13 竞态 / MEDIUM-2 cache 抖动 / LOW-1 closeMenu 收口）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { setSidebarVisible } from '@/store/slices/layout';
import { setActiveView } from '@/store/slices/sidebar';
import type { CompletionItem } from '@/services/inputCommands/types';
import type { RichTextInputHandle, AtType, AtTrigger } from '@/services/inputCommands/richInput/types';
import { AT_TYPE_ENTRIES, fetchTypeItems } from '@/services/inputCommands/atProviders';
import { detectSlashTrigger } from '@/services/inputCommands/richInput/atTrigger';
import { commandRegistry } from '@/services/inputCommands/commandRegistry';
import { listConversationSummaries } from '@/services/conversationPersistence';
import type { ConversationSummary } from '@/store/slices/conversationHistory';
import { AtTypeMenu } from '@/components/chat/AtTypeMenu';

interface MenuState {
  open: boolean;
  mode: 'at' | 'slash';
  level: 'type' | 'item';
  selectedType: AtType | null;
  query: string;
  trigger: AtTrigger | null;
  items: CompletionItem[];
  activeIndex: number;
  loading: boolean;
}

const INITIAL_MENU: MenuState = { open: false, mode: 'at', level: 'type', selectedType: null, query: '', trigger: null, items: [], activeIndex: 0, loading: false };

interface UseAtMentionOptions {
  richRef: RefObject<RichTextInputHandle | null>;
  /** Ctrl+Enter（底部）或 Enter（编辑框）触发的提交回调（发送 / 保存）。 */
  onSubmit: () => void;
  /** true=单 Enter 提交（编辑框）；false（默认）=Ctrl+Enter 提交（底部，Enter 留作换行）。 */
  submitOnPlainEnter?: boolean;
  /** 插/删 token 等程序化改动后回调（父组件据此更新 canSend 等派生态；onContentChange 不会被程序化改动触发）。 */
  onAfterMutate?: () => void;
}

interface UseAtMentionResult {
  /** 受控菜单元素（放到输入框容器内、RichTextInput 之前）。 */
  menuElement: ReactNode;
  /** 传给 RichTextInput 的 onEditorKeyDown（返回 true=已消费）。 */
  handleEditorKeyDown: (e: KeyboardEvent) => boolean;
  /** 传给 RichTextInput 的 onContentChange（探测 @ / 命令触发刷新菜单）。 */
  refreshMenu: () => void;
  /** 关闭菜单（统一收口）。 */
  closeMenu: () => void;
}

export function useAtMention({ richRef, onSubmit, submitOnPlainEnter = false, onAfterMutate }: UseAtMentionOptions): UseAtMentionResult {
  const dispatch = useAppDispatch();
  const [menu, setMenu] = useState<MenuState>(INITIAL_MENU);
  const atRequestSeqRef = useRef(0);
  const [atConvCache, setAtConvCache] = useState<ConversationSummary[] | null>(null);
  const atConvLoadingRef = useRef(false);
  // MEDIUM-2：稳定读取最新 cache 供 fetchSecondLevel（避免其 useCallback 随 cache 变化重建 → 二级 effect 重复 fetch 抖动）。
  const atConvCacheRef = useRef(atConvCache);
  atConvCacheRef.current = atConvCache;

  const closeMenu = useCallback(() => {
    atRequestSeqRef.current++; // LOW-1：关菜单统一丢弃在途二级 fetch。
    setMenu(m => (m.open ? { ...m, open: false, level: 'type', selectedType: null, items: [], activeIndex: 0, loading: false } : m));
  }, []);

  // ★ 二级 fetch（竞态守卫 P13）：每次 ++requestSeq，回调比对丢弃 stale。
  const fetchSecondLevel = useCallback((type: AtType, query: string) => {
    const seq = ++atRequestSeqRef.current;
    setMenu(m => ({ ...m, loading: true }));
    void fetchTypeItems(type, query, { convCache: atConvCacheRef.current })
      .then(items => {
        if (seq !== atRequestSeqRef.current) return;
        setMenu(m => (m.open && m.mode === 'at' && m.selectedType === type) ? { ...m, items, activeIndex: 0, loading: false } : m);
      })
      .catch(() => {
        if (seq !== atRequestSeqRef.current) return;
        setMenu(m => (m.open && m.selectedType === type) ? { ...m, items: [], loading: false } : m);
      });
  }, []);

  // onContentChange 后：① @ 触发 → 两级类型菜单；② / 命令 → 单层命令菜单；都不命中关闭。IME 守卫在 RichTextInput。
  const refreshMenu = useCallback(() => {
    const root = richRef.current?.getElement();
    if (!root) { closeMenu(); return; }
    const at = richRef.current!.getAtTrigger();
    if (at) {
      if (atConvCacheRef.current === null && !atConvLoadingRef.current) {
        atConvLoadingRef.current = true;
        void listConversationSummaries({})
          .then(list => setAtConvCache(list))
          .catch(() => setAtConvCache([]))
          .finally(() => { atConvLoadingRef.current = false; });
      }
      setMenu(m => ({
        ...m,
        open: true,
        mode: 'at',
        level: m.open && m.mode === 'at' && m.selectedType ? 'item' : 'type',
        query: at.query,
        trigger: at,
        items: m.open && m.mode === 'at' && m.selectedType ? m.items : [],
        activeIndex: 0,
      }));
      return;
    }
    const slash = detectSlashTrigger(root);
    if (slash) {
      const items = commandRegistry.filter(slash.query);
      if (items.length === 0) { closeMenu(); return; }
      setMenu(m => ({ ...m, open: true, mode: 'slash', level: 'item', selectedType: null, query: slash.query, trigger: null, items, activeIndex: 0, loading: false }));
      return;
    }
    closeMenu();
  }, [closeMenu, richRef]);

  // 二级：query / 类型变化 → 重取候选。
  useEffect(() => {
    if (!menu.open || menu.mode !== 'at' || menu.level !== 'item' || !menu.selectedType) return;
    fetchSecondLevel(menu.selectedType, menu.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu.open, menu.mode, menu.level, menu.selectedType, menu.query, fetchSecondLevel]);

  // MEDIUM-2：@对话二级打开期间 atConvCache 异步 load 完成 → 仅此时重取一次。
  useEffect(() => {
    if (menu.open && menu.mode === 'at' && menu.level === 'item' && menu.selectedType === 'conversation') {
      fetchSecondLevel('conversation', menu.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atConvCache]);

  const applyTypeSelect = useCallback((type: AtType) => {
    setMenu(m => ({ ...m, mode: 'at', level: 'item', selectedType: type, query: '', items: [], activeIndex: 0, loading: true }));
  }, []);

  const applyTokenCompletion = useCallback((item: CompletionItem) => {
    const meta = (item.meta ?? {}) as Record<string, unknown>;
    if (menu.mode === 'slash') {
      const name = String(meta.name ?? item.label.replace(/^\//, '').split(/\s/)[0]);
      richRef.current?.setContent([`/${name} `]);
      richRef.current?.focus();
      onAfterMutate?.();
      closeMenu();
      return;
    }
    const type = (meta.type as AtType) ?? menu.selectedType;
    if (type === 'settings') {
      const sectionId = String(meta.sectionId ?? meta.id ?? '');
      dispatch(setActiveView('settings'));
      dispatch(setSidebarVisible(true));
      if (sectionId) {
        requestAnimationFrame(() => { window.dispatchEvent(new CustomEvent('synapse:settings-focus-section', { detail: sectionId })); });
      }
      closeMenu();
      return;
    }
    // 其余六类：插内联 atomic token。HIGH-1/2：插前重新 detect 锚点（避 IME normalize 后 startNode 游离）。
    const trigger = richRef.current?.getAtTrigger() ?? menu.trigger;
    const id = String(meta.id ?? '');
    const value = String(meta.value ?? item.label);
    if (type && trigger && id) {
      richRef.current?.insertTokenAt(trigger, { type, id, value });
      onAfterMutate?.();
    }
    closeMenu();
  }, [menu.mode, menu.selectedType, menu.trigger, dispatch, closeMenu, richRef, onAfterMutate]);

  const handleEditorKeyDown = useCallback((e: KeyboardEvent): boolean => {
    // 提交键：底部 Ctrl+Enter（即便菜单开也提交）；编辑框 Enter（仅菜单关时提交，菜单开让位选候选）。
    const isSubmit = submitOnPlainEnter
      ? (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)
      : (e.key === 'Enter' && e.ctrlKey);
    if (isSubmit && (!submitOnPlainEnter || !menu.open)) {
      e.preventDefault();
      onSubmit();
      return true;
    }
    if (!menu.open) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const len = menu.mode === 'at' && menu.level === 'type' ? AT_TYPE_ENTRIES.length : menu.items.length;
      setMenu(m => ({ ...m, activeIndex: Math.min(m.activeIndex + 1, Math.max(0, len - 1)) }));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMenu(m => ({ ...m, activeIndex: Math.max(m.activeIndex - 1, 0) }));
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (menu.mode === 'at' && menu.level === 'type') {
        const entry = AT_TYPE_ENTRIES[menu.activeIndex];
        if (entry) applyTypeSelect(entry.type);
      } else {
        const item = menu.items[menu.activeIndex];
        if (item) applyTokenCompletion(item);
      }
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (menu.mode === 'at' && menu.level === 'item') {
        atRequestSeqRef.current++;
        setMenu(m => ({ ...m, level: 'type', selectedType: null, items: [], activeIndex: 0, loading: false }));
      } else {
        closeMenu();
      }
      return true;
    }
    return false;
  }, [submitOnPlainEnter, menu.open, menu.mode, menu.level, menu.items, menu.activeIndex, applyTypeSelect, applyTokenCompletion, closeMenu, onSubmit]);

  const menuElement = (
    <AtTypeMenu
      open={menu.open}
      level={menu.level}
      typeEntries={AT_TYPE_ENTRIES}
      items={menu.items}
      activeIndex={menu.activeIndex}
      loading={menu.loading}
      selectedType={menu.selectedType}
      onSelectType={applyTypeSelect}
      onSelectItem={applyTokenCompletion}
      onActiveIndexChange={(idx) => setMenu(m => ({ ...m, activeIndex: idx }))}
      onBack={() => { atRequestSeqRef.current++; setMenu(m => ({ ...m, level: 'type', selectedType: null, items: [], activeIndex: 0, loading: false })); }}
    />
  );

  return { menuElement, handleEditorKeyDown, refreshMenu, closeMenu };
}
