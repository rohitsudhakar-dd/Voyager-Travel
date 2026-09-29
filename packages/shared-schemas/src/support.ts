import { z } from 'zod';

/**
 * Support chat -- 05-FUNCTIONALITY.md § 2.7 and § 9.
 *
 * `POST /support/conversations/{id}/messages` answers with an SSE stream of
 * token deltas, tool-call events and a final message. The event names below
 * are the ones the client listens for; the specification describes the three
 * kinds of event but does not name them.
 */

export const supportToolNameSchema = z.enum([
  'lookup_booking',
  'get_cancellation_policy',
  'initiate_cancellation',
  'get_loyalty_balance',
  'escalate_to_human',
]);
export type SupportToolName = z.infer<typeof supportToolNameSchema>;

export const supportMessageSchema = z.object({
  id: z.union([z.number().int(), z.string()]),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  toolName: supportToolNameSchema.nullable().optional(),
  createdAt: z.string(),
});
export type SupportMessage = z.infer<typeof supportMessageSchema>;

export const conversationSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(['open', 'resolved', 'escalated']),
  intent: z.string().nullable(),
  messages: z.array(supportMessageSchema),
  createdAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const createConversationResponseSchema = z.object({
  conversationId: z.string().uuid(),
});
export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>;

export const sendMessageRequestSchema = z.object({
  content: z.string().min(1).max(2000),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const supportStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), delta: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    tool: supportToolNameSchema,
    label: z.string(),
    outcome: z.enum(['pending', 'ok', 'error']),
  }),
  z.object({ type: z.literal('message'), message: supportMessageSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('done') }),
]);
export type SupportStreamEvent = z.infer<typeof supportStreamEventSchema>;
