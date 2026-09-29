/**
 * mock-email -- simulated transactional email provider.
 *
 * Keeps the last 200 messages in memory so the ops console can show what the
 * system actually sent, and rejects malformed payloads with a 422, which is
 * how DLQ traffic gets generated on demand (05-FUNCTIONALITY.md § 5.3).
 */

import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';

import * as chaos from './chaos';
import { config } from './config';
import { createLogger } from './logger';

const logger = createLogger(config.service, config.env, config.version);
const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

interface Message {
  id: string;
  to: string;
  from: string;
  subject: string;
  template: string | null;
  body: string;
  metadata: Record<string, unknown>;
  sentAt: string;
}

/** Newest first, capped at `outboxCapacity`. */
const outbox: Message[] = [];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/health', async () => ({
  status: 'ok',
  service: config.service,
  version: config.version,
  outbox_size: outbox.length,
}));

app.get('/ready', async () => ({ status: 'ready' }));

interface SendBody {
  to?: string;
  from?: string;
  subject?: string;
  template?: string;
  body?: string;
  html?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

app.post('/v1/send', async (request, reply) => {
  await chaos.refresh();

  const body = (request.body ?? {}) as SendBody;
  const problems: string[] = [];

  if (!body.to || !EMAIL_PATTERN.test(body.to)) problems.push('to must be a valid address');
  if (!body.subject) problems.push('subject is required');
  const content = body.body ?? body.html ?? body.text;
  if (!content) problems.push('one of body, html or text is required');

  // The chaos rejection is a 422 rather than a 5xx on purpose: a rejected
  // message is a permanent failure, so notification-worker sends it straight
  // to the DLQ instead of retrying. That is how S5 fills the DLQ on demand.
  if (problems.length === 0 && chaos.maybeFail('email_failure_rate')) {
    problems.push('message rejected by the provider');
  }

  if (problems.length > 0) {
    logger.warn({ problems, template: body.template ?? null }, 'Rejected malformed email');
    return reply.code(422).send({
      error: { type: 'invalid_request', message: 'Message is malformed.', details: { problems } },
    });
  }

  const message: Message = {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    to: body.to!,
    from: body.from ?? 'no-reply@voyager.demo',
    subject: body.subject!,
    template: body.template ?? null,
    body: content!,
    metadata: body.metadata ?? {},
    sentAt: new Date().toISOString(),
  };

  outbox.unshift(message);
  if (outbox.length > config.outboxCapacity) outbox.length = config.outboxCapacity;

  logger.info(
    { message_id: message.id, template: message.template, outbox_size: outbox.length },
    'Email accepted',
  );
  return reply.code(202).send({ id: message.id, status: 'accepted', sent_at: message.sentAt });
});

app.get('/outbox', async (request, reply) => {
  const query = request.query as { limit?: string; to?: string; template?: string };
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), config.outboxCapacity);

  let messages = outbox;
  if (query.to) messages = messages.filter((message) => message.to === query.to);
  if (query.template) messages = messages.filter((m) => m.template === query.template);

  return reply.send({ count: messages.length, messages: messages.slice(0, limit) });
});

app.delete('/outbox', async (_request, reply) => {
  const cleared = outbox.length;
  outbox.length = 0;
  logger.info({ cleared }, 'Outbox cleared');
  return reply.send({ cleared });
});

async function start(): Promise<void> {
  chaos.initChaos(config.redisUrl);
  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { port: config.port, outbox_capacity: config.outboxCapacity },
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
