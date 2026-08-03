import type { ChatMessage, ModelInfo } from '../types';
import { authHeaders } from './auth';

export const API_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const DEFAULT_MODEL = 'gemma4:31b-cloud';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${API_BASE}/api/models`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to reach backend (${res.status})`);
  const data = (await res.json()) as { models?: ModelInfo[] };
  return data.models ?? [];
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  think: boolean;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onDone: (fullText: string, provider?: 'cloudflare' | 'ollama') => void;
  onThinking?: (text: string) => void;
}

function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.streaming) continue;
    if (m.role === 'assistant' && !m.content && !m.error) continue;
    out.push({
      role: m.role,
      content: m.content,
      ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
    });
  }
  return out;
}

export async function streamChat({
  model,
  messages,
  think,
  signal,
  onDelta,
  onDone,
  onThinking,
}: StreamChatOptions): Promise<void> {
  const payload = {
    model,
    messages: toOllamaMessages(messages),
    stream: true,
    think,
    keep_alive: '30m',
    options: { num_ctx: 16384 },
  };

  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    let detail = `Backend error (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }

  if (!res.body) throw new Error('No response stream from backend');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let provider: 'cloudflare' | 'ollama' | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const jsonText = trimmed.slice(5).trim();
      if (!jsonText) continue;
      let chunk: {
        content?: string;
        thinking?: string;
        done?: boolean;
        error?: string;
        provider?: 'cloudflare' | 'ollama';
      };
      try {
        chunk = JSON.parse(jsonText);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.provider) provider = chunk.provider;
      if (chunk.thinking && onThinking) {
        onThinking(chunk.thinking);
      }
      const piece = chunk.content ?? '';
      if (piece) {
        fullText += piece;
        onDelta(piece);
      }
      if (chunk.done) {
        onDone(fullText, provider);
        return;
      }
    }
  }
  onDone(fullText, provider);
}
