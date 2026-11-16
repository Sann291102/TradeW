import { PrismaService } from '../prisma/prisma.service';

/**
 * Audit trail for payment operations, written to the same `AuditEvent` table
 * as authentication events under a `billing.` prefix so the admin Audit page
 * shows them alongside sign-ins. Metadata carries Stripe ids and amounts only,
 * never card data.
 *
 * Fire-and-forget: an audit write must never fail a payment.
 */
export async function billingAudit(
  prisma: PrismaService,
  eventType: string,
  userId: string | null,
  metadata?: Record<string, unknown>,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<void> {
  await prisma.auditEvent
    .create({
      data: {
        eventType: `billing.${eventType}`,
        userId: userId ?? undefined,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: metadata as never,
      },
    })
    .catch(() => undefined);
}
