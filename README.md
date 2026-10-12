# Roothoot Video Editor

Upload any number of clips, put them in order, optionally add a text pill (caption) to any clip, a voiceover (one for the whole video or one per clip) and background music, and export one MP4 with the Roothoot logo as an animated intro and outro.

**Live:** deployed on Vercel (free tier) — static site, no backend.

## How it works

```
Browser (Chrome / Edge / Safari)
 ├─ Mediabunny demuxes each file (MP4, MOV, WebM, MKV)
 ├─ WebCodecs decodes frames on the GPU media engine
 ├─ Each frame is letterboxed onto one canvas at the output size and frame rate, with optional text pills drawn on top
 ├─ Clip sound, voiceover and music are mixed (Web Audio) at 48 kHz stereo, in sync with the video
 └─ WebCodecs encodes H.264 + AAC → MP4 (fast-start) → download
```

| Decision | Why |
|---|---|
| All processing in the browser | Zero server cost, no upload wait, files never leave the device, no Vercel size/time limits |
| WebCodecs (via Mediabunny) instead of ffmpeg.wasm | Hardware-accelerated decode/encode — many times faster, no 30 MB WASM download |
| Re-encode instead of stream copy | Clips usually differ in codec, size and frame rate; one constant-frame-rate output plays everywhere |
| Very-high bitrate H.264, max clip frame rate (≤60), up to 4K | Best quality without bloating size |
| Video and audio timestamps derived from one frame counter | A/V can never drift, across any number of clips |
| Audio mixed and encoded in 1-second chunks alongside video | Memory stays flat regardless of clip length |
| Per-clip voiceover plays from its clip's start and fades out at the clip's end | Each explanation stays with its clip, even after reordering |
| Whole-video voiceover starts with the first clip; music loops under the whole video with fade in/out | Standard edit layout; music defaults to 20% and clip sound drops to 30% when a voiceover is added, so the voice stays clear |
| Stateless soft limiter on the mix | Loud layers can never clip, with no artefacts between chunks |
| Media engine lazy-loaded | Page paints instantly; engine loads in the background |

## Project structure

```
src/
  App.tsx       UI: upload, reorder, settings, progress, preview, download
  render.ts     Media engine: probe clips, render timeline, encode MP4
  styles.css    Styles (light + dark)
  assets/logo.png
```

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
```

Requires Node.js 20.19+.

## Browser support

Latest Chrome, Edge, Safari (17+). The app shows a notice if the browser can't encode video.
