import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import type { Attachment, ChatMessage, Conversation } from './types';
import { DEFAULT_MODEL, fetchModels, streamChat } from './lib/ollama';
import { loadConversations, saveConversations, uid } from './lib/storage';
import { checkAuth, exchangeOAuthCode, logout, startCloudflareOAuth } from './lib/auth';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type UserSettings,
} from './lib/settings';
import { Sidebar, MODELS } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { EmptyState } from './components/EmptyState';
import { Composer } from './components/Composer';
import { Landing } from './components/Landing';
import { Logo } from './components/Logo';
import { Settings } from './components/Settings';

const SYSTEM_PROMPT: ChatMessage = {
  id: 'system',
  role: 'system',
  content: [
    'You are Frio, a bold, sharp and friendly AI assistant.',
    'You answer clearly, concisely and with a bit of personality.',
    'When the user attaches images or audio, analyze them carefully and respond about what you see or hear.',
    'When files are attached, read their contents and reference them by name.',
    'Use Markdown for structure: headings, lists and code blocks where helpful.',
    'Never use emojis or emoticons in your responses.',
  ].join(' '),
  createdAt: 0,
};

function systemMessages(settings: UserSettings): ChatMessage[] {
  const personality = settings.personality.trim();
  if (!personality) return [SYSTEM_PROMPT];
  return [
    SYSTEM_PROMPT,
    {
      id: 'system-personality',
      role: 'system',
      content: `Personality and style instructions from the user:\n${personality}`,
      createdAt: 0,
    },
  ];
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'authed' | 'guest'>('loading');
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [think, setThink] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [newChatKey, setNewChatKey] = useState(0);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const conversationsRef = useRef(conversations);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    const code = params.get('code');
    if (oauth === '1' && code) {
      exchangeOAuthCode(code)
        .then(() => setAuthState('authed'))
        .catch(() => setAuthState('guest'))
        .finally(() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('oauth');
          url.searchParams.delete('code');
          window.history.replaceState({}, '', url.toString());
        });
      return;
    }
    if (oauth === 'error') {
      const reason = params.get('e') || 'authorization failed';
      const url = new URL(window.location.href);
      url.searchParams.delete('oauth');
      url.searchParams.delete('e');
      window.history.replaceState({}, '', url.toString());
      setOauthError(reason);
      setAuthState('guest');
      return;
    }
    void checkAuth().then((ok) => setAuthState(ok ? 'authed' : 'guest'));
  }, []);

  useEffect(() => {
    if (authState !== 'authed') return;
    const list = loadConversations();
    setConversations(list);
    setActiveId(list.length > 0 ? list[0].id : null);
    setSettings(loadSettings());
  }, [authState]);

  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme =
        settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : settings.theme;
      root.dataset.theme = theme;
    };
    apply();
    if (settings.theme === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [settings.theme]);

  useEffect(() => {
    if (authState !== 'authed') return;
    const t = setTimeout(() => saveSettings(settings), 300);
    return () => clearTimeout(t);
  }, [settings, authState]);

  const handleLogout = () => {
    void logout().then(() => {
      setConversations([]);
      setAuthState('guest');
      setActiveId(null);
    });
  };

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    if (authState !== 'authed') return;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    const t = setTimeout(() => saveConversations(conversations), 500);
    return () => clearTimeout(t);
  }, [conversations, authState]);

  useEffect(() => {
    if (authState !== 'authed') return;
    let cancelled = false;
    const check = async () => {
      try {
        const list = await fetchModels();
        if (cancelled) return;
        setModel((cur) => {
          if (list.some((m) => m.name === cur)) return cur;
          if (list.some((m) => m.name === DEFAULT_MODEL)) return DEFAULT_MODEL;
          return cur;
        });
      } catch {
        /* Ollama offline — retry on next poll */
      }
    };
    void check();
    const id = window.setInterval(check, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authState]);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;

  const runStream = useCallback(
    async (convId: string, baseMessages: ChatMessage[], assistantId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      streamingRef.current = true;
      setIsStreaming(true);

      const audioIncluded = baseMessages.some(
        (m) => m.images && m.images.length > 0 && m.role === 'user',
      );
      const effectiveThink = think && !audioIncluded;

      try {
        await streamChat({
          model,
          messages: [...systemMessages(settings), ...baseMessages],
          think: effectiveThink,
          signal: controller.signal,
          onThinking: (piece) => {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      messages: c.messages.map((m) =>
                        m.id === assistantId
                          ? { ...m, thinking: (m.thinking ?? '') + piece }
                          : m,
                      ),
                    }
                  : c,
              ),
            );
          },
          onDelta: (piece) => {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      messages: c.messages.map((m) =>
                        m.id === assistantId ? { ...m, content: m.content + piece } : m,
                      ),
                    }
                  : c,
              ),
            );
          },
          onDone: () => {
            /* placeholder */
          },
        });
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  updatedAt: Date.now(),
                  messages: c.messages.map((m) =>
                    m.id === assistantId ? { ...m, streaming: false } : m,
                  ),
                }
              : c,
          ),
        );
      } catch (e) {
        const aborted = controller.signal.aborted;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          streaming: false,
                          error: !aborted,
                          content:
                            aborted || m.content
                              ? m.content
                              : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`,
                        }
                      : m,
                  ),
                }
              : c,
          ),
        );
        if (!aborted) console.error(e);
      } finally {
        streamingRef.current = false;
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [model, think, settings],
  );

  const sendMessage = useCallback(
    async (rawText: string, attachments: Attachment[]) => {
      if (streamingRef.current) return;
      const text = rawText.trim();

      const images: string[] = [];
      const parts: string[] = [];
      if (text) parts.push(text);

      for (const a of attachments) {
        if (a.kind === 'text' || a.kind === 'pdf') {
          if (a.textContent) parts.push(`[Attached file: ${a.name}]\n${a.textContent}`);
          else parts.push(`[Attached file: ${a.name}]`);
        } else {
          if (a.data) images.push(a.data);
          parts.push(`[Attached ${a.kind}: ${a.name}]`);
        }
      }
      const content = parts.join('\n\n');

      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content,
        attachments,
        images: images.length > 0 ? images : undefined,
        createdAt: Date.now(),
      };
      const assistantId = uid();

      let convId = activeId;
      let baseMessages: ChatMessage[];

      if (!convId) {
        convId = uid();
        baseMessages = [userMsg];
        const conv: Conversation = {
          id: convId,
          title: text.slice(0, 48) || attachments[0]?.name || 'New chat',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [userMsg],
        };
        setConversations((prev) => [conv, ...prev]);
        setActiveId(convId);
      } else {
        const existing = conversationsRef.current.find((c) => c.id === convId);
        baseMessages = existing ? [...existing.messages, userMsg] : [userMsg];
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, updatedAt: Date.now(), messages: [...c.messages, userMsg] }
              : c,
          ),
        );
      }

      const placeholder: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        thinking: '',
        createdAt: Date.now(),
        streaming: true,
      };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? { ...c, messages: [...c.messages, placeholder] }
            : c,
        ),
      );

      void runStream(convId, baseMessages, assistantId);
    },
    [activeId, runStream],
  );

  const regenerate = useCallback(async () => {
    const conv = conversationsRef.current.find((c) => c.id === activeId);
    if (!conv || streamingRef.current) return;
    const idx = findLastUserIndex(conv.messages);
    if (idx < 0) return;
    const baseMessages = conv.messages.slice(0, idx + 1);
    const assistantId = uid();
    const convId = conv.id;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: [
                ...c.messages.slice(0, idx + 1),
                {
                  id: assistantId,
                  role: 'assistant',
                  content: '',
                  thinking: '',
                  createdAt: Date.now(),
                  streaming: true,
                },
              ],
            }
          : c,
      ),
    );
    void runStream(convId, baseMessages, assistantId);
  }, [activeId, runStream]);

  const editMessage = useCallback(
    (convId: string, messageId: string, newContent: string) => {
      if (streamingRef.current) return;
      const conv = conversationsRef.current.find((c) => c.id === convId);
      if (!conv) return;
      const idx = conv.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const target = conv.messages[idx];
      if (target.content === newContent) return;
      const oldResponse =
        conv.messages[idx + 1]?.role === 'assistant' ? conv.messages[idx + 1].content : '';
      const history = target.history ? [...target.history, target.content] : [target.content];
      const responses = target.responses ? [...target.responses, oldResponse] : [oldResponse];
      if (
        history.length > 1 &&
        history[history.length - 1] === history[history.length - 2]
      ) {
        history.pop();
        responses.pop();
      }
      const baseMessages = conv.messages.slice(0, idx + 1).map((m, i) =>
        i === idx ? { ...m, content: newContent, history, responses } : m,
      );
      const assistantId = uid();
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                updatedAt: Date.now(),
                messages: [
                ...baseMessages,
                {
                  id: assistantId,
                  role: 'assistant',
                  content: '',
                  thinking: '',
                  createdAt: Date.now(),
                  streaming: true,
                },
              ],
            }
          : c,
        ),
    );
    void runStream(convId, baseMessages, assistantId);
  },
  [runStream],
  );

  const revertMessage = useCallback(
    (convId: string, messageId: string, content: string, response: string) => {
      if (streamingRef.current) return;
      const conv = conversationsRef.current.find((c) => c.id === convId);
      if (!conv) return;
      const idx = conv.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const target = conv.messages[idx];
      const history = [...(target.history ?? [])];
      const responses = [...(target.responses ?? [])];
      const vIdx = history.indexOf(content);
      if (vIdx < 0) return;
      const oldResponse =
        conv.messages[idx + 1]?.role === 'assistant' ? conv.messages[idx + 1].content : '';
      const newHistory = history.filter((_, k) => k !== vIdx);
      const newResponses = responses.filter((_, k) => k !== vIdx);
      newHistory.push(target.content);
      newResponses.push(oldResponse);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                updatedAt: Date.now(),
                messages: [
                  ...c.messages.slice(0, idx),
                  { ...target, content, history: newHistory, responses: newResponses },
                  {
                    id: uid(),
                    role: 'assistant',
                    content: response,
                    createdAt: conv.messages[idx + 1]?.createdAt ?? Date.now(),
                  },
                ],
              }
            : c,
        ),
      );
    },
    [],
  );

  const newChat = useCallback(() => {
    if (streamingRef.current) return;
    setActiveId(null);
    setNewChatKey((k) => k + 1);
  }, []);

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) setActiveId(null);
    },
    [activeId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  if (authState === 'loading') {
    return (
      <div className="app-splash">
        <Logo />
      </div>
    );
  }

  if (authState === 'guest') {
    return <Landing onOAuth={startCloudflareOAuth} error={oauthError} />;
  }

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onNew={newChat}
        onSelect={setActiveId}
        onDelete={deleteConversation}
        onOpenSettings={() => setSettingsOpen(true)}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
      />
      <main className="chat">
        <header className="topbar">
          <div className="brand-dropdown">
            <span className="chat-brand">Frio</span>
            <ChevronDown size={14} className="brand-caret" />
            <div className="brand-menu">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  className={`brand-model${model === m.id ? ' active' : ''}`}
                  onClick={() => setModel(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <button className="topbar-logout" onClick={handleLogout} title="Sign out">
            <LogOut size={16} />
          </button>
        </header>
        {activeConversation ? (
          <>
            <ChatView
              conversation={activeConversation}
              isStreaming={isStreaming}
              onRegenerate={() => void regenerate()}
              onEdit={(messageId, content) =>
                editMessage(activeConversation.id, messageId, content)
              }
              onRevert={(messageId, content, response) =>
                revertMessage(activeConversation.id, messageId, content, response)
              }
            />
            <Composer
              isStreaming={isStreaming}
              onSend={sendMessage}
              onStop={stop}
              think={think}
              onThinkChange={setThink}
            />
          </>
        ) : (
          <div className="empty-center">
            <EmptyState key={newChatKey} />
            <Composer
              isStreaming={isStreaming}
              onSend={sendMessage}
              onStop={stop}
              think={think}
              onThinkChange={setThink}
            />
          </div>
        )}
      </main>
      {settingsOpen && (
        <Settings
          settings={settings}
          onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
