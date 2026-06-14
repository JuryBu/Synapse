import {
  FolderTree,
  Brain,
  Search,
  Settings,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react';

interface ActivityBarItem {
  id: string;
  icon: LucideIcon;
  tooltip: string;
}

const items: ActivityBarItem[] = [
  { id: 'explorer', icon: FolderTree, tooltip: '课件管理' },
  { id: 'synopsis', icon: Brain, tooltip: '知识概要' },
  { id: 'history', icon: MessageSquare, tooltip: '对话历史' },
  { id: 'search', icon: Search, tooltip: '搜索' },
  { id: 'settings', icon: Settings, tooltip: '设置' },
];

interface ActivityBarProps {
  activeView: string;
  onViewClick: (view: any) => void;
}

export function ActivityBar({ activeView, onViewClick }: ActivityBarProps) {
  return (
    <div className="activity-bar glass-panel">
      <div className="activity-bar-top">
        {/* Logo */}
        <button className="activity-bar-logo" title="Synapse">
          <span className="logo-emoji">🧠</span>
        </button>

        {/* Navigation Icons */}
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              className={`activity-bar-item ${isActive ? 'active' : ''}`}
              onClick={() => onViewClick(item.id)}
              title={item.tooltip}
            >
              <Icon size={20} strokeWidth={isActive ? 2 : 1.5} />
              {isActive && <div className="activity-indicator" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
