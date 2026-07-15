import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementsService } from './entitlements.service';

export const CAPABILITY_KEY = 'required_capability';

/** Declares the entitlement a route needs, e.g. @RequiresCapability('sentinel'). */
export const RequiresCapability = (capability: string) => SetMetadata(CAPABILITY_KEY, capability);

/**
 * Runs after AuthGuard (expects req.user.sub). Asks the centralized
 * EntitlementsService — the decision (incl. quota state) is attached to the
 * request as req.entitlement for handlers that want to expose it.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const capability = this.reflector.getAllAndOverride<string | undefined>(CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!capability) return true;

    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.sub;
    if (!userId) throw new UnauthorizedException('Capability check requires an authenticated user');

    const decision = await this.entitlements.check(userId, capability);
    req.entitlement = decision;
    if (!decision.allowed) {
      throw new ForbiddenException({
        message: `Missing entitlement: ${capability}`,
        capability,
        reason: decision.reason,
        ...(decision.quota ? { quota: decision.quota } : {}),
      });
    }
    return true;
  }
}
