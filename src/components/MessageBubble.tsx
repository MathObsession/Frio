import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Image as ImageIcon,
  Lightbulb,
  Pencil,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import type { Attachment, ChatMessage } from '../types';
import { Markdown } from './Markdown';

function dataUrl(mime: string, data?: string): string {
  return `data:${mime};base64,${data ?? ''}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
  if (attachment.kind === 'image' && attachment.data) {
    return (
      <img
        className="thumb"
        src={dataUrl(attachment.mime || 'image/jpeg', attachment.data)}
        alt={attachment.name}
        loading="lazy"
      />
    );
  }
  if (attachment.kind === 'audio' && attachment.data) {
    return (
      <audio className="msg-audio" controls src={dataUrl('audio/wav', attachment.data)} />
    );
  }
  const Icon = attachment.kind === 'pdf' ? FileText : ImageIcon;
  return (
    <span className="chip" title={attachment.textContent ? 'Contents read by Frio' : undefined}>
      <Icon size={14} />
      <span className="chip-name">{attachment.name}</span>
    </span>
  );
}

export function MessageBubble({
  message,
  canRegenerate,
  onRegenerate,
  onEdit,
  onRevert,
}: {
  message: ChatMessage;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onEdit: (messageId: string, content: string) => void;
  onRevert: (messageId: string, content: string, response: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [viewPos, setViewPos] = useState(0);
  const [thinkingOpen, setThinkingOpen] = useState(false);

  const history = message.history ?? [];
  const responses = message.responses ?? [];
  const len = history.length;
  const pos = Math.min(viewPos, len);
  const displayed = pos === 0 ? message.content : history[len - pos];

  const startEdit = () => {
    setDraft(displayed);
    setEditing(true);
  };

  const saveEdit = () => {
    const text = draft.trim();
    if (!text || text === displayed) {
      setEditing(false);
      return;
    }
    onEdit(message.id, text);
    setEditing(false);
    setViewPos(0);
  };

  const revertTo = () => {
    if (pos === 0) return;
    onRevert(message.id, history[len - pos], responses[len - pos] ?? '');
    setViewPos(0);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={`msg ${message.role}${message.error ? ' error' : ''}`}>
      {message.role === 'user' && (
        <div className="msg-avatar">
          <ImageIcon size={16} strokeWidth={2.4} />
        </div>
      )}
      <div className="msg-body">
        {message.attachments && message.attachments.length > 0 && (
          <div className="attachments">
            {message.attachments.map((a) => (
              <AttachmentView key={a.id} attachment={a} />
            ))}
          </div>
        )}
        {message.role === 'user' && editing ? (
          <div className="msg-edit">
            <textarea
              className="msg-edit-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                } else if (e.key === 'Escape') {
                  setEditing(false);
                }
              }}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              autoFocus
            />
            <div className="msg-edit-actions">
              <button className="icon-btn" onClick={() => setEditing(false)} title="Cancel">
                <X size={14} />
              </button>
              <button className="icon-btn" onClick={saveEdit} title="Save">
                <Check size={14} />
              </button>
            </div>
          </div>
        ) : (
          <div className="msg-bubble">
            {message.role === 'assistant' ? (
              <>
                {message.thinking ? (
                  <div className={`msg-thinking${thinkingOpen ? ' open' : ''}`}>
                    <button
                      type="button"
                      className="msg-thinking-toggle"
                      onClick={() => setThinkingOpen((o) => !o)}
                      title={thinkingOpen ? 'Hide reasoning' : 'Show reasoning'}
                    >
                      <Lightbulb size={13} />
                      <span>Thinking</span>
                      <ChevronDown size={14} className="msg-thinking-caret" />
                    </button>
                    {thinkingOpen && (
                      <div className="msg-thinking-text">{message.thinking}</div>
                    )}
                  </div>
                ) : null}
                <Markdown content={message.content} />
                {message.sources && message.sources.length > 0 && (
                  <div className="msg-sources">
                    <span className="msg-sources-title">Sources</span>
                    {message.sources.map((s, i) => (
                      <a
                        key={`${s.url}-${i}`}
                        className="msg-sources-link"
                        href={s.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={s.snippet}
                      >
                        {s.title}
                      </a>
                    ))}
                  </div>
                )}
                {message.streaming && <span className="cursor" />}
              </>
            ) : (
              <>
                {displayed}
                {pos > 0 && <span className="msg-version-badge">Edited</span>}
              </>
            )}
          </div>
        )}
        <div className="msg-meta">
          <span>{formatTime(message.createdAt)}</span>
          {message.role === 'assistant' && message.provider && (
            <span className="msg-provider" title="Model served by this provider">
              <span className={`msg-provider-dot ${message.provider}`} />
              Answered by {message.provider === 'cloudflare' ? 'Cloudflare' : 'Ollama'}
            </span>
          )}
          {message.role === 'user' && !editing && (
            <span className="msg-actions">
              <button className="icon-btn" onClick={startEdit} title="Edit">
                <Pencil size={14} />
              </button>
              {len > 0 && (
                <>
                  <button
                    className="icon-btn"
                    onClick={() => setViewPos((v) => Math.min(len, v + 1))}
                    title="Older version"
                    disabled={pos >= len}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => setViewPos((v) => Math.max(0, v - 1))}
                    title="Newer version"
                    disabled={pos === 0}
                  >
                    <ChevronRight size={14} />
                  </button>
                  {pos > 0 && (
                    <button className="icon-btn" onClick={revertTo} title="Revert to this version">
                      <Undo2 size={14} />
                    </button>
                  )}
                </>
              )}
            </span>
          )}
          {message.role === 'assistant' && !message.streaming && (
            <span className="msg-actions">
              <button className="icon-btn" onClick={copy} title="Copy">
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              {canRegenerate && (
                <button className="icon-btn" onClick={onRegenerate} title="Regenerate">
                  <RefreshCw size={14} />
                </button>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
