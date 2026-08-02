import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Loader2,
  Paperclip,
  Plus,
  Square,
  X,
} from 'lucide-react';
import type { Attachment } from '../types';
import { fileToAttachment } from '../lib/files';

interface ComposerProps {
  isStreaming: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  think: boolean;
  onThinkChange: (value: boolean) => void;
}

export function Composer({
  isStreaming,
  onSend,
  onStop,
  think,
  onThinkChange,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [processing, setProcessing] = useState(false);
  const [dragover, setDragover] = useState(false);
  const [addonsOpen, setAddonsOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const addonsRef = useRef<HTMLDivElement>(null);

  const canSend = !isStreaming && !processing && (text.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (!addonsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addonsRef.current && !addonsRef.current.contains(e.target as Node)) {
        setAddonsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [addonsOpen]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setProcessing(true);
    try {
      const results = await Promise.all(list.map((f) => fileToAttachment(f)));
      setAttachments((prev) => [...prev, ...results]);
    } catch (e) {
      console.error(e);
    } finally {
      setProcessing(false);
    }
  };

  const send = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    onSend(trimmed, attachments);
    setText('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (isStreaming) return;
      send();
    }
  };

  return (
    <div className="composer-wrap">
      <div
        className={`composer${dragover ? ' dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragover(true);
        }}
        onDragLeave={() => setDragover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragover(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <div className="attachments-preview">
            {attachments.map((a) => (
              <span className="chip" key={a.id}>
                <span className="chip-name">{a.name}</span>
                <button
                  className="chip-remove"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((p) => p.id !== a.id))
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Message Frio"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isStreaming}
        />
        <div className="composer-row">
          <div className="addons" ref={addonsRef}>
            <button
              className={`addons-btn${addonsOpen ? ' open' : ''}`}
              onClick={() => setAddonsOpen((o) => !o)}
              disabled={isStreaming || processing}
            >
              <Plus size={16} className="addons-plus" />
              <span>Addons</span>
            </button>
            {addonsOpen && (
              <div className="addons-menu">
                <button
                  className="addons-item"
                  onClick={() => {
                    setAddonsOpen(false);
                    fileInputRef.current?.click();
                  }}
                  title="Attach images, audio or files"
                  disabled={isStreaming || processing}
                >
                  {processing ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <Paperclip size={16} />
                  )}
                  <span>Attach files</span>
                </button>
                <label className="addons-think">
                  <span className="addons-think-label">
                    Thinking
                    <small>Reasoning is off unless enabled</small>
                  </span>
                  <button
                    type="button"
                    className={`switch${think ? ' on' : ''}`}
                    role="switch"
                    aria-checked={think}
                    onClick={() => onThinkChange(!think)}
                  >
                    <span className="switch-knob" />
                  </button>
                </label>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept="image/*,audio/*,application/pdf,.pdf,text/plain,.txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.py,.sql,.log,.yaml,.yml"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {isStreaming ? (
            <button className="send-btn" onClick={onStop} title="Stop generating">
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={send}
              disabled={!canSend}
              title="Send"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        Frio runs on Ollama. Images, audio and files can be attached.
      </div>
    </div>
  );
}
