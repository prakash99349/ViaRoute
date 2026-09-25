import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthTokenType, prisma, type User } from '@viaroute/db';
import { randomToken, sha256 } from '../common/crypto';

const TTL_MINUTES: Record<AuthTokenType, number> = {
  VERIFY_EMAIL: 60 * 24 * 3,
  RESET_PASSWORD: 60,
  INVITE: 60 * 24 * 7,
};

/** One-time email-link tokens. Only hashes are stored; issuing a new one voids older ones of the same type. */
@Injectable()
export class TokensService {
  async issue(userId: string, type: AuthTokenType): Promise<string> {
    const raw = randomToken();
    await prisma.$transaction([
      prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.authToken.create({
        data: { userId, type, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + TTL_MINUTES[type] * 60_000) },
      }),
    ]);
    return raw;
  }

  /** Marks the token used and returns its user; throws if invalid, used or expired. */
  async consume(raw: string, type: AuthTokenType): Promise<User> {
    const token = await prisma.authToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
    if (!token || token.type !== type || token.usedAt || token.expiresAt < new Date()) {
      throw new BadRequestException('This link is invalid or has expired');
    }
    // Conditional update so two simultaneous clicks can't both succeed.
    const { count } = await prisma.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
    if (count !== 1) throw new BadRequestException('This link has already been used');
    return token.user;
  }
}
