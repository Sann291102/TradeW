# scripts/cutting-room/ 🎬

Renders the **TradeW Cutting Room** reel — four ad cuts, four aspect ratios — into
uploadable H.264 MP4s.

The reel itself lives in `cutting-room.html`, a copy of the published Cutting Room
artifact. It is a studio, not a file format: four cuts built from real product copy
(`lib/discipline.ts` strings, Tara's real commands, Sentinel's real observation
wording), playable and scrubbable in 9:16, 4:5, 1:1 and 16:9.

## Why not just screen-record it

The reel's own Capture note used to say *"record with OBS at 60fps and crop to the
stage"*. That gives you dropped frames, a variable frame rate, whatever the
compositor did that afternoon, and a hand-eyeballed crop.

It isn't necessary. Every scene renderer in the reel is a pure function of the
timeline clock — the FX layer says so in its own comment: *"pure f(t), so scrubbing
is exact"*. Nothing carries over between frames. So the reel renders the way a 3D
scene does: set the clock, paint, capture, encode at a locked frame rate. Every
frame lands exactly where the animation says it should, and a slow machine makes
the render take longer instead of making the video worse.

## Running it

```bash
npm i -D playwright && npx playwright install chromium
npm run reel:build          # fetch fonts, build the render harness
npm run reel:render         # all four cuts, 9:16, into scripts/cutting-room/out/
```

You also need an **ffmpeg built with libx264**. A distro build is fine
(`apt install ffmpeg`, `brew install ffmpeg`), as is `pip install imageio-ffmpeg`,
which `render.mjs` finds on its own. Playwright's bundled ffmpeg is *not* usable —
it is a cut-down VP8/WebM-only encoder.

More than the default:

```bash
node scripts/cutting-room/render.mjs --aspects=all       # all 16 files
node scripts/cutting-room/render.mjs --cuts=2 --aspects=16:9,1:1
node scripts/cutting-room/render.mjs --fps=60 --out=./reel
```

`--cuts` is 1-based, matching the CUT 01..04 labels in the studio.

Roughly a minute of wall time per 15s of 1080p output. Both `.harness/` and `out/`
are gitignored — they are build products, not sources.

## The files

| File | What it does |
| --- | --- |
| `cutting-room.html` | The reel. Copy of the published artifact, kept here so renders are reproducible from the repo alone. |
| `build-harness.mjs` | Copies the reel into a render harness: fonts pulled local, a `window.__CUT` seek API exposed, studio chrome stripped, stage pinned at 1:1. Never modifies the reel. |
| `render.mjs` | Drives the harness frame by frame and pipes PNGs into ffmpeg. |

Both scripts carry their reasoning in a header comment — read those before changing
encoder settings or the seek mechanism.

## Output

Files land as `tradew-cut01-say-where-you-want-to-go-9x16.mp4` and so on:
H.264 High/4.2, yuv420p, `+faststart`, CRF 18, 30fps. That is the intersection of
what Instagram, TikTok, YouTube, X and LinkedIn all ingest cleanly — `yuv420p` in
particular is what stops a file playing as a green rectangle in Safari previews and
on older Android.

**These render silent.** Each cut's `spec` in the reel describes the sound design it
was cut for (whip-and-snap on Cut 01, room tone and keystrokes on Cut 02, near
silence on Cut 03, one music bed on Cut 04). Captions are burned in, so they read
with the sound off — but add the audio before posting.

## When the reel changes

`build-harness.mjs` asserts on the two things it rewrites — the font `<link>` tags
and the autoplay line at the end of the engine's IIFE. If the artifact is
re-published with either changed, the build fails loudly instead of quietly
rendering hundreds of frames of the wrong thing. Re-copy the artifact HTML over
`cutting-room.html` (everything from `<title>` onward, without the artifact shell's
frame-runtime `<head>`), then fix whichever assertion tripped.
