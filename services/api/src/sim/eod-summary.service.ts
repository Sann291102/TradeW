import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notification/notification.service';
import { PortfolioService } from './portfolio.service';
import { eodSummary, type EodOrderLine } from '../mail/templates';
import { isTradingDay, istDateKey, istMidnightUtc } from '../discipline/market-calendar';

/**
 * The end-of-day summary email.
 *
 * Once per trading day, after the market closes, every active paper-trading
 * user with a real email address gets a wrap-up: portfolio value, the day's
 * P&L, and the day's orders. Built on the SAME pattern as the performance
 * sweep it sits beside (LeaderElectionService + a coarse setInterval + the IST
 * market calendar) — see PerformanceService for the reasoning behind each part.
 *
 * FOUR GATES, so this can never spam:
 *  1. LEADER only — one instance sends, never N copies from N replicas.
 *  2. TRADING DAY only — nothing to summarise on a weekend/holiday.
 *  3. AFTER CLOSE only — fires no earlier than EOD_EMAIL_HOUR_IST (default 16:00
 *     IST, comfortably past the 15:30 NSE close), so the numbers are final.
 *  4. ONCE PER USER PER DAY — a durable per-user marker (UserPreference
 *     `eod_email_last_sent`) makes a re-run within the day a no-op, so a restart
 *     or a second tick cannot double-send.
 *
 * Off by default: sending real mail to every user is opt-in via
 * `EOD_EMAIL_ENABLED=true`, and a user can opt out with the
 * `eod_email_enabled=false` preference. Synthetic phone placeholders
 * (`…@phone.tradew.local`) are always skipped.
 */
const CHECK_MS = 10 * 60_000; // coarse — this is a once-a-day event, not a price loop
const EOD_JOB = 'eod-summary-email';
const LAST_SENT_PREF = 'eod_email_last_sent';
const OPT_OUT_PREF = 'eod_email_enabled';

@Injectable()
export class EodSummaryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EodSummaryService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly enabled = process.env.EOD_EMAIL_ENABLED === 'true';
  private readonly hourIst = Number(process.env.EOD_EMAIL_HOUR_IST || 16);

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioService,
    private readonly mail: MailService,
    private readonly notifications: NotificationService,
    private readonly leader: LeaderElectionService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('EOD summary email disabled (set EOD_EMAIL_ENABLED=true to enable)');
      return;
    }
    this.leader.register(EOD_JOB);
    this.timer = setInterval(() => void this.sweep(), CHECK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (!this.leader.isLeader(EOD_JOB)) return;
    if (!isTradingDay()) return;
    if (istHour() < this.hourIst) return; // too early — market not yet closed

    const todayKey = istDateKey();
    let wallets: Array<{ userId: string }>;
    try {
      wallets = await this.prisma.paperWallet.findMany({ select: { userId: true } });
    } catch (err) {
      this.logger.error('EOD sweep: failed to load wallets', err as Error);
      return;
    }

    for (const { userId } of wallets) {
      try {
        await this.sendFor(userId, todayKey);
      } catch (err) {
        this.logger.error(`EOD sweep: failed for ${userId}`, err as Error);
      }
    }
  }

  /** Idempotent per user per day. Returns without sending if already sent, opted
   *  out, or the address isn't a real mailbox. */
  private async sendFor(userId: string, todayKey: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email || user.email.endsWith('@phone.tradew.local')) return;

    const prefs = await this.prisma.userPreference.findMany({
      where: { userId, key: { in: [LAST_SENT_PREF, OPT_OUT_PREF] } },
    });
    const lastSent = prefs.find((p) => p.key === LAST_SENT_PREF)?.value as { dateKey?: string } | undefined;
    if (lastSent?.dateKey === todayKey) return; // already sent today
    const optOut = prefs.find((p) => p.key === OPT_OUT_PREF)?.value;
    if (optOut === false) return; // user disabled it

    const [summary, orders] = await Promise.all([this.portfolio.summary(userId), this.todaysOrders(userId, todayKey)]);
    const dateLabel = new Date().toLocaleDateString('en-IN', { dateStyle: 'medium' } as Intl.DateTimeFormatOptions);

    const mail = eodSummary({
      email: user.email,
      dateLabel,
      currency: '₹',
      portfolioValue: summary.netWorth,
      dayPnl: summary.dailyPnl,
      orders,
    });
    const result = await this.mail.send(user.email, mail.subject, mail.text, mail.html);

    // Only mark as sent when it actually left (or was console-logged in the
    // no-SMTP fallback, which still returns a preview). A hard SMTP failure
    // leaves the marker unset so the next tick retries rather than silently
    // dropping the day's summary.
    if (result.delivered || result.preview) {
      await this.prisma.userPreference.upsert({
        where: { userId_key: { userId, key: LAST_SENT_PREF } },
        update: { value: { dateKey: todayKey } },
        create: { userId, key: LAST_SENT_PREF, value: { dateKey: todayKey } },
      });
      await this.notifications
        .create(userId, {
          category: 'portfolio',
          title: 'Daily summary sent',
          body: `Your ${dateLabel} portfolio wrap-up is in your inbox.`,
        })
        .catch(() => undefined);
    }
  }

  private async todaysOrders(userId: string, dateKey: string): Promise<EodOrderLine[]> {
    const start = istMidnightUtc(dateKey);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const orders = await this.prisma.order.findMany({
      where: { userId, placedAt: { gte: start, lt: end } },
      include: { instrument: true },
      orderBy: { placedAt: 'asc' },
    });
    return orders.map((o) => ({
      symbol: o.instrument.symbol,
      side: String(o.side),
      qty: o.quantity,
      price: Number(o.avgFillPrice ?? o.price ?? 0),
      status: String(o.status),
    }));
  }
}

/** Current hour (0–23) in IST. */
function istHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
}
