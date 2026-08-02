import { useEffect, useRef, useState } from 'react';
import {
  Ellipsis,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import { FrioIcon } from './FrioIcon';
import type { Conversation } from '../types';
import { Logo } from './Logo';

export const MODELS = [
  { id: 'gemma4:31b-cloud', label: 'Lite' },
  { id: 'nemotron-3-super:cloud', label: 'Pro' },
  { id: 'minimax-m3:cloud', label: 'Max' },
];

function formatDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  open: boolean;
  onToggle: () => void;
}

export function Sidebar({
  conversations,
  activeId,
  onNew,
  onSelect,
  onDelete,
  onOpenSettings,
  open,
  onToggle,
}: SidebarProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [logoHover, setLogoHover] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const historyTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLogoHover(false);
  }, [open]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    return () => {
      if (historyTimer.current) window.clearTimeout(historyTimer.current);
    };
  }, []);

  const q = query.trim().toLowerCase();
  const visibleConversations = q
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
    : conversations;

  const openHistory = () => {
    if (historyTimer.current) {
      window.clearTimeout(historyTimer.current);
      historyTimer.current = null;
    }
    setHistoryOpen(true);
  };

  const closeHistory = () => {
    if (historyTimer.current) window.clearTimeout(historyTimer.current);
    historyTimer.current = window.setTimeout(() => setHistoryOpen(false), 180);
  };

  if (!open) {
    return (
      <aside className="sidebar collapsed">
        <button
          className="rail-logo"
          onClick={onToggle}
          title="Expand sidebar"
          onMouseEnter={() => setLogoHover(true)}
          onMouseLeave={() => setLogoHover(false)}
        >
          {logoHover ? <PanelLeftOpen size={22} /> : <Logo />}
        </button>
        <button
          className="rail-btn"
          title="Search chats"
          onClick={() => {
            onToggle();
            setSearchOpen(true);
          }}
        >
          <Search size={18} />
        </button>
        <button className="rail-btn" onClick={onNew} title="New chat">
          <Plus size={18} strokeWidth={2.6} />
        </button>
        <div
          className="rail-pop"
          onMouseEnter={openHistory}
          onMouseLeave={closeHistory}
        >
          <button className="rail-btn" title="Chat history">
            <Ellipsis size={18} />
          </button>
          {historyOpen && (
            <div className="history-pop">
              <div className="history-pop-head">Chats</div>
              {conversations.length === 0 && (
                <div className="history-empty">No chats yet</div>
              )}
              {conversations.map((c) => (
                <button
                  key={c.id}
                  className={`history-item${c.id === activeId ? ' active' : ''}`}
                  onClick={() => {
                    onSelect(c.id);
                    setHistoryOpen(false);
                  }}
                >
                  <span className="history-title">{c.title || 'New chat'}</span>
                  <span className="history-date">{formatDate(c.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className="rail-btn rail-settings"
          onClick={onOpenSettings}
          title="Settings"
        >
          <SettingsIcon size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <a
          className="logo"
          href="#"
          title="New chat"
          onClick={(e) => {
            e.preventDefault();
            onNew();
          }}
        >
          <Logo />
        </a>
        <div className="sidebar-head-actions">
          <button
            className="collapse-btn"
            title="Search chats"
            onClick={() => setSearchOpen((o) => !o)}
          >
            <Search size={18} />
          </button>
          <button className="collapse-btn" onClick={onToggle} title="Collapse sidebar">
            <PanelLeftClose size={18} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="chat-search">
          <Search size={14} />
          <input
            ref={searchRef}
            className="chat-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
          />
        </div>
      )}

      <button className="new-chat-btn" onClick={onNew}>
        <Plus size={16} strokeWidth={2.6} />
        New chat
      </button>

      <div className="conv-list">
        {conversations.length === 0 && (
          <p className="composer-hint" style={{ padding: '8px 4px' }}>
            No conversations yet
          </p>
        )}
        {conversations.length > 0 && visibleConversations.length === 0 && (
          <p className="composer-hint" style={{ padding: '8px 4px' }}>
            No matches
          </p>
        )}
        {visibleConversations.map((c) => (
          <div
            key={c.id}
            className={`conv-item${c.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(c.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(c.id);
            }}
          >
            <FrioIcon size={16} className="conv-item-icon" />
            <span className="conv-item-title">{c.title || 'New chat'}</span>
            <span className="conv-item-date">{formatDate(c.updatedAt)}</span>
            <button
              className="conv-del"
              title="Delete chat"
              onClick={(e) => {
                e.stopPropagation();
                if (confirmDelete === c.id) {
                  onDelete(c.id);
                  setConfirmDelete(null);
                } else {
                  setConfirmDelete(c.id);
                  setTimeout(() => setConfirmDelete(null), 2500);
                }
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <button
          className="settings-sidebar-btn"
          onClick={onOpenSettings}
          title="Settings"
        >
          <SettingsIcon size={16} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
