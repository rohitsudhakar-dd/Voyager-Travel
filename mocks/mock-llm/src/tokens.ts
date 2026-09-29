/**
 * Token accounting.
 *
 * Real enough that the cost and token-usage dashboards move in proportion to
 * actual traffic, which is all the LLM Observability demo needs. Roughly four
 * characters per token is the usual rule of thumb for English prose.
 */

const CHARS_PER_TOKEN = 4;

export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export interface ChatMessage {
  role: string;
  content?: string | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** Every message carries a few tokens of role and delimiter overhead. */
const PER_MESSAGE_OVERHEAD = 4;

export function countPromptTokens(messages: ChatMessage[], tools?: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    total += PER_MESSAGE_OVERHEAD + countTokens(message.content ?? '');
    if (message.tool_calls) total += countTokens(JSON.stringify(message.tool_calls));
  }
  // Tool schemas are part of the prompt and are usually the largest part of
  // it -- which is exactly the sort of thing a cost dashboard should reveal.
  if (tools?.length) total += countTokens(JSON.stringify(tools));
  return total;
}

/** Split into token-ish chunks for streaming, keeping whitespace attached. */
export function tokenize(text: string): string[] {
  const chunks = text.match(/\S+\s*/g) ?? [];
  return chunks.length > 0 ? chunks : [text];
}
