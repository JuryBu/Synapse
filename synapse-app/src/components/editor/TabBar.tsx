import { X, FileCode, FileText, Image, Film, Presentation, BookOpen, Globe, Home, Settings, ListChecks, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { closeTab, markTabSaved, setActiveTab } from '@/store/slices/editorTabs';
import type { RootState } from '@/store';
import { useCallback, useEffect, useRef } from 'react';
import { resolveUnsavedTabs } from '@/services/unsavedChanges';

const tabIcons: Record<string, React.ElementType> = {
  code: FileCode,
  pdf: FileText,
  pptx: Presentation,
  docx: BookOpen,
  office: BookOpen,
  markdown: FileText,
  html: Globe,
  image: Image,
  video: Film,
  showcase: Globe,
  welcome: Home,
  settings: Settings,
  review: ListChecks,
  unsupported: FileText,
};

export function TabBar() {
  const dispatch = useAppDispatch();
  const tabs = useAppSelector((s: RootState) => s.editorTabs.tabs);
  const activeTabId = useAppSelector((s: RootState) => s.editorTabs.activeTabId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const tab = tabs.find(item => item.id === tabId);
    if (tab?.isDirty) {
      const ok = await resolveUnsavedTabs([tab], '关闭标签');
      if (!ok) return;
      dispatch(markTabSaved({ id: tab.id, content: tab.content }));
    }
    dispatch(closeTab(tabId));
  }, [dispatch, tabs]);

  const handleMiddleClick = useCallback(async (e: React.MouseEvent, tabId: string) => {
    if (e.button === 1) {
      e.preventDefault();
      const tab = tabs.find(item => item.id === tabId);
      if (tab?.isDirty) {
        const ok = await resolveUnsavedTabs([tab], '关闭标签');
        if (!ok) return;
        dispatch(markTabSaved({ id: tab.id, content: tab.content }));
      }
      dispatch(closeTab(tabId));
    }
  }, [dispatch, tabs]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY;
    }
  }, []);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    scrollRef.current?.scrollBy({
      left: direction === 'left' ? -220 : 220,
      behavior: 'smooth',
    });
  }, []);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeTabId, tabs.length]);

  return (
    <div className="tab-strip">
      <button className="tab-scroll-btn" type="button" onClick={() => scrollTabs('left')} title="向左滚动标签" aria-label="向左滚动标签">
        <ChevronLeft size={14} />
      </button>
      <div className="tab-bar" ref={scrollRef} onWheel={handleWheel}>
        {tabs.map(tab => {
          const Icon = tabIcons[tab.type] || FileCode;
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              ref={isActive ? activeTabRef : undefined}
              className={`tab-item ${isActive ? 'active' : ''} ${tab.isPreview ? 'preview' : ''}`}
              onClick={() => dispatch(setActiveTab(tab.id))}
              onMouseDown={(e) => handleMiddleClick(e, tab.id)}
              title={tab.filePath || tab.fileName}
            >
              <Icon size={14} className={`tab-icon tab-icon-${tab.type}`} />
              <span className="tab-label">
                {tab.fileName}
                {tab.isDirty && <span className="tab-dirty">●</span>}
              </span>
              {tab.type !== 'welcome' && (
                <button
                  className="tab-close"
                  onClick={(e) => handleClose(e, tab.id)}
                  title="关闭"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button className="tab-scroll-btn" type="button" onClick={() => scrollTabs('right')} title="向右滚动标签" aria-label="向右滚动标签">
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
