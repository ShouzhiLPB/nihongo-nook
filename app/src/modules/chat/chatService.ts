import type { ChatMessage, ChatSession, PromptMode } from "@/shared/types";
import { nowIso, uid } from "@/shared/utils";

export function createChatSession(lessonId: string, title: string, mode: PromptMode): ChatSession {
  const now = nowIso();
  return {
    id: uid("chat"),
    lessonId,
    title: title.trim() || "新会话",
    mode,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function pushMessage(
  session: ChatSession,
  role: "user" | "assistant",
  content: string,
): ChatSession {
  const nextMessage: ChatMessage = {
    id: uid("msg"),
    role,
    content: content.trim(),
    createdAt: nowIso(),
  };
  return {
    ...session,
    messages: [...session.messages, nextMessage],
    updatedAt: nowIso(),
  };
}

export function recentContext(messages: ChatMessage[], rounds = 5): ChatMessage[] {
  return messages.slice(Math.max(0, messages.length - rounds * 2));
}

