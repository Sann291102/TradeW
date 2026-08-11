import { InstrumentRef, SEGMENT_BY_CODE } from '../../contracts/instrument-ref';
import { DepthLevel, MarketTick } from '../../contracts/tick';

/**
 * Parser for DhanHQ Live Market Feed binary packets.
 *
 * Dhan sends market data as packed little-endian binary rather than JSON, so
 * nothing can consume the feed without this. It is pure and synchronous — no
 * network, no credentials — which is deliberate: the riskiest part of the
 * WebSocket integration is byte-offset arithmetic, and this way it is fully
 * verifiable before a live connection ever exists.
 *
 * Layouts are transcribed from the DhanHQ v2 "Live Market Feed" documentation.
 * Every packet starts with the same 8-byte header:
 *
 *   byte 0     : feed response code
 *   bytes 1-2  : int16  message length
 *   byte 3     : exchange segment code
 *   bytes 4-7  : int32  security id
 */

export const FEED_CODE = {
  TICKER: 2,
  QUOTE: 4,
  OI: 5,
  PREV_CLOSE: 6,
  FULL: 8,
  DISCONNECT: 50,
} as const;

export const HEADER_BYTES = 8;

export interface PacketHeader {
  code: number;
  messageLength: number;
  segmentCode: number;
  securityId: string;
}

export type ParsedPacket =
  | { kind: 'tick'; tick: MarketTick }
  | { kind: 'disconnect'; code: number; securityId: string }
  | { kind: 'unknown'; header: PacketHeader };

export function readHeader(buf: Buffer, offset = 0): PacketHeader {
  return {
    code: buf.readUInt8(offset),
    messageLength: buf.readInt16LE(offset + 1),
    segmentCode: buf.readUInt8(offset + 3),
    securityId: String(buf.readInt32LE(offset + 4)),
  };
}

function refFor(header: PacketHeader): InstrumentRef {
  const segment = SEGMENT_BY_CODE[header.segmentCode];
  return {
    // The wire carries no symbol — only (segment, securityId). Resolving that
    // to a platform symbol is the ingestor's job via the Instrument table, so
    // symbol is left empty here rather than guessed.
    symbol: '',
    securityId: header.securityId,
    exchangeSegment: segment === 'IDX_I' ? 'IDX_I' : segment,
  };
}

/**
 * IST is UTC+05:30 and India observes no daylight saving, so a fixed offset is
 * genuinely correct here — unlike most zones, where a constant would be a bug
 * waiting for a DST boundary.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Last-trade-time -> Date. Dhan sends 0 when a trade time is unavailable.
 *
 * The WebSocket feed's LTT is **not** a UTC epoch, despite the docs labelling
 * it only "EPOCH". It counts seconds from the Unix epoch as though IST wall
 * clock were UTC, so reading it directly lands every tick 5h30m in the future.
 * Measured against the live feed: an MCX contract's final tick of the session
 * decodes to 23:29:59 — which is nonsense as UTC (04:59:59 IST, hours after
 * MCX shuts) and exactly right as IST (the 23:30 IST close). NSE rows land on
 * their own close the same way. Subtracting the offset recovers a true instant.
 *
 * Do NOT factor this together with the REST conversion in the historical
 * backfill: `/v2/charts/historical` genuinely is a UTC epoch (09:15 IST opens
 * at 03:45:00Z, verified). The two Dhan surfaces disagree, so one shared helper
 * would necessarily be wrong for one of them.
 */
function tradeTime(epochSeconds: number, fallback: Date): Date {
  if (epochSeconds <= 0) return fallback;
  return new Date(epochSeconds * 1000 - IST_OFFSET_MS);
}

/**
 * Parse a single packet beginning at `offset`.
 *
 * Returns null when the buffer is too short for the declared packet — a normal
 * condition on a stream boundary, not an error.
 */
export function parsePacket(buf: Buffer, offset = 0, now: Date = new Date()): ParsedPacket | null {
  if (buf.length - offset < HEADER_BYTES) return null;
  const header = readHeader(buf, offset);
  const ref = refFor(header);

  switch (header.code) {
    case FEED_CODE.TICKER: {
      if (buf.length - offset < 16) return null;
      const ltp = buf.readFloatLE(offset + 8);
      const ltt = buf.readInt32LE(offset + 12);
      return { kind: 'tick', tick: { ref, at: tradeTime(ltt, now), source: 'dhan', ltp: roundPrice(ltp) } };
    }

    case FEED_CODE.PREV_CLOSE: {
      if (buf.length - offset < 16) return null;
      return {
        kind: 'tick',
        tick: {
          ref,
          at: now,
          source: 'dhan',
          previousClose: roundPrice(buf.readFloatLE(offset + 8)),
          openInterest: buf.readInt32LE(offset + 12),
        },
      };
    }

    case FEED_CODE.OI: {
      if (buf.length - offset < 12) return null;
      return { kind: 'tick', tick: { ref, at: now, source: 'dhan', openInterest: buf.readInt32LE(offset + 8) } };
    }

    case FEED_CODE.QUOTE: {
      if (buf.length - offset < 50) return null;
      const ltt = buf.readInt32LE(offset + 14);
      return {
        kind: 'tick',
        tick: {
          ref,
          at: tradeTime(ltt, now),
          source: 'dhan',
          ltp: roundPrice(buf.readFloatLE(offset + 8)),
          lastTradedQuantity: buf.readInt16LE(offset + 12),
          averageTradePrice: roundPrice(buf.readFloatLE(offset + 18)),
          volume: buf.readInt32LE(offset + 22),
          totalSellQuantity: buf.readInt32LE(offset + 26),
          totalBuyQuantity: buf.readInt32LE(offset + 30),
          open: roundPrice(buf.readFloatLE(offset + 34)),
          close: nonZero(roundPrice(buf.readFloatLE(offset + 38))),
          high: roundPrice(buf.readFloatLE(offset + 42)),
          low: roundPrice(buf.readFloatLE(offset + 46)),
        },
      };
    }

    case FEED_CODE.FULL: {
      if (buf.length - offset < 162) return null;
      const ltt = buf.readInt32LE(offset + 14);
      const depth = readDepth(buf, offset + 62);
      return {
        kind: 'tick',
        tick: {
          ref,
          at: tradeTime(ltt, now),
          source: 'dhan',
          ltp: roundPrice(buf.readFloatLE(offset + 8)),
          lastTradedQuantity: buf.readInt16LE(offset + 12),
          averageTradePrice: roundPrice(buf.readFloatLE(offset + 18)),
          volume: buf.readInt32LE(offset + 22),
          totalSellQuantity: buf.readInt32LE(offset + 26),
          totalBuyQuantity: buf.readInt32LE(offset + 30),
          openInterest: buf.readInt32LE(offset + 34),
          dayHighOpenInterest: buf.readInt32LE(offset + 38),
          dayLowOpenInterest: buf.readInt32LE(offset + 42),
          open: roundPrice(buf.readFloatLE(offset + 46)),
          close: nonZero(roundPrice(buf.readFloatLE(offset + 50))),
          high: roundPrice(buf.readFloatLE(offset + 54)),
          low: roundPrice(buf.readFloatLE(offset + 58)),
          bid: depth[0]?.bidPrice,
          ask: depth[0]?.askPrice,
          depth,
        },
      };
    }

    case FEED_CODE.DISCONNECT: {
      if (buf.length - offset < 10) return null;
      return { kind: 'disconnect', code: buf.readInt16LE(offset + 8), securityId: header.securityId };
    }

    default:
      return { kind: 'unknown', header };
  }
}

/** 5 depth levels of 20 bytes each. */
function readDepth(buf: Buffer, offset: number): DepthLevel[] {
  const levels: DepthLevel[] = [];
  for (let i = 0; i < 5; i++) {
    const o = offset + i * 20;
    if (buf.length < o + 20) break;
    levels.push({
      bidQuantity: buf.readInt32LE(o),
      askQuantity: buf.readInt32LE(o + 4),
      bidOrders: buf.readInt16LE(o + 8),
      askOrders: buf.readInt16LE(o + 10),
      bidPrice: roundPrice(buf.readFloatLE(o + 12)),
      askPrice: roundPrice(buf.readFloatLE(o + 16)),
    });
  }
  return levels;
}

/**
 * A single WebSocket frame can carry several packets back to back. Walking by
 * the header's declared length rather than assuming one packet per frame is
 * what keeps multi-packet frames from being silently truncated.
 */
export function parseFrame(buf: Buffer, now: Date = new Date()): ParsedPacket[] {
  const out: ParsedPacket[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= buf.length) {
    const header = readHeader(buf, offset);
    const parsed = parsePacket(buf, offset, now);
    if (!parsed) break;
    out.push(parsed);
    // Guard against a zero/negative declared length, which would spin forever.
    const advance = header.messageLength > 0 ? header.messageLength : knownPacketSize(header.code);
    if (advance <= 0) break;
    offset += advance;
  }
  return out;
}

function knownPacketSize(code: number): number {
  switch (code) {
    case FEED_CODE.TICKER:
      return 16;
    case FEED_CODE.PREV_CLOSE:
      return 16;
    case FEED_CODE.OI:
      return 12;
    case FEED_CODE.QUOTE:
      return 50;
    case FEED_CODE.FULL:
      return 162;
    case FEED_CODE.DISCONNECT:
      return 10;
    default:
      return 0;
  }
}

/**
 * Prices arrive as float32, which carries only ~7 significant decimal digits —
 * an index near 80,000.00 sits exactly at that boundary, so the raw value can
 * be off by a fraction of a paisa. Rounding to 2dp on ingest keeps the value
 * consistent with the Decimal(12,2) column it lands in.
 */
function roundPrice(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Dhan sends 0 for day-close before market close; that is "absent", not zero. */
function nonZero(n: number): number | undefined {
  return n === 0 ? undefined : n;
}
