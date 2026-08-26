#!/usr/bin/env node
/**
 * Turn the explainer reel into a frame-exact, offline render harness.
 *
 * Same pattern as scripts/cutting-room/build-harness.mjs — localises fonts,
 * replaces the autoplay line with a window.__CUT seek API, and adds render-
 * mode CSS that strips studio chrome so a Playwright screenshot IS the frame.
 *
 * Usage:  node scripts/explainer/build-harness.mjs [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'explainer.html');
const OUT_DIR = path.resolve(process.argv[2] ?? path.join(HERE, '.harness'));

const FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900' +
  '&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
    if (reel === before) throw new Error('font <link> tags not found — has explainer.html changed?');
  }

  if (!reel.includes(AUTOPLAY)) {
    throw new Error('autoplay line not found — the explainer engine changed, re-check the seek API against it');
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
