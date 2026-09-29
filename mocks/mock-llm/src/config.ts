/** Runtime configuration. Everything comes from the environment. */

export const config = {
  service: process.env.DD_SERVICE ?? 'mock-llm',
  env: process.env.DD_ENV ?? 'demo',
  version: process.env.DD_VERSION ?? 'dev',
  port: Number(process.env.PORT ?? 4930),
  host: '0.0.0.0',
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',

  model: process.env.LLM_MODEL ?? 'voyager-support-v1',

  /** Time to first token, uniform in this range. */
  ttftMinMs: Number(process.env.MOCK_LLM_TTFT_MIN_MS ?? 200),
  ttftMaxMs: Number(process.env.MOCK_LLM_TTFT_MAX_MS ?? 600),

  /** Streaming rate once the first token is out. */
  tokensPerSecond: Number(process.env.MOCK_LLM_TOKENS_PER_SECOND ?? 25),
};
