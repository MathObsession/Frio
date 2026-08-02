import type { Conversation } from '../types';
import { getUsername } from './auth';

const LEGACY_KEY = 'frio.conversations.v1';

function storageKey(): string {
  const user = getUsername();
  return user ? `frio.conversations.${user}.v1` : LEGACY_KEY;
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    const copy = conversations.map((c) => ({
      ...c,
      messages: c.messages.map((m) => {
        const mCopy = { ...m };
        if (mCopy.images && mCopy.images.length > 0) mCopy.images = mCopy.images;
        return mCopy;
      }),
    }));
    localStorage.setItem(storageKey(), JSON.stringify(copy));
  } catch {
    // Storage quota exceeded: retry without heavy base64 payloads.
    const lean = conversations.map((c) => ({
      ...c,
      messages: c.messages.map((m) => ({
        ...m,
        images: undefined,
        attachments: m.attachments?.map((a) => ({ ...a, data: undefined })),
      })),
    }));
    try {
      localStorage.setItem(storageKey(), JSON.stringify(lean));
    } catch {
      /* give up silently */
    }
  }
}

export function uid(): string {
  return crypto.randomUUID();
}
