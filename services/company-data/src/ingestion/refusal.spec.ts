import { describe, expect, it } from 'vitest';
import { looksLikeRefusal } from './source-fetcher.service';

/**
 * NSE refuses by serving an HTML page with HTTP 200.
 *
 * That is the single most expensive gotcha on this surface, because the symptom
 * appears far from the cause: a parser somewhere downstream fails on "Unexpected
 * token '<'" and the investigation starts in the wrong file. Detecting it at the
 * fetch boundary is what keeps "we could not READ it" separate from "we could
 * not UNDERSTAND it" — and only the first of those justifies continuing to show
 * the last good value.
 */

const headers = (contentType: string) => ({
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
});

describe('looksLikeRefusal', () => {
  it('detects the Access Denied page NSE served for quote-equity', () => {
    // Verbatim shape of the real 2026-08-19 response body.
    const body = '<HTML><HEAD> <TITLE>Access Denied</TITLE> </HEAD><BODY> <H1>Access Denied</H1>';
    expect(looksLikeRefusal(body, headers('text/html'))).toBe(true);
  });

  it('detects an HTML document served under a JSON-ish request', () => {
    expect(looksLikeRefusal('<!doctype html>\n<html lang="en">', headers('text/html'))).toBe(true);
  });

  it('passes real JSON payloads through', () => {
    expect(looksLikeRefusal('[{"symbol":"RELIANCE"}]', headers('application/json'))).toBe(false);
    expect(looksLikeRefusal('{"data":[]}', headers('application/json'))).toBe(false);
  });

  it('passes CSV through', () => {
    const csv = 'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\nRELIANCE,Reliance Industries Limited,EQ,29-NOV-1995';
    expect(looksLikeRefusal(csv, headers('text/csv'))).toBe(false);
  });

  it('passes XBRL through — an XML declaration is not an HTML tag', () => {
    // This is the case a naive startsWith('<') check would get wrong, and it
    // would reject every financial statement we fetch.
    const xbrl = '<?xml version="1.0" encoding="UTF-8"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance">';
    expect(looksLikeRefusal(xbrl, headers('application/xml'))).toBe(false);
  });

  it('does not treat an empty body as a refusal', () => {
    // Empty is its own problem, handled by the parser. Conflating the two would
    // make an empty-but-valid response re-prime the cookie jar pointlessly.
    expect(looksLikeRefusal('', headers('application/json'))).toBe(false);
  });
});
