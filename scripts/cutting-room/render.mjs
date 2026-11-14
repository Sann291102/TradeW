#!/usr/bin/env node
/**
 * Render the Cutting Room reel to uploadable H.264 MP4s.
 *
 * Drives the harness from `build-harness.mjs` one frame at a time — set the
 * clock, screenshot, feed the PNG straight to ffmpeg — so the output is exact
 * rather than a recording of a browser doing its best. See that file for why
 * the reel can be rendered this way at all.
 *
 * ── ENCODING CHOICES, AND WHY ──────────────────────────────────────────────
 *
 * H.264 High profile, level 4.2, yuv420p, +faststart. This is the intersection
 * of what Instagram, TikTok, YouTube, X and LinkedIn all ingest without
 * re-encoding surprises; yuv420p in particular is the one that stops a file
 * from playing as a green rectangle on older Android and in Safari previews.
 * CRF 18 is visually lossless for flat-colour motion graphics like these, and
 * these cuts are mostly near-black — the files land around 1-3 MB, far under
 * every platform's limit, so there is no reason to trade quality for size.
 *
 * 30fps rather than the 60 the old OBS note asked for: every one of these
 * platforms delivers 30fps to most viewers anyway, it halves render time, and
 * because frames are computed rather than captured there is no judder to hide.
 *
 * Frames go down a pipe instead of to disk. A 17.5s cut at 1080x1920 is ~525
 * PNGs; writing them out would burn ~400MB per cut for files read once. The
 * `write()` helper below respects backpressure so a slow encoder slows the
 * capture loop rather than growing an unbounded buffer in Node.
 *
 * Usage:
 *   node scripts/cutting-room/render.mjs                      # all cuts, 9:16
 *   node scripts/cutting-room/render.mjs --aspects=all        # every aspect
 *   node scripts/cutting-room/render.mjs --cuts=2 --aspects=16:9
 *   node scripts/cutting-room/render.mjs --fps=60 --out=./reel
 *
 * Cuts are 1-based here (CUT 01..04) to match how the studio labels them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const FPS = Number(arg('fps', 30));
const OUT_DIR = path.resolve(arg('out', path.join(HERE, 'out')));
const HARNESS_DIR = path.resolve(arg('harness', path.join(HERE, '.harness')));

/**
 * ffmpeg must be a build with libx264 — notably NOT the one Playwright bundles,
 * which is a cut-down VP8/WebM-only encoder and will fail with "Unknown encoder
 * 'libx264'". A distro ffmpeg is fine; so is `pip install imageio-ffmpeg`.
 */
function resolveFfmpeg() {
  const candidates = [process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  try {
    const py = spawnSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], {
      encoding: 'utf8',
    });
    if (py.status === 0) candidates.push(py.stdout.trim());
  } catch { /* python or the package is absent — the other candidates still apply */ }

  for (const bin of candidates) {
    const probe = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.includes('libx264')) return bin;
  }
  throw new Error(
    'no ffmpeg with libx264 found. Install one (apt install ffmpeg, brew install ffmpeg, ' +
      'or pip install imageio-ffmpeg) or point $FFMPEG at it. Playwright\'s bundled ffmpeg is WebM-only.',
  );
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function encoder(ffmpeg, file, fps) {
  const proc = spawn(
    ffmpeg,
    [
      '-y', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(fps), '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow',
      '-profile:v', 'high', '-level', '4.2', '-movflags', '+faststart',
      file,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const closed = new Promise((resolve, reject) => {
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`)));
  });
  return { proc, closed };
}

const write = (stream, buf) =>
  new Promise((resolve) => (stream.write(buf) ? resolve() : stream.once('drain', resolve)));

async function main() {
  const harness = path.join(HARNESS_DIR, 'harness.html');
  if (!fs.existsSync(harness)) {
    throw new Error(`no harness at ${harness} — run: node scripts/cutting-room/build-harness.mjs`);
  }

  const ffmpeg = resolveFfmpeg();
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // A mismatched Playwright/browser revision is common on machines where the
  // browsers were provisioned separately; fall back to the on-disk chromium.
  const shipped = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium')
    : null;
  const launch = { args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'] };
  let browser;
  try {
    browser = await chromium.launch(launch);
  } catch (err) {
    if (!shipped || !fs.existsSync(shipped)) throw err;
    browser = await chromium.launch({ ...launch, executablePath: shipped });
  }

  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(`file://${harness}`);
  // Capturing before the webfonts settle bakes a fallback face into frame one.
  await page.evaluate(() => document.fonts.ready);
  const reel = await page.evaluate(() => ({ cuts: window.__CUT.cuts, aspects: window.__CUT.aspects }));

  const wantAspects = arg('aspects', '9:16');
  const aspects = wantAspects === 'all'
    ? reel.aspects.map((_, i) => i)
    : wantAspects.split(',').map((k) => {
        const i = reel.aspects.findIndex((a) => a.k === k.trim());
        if (i < 0) throw new Error(`unknown aspect "${k}" — have: ${reel.aspects.map((a) => a.k).join(', ')}`);
        return i;
      });

  const wantCuts = arg('cuts', 'all');
  const cuts = wantCuts === 'all'
    ? reel.cuts.map((_, i) => i)
    : wantCuts.split(',').map((n) => {
        const i = Number(n) - 1;
        if (!Number.isInteger(i) || i < 0 || i >= reel.cuts.length) {
          throw new Error(`unknown cut "${n}" — the reel has cuts 1..${reel.cuts.length}`);
        }
        return i;
      });

  for (const ai of aspects) {
    const aspect = reel.aspects[ai];
    await page.setViewportSize({ width: aspect.w, height: aspect.h });
    await page.evaluate((i) => window.__CUT.setAspect(i), ai);

    for (const ci of cuts) {
      const cut = reel.cuts[ci];
      const name = `tradew-cut${String(ci + 1).padStart(2, '0')}-${slug(cut.name)}-${aspect.k.replace(':', 'x')}.mp4`;
      const file = path.join(OUT_DIR, name);
      // +1 so the final frame of the timeline is held, not cut off one frame early.
      const frames = Math.round((cut.dur / 1000) * FPS) + 1;

      await page.evaluate((i) => window.__CUT.select(i), ci);
      const { proc, closed } = encoder(ffmpeg, file, FPS);
      const started = Date.now();

      for (let f = 0; f < frames; f++) {
        const ms = Math.min((f * 1000) / FPS, cut.dur);
        await page.evaluate((m) => window.__CUT.seek(m), ms);
        await write(proc.stdin, await page.screenshot({
          clip: { x: 0, y: 0, width: aspect.w, height: aspect.h },
        }));
      }

      proc.stdin.end();
      await closed;
      const mb = (fs.statSync(file).size / 1048576).toFixed(1);
      console.log(`${name}  ${frames} frames  ${mb}MB  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
