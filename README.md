# Roothoot Video Editor

Upload any number of video clips and photos (each photo shown for a chosen number of seconds), put them in order, optionally add transitions (dissolve, fade, slide, wipe), zoom in/out motion, a text pill (caption) placed on a 5×5 grid, and overlay images to any clip, a voiceover (one for the whole video, one per clip, or one covering a chosen run of clips) and background music, choose the output size (including Instagram and square ad formats) and an optional coloured border, cap the file size to a target (e.g. 2 MB mobile / 5 MB desktop) with no change to the resolution, and export one MP4 with the Roothoot logo as an animated intro and outro.

**Live:** deployed on Vercel (free tier) — static site, no backend.

## How it works

```
Browser (Chrome / Edge / Safari)
 ├─ Mediabunny demuxes each file (MP4, MOV, WebM, MKV)
 ├─ WebCodecs decodes frames on the GPU media engine
 ├─ Each frame is letterboxed onto one canvas at the output size and frame rate, with zoom, transitions and text pills composited on top
 ├─ Clip sound, voiceover and music are mixed (Web Audio) at 48 kHz stereo, in sync with the video
 └─ WebCodecs encodes H.264 (or HEVC when a size cap is set) + AAC → MP4 streamed to on-disk browser storage (OPFS) → preview / download
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
| Timeline planned on an exact frame grid (`timeline.ts`) shared by UI and engine | Durations shown in the UI match the export; overlapping transitions shorten the video exactly as previewed |
| Overlapping clips decoded side by side, audio crossfaded with the picture | Dissolve/slide/wipe look and sound seamless |
| Default output 1080p at up to 30 fps | Phone footage is often 4K60 — 1080p30 is ~8× fewer pixels to encode, so exports are much faster |
| Export streamed to the Origin Private File System, with the MP4 index reserved up front (`fastStart: 'reserve'`) | Output size is limited by free disk space, not RAM; files stay fast-start; falls back to in-memory where OPFS is unavailable |
| Input videos read lazily from disk (`BlobSource`); photos and overlay images decoded only while their clip is on screen | Memory stays flat no matter how large or how many the inputs are |
| Encoder watchdog: a step that returns nothing for 20 s triggers one automatic retry with a compatible profile (realtime encoding, software video where offered, in-memory output) | Some devices' encoders hold frames back indefinitely; the export recovers instead of hanging |
| Safari/iOS (WebKit) use the compatible profile from the start | WebKit's encoder can wait for more frames than the pipeline sends, and its on-disk writer is new; realtime mode returns every frame immediately |
| Optional file-size cap sets the exact video bitrate for the whole video (`maxBytes`), preferring HEVC where supported; resolution never changes | Hits a hard size target (e.g. 2 MB / 5 MB ad limits) with the least possible quality loss. At a fixed resolution, size is governed by bitrate, so the UI shows the exact bitrate the cap allows and warns when a cap is too tight for the video's length rather than degrading silently |
| HEVC preferred only when a cap is set and not on WebKit/software paths | HEVC fits ~40% more picture into the same bytes, so a given cap costs less quality; AVC stays the default elsewhere for the widest playback |
| Optional border renders content into an inner canvas composited inside the frame | A coloured border can never cover the video, logo, pills or images — they are fitted inside it, not drawn over |
| Text-pill position is a normalised x/y anchor, snapped to a 5×5 grid in the UI | More placement choices without changing the engine; the grid size is one UI constant |
| A voiceover can span a chosen run of clips (`voiceRanges`, by clip index → exact seconds) | One narration file often covers two or three clips in sequence; it plays across the run and fades at the end |
| First-frame thumbnail generated for every clip (first decoded frame for video, the image itself for photos) | Clips are identified at a glance; generated off the main path and falling back to a placeholder, so it never blocks or breaks an import |
| Screen wake lock during export | Long exports don't stop because the computer went to sleep |
| Media engine lazy-loaded | Page paints instantly; engine loads in the background |

## Project structure

```
src/
  App.tsx       UI: upload, reorder, settings, progress, preview, download
  render.ts     Media engine: probe clips, render timeline, encode MP4
  timeline.ts   Pure timeline maths: output size, frame rate, transition layout
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
