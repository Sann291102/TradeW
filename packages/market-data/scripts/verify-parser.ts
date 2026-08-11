/**
 * Round-trip check for the Dhan binary packet parser.
 *
 *   npm run verify -w @tradew/market-data
 *
 * Byte-offset arithmetic is the single most error-prone part of the WebSocket
 * integration and the part that is hardest to debug against a live feed — a
 * wrong offset yields plausible-looking numbers, not a crash. This builds
 * packets to the documented layout and asserts the parser reads back exactly
 * what was written, so the offsets are proven before any credential exists.
 */
import {
  FEED_CODE,
  parseFrame,
  parsePacket,
  type ParsedPacket,
} from '../src/providers/dhan/dhan-binary-parser';

let failures = 0;

/** UTC+05:30. Dhan's WS last-trade-time is IST-based — see the LTT section. */
const IST_OFFSET_S = (5 * 60 + 30) * 60;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Number.isFinite(actual as number) && Number.isFinite(expected as number)
    ? Math.abs((actual as number) - (expected as number)) < 0.011
    : actual === expected;
  if (ok) {
    console.log(`  ok   ${label}: ${String(actual)}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}: got ${String(actual)}, expected ${String(expected)}`);
  }
}

function header(buf: Buffer, code: number, length: number, segment: number, securityId: number): void {
  buf.writeUInt8(code, 0);
  buf.writeInt16LE(length, 1);
  buf.writeUInt8(segment, 3);
  buf.writeInt32LE(securityId, 4);
}

function tickOf(packet: ParsedPacket | null) {
  if (!packet || packet.kind !== 'tick') throw new Error('expected a tick packet');
  return packet.tick;
}

// --- Ticker packet (16 bytes) ------------------------------------------------
console.log('\nTicker packet');
{
  const buf = Buffer.alloc(16);
  header(buf, FEED_CODE.TICKER, 16, 1, 11536);
  buf.writeFloatLE(1234.55, 8);
  buf.writeInt32LE(1753100000, 12);

  const tick = tickOf(parsePacket(buf));
  check('ltp', tick.ltp, 1234.55);
  check('securityId', tick.ref.securityId, '11536');
  check('exchangeSegment', tick.ref.exchangeSegment, 'NSE_EQ');
  // This previously asserted the epoch round-tripped unchanged, which pinned a
  // real bug: the WS feed's LTT is an IST-based epoch, so reading it straight
  // stamped every tick 5h30m into the future. See the LTT section below.
  check('trade time (epoch s)', Math.floor(tick.at.getTime() / 1000), 1753100000 - IST_OFFSET_S);
}

// --- Quote packet (50 bytes) -------------------------------------------------
console.log('\nQuote packet');
{
  const buf = Buffer.alloc(50);
  header(buf, FEED_CODE.QUOTE, 50, 2, 49081);
  buf.writeFloatLE(24850.25, 8); // ltp
  buf.writeInt16LE(75, 12); // last traded qty
  buf.writeInt32LE(1753100001, 14); // ltt
  buf.writeFloatLE(24840.1, 18); // atp
  buf.writeInt32LE(987654, 22); // volume
  buf.writeInt32LE(4321, 26); // total sell qty
  buf.writeInt32LE(1234, 30); // total buy qty
  buf.writeFloatLE(24800.0, 34); // day open
  buf.writeFloatLE(0, 38); // day close — 0 means "not yet sent"
  buf.writeFloatLE(24900.5, 42); // day high
  buf.writeFloatLE(24750.75, 46); // day low

  const tick = tickOf(parsePacket(buf));
  check('ltp', tick.ltp, 24850.25);
  check('lastTradedQuantity', tick.lastTradedQuantity, 75);
  check('averageTradePrice', tick.averageTradePrice, 24840.1);
  check('volume', tick.volume, 987654);
  check('totalSellQuantity', tick.totalSellQuantity, 4321);
  check('totalBuyQuantity', tick.totalBuyQuantity, 1234);
  check('open', tick.open, 24800.0);
  check('close absent when 0', tick.close, undefined);
  check('high', tick.high, 24900.5);
  check('low', tick.low, 24750.75);
  check('exchangeSegment', tick.ref.exchangeSegment, 'NSE_FNO');
}

// --- Full packet (162 bytes, incl. 5 depth levels) ---------------------------
console.log('\nFull packet');
{
  const buf = Buffer.alloc(162);
  header(buf, FEED_CODE.FULL, 162, 2, 49082);
  buf.writeFloatLE(52700.5, 8);
  buf.writeInt16LE(35, 12);
  buf.writeInt32LE(1753100002, 14);
  buf.writeFloatLE(52690.0, 18);
  buf.writeInt32LE(555000, 22);
  buf.writeInt32LE(900, 26);
  buf.writeInt32LE(800, 30);
  buf.writeInt32LE(2_500_000, 34); // OI
  buf.writeInt32LE(2_700_000, 38); // day high OI
  buf.writeInt32LE(2_300_000, 42); // day low OI
  buf.writeFloatLE(52600.0, 46); // open
  buf.writeFloatLE(0, 50); // close
  buf.writeFloatLE(52800.0, 54); // high
  buf.writeFloatLE(52550.0, 58); // low
  // depth level 0 at byte 62
  buf.writeInt32LE(120, 62);
  buf.writeInt32LE(140, 66);
  buf.writeInt16LE(3, 70);
  buf.writeInt16LE(4, 72);
  buf.writeFloatLE(52700.0, 74);
  buf.writeFloatLE(52701.0, 78);
  // depth level 4 at byte 62 + 4*20 = 142
  buf.writeFloatLE(52696.0, 142 + 12);
  buf.writeFloatLE(52705.0, 142 + 16);

  const tick = tickOf(parsePacket(buf));
  check('ltp', tick.ltp, 52700.5);
  check('openInterest', tick.openInterest, 2_500_000);
  check('dayHighOpenInterest', tick.dayHighOpenInterest, 2_700_000);
  check('dayLowOpenInterest', tick.dayLowOpenInterest, 2_300_000);
  check('high', tick.high, 52800.0);
  check('depth levels', tick.depth?.length, 5);
  check('best bid from depth[0]', tick.bid, 52700.0);
  check('best ask from depth[0]', tick.ask, 52701.0);
  check('depth[0].bidQuantity', tick.depth?.[0]?.bidQuantity, 120);
  check('depth[0].askOrders', tick.depth?.[0]?.askOrders, 4);
  check('depth[4].bidPrice', tick.depth?.[4]?.bidPrice, 52696.0);
}

// --- Prev close + OI ---------------------------------------------------------
console.log('\nPrev-close and OI packets');
{
  const prev = Buffer.alloc(16);
  header(prev, FEED_CODE.PREV_CLOSE, 16, 1, 11536);
  prev.writeFloatLE(1200.4, 8);
  prev.writeInt32LE(999, 12);
  check('previousClose', tickOf(parsePacket(prev)).previousClose, 1200.4);

  const oi = Buffer.alloc(12);
  header(oi, FEED_CODE.OI, 12, 2, 49081);
  oi.writeInt32LE(1_750_000, 8);
  check('openInterest', tickOf(parsePacket(oi)).openInterest, 1_750_000);
}

// --- Last trade time is an IST-based epoch -----------------------------------
// Regression guard. Dhan's docs call the WS field only "EPOCH"; it is in fact
// seconds counted as though IST wall clock were UTC, so decoding it directly
// stamped every real tick 5h30m in the future. Measured against the live feed:
// an MCX contract's last tick decoded to 23:29:59 — impossible as UTC (that is
// 04:59:59 IST, hours after MCX shuts) and exactly the 23:30 IST close as IST.
//
// The assertion is written as the invariant rather than as the subtraction, so
// it fails if someone "simplifies" the conversion back to new Date(s * 1000):
// the raw epoch rendered as a UTC wall clock must equal the decoded instant
// rendered as an IST wall clock. Restating `- 19800` would pass either way.
console.log('\nLast trade time (IST-based epoch)');
{
  const wall = (d: Date, timeZone: string) =>
    d.toLocaleString('en-GB', { timeZone, hour12: false, dateStyle: 'short', timeStyle: 'medium' });

  // 12:13:20 IST on 2025-07-21, as Dhan puts it on the wire.
  const raw = 1753100000;
  const buf = Buffer.alloc(16);
  header(buf, FEED_CODE.TICKER, 16, 1, 11536);
  buf.writeFloatLE(100, 8);
  buf.writeInt32LE(raw, 12);

  const at = tickOf(parsePacket(buf)).at;
  check('decoded IST wall clock matches the raw epoch', wall(at, 'Asia/Kolkata'), wall(new Date(raw * 1000), 'UTC'));
  check('decoded instant is true UTC', at.toISOString(), '2025-07-21T06:43:20.000Z');

  // The MCX close that exposed the bug, end to end.
  const mcx = Buffer.alloc(16);
  header(mcx, FEED_CODE.TICKER, 16, 5, 428);
  mcx.writeFloatLE(100, 8);
  mcx.writeInt32LE(Math.floor(Date.UTC(2026, 7, 10, 23, 29, 59) / 1000), 12);
  check('MCX 23:30 IST close decodes to 18:00Z', tickOf(parsePacket(mcx)).at.toISOString(), '2026-08-10T17:59:59.000Z');

  // ltt == 0 still means "unavailable" and must take the caller's fallback
  // unshifted — the offset applies to trade times, not to our own clock.
  const none = Buffer.alloc(16);
  header(none, FEED_CODE.TICKER, 16, 1, 11536);
  none.writeFloatLE(100, 8);
  none.writeInt32LE(0, 12);
  const fallback = new Date('2026-08-10T20:00:00.000Z');
  check('ltt=0 uses fallback unshifted', tickOf(parsePacket(none, 0, fallback)).at.toISOString(), fallback.toISOString());
}

// --- Multi-packet frame ------------------------------------------------------
// A single WebSocket frame can carry several packets back to back; walking by
// declared length is what keeps the tail from being dropped.
console.log('\nMulti-packet frame');
{
  const a = Buffer.alloc(16);
  header(a, FEED_CODE.TICKER, 16, 1, 111);
  a.writeFloatLE(101.5, 8);
  a.writeInt32LE(1753100003, 12);

  const b = Buffer.alloc(16);
  header(b, FEED_CODE.TICKER, 16, 1, 222);
  b.writeFloatLE(202.5, 8);
  b.writeInt32LE(1753100004, 12);

  const packets = parseFrame(Buffer.concat([a, b]));
  check('packets in frame', packets.length, 2);
  check('first securityId', tickOf(packets[0]).ref.securityId, '111');
  check('second ltp', tickOf(packets[1]).ltp, 202.5);
}

// --- Disconnect + robustness -------------------------------------------------
console.log('\nDisconnect and truncation');
{
  const d = Buffer.alloc(10);
  header(d, FEED_CODE.DISCONNECT, 10, 1, 0);
  d.writeInt16LE(805, 8);
  const packet = parsePacket(d);
  check('disconnect kind', packet?.kind, 'disconnect');
  check('disconnect code', packet && packet.kind === 'disconnect' ? packet.code : null, 805);

  // A short buffer must return null, not read past the end.
  check('truncated packet returns null', parsePacket(Buffer.alloc(4)), null);
  check('truncated frame yields no packets', parseFrame(Buffer.alloc(4)).length, 0);

  // A zero declared length must not spin forever.
  const zero = Buffer.alloc(16);
  header(zero, FEED_CODE.TICKER, 0, 1, 1);
  check('zero-length header terminates', parseFrame(zero).length <= 1, true);
}

console.log(failures === 0 ? '\nOK — parser round-trips every documented layout.' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
