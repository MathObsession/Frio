import { useEffect, useRef } from 'react';
import type { Conversation } from '../types';
import { MessageBubble } from './MessageBubble';

export function ChatView({
  conversation,
  isStreaming,
  onRegenerate,
  onEdit,
  onRevert,
}: {
  conversation: Conversation;
  isStreaming: boolean;
  onRegenerate: () => void;
  onEdit: (messageId: string, content: string) => void;
  onRevert: (messageId: string, content: string, response: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.messages]);

  const lastIndex = conversation.messages.length - 1;
  const lastUserIndex = (() => {
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      if (conversation.messages[i].role === 'user') return i;
    }
    return -1;
  })();

  return (
    <>
      <div className="chat-scroll" ref={scrollRef}>
        <div className="messages">
          {conversation.messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              canRegenerate={
                !isStreaming &&
                !m.streaming &&
                m.role === 'assistant' &&
                i === lastIndex &&
                lastUserIndex < i
              }
              onRegenerate={onRegenerate}
              onEdit={onEdit}
              onRevert={onRevert}
            />
          ))}
        </div>
      </div>
    </>
  );
}
