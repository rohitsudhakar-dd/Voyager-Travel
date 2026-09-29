/**
 * mock-llm -- OpenAI-compatible chat completions.
 *
 * ai-support-service points the `openai` client at this service via
 * `base_url`, so the wire format has to be right down to the SSE framing:
 * that is what lets the same code talk to a real provider by changing one
 * environment variable (05-FUNCTIONALITY.md § 5.4).
 */

import { randomUUID } from 'node:crypto';

import Fastify, { FastifyReply } from 'fastify';

import * as chaos from './chaos';
import { config } from './config';
import {
  bloat,
  classify,
  degradedResponse,
  extractArguments,
  hallucinatedResponse,
  isAffirmative,
  pickResponse,
  PREFERRED_TOOL,
} from './intents';
import { createLogger } from './logger';
import { ChatMessage, countPromptTokens, countTokens, tokenize } from './tokens';

const logger = createLogger(config.service, config.env, config.version);
const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

interface ToolDefinition {
  type: string;
  function: { name: string; description?: string; parameters?: unknown };
}

interface CompletionBody {
  model?: string;
  messages?: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastUserMessage(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content ?? '';
  }
  return '';
}

function hasToolResult(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'tool');
}

interface Plan {
  intent: string;
  content: string | null;
  toolCall: { id: string; name: string; args: Record<string, unknown> } | null;
  finishReason: 'stop' | 'tool_calls';
}

/**
 * Decide what this turn should be: a tool call, or an answer.
 *
 * The first turn with tools available and no tool result yet is a tool call;
 * everything after that is prose. That is the two-LLM-call shape the span
 * diagram in § 9 expects.
 */
function plan(body: CompletionBody): Plan {
  const messages = body.messages ?? [];
  const userText = lastUserMessage(messages);
  const intent = classify(userText);
  const toolNames = new Set(
    (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean) as string[],
  );

  if (chaos.isEnabled('llm_hallucinate')) {
    return {
      intent,
      content: hallucinatedResponse(),
      toolCall: null,
      finishReason: 'stop',
    };
  }

  const wanted = PREFERRED_TOOL[intent];
  const shouldCallTool =
    !chaos.isEnabled('llm_degrade_tools') &&
    !hasToolResult(messages) &&
    wanted !== null &&
    toolNames.has(wanted) &&
    body.tool_choice !== 'none';

  if (shouldCallTool) {
    // Cancellation is only ever proposed after the user has said yes, and
    // even then the real gate is in the tool handler.
    const tool =
      intent === 'cancellation_policy' &&
      isAffirmative(userText) &&
      toolNames.has('initiate_cancellation')
        ? 'initiate_cancellation'
        : wanted!;

    return {
      intent,
      content: null,
      toolCall: {
        id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: tool,
        args: extractArguments(tool, userText),
      },
      finishReason: 'tool_calls',
    };
  }

  let content = chaos.isEnabled('llm_degrade_tools')
    ? degradedResponse(intent)
    : pickResponse(intent);
  if (chaos.isEnabled('llm_token_bloat')) content = bloat(content);

  return { intent, content, toolCall: null, finishReason: 'stop' };
}

function ttftMs(): number {
  return (
    config.ttftMinMs + Math.random() * (config.ttftMaxMs - config.ttftMinMs)
  );
}

// ------------------------------------------------------------------ routes --

app.get('/health', async () => ({
  status: 'ok',
  service: config.service,
  version: config.version,
  model: config.model,
}));

app.get('/ready', async () => ({ status: 'ready' }));

app.get('/v1/models', async () => ({
  object: 'list',
  data: [
    {
      id: config.model,
      object: 'model',
      created: 1_735_689_600,
      owned_by: 'voyager',
    },
  ],
}));

app.post('/v1/chat/completions', async (request, reply) => {
  await chaos.refresh();

  const body = (request.body ?? {}) as CompletionBody;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return reply.code(422).send({
      error: { type: 'invalid_request_error', message: 'messages is required.' },
    });
  }

  if (chaos.maybeFail('llm_error_rate')) {
    logger.error({ model: body.model ?? config.model }, 'Completion failed');
    return reply.code(500).send({
      error: { type: 'server_error', message: 'The model is temporarily unavailable.' },
    });
  }

  const decision = plan(body);
  const model = body.model ?? config.model;
  const completionId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1_000);
  const promptTokens = countPromptTokens(body.messages, body.tools);

  // Time to first token: the baseline plus whatever chaos adds.
  await sleep(ttftMs());
  await chaos.maybeDelay('llm_latency_ms');

  const completionText = decision.content ?? '';
  const toolCallPayload = decision.toolCall
    ? [
        {
          id: decision.toolCall.id,
          type: 'function',
          function: {
            name: decision.toolCall.name,
            arguments: JSON.stringify(decision.toolCall.args),
          },
        },
      ]
    : undefined;

  const completionTokens = decision.toolCall
    ? countTokens(JSON.stringify(toolCallPayload))
    : countTokens(completionText);

  logger.info(
    {
      model,
      intent: decision.intent,
      streaming: Boolean(body.stream),
      tool_call: decision.toolCall?.name ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
    'Completion served',
  );

  if (!body.stream) {
    return reply.send({
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: decision.toolCall ? null : completionText,
            ...(toolCallPayload ? { tool_calls: toolCallPayload } : {}),
          },
          finish_reason: decision.finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  }

  return streamCompletion(reply, {
    completionId,
    created,
    model,
    decision,
    toolCallPayload,
    completionText,
    promptTokens,
    completionTokens,
  });
});

interface StreamArgs {
  completionId: string;
  created: number;
  model: string;
  decision: Plan;
  toolCallPayload: unknown;
  completionText: string;
  promptTokens: number;
  completionTokens: number;
}

async function streamCompletion(reply: FastifyReply, args: StreamArgs): Promise<void> {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Buffering an SSE stream defeats the entire purpose of it.
    'x-accel-buffering': 'no',
  });

  const send = (payload: unknown): void => {
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const frame = (delta: unknown, finishReason: string | null) => ({
    id: args.completionId,
    object: 'chat.completion.chunk',
    created: args.created,
    model: args.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  send(frame({ role: 'assistant' }, null));

  if (args.decision.toolCall) {
    // Tool calls stream as a single delta. Splitting the JSON arguments
    // across chunks is legal but only ever makes clients fail in new ways.
    send(frame({ tool_calls: args.toolCallPayload }, null));
    send(frame({}, 'tool_calls'));
  } else {
    const delayPerToken = 1_000 / Math.max(1, config.tokensPerSecond);
    for (const chunk of tokenize(args.completionText)) {
      send(frame({ content: chunk }, null));
      await sleep(delayPerToken);
    }
    send(frame({}, 'stop'));
  }

  // `stream_options: {include_usage: true}` is what the OpenAI client looks
  // for; sending usage unconditionally is harmless and keeps the token
  // metrics populated for every request.
  send({
    id: args.completionId,
    object: 'chat.completion.chunk',
    created: args.created,
    model: args.model,
    choices: [],
    usage: {
      prompt_tokens: args.promptTokens,
      completion_tokens: args.completionTokens,
      total_tokens: args.promptTokens + args.completionTokens,
    },
  });

  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}

// ------------------------------------------------------------------- boot --

async function start(): Promise<void> {
  chaos.initChaos(config.redisUrl);
  await app.listen({ port: config.port, host: config.host });
  logger.info(
    {
      port: config.port,
      model: config.model,
      tokens_per_second: config.tokensPerSecond,
    },
    'Service started',
  );
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    await chaos.closeChaos();
    process.exit(0);
  });
}

start().catch((error) => {
  logger.error(
    { error: { kind: error?.constructor?.name, message: error?.message } },
    'Service failed to start',
  );
  process.exit(1);
});
