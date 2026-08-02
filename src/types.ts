export type AttachmentKind = 'image' | 'audio' | 'text' | 'pdf' | 'file';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  /** base64 payload to send to the model (images, converted WAV audio) */
  data?: string;
  /** extracted text for text/pdf files */
  textContent?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  /** base64 payloads passed through to Ollama's `images` field */
  images?: string[];
  /** previous versions of edited user messages, oldest first */
  history?: string[];
  /** assistant response that followed each entry in `history` (parallel array) */
  responses?: string[];
  createdAt: number;
  error?: boolean;
  streaming?: boolean;
  /** model reasoning produced before the answer (when Thinking is on) */
  thinking?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ModelInfo {
  name: string;
  model: string;
  size: number;
  modified_at: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}
