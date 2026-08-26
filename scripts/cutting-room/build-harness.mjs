#!/usr/bin/env node
/**
 * Turn the Cutting Room reel into a frame-exact, offline render harness.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `cutting-room.html` is a studio, not a file format: it plays four ad cuts in
 * four aspect ratios, and its own Capture note used to say "record with OBS at
 * 60fps and crop to the stage". Screen-recording a browser gives you dropped
 * frames, a variable frame rate, whatever your compositor felt like doing, and
 * a crop you eyeballed. None of that is uploadable without an apology.
 *
 * It does not have to be that way. Every scene renderer in the reel is a pure
 * function of the timeline clock — the FX layer's own comment says so ("pure
 * f(t), so scrubbing is exact"). Nothing accumulates between frames. So the
 * reel can be rendered the way a 3D scene is: set the clock, paint, capture,
 * repeat, and encode the result at a locked frame rate. Every frame lands
 * exactly where the animation says it should, and a slow machine makes the
 * render take longer rather than making the video worse.
 *
 * ── WHAT THE HARNESS CHANGES ───────────────────────────────────────────────
 *
 * Three edits, all of them additive to a copy — the published artifact and
 * `cutting-room.html` are never modified:
 *
 *   1. Fonts are pulled local. Archivo and IBM Plex Mono carry the whole
 *      typographic identity of these cuts; a render that silently fell back to
 *      a system sans would look wrong in a way that is hard to notice in a
 *      thumbnail and obvious on a phone. Local files also mean a render is
 *      reproducible with the network unplugged. If the fetch fails we keep the
 *      remote <link> and warn rather than dying — the reel still renders, and
 *      Chromium will resolve the fonts if it has a route out.
 *
 *   2. A seek API is exposed. The engine is an IIFE, so `t`, `paint()` and
 *      `select()` are sealed inside a closure and unreachable from Playwright.
 *      We replace the autoplay line at the end of that closure with a small
 *      `window.__CUT` surface. Replacing the autoplay line does double duty: it
 *      is inside the closure (so it can see the locals) and removing it stops
 *      the reel from running on its own clock while we are driving it by hand.
 *
 *   3. Render-mode CSS strips the studio. The reel's own "clean mode" still
 *      scales the stage to fit the window; for capture we want the opposite —
 *      the stage pinned at 1:1 with the viewport sized to match, so a
 *      screenshot IS the frame and no resampling ever touches it.
 *
 * Both replacements assert before they act. If someone re-publishes the reel
 * with a different ending or different font links, this fails loudly at build
 * time instead of quietly rendering 1700 frames of the wrong thing.
 *
 * Usage:  node scripts/cutting-room/build-harness.mjs [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'cutting-room.html');
const OUT_DIR = path.resolve(process.argv[2] ?? path.join(HERE, '.harness'));

const FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900' +
  '&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
// Google serves woff2 only to browsers it recognises; without a browser UA the
// same URL answers with ttf and the @font-face src rewriting below finds nothing.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Fetch the webfont CSS and every face it references into `outDir/fonts`. */
async function localiseFonts(outDir) {
  const res = await fetch(FONT_CSS_URL, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`font CSS ${res.status}`);
  let css = await res.text();

  const urls = [...new Set([...css.matchAll(/https:\/\/fonts\.gstatic\.com\/[^)]+/g)].map((m) => m[0]))];
  if (urls.length === 0) throw new Error('no font files referenced in CSS');

  fs.mkdirSync(path.join(outDir, 'fonts'), { recursive: true });
  await Promise.all(
    urls.map(async (url, i) => {
      const file = `f${String(i).padStart(2, '0')}.woff2`;
      const font = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
      if (!font.ok) throw new Error(`font file ${font.status} for ${url}`);
      fs.writeFileSync(path.join(outDir, 'fonts', file), Buffer.from(await font.arrayBuffer()));
      css = css.replaceAll(url, `fonts/${file}`);
    }),
  );

  fs.writeFileSync(path.join(outDir, 'fonts.css'), css);
  return urls.length;
}

// The seek surface Playwright drives. `setPlay(false)` before each seek keeps the
// rAF loop from advancing `t` underneath us between the seek and the screenshot.
const SEEK_API = `
window.__CUT = {
  cuts: ADS.map(function(a){ return {name:a.n, dur:a.dur}; }),
  aspects: ASPECTS.map(function(a){ return {k:a.k, w:a.w, h:a.h}; }),
  setAspect: function(i){ A = ASPECTS[i]; applyGeo(); paint(); },
  select: function(i){ select(i); },
  seek: function(ms){ setPlay(false); t = ms; paint(); }
};
`;

const AUTOPLAY = "if(!matchMedia('(prefers-reduced-motion: reduce)').matches) setPlay(true);";

const RENDER_CSS = `
  html,body{margin:0;padding:0}
  /* Render mode: hide every piece of studio chrome and pin the stage at 1:1, so a
     viewport of exactly W x H makes the screenshot the finished frame. The reel's
     own .clean mode is not enough — it still scales the stage to fit the window. */
  body.render{background:#000;overflow:hidden}
  body.render .mast,body.render .rail,body.render .bar,body.render .scrub,body.render .exit{display:none!important}
  body.render .wrap{display:block!important;max-width:none!important;padding:0!important;margin:0!important;gap:0!important}
  body.render .viewer{min-width:0}
  body.render .frame{border:0!important;border-radius:0!important;box-shadow:none!important;display:block!important}
  body.render #fit{width:100vw!important;height:100vh!important}
  body.render #stage{transform:none!important;top:0!important;left:0!important}
`;

async function main() {
  let reel = fs.readFileSync(SOURCE, 'utf8');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let fontHref = FONT_CSS_URL;
  try {
    const n = await localiseFonts(OUT_DIR);
    fontHref = 'fonts.css';
    console.log(`fonts: ${n} faces pulled local`);
  } catch (err) {
    console.warn(`fonts: staying remote (${err.message}) — renders need network and are not byte-reproducible`);
  }

  if (fontHref !== FONT_CSS_URL) {
    const before = reel;
    reel = reel
      .replace(/<link rel="preconnect"[^>]*>\s*/g, '')
      .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*">\s*/g, '');
    if (reel === before) throw new Error('font <link> tags not found — has cutting-room.html changed?');
  }

  if (!reel.includes(AUTOPLAY)) {
    throw new Error('autoplay line not found — the reel engine changed, re-check the seek API against it');
  }
  reel = reel.replace(AUTOPLAY, SEEK_API);

  const html =
    `<!doctype html><html><head><meta charset="utf8">\n` +
    `<link rel="stylesheet" href="${fontHref}">\n` +
    `<style>${RENDER_CSS}</style></head><body class="render">\n` +
    reel;

  const file = path.join(OUT_DIR, 'harness.html');
  fs.writeFileSync(file, html);
  console.log(`harness: ${file}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
