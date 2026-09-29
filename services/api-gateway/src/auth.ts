/**
 * Authentication (05-FUNCTIONALITY.md § 2.1).
 *
 * Short-lived JWT access tokens, opaque refresh tokens held in Redis. The
 * refresh token is opaque and server-side precisely so that logout can revoke
 * it -- a self-contained refresh JWT is valid until it expires no matter what
 * the user clicks.
 */

import { randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';

import { config } from './config';
import { InvalidCredentialsError, UnauthorizedError } from './errors';

export interface Principal {
  id: string;
  email: string;
  tier: string;
}

const REFRESH_PREFIX = 'auth:refresh:';

export function signAccessToken(user: Principal): string {
  return jwt.sign(
    { sub: user.id, email: user.email, tier: user.tier },
    config.auth.jwtSecret,
    { expiresIn: config.auth.accessTokenTtlSeconds },
  );
}

export function verifyAccessToken(token: string): Principal {
  try {
    const claims = jwt.verify(token, config.auth.jwtSecret) as jwt.JwtPayload;
    return {
      id: String(claims.sub),
      email: String(claims.email ?? ''),
      tier: String(claims.tier ?? 'standard'),
    };
  } catch {
    throw new UnauthorizedError('That session has expired. Please sign in again.');
  }
}

export async function issueRefreshToken(redis: Redis, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await redis.set(
    REFRESH_PREFIX + token,
    userId,
    'EX',
    config.auth.refreshTokenTtlSeconds,
  );
  return token;
}

export async function redeemRefreshToken(
  redis: Redis,
  token: string,
): Promise<string> {
  const userId = await redis.get(REFRESH_PREFIX + token);
  if (!userId) {
    throw new UnauthorizedError('That session has expired. Please sign in again.');
  }
  return userId;
}

export async function revokeRefreshToken(redis: Redis, token: string): Promise<void> {
  await redis.del(REFRESH_PREFIX + token);
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.auth.bcryptRounds);
}

export async function checkPassword(password: string, hash: string): Promise<void> {
  const matches = await bcrypt.compare(password, hash);
  if (!matches) throw new InvalidCredentialsError();
}

export async function findUser(pool: Pool, email: string) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, first_name, last_name, tier, locale
     FROM voyager.users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

/**
 * The principal on the request, or null.
 *
 * Callers that require a user use `requirePrincipal`; endpoints that merely
 * personalise when signed in (the home page, a guest booking lookup) read
 * this and carry on either way.
 */
export function principalOf(request: FastifyRequest): Principal | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return verifyAccessToken(header.slice(7));
  } catch {
    return null;
  }
}

export function requirePrincipal(request: FastifyRequest): Principal {
  const principal = principalOf(request);
  if (!principal) throw new UnauthorizedError();
  return principal;
}

/**
 * Gate the admin surface.
 *
 * The comparison is length-safe and the failure says nothing about the
 * expected value -- § 2.8 asks for a 401 with no hint, and a message like
 * "wrong secret" versus "missing header" is itself a hint.
 */
export function requireAdmin(request: FastifyRequest): void {
  const supplied = request.headers['x-voyager-admin'];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!value || !timingSafeEqual(value, config.adminSecret)) {
    throw new UnauthorizedError('Not authorised.');
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
