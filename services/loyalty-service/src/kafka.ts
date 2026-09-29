/** The single KafkaJS client. Producer, consumer and admin all share it. */

import { Kafka, logLevel } from 'kafkajs';

import { config } from './config';

export const kafka = new Kafka({
  clientId: config.service,
  brokers: config.kafka.brokers,
  // KafkaJS retries connections forever by default, which is what makes the
  // service survive a broker that is not up yet at boot. The log level is
  // dropped to NOTHING because its own logger does not speak the shared JSON
  // schema; connection state is logged by this service instead.
  logLevel: logLevel.NOTHING,
  retry: { initialRetryTime: 300, retries: 10 },
});

/** Readiness probe: cheapest call that proves the broker answers. */
export async function pingKafka(): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.listTopics();
  } finally {
    await admin.disconnect().catch(() => {});
  }
}
