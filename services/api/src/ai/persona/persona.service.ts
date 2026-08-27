import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SUGGESTED_NAMES, validatePersonaName } from './persona-name.filter';

export interface PersonaView {
  /** Null until the user has named their assistant. */
  name: string | null;
  namedAt: Date | null;
  suggestions: readonly string[];
}

/**
 * Read/write the user-chosen AI identity (`AI-PERSONA.md`).
 *
 * Every write goes through `validatePersonaName` — there is no path that
 * persists a name without validating it, including the signup carry-through
 * (`applyAtSignup`), because the pre-auth name arrives from the browser and is
 * exactly as untrusted as a direct API call.
 */
@Injectable()
export class PersonaService {
  private readonly log = new Logger(PersonaService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<PersonaView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { aiPersonaName: true, aiPersonaNamedAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      name: user.aiPersonaName,
      namedAt: user.aiPersonaNamedAt,
      suggestions: SUGGESTED_NAMES,
    };
  }

  /** The name only, for prompt slotting and greetings. Never throws on a missing user. */
  async nameFor(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { aiPersonaName: true },
    });
    return user?.aiPersonaName ?? null;
  }

  /**
   * Name or rename the assistant.
   *
   * Renaming is immediate and global but deliberately does NOT touch
   * conversation history: past threads keep the `personaName` they were
   * created under (`AI-PERSONA.md` §7), because rewriting them would be a
   * small lie about what the user was told at the time.
   */
  async set(userId: string, rawName: unknown): Promise<PersonaView> {
    const check = validatePersonaName(rawName);
    if (!check.ok) {
      this.log.warn(`persona name rejected [${check.ruleId}] for user ${userId}`);
      throw new BadRequestException({ message: check.message, ruleId: check.ruleId });
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { aiPersonaName: check.name, aiPersonaNamedAt: new Date() },
      select: { aiPersonaName: true, aiPersonaNamedAt: true },
    });

    return {
      name: user.aiPersonaName,
      namedAt: user.aiPersonaNamedAt,
      suggestions: SUGGESTED_NAMES,
    };
  }

  /**
   * Carry a pre-signup name onto a freshly created account.
   *
   * Best-effort by design: a rejected name must never block account creation.
   * The user has already paid for the email/password step, and losing the
   * account over a bad assistant name would be an absurd trade. A rejected or
   * absent name simply leaves the column null, and onboarding asks once
   * (`ONBOARDING.md` §2).
   */
  async applyAtSignup(userId: string, rawName: unknown): Promise<string | null> {
    if (rawName === undefined || rawName === null || rawName === '') return null;

    const check = validatePersonaName(rawName);
    if (!check.ok) {
      this.log.warn(`pre-signup persona name rejected [${check.ruleId}] for user ${userId}`);
      return null;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { aiPersonaName: check.name, aiPersonaNamedAt: new Date() },
    });
    return check.name;
  }
}
