import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Blocks restricted features (billing, saved cards, checkout) until the
 * caller's email address is verified.
 *
 * Runs AFTER `AuthGuard` (it reads `req.user.sub`) and re-reads the user row on
 * every request rather than trusting a claim baked into the access token, for
 * the reason `isAdmin` is re-read: a token minted before verification must
 * start working the moment the link is clicked, without a fresh sign-in.
 *
 * The 403 carries a stable `code` so the UI can show "verify your email" with
 * a resend button rather than a generic error.
 */
@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.sub;
    if (!userId) throw new UnauthorizedException('Missing bearer token');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    if (!user) throw new UnauthorizedException('User not found');
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Verify your email address to use billing. Check your inbox, or ask for a new link.',
      });
    }
    return true;
  }
}
