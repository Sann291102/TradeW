import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_ALLOWED_AGENTS,
  DEFAULT_ALLOWED_SYMBOLS,
  type AccountAuthorization,
  type AccountScope,
  authorizeAccount,
} from './execution-account';

/**
 * Reads the account behind an execution profile and authorizes it.
 *
 * The decision itself lives in `execution-account.ts` (pure, testable); this is
 * the database half — it selects the MINIMUM it needs and nothing more.
 *
 * ## The select list is a security boundary
 *
 * `passwordHash` is never read as a value, only as a boolean ("does a sign-in
 * credential exist"), and it is derived inside the query result rather than
 * carried further. Nothing downstream of this service can see it, log it or
 * serialise it. Same for `googleId`. This mirrors `AdminService.users`, which
 * uses an explicit select for exactly this reason: a spread on `User` ships a
 * password hash to a browser.
 *
 * No credential of any kind — user password, Google identity, broker token —
 * is used to execute. The account reference is `userId`, an internal identity.
 */
@Injectable()
export class ExecutionAccountService {
  constructor(private readonly prisma: PrismaService) {}

  /** Permitted markets/agents, overridable per deployment. */
  private get allowedSymbols(): string[] {
    return splitEnv(process.env.PAPER_EXECUTION_ALLOWED_SYMBOLS) ?? DEFAULT_ALLOWED_SYMBOLS;
  }
  private get allowedAgents(): string[] {
    return splitEnv(process.env.PAPER_EXECUTION_ALLOWED_AGENTS) ?? DEFAULT_ALLOWED_AGENTS;
  }

  /**
   * Authorize one profile's account, re-reading the account on every call.
   *
   * Deliberately NOT cached and NOT denormalised onto the profile: consent is
   * revocable, and a cached grant is a grant that survives its revocation.
   */
  async authorize(profile: {
    environment: string;
    /** From `environmentFor(state)`. Optional; defaults to PAPER. */
    authorizedEnvironment?: 'PAPER' | 'LIVE';
    accountScope: AccountScope;
    accountUserId: string;
    symbol: string;
    agent: string;
  }): Promise<AccountAuthorization> {
    const account = await this.prisma.user.findUnique({
      where: { id: profile.accountUserId },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        googleId: true,
        agentPaperTradingEnabledAt: true,
      },
    });

    const wallet = account
      ? await this.prisma.paperWallet.findUnique({ where: { userId: account.id }, select: { id: true } })
      : null;

    return authorizeAccount({
      environment: profile.environment,
      authorizedEnvironment: profile.authorizedEnvironment,
      declaredScope: profile.accountScope,
      symbol: profile.symbol,
      agent: profile.agent,
      account: account
        ? {
            id: account.id,
            email: account.email,
            // Collapsed to booleans HERE, at the boundary. The hash itself goes
            // no further than this expression.
            hasPasswordCredential: account.passwordHash != null,
            hasGoogleIdentity: account.googleId != null,
            agentPaperTradingEnabledAt: account.agentPaperTradingEnabledAt,
          }
        : null,
      walletExists: wallet != null,
      allowedSymbols: this.allowedSymbols,
      allowedAgents: this.allowedAgents,
    });
  }

  /**
   * TradeW accounts an operator may bind a USER_PAPER profile to.
   *
   * Returns real accounts only — a system paper account is excluded because it
   * cannot be a USER_PAPER target, and showing it would invite exactly the
   * mis-binding `authorizeAccount` refuses. Carries no credential field of any
   * kind; the console renders email + wallet + consent state and nothing else.
   */
  async eligibleAccounts(params: { q?: string; limit?: number } = {}) {
    const users = await this.prisma.user.findMany({
      where: {
        // "Real account" = someone can sign in to it. This is the same
        // predicate `authorizeAccount` enforces, expressed as a query so the
        // console cannot offer a choice the server would then refuse.
        OR: [{ passwordHash: { not: null } }, { googleId: { not: null } }],
        ...(params.q ? { email: { contains: params.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(params.limit ?? 50, 1), 200),
      // Explicit select — never a spread. `passwordHash` and `googleId` must
      // not leave the server, so they are not selected at all here (unlike
      // `authorize`, which needs their presence and collapses them immediately).
      select: {
        id: true,
        email: true,
        country: true,
        createdAt: true,
        agentPaperTradingEnabledAt: true,
        agentPaperTradingGrantedBy: true,
        paperWallet: {
          select: { startingBalance: true, cashBalance: true, marginUsed: true, realizedPnl: true },
        },
        _count: { select: { orders: true, positions: true, executionProfiles: true } },
      },
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      country: u.country,
      createdAt: u.createdAt.toISOString(),
      agentPaperTradingEnabled: u.agentPaperTradingEnabledAt != null,
      agentPaperTradingEnabledAt: u.agentPaperTradingEnabledAt?.toISOString() ?? null,
      agentPaperTradingGrantedBy: u.agentPaperTradingGrantedBy,
      wallet: u.paperWallet
        ? {
            startingBalance: Number(u.paperWallet.startingBalance),
            cashBalance: Number(u.paperWallet.cashBalance),
            marginUsed: Number(u.paperWallet.marginUsed),
            realizedPnl: Number(u.paperWallet.realizedPnl),
          }
        : null,
      orders: u._count.orders,
      positions: u._count.positions,
      boundProfiles: u._count.executionProfiles,
    }));
  }

  /**
   * Grant or revoke a user's consent to agent paper trading.
   *
   * Audited like `AdminService.setAdmin`, and for a stronger reason: this is the
   * switch that lets an autonomous agent trade in a real person's account. The
   * `AuditEvent` is written in the same transaction as the flag, so the grant
   * and the record of who made it cannot diverge.
   */
  async setAgentPaperTrading(userId: string, enabled: boolean, operator: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          agentPaperTradingEnabledAt: enabled ? new Date() : null,
          agentPaperTradingGrantedBy: enabled ? operator : null,
        },
        select: { id: true, email: true, agentPaperTradingEnabledAt: true, agentPaperTradingGrantedBy: true },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          eventType: enabled ? 'execution.agent-paper-trading.granted' : 'execution.agent-paper-trading.revoked',
          metadata: { targetEmail: user.email, operator },
        },
      });
      return {
        id: user.id,
        email: user.email,
        agentPaperTradingEnabled: user.agentPaperTradingEnabledAt != null,
        agentPaperTradingEnabledAt: user.agentPaperTradingEnabledAt?.toISOString() ?? null,
        agentPaperTradingGrantedBy: user.agentPaperTradingGrantedBy,
      };
    });
  }
}

function splitEnv(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return parts.length ? parts : null;
}
