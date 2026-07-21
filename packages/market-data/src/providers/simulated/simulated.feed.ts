import { MarketFeed, StatusHandler, TickHandler, TypedEmitter, Unsubscribe } from '../../contracts/feed';
import { InstrumentRef, refKey } from '../../contracts/instrument-ref';
import { FeedMode, FeedStatus, FeedStatusEvent, MarketTick } from '../../contracts/tick';
import { AnchorResolver, fallbackAnchor, InstrumentAnchor } from './simulated.provider';
import { marketStatusAt, simulateQuoteAt } from './ou-engine';

/**
 * Push feed backed by the simulated engine.
 *
 * This exists because of a constraint the architecture creates: once API reads
 * are pure (no generation at request time), *something* has to write prices
 * continuously or the dashboard freezes. In production that is the Dhan
 * WebSocket; in development it is this. Both implement `MarketFeed`, so the
 * ingestion pipeline downstream is identical and the switch is configuration,
 * not code.
 *
 * It is not a stub or a stand-in for the real feed — it is the sanctioned
 * development and fallback source, the same status `mock_dhanhq.py` holds for
 * paper trading in services/trading-engine.
 */
export interface SimulatedFeedOptions {
  /** How often to emit a tick per subscribed instrument. */
  intervalMs?: number;
  resolveAnchor?: AnchorResolver;
  /**
   * Emit ticks even when the simulated market is closed. Off by default so the
   * feed behaves like a real one — a real exchange sends nothing overnight, and
   * code that assumes ticks always arrive should fail in dev, not in production.
   */
  emitWhenClosed?: boolean;
  now?: () => Date;
}

export class SimulatedMarketFeed implements MarketFeed {
  readonly name = 'simulated';

  private _status: FeedStatus = 'idle';
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly subscriptions = new Map<string, { ref: InstrumentRef; mode: FeedMode }>();
  private readonly anchors = new Map<string, InstrumentAnchor>();

  private readonly ticks = new TypedEmitter<MarketTick>();
  private readonly statuses = new TypedEmitter<FeedStatusEvent>();

  private readonly intervalMs: number;
  private readonly resolveAnchor?: AnchorResolver;
  private readonly emitWhenClosed: boolean;
  private readonly now: () => Date;

  constructor(options: SimulatedFeedOptions = {}) {
    this.intervalMs = options.intervalMs ?? 2000;
    this.resolveAnchor = options.resolveAnchor;
    this.emitWhenClosed = options.emitWhenClosed ?? false;
    this.now = options.now ?? (() => new Date());
  }

  get status(): FeedStatus {
    return this._status;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.setStatus('connecting');
    // No handshake to perform — but going straight to 'connected' would let a
    // bug that depends on the connecting->connected transition hide here and
    // only surface against the real feed.
    this.timer = setInterval(() => void this.emitAll(), this.intervalMs);
    this.setStatus('connected');
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.setStatus('stopped');
  }

  async subscribe(refs: InstrumentRef[], mode: FeedMode): Promise<void> {
    for (const ref of refs) {
      this.subscriptions.set(refKey(ref), { ref, mode });
      await this.ensureAnchor(ref.symbol);
    }
  }

  async unsubscribe(refs: InstrumentRef[]): Promise<void> {
    for (const ref of refs) this.subscriptions.delete(refKey(ref));
  }

  onTick(handler: TickHandler): Unsubscribe {
    return this.ticks.on(handler);
  }

  onStatus(handler: StatusHandler): Unsubscribe {
    return this.statuses.on(handler);
  }

  /** Emit one tick per subscribed instrument immediately, outside the timer. */
  async emitAll(): Promise<void> {
    const at = this.now();
    if (!this.emitWhenClosed && marketStatusAt(at) === 'closed') return;

    for (const { ref, mode } of this.subscriptions.values()) {
      const anchor = await this.ensureAnchor(ref.symbol);
      const sim = simulateQuoteAt(ref.symbol, anchor.previousClose, anchor.tickSize, at);

      // Field coverage mirrors the real feed's modes, so a consumer written
      // against the simulator cannot accidentally depend on data that a Ticker
      // subscription would not actually deliver in production.
      const tick: MarketTick = { ref, at, source: this.name, ltp: sim.ltp };
      if (mode === 'quote' || mode === 'full') {
        tick.open = sim.open;
        tick.high = sim.high;
        tick.low = sim.low;
        tick.previousClose = anchor.previousClose;
        tick.volume = sim.volume;
        tick.averageTradePrice = sim.ltp;
      }
      if (mode === 'full') {
        tick.bid = sim.bid;
        tick.ask = sim.ask;
        tick.depth = [
          {
            bidQuantity: Math.max(1, Math.round(sim.volume / 1000)),
            askQuantity: Math.max(1, Math.round(sim.volume / 1100)),
            bidOrders: 5,
            askOrders: 5,
            bidPrice: sim.bid,
            askPrice: sim.ask,
          },
        ];
      }
      this.ticks.emit(tick);
    }
  }

  private async ensureAnchor(symbol: string): Promise<InstrumentAnchor> {
    const cached = this.anchors.get(symbol);
    if (cached) return cached;
    const resolved = (this.resolveAnchor ? await this.resolveAnchor(symbol) : null) ?? fallbackAnchor(symbol);
    this.anchors.set(symbol, resolved);
    return resolved;
  }

  /** Drop cached anchors so the next tick re-reads them (e.g. after a reseed). */
  refreshAnchors(): void {
    this.anchors.clear();
  }

  private setStatus(status: FeedStatus, extra: Partial<FeedStatusEvent> = {}): void {
    this._status = status;
    this.statuses.emit({ status, feed: this.name, at: this.now(), ...extra });
  }
}
