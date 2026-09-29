import type { SupportStreamEvent } from '@voyager/shared-schemas';
import { HttpResponse, http } from 'msw';
import { bookingByIdOrPnr, chaosBool, chaosNumber, loyalty, state, uuid } from '../fixtures/state';
import { delay, errorResponse } from './shared';

const API = '/api/v1';

const PNR_PATTERN = /\b[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}\b/;

function encoder() {
  return new TextEncoder();
}

function sse(event: SupportStreamEvent): Uint8Array {
  return encoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function words(text: string): string[] {
  return text.split(/(\s+)/).filter(Boolean);
}

/**
 * The scripted reply. It reads the real fixture booking when the message
 * contains a reference, which is what makes the visible tool-call chips honest.
 */
function plan(content: string): {
  tools: { tool: SupportStreamEvent extends never ? never : string; label: string }[];
  reply: string;
} {
  const reference = content.toUpperCase().match(PNR_PATTERN)?.[0];
  const booking = reference ? bookingByIdOrPnr(reference) : undefined;

  if (chaosBool('llm_hallucinate')) {
    return {
      tools: [],
      reply:
        'I can see booking QK4TR9 departing on the 14th at 09:40 from Gatwick, fully refundable. Shall I cancel it for you?',
    };
  }

  if (chaosBool('llm_degrade_tools')) {
    return {
      tools: [],
      reply:
        'I would need to look that up. Generally speaking, most fares can be changed for a fee and cancellations depend on the rate you booked.',
    };
  }

  if (booking) {
    const policyLine =
      booking.productType === 'flight'
        ? 'Your fare allows free cancellation up to 48 hours before departure.'
        : 'Your rate allows free cancellation up to 48 hours before check-in.';
    return {
      tools: [
        { tool: 'lookup_booking', label: `Looked up booking ${booking.pnr}` },
        { tool: 'get_cancellation_policy', label: 'Checked cancellation policy' },
      ],
      reply: `I found ${booking.pnr}: ${booking.items[0]?.description ?? 'your booking'}, currently ${booking.state
        .replace(/_/g, ' ')
        .toLowerCase()}. ${policyLine} Would you like me to start the cancellation?`,
    };
  }

  if (/points|balance|tier/i.test(content)) {
    return {
      tools: [{ tool: 'get_loyalty_balance', label: 'Checked points balance' }],
      reply: `You have ${loyalty.pointsBalance.toLocaleString('en-GB')} Voyager points and you are ${loyalty.tier} tier. ${loyalty.pointsToNextTier?.toLocaleString('en-GB')} points takes you to ${loyalty.nextTier}.`,
    };
  }

  return {
    tools: [],
    reply:
      'Happy to help. If you give me the six-character booking reference from your confirmation email, I can look up the itinerary and the cancellation terms.',
  };
}

export const supportHandlers = [
  http.post(`${API}/support/conversations`, async () => {
    await delay(160);
    const conversationId = uuid();
    state.conversations.set(conversationId, {
      id: conversationId,
      state: 'open',
      intent: null,
      messages: [],
      createdAt: new Date().toISOString(),
    });
    return HttpResponse.json({ conversationId });
  }),

  http.get(`${API}/support/conversations/:id`, async ({ params }) => {
    await delay(120);
    const conversation = state.conversations.get(String(params.id));
    if (!conversation) {
      return errorResponse(
        404,
        'NotFoundError',
        'conversation_not_found',
        'Conversation not found.',
      );
    }
    return HttpResponse.json(conversation);
  }),

  http.post(`${API}/support/conversations/:id/messages`, async ({ request }) => {
    const body = (await request.json()) as { content: string };

    if (Math.random() < chaosNumber('llm_error_rate')) {
      return errorResponse(
        502,
        'LlmProviderError',
        'llm_provider_error',
        'Our assistant is unavailable right now.',
      );
    }

    const { tools, reply } = plan(body.content);
    const verbose = chaosBool('llm_token_bloat');
    const text = verbose ? `${reply} ${reply} ${reply}` : reply;
    const firstTokenDelay = 260 + chaosNumber('llm_latency_ms');

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const tool of tools) {
          controller.enqueue(
            sse({
              type: 'tool_call',
              tool: tool.tool as never,
              label: tool.label,
              outcome: 'pending',
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 420));
          controller.enqueue(
            sse({ type: 'tool_call', tool: tool.tool as never, label: tool.label, outcome: 'ok' }),
          );
        }

        await new Promise((resolve) => setTimeout(resolve, firstTokenDelay));

        for (const word of words(text)) {
          controller.enqueue(sse({ type: 'token', delta: word }));
          await new Promise((resolve) => setTimeout(resolve, 24));
        }

        controller.enqueue(sse({ type: 'done' }));
        controller.close();
      },
    });

    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }),
];
