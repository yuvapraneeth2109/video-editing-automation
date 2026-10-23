# Roothoot Video Editor

Upload any number of video clips and photos (each photo shown for a chosen number of seconds), trim each video to a kept start–end range against a filmstrip of its own frames (with live start/end frame previews so you can see exactly where you are cutting), put them in order, optionally add transitions (dissolve, fade, slide, wipe), camera motion (zoom in/out or pan left/right/up/down, at a chosen speed), any number of text pills (captions) per clip, each with adjustable text size and its own show/hide window within the clip, and overlay images placed by dragging over the clip's first frame or by typing exact X/Y (and size) numbers, a watermark logo that stays on the whole video, a voiceover (one for the whole video, one per clip, or one covering a chosen run of clips — each trimmable to a chosen span with a "play selection" preview and positioned with a start offset) and background music (with its own start offset), choose the ad-canvas output size (960×960 or 1024×1024, or a custom size), and export one best-quality H.264 MP4 with the Roothoot logo as an animated intro and outro. The finished video can be downloaded as-is, or as a standard H.264 MP4 kept under 5 MB at the same resolution you chose — copied losslessly when it already fits (identical quality), otherwise re-encoded at that size with a lower bitrate (a long video may look softer; trimming shorter or a smaller output size keeps it crisp).

**Live:** deployed on Vercel (free tier) — static site, no backend.

## How it works

```
Browser (Chrome / Edge / Safari)
 ├─ Mediabunny demuxes each file (MP4, MOV, WebM, MKV)
 ├─ WebCodecs decodes frames on the GPU media engine
 ├─ Each frame is letterboxed onto one canvas at the output size and frame rate, with zoom, transitions and text pills composited on top
 ├─ Clip sound, voiceover and music are mixed (Web Audio) at 48 kHz stereo, in sync with the video
 └─ WebCodecs encodes H.264 + AAC → MP4 streamed to on-disk browser storage (OPFS) → preview / download
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
| Output size is the ad canvas only — 960×960 (required), 1024×1024 (maximum), or a custom size; clips are letterboxed into the square | Matches the delivery spec; clips of any shape fit the square with black bars (fit: contain) |
| Default very-high bitrate at the clips' own frame rate (no frames skipped) | Best quality; a 30 fps cap is still selectable for a smaller/faster file |
| Export streamed to the Origin Private File System, with the MP4 index reserved up front (`fastStart: 'reserve'`) | Output size is limited by free disk space, not RAM; files stay fast-start; falls back to in-memory where OPFS is unavailable |
| Input videos read lazily from disk (`BlobSource`); photos and overlay images decoded only while their clip is on screen | Memory stays flat no matter how large or how many the inputs are |
| Encoder watchdog: a step that returns nothing for 20 s triggers one automatic retry with a compatible profile (realtime encoding, software video where offered, in-memory output) | Some devices' encoders hold frames back indefinitely; the export recovers instead of hanging |
| Safari/iOS (WebKit) use the compatible profile from the start | WebKit's encoder can wait for more frames than the pipeline sends, and its on-disk writer is new; realtime mode returns every frame immediately |
| No compressor or file-size cap — the export is always best quality | Quality is never traded for size; the file is as good as the source allows |
| Always H.264 (AVC) inside the MP4, never HEVC | The most widely compatible output — plays in every browser, QuickTime and editor |
| Two downloads: the file as-made, or an H.264 MP4 under 5 MB (`transcodeH264`) | Both downloads are the full size the user chose (e.g. 1024×1024) — the ≤5 MB copy is never downscaled. If it already fits, the H.264 streams are copied losslessly (identical quality); if larger, it is re-encoded at the same resolution with the bitrate the 5 MB budget allows (`h264FitSize`, shared by the UI and engine so the size shown on the button matches the file). A long video therefore gets a lower bitrate and may look softer, which trimming shorter or a smaller output size improves. Audio is copied; a software encoder and 25 s watchdog handle Safari, and a two-step prepare-then-link flow makes the download work there (Safari blocks a programmatic download fired after an `await`) |
| Each clip holds a list of text pills (`pills: TextPill[]`), every one with its own text, style, size (`size` %, clamped 0.3×–4×), position and on-screen window (`start`/`end` seconds), laid out and faded independently in the engine | Several captions can appear on one clip, at once or at different moments; each is added/removed like an image overlay, the others shown faintly in the placement preview, whose font scales in `cqmin` units to match the export exactly |
| Every voiceover can be trimmed to a span of its audio (`AudioTrim`, sliced once via `sliceBuffer`) and previewed with a "play selection" button, then positioned with a start offset — in all three modes (whole `voiceTrim`/`voiceStartOffset`, per-clip `voiceTrim`/`voiceOffset`, per-range `trim`/`startOffset`) | Use just the part of a recording you want and hear exactly that part before committing, then place it precisely on the timeline; offsets are clamped so a voice never starts past the end of its span |
| Per-clip trim shows a filmstrip of the clip's own frames with the trimmed ends dimmed, plus live start/end frame previews (`makeFrames`) | You see the actual video content and exactly which frames the cut keeps, instead of guessing from a seconds number; frames decode off the main path and the start/end previews debounce so dragging stays smooth |
| One `PlacementEditor` for pills, overlay images and the watermark: drag over the clip's first frame AND editable X/Y (and size) numbers | Pixel-free, resolution-independent placement with a true preview; no grids anywhere — exact numeric control everywhere |
| Pill position is the box CENTRE as a normalised x/y, clamped on-screen; images/watermark are centre + width | Intuitive "type the position" model that matches the drag preview exactly |
| Per-clip video trim (`trimStart` + trimmed `info.duration`); the engine decodes frames and audio from the trim point | Cut off unwanted heads/tails without a separate tool; timeline and sound stay aligned |
| Camera motion is zoom OR pan, with a speed (`MOTION_SPEED_SCALE`); pan zooms in for overscan then travels so no edge ever shows; pan moves only the video, overlays stay put | Ken-Burns-style movement with intuitive direction + speed, without disturbing captions or logos |
| Watermark logo drawn at a fixed spot on every clip frame (`logoOverlay`), composited on top after the clips | A brand mark that persists through the whole video, separate from the animated intro/outro |
| Whole-video voiceover and music take a start offset; every audio track has an inline listen preview | Position narration/music on the timeline and hear a file before committing |
| A voiceover can span a chosen run of clips (`voiceRanges`, by clip index → exact seconds) | One narration file often covers two or three clips in sequence; it plays across the run and fades at the end |
| First-frame thumbnail generated for every clip (first decoded frame for video, the image itself for photos), reused as the image-placement backdrop | Clips are identified at a glance and placement shows the real frame; generated off the main path and falling back to a placeholder, so it never blocks or breaks an import |
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
