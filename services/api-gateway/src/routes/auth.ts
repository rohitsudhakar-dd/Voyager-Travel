/** Auth routes (05-FUNCTIONALITY.md § 2.1). */

import type { FastifyInstance } from 'fastify';

import {
  checkPassword,
  findUser,
  hashPassword,
  issueRefreshToken,
  redeemRefreshToken,
  requirePrincipal,
  revokeRefreshToken,
  signAccessToken,
  type Principal,
} from '../auth';
import { EmailAlreadyRegisteredError, InvalidCredentialsError, ValidationError } from '../errors';
import { callService } from '../http';
import type { Deps } from '../deps';

const MIN_PASSWORD_LENGTH = 8;

export function registerAuthRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/api/v1/auth/signup', async (request) => {
    const body = request.body as Record<string, string>;
    const email = (body?.email ?? '').trim().toLowerCase();
    const password = body?.password ?? '';

    if (!email.includes('@')) throw new ValidationError('Enter a valid email address.');
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(
        `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }
    if (!body?.firstName || !body?.lastName) {
      throw new ValidationError('We need your first and last name.');
    }

    if (await findUser(deps.pool, email)) throw new EmailAlreadyRegisteredError();

    const { rows } = await deps.pool.query(
      `INSERT INTO voyager.users (email, password_hash, first_name, last_name, tier,
                                  signup_cohort, locale, created_at)
       VALUES ($1, $2, $3, $4, 'standard', 'organic', 'en-GB', now())
       RETURNING id, email, first_name, last_name, tier`,
      [email, await hashPassword(password), body.firstName, body.lastName],
    );

    // A new member starts with a loyalty account so the points widget has
    // something to show rather than an error on their first visit.
    await deps.pool.query(
      `INSERT INTO voyager.loyalty_accounts (user_id, points_balance, lifetime_points,
                                             tier, tier_qualified_at, updated_at)
       VALUES ($1, 0, 0, 'standard', now(), now())
       ON CONFLICT (user_id) DO NOTHING`,
      [rows[0].id],
    );

    return tokensFor(deps, rows[0]);
  });

  app.post('/api/v1/auth/login', async (request) => {
    const body = request.body as Record<string, string>;
    const user = await findUser(deps.pool, (body?.email ?? '').trim());

    // The same error whether the email is unknown or the password is wrong.
    if (!user) throw new InvalidCredentialsError();
    await checkPassword(body?.password ?? '', user.password_hash);

    return tokensFor(deps, user);
  });

  app.post('/api/v1/auth/refresh', async (request) => {
    const body = request.body as Record<string, string>;
    if (!body?.refreshToken) throw new ValidationError('refreshToken is required.');

    const userId = await redeemRefreshToken(deps.redis, body.refreshToken);
    const { rows } = await deps.pool.query(
      `SELECT id, email, tier FROM voyager.users WHERE id = $1`,
      [userId],
    );
    if (rows.length === 0) throw new InvalidCredentialsError();

    return { accessToken: signAccessToken(principalOfRow(rows[0])) };
  });

  app.post('/api/v1/auth/logout', async (request) => {
    const body = request.body as Record<string, string>;
    if (body?.refreshToken) await revokeRefreshToken(deps.redis, body.refreshToken);
    return { status: 'signed_out' };
  });

  app.get('/api/v1/auth/me', async (request) => {
    const principal = requirePrincipal(request);
    const { rows } = await deps.pool.query(
      `SELECT id, email, first_name, last_name, tier, locale
       FROM voyager.users WHERE id = $1`,
      [principal.id],
    );
    if (rows.length === 0) throw new InvalidCredentialsError();

    // The balance lives in loyalty-service. A points widget that fails should
    // not take the whole profile down with it.
    let loyaltyPoints: number | null = null;
    try {
      const loyalty = await callService<{ pointsBalance: number }>('loyalty', {
        path: `/v1/loyalty/${principal.id}`,
        requestId: request.id,
        timeoutMs: 2000,
      });
      loyaltyPoints = loyalty.body?.pointsBalance ?? null;
    } catch {
      loyaltyPoints = null;
    }

    return {
      id: rows[0].id,
      email: rows[0].email,
      firstName: rows[0].first_name,
      lastName: rows[0].last_name,
      tier: rows[0].tier,
      locale: rows[0].locale,
      loyaltyPoints,
    };
  });
}

async function tokensFor(deps: Deps, row: Record<string, string>) {
  const principal = principalOfRow(row);
  return {
    user: {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      tier: row.tier,
    },
    accessToken: signAccessToken(principal),
    refreshToken: await issueRefreshToken(deps.redis, row.id),
  };
}

function principalOfRow(row: Record<string, string>): Principal {
  return { id: row.id, email: row.email, tier: row.tier ?? 'standard' };
}
