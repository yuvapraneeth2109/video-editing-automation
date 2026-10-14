import {
  MATROSKA,
  MP4,
  QTFF,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  WEBM,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
  type WrappedAudioBuffer,
} from 'mediabunny';

import {
  GRID,
  cellBounds,
  planTimeline,
  type ClipInfo,
  type Motion,
  type PillPosition,
  type PlannedClip,
  type Quality,
  type Size,
  type Transition,
} from './timeline';

/** Output audio format. 48 kHz stereo is the delivery standard for video. */
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** Audio is mixed and encoded in step with video every ~second so memory stays flat. */
const AUDIO_CHUNK_SECONDS = 1;
const MUSIC_FADE_IN = 1;
const MUSIC_FADE_OUT = 2.5;
const VOICE_FADE_OUT = 0.4;
const CLIP_VOICE_FADE_OUT = 0.3;
/** Text pills and images fade in and out over this many seconds. */
const OVERLAY_FADE = 0.4;
/** Zoom in/out moves between 100% and this scale over the clip. */
const MOTION_SCALE = 1.12;

/** A caption shown in a rounded box over one clip. */
export type TextPill = {
  text: string;
  position: PillPosition;
  /** Any CSS colour, e.g. rgba(15, 17, 21, 0.72). */
  background: string;
  color: string;
  fontFamily: string;
};

export type RenderClip = {
  file: File;
  info: ClipInfo;
  /** True for photos: shown still for `info.duration` seconds instead of decoding video. */
  photo: boolean;
  motion: Motion;
  /** Transition into the next clip (ignored on the last clip). */
  transition: Transition;
  /** Plays from the start of this clip and is cut at its end. */
  voiceover?: AudioBuffer;
  pill?: TextPill;
  /** Images shown over this clip (later ones on top), each fitted inside the grid cells it covers. */
  images: { file: File; cells: number[] }[];
};

export type RenderOptions = {
  clips: RenderClip[];
  logo: ImageBitmap;
  size: Size;
  fps: number;
  logoSeconds: number;
  transitionSeconds: number;
  quality: Quality;
  /** Volumes (0–1) of the clips' own sound, every voiceover, and the music. */
  clipVolume: number;
  voiceVolume: number;
  musicVolume: number;
  /** One voiceover for the whole video: starts with the first clip and plays once. */
  voiceover?: AudioBuffer;
  /** Plays under the whole video, looping if shorter, with fades at both ends. */
  music?: AudioBuffer;
  signal: AbortSignal;
  /** `stage` names what is being rendered, e.g. "Clip 2 of 5". */
  onProgress: (fraction: number, stage: string) => void;
};

/** MP4, MOV, WebM and MKV cover camera, phone and screen-recorder output. */
const INPUT_FORMATS = [MP4, QTFF, WEBM, MATROSKA];

const openInput = (file: File) => new Input({ source: new BlobSource(file), formats: INPUT_FORMATS });

/** Reads the metadata needed to plan the render and fails early on files the browser cannot decode. */
export async function probeClip(file: File): Promise<ClipInfo> {
  const input = openInput(file);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('No video track found.');
    if (!(await video.canDecode())) throw new Error('This browser cannot decode this video format.');

    const [width, height, start, end, metrics] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      input.getFirstTimestamp(),
      input.computeDuration(),
      video.computeFrameRateMetrics(),
    ]);
    return { width, height, duration: end - start, fps: metrics.bestGuessFrameRate };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Unsupported file.');
  } finally {
    input.dispose();
  }
}

/** Overlay images are decoded at most this large on their long edge — sharp even at 4K, far less memory. */
const OVERLAY_MAX_EDGE = 2048;

/** Decodes an image, scaled down to `maxEdge` if it is larger. Callers must close() the result. */
async function decodeImage(file: File, maxEdge: number): Promise<ImageBitmap> {
  const full = await createImageBitmap(file);
  const scale = maxEdge / Math.max(full.width, full.height);
  if (scale >= 1) return full;
  const resized = await createImageBitmap(full, {
    resizeWidth: Math.round(full.width * scale),
    resizeHeight: Math.round(full.height * scale),
    resizeQuality: 'high',
  });
  full.close();
  return resized;
}

/**
 * Checks an image can be read and returns its size. Nothing is kept in memory: images are
 * decoded again only while their clip is being exported, so projects can hold any number of photos.
 */
export async function probeImage(file: File): Promise<Size> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    throw new Error('This image could not be read. Use PNG, JPG or WebP.');
  }
}

/**
 * Finished exports are streamed into the browser's private on-disk storage (Origin Private File System)
 * instead of being held in memory, so the output can be many gigabytes. One export is kept at a time.
 */
const EXPORT_FILE = 'export.mp4';

/** Deletes the stored export, freeing its disk space. */
export async function clearExports() {
  try {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry(EXPORT_FILE);
  } catch {
    // Nothing stored, or on-disk storage is unavailable.
  }
}

/** A step that takes longer than this without finishing is treated as stuck. */
const STALL_MS = 20_000;

/** Thrown when an encoder or the output file stops responding. */
class StallError extends Error {}

/**
 * Rejects with a StallError if `promise` has not settled within `ms`, or with the abort reason as soon as
 * `signal` fires — so Cancel works immediately even while an encoder is stuck.
 */
function withTimeout<T>(promise: Promise<T>, what: string, ms = STALL_MS, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StallError(`${what} stopped responding`)), ms);
    onAbort = () => reject(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort!);
  });
}

/** Where the MP4 is written: on disk when the browser allows it, otherwise in memory. */
async function createTarget() {
  try {
    await withTimeout(clearExports(), 'Disk storage', 10_000);
    const dir = await withTimeout(navigator.storage.getDirectory(), 'Disk storage', 10_000);
    const handle = await withTimeout(dir.getFileHandle(EXPORT_FILE, { create: true }), 'Disk storage', 10_000);
    const writable = (await withTimeout(handle.createWritable(), 'Disk storage', 10_000)) as unknown as WritableStream<StreamTargetChunk>;
    return {
      target: new StreamTarget(writable, { chunked: true }),
      // Space for the index is reserved at the start, so the file streams/plays instantly without buffering it all.
      fastStart: 'reserve' as const,
      // A disk-backed Blob: previewing and downloading read from disk, not memory.
      result: async () => new Blob([await handle.getFile()], { type: 'video/mp4' }),
      discard: clearExports,
    };
  } catch {
    const target = new BufferTarget();
    return {
      target,
      fastStart: 'in-memory' as const,
      result: async () => new Blob([target.buffer!], { type: 'video/mp4' }),
      discard: async () => {},
    };
  }
}

/** Decodes an audio file (MP3, WAV, M4A, AAC…) straight to the output format: 48 kHz stereo. */
export async function loadAudio(file: File): Promise<AudioBuffer> {
  try {
    return await new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('This audio file could not be read.');
  }
}

/**
 * Feeds a clip's decoded audio (any sample rate / channel layout, possibly with gaps)
 * into a mixing window, aligned exactly to the clip's position on the timeline.
 */
class ClipAudioReader {
  private pending: WrappedAudioBuffer[] = [];
  private done = false;

  constructor(
    private readonly buffers: AsyncGenerator<WrappedAudioBuffer, void, unknown>,
    private readonly origin: number,
  ) {}

  /** Schedules the audio between `from` and `to` (seconds from clip start) at the start of `context`. */
  async schedule(context: BaseAudioContext, destination: AudioNode, from: number, to: number) {
    while (!this.done && (this.pending.length === 0 || this.relStart(this.pending.at(-1)!) < to)) {
      const next = await this.buffers.next();
      if (next.done) this.done = true;
      else this.pending.push(next.value);
    }

    for (const wrapped of this.pending) {
      const start = this.relStart(wrapped);
      if (start >= to || start + wrapped.duration <= from) continue;
      const node = context.createBufferSource();
      node.buffer = wrapped.buffer;
      node.connect(destination);
      node.start(Math.max(0, start - from), Math.max(0, from - start));
    }

    this.pending = this.pending.filter((b) => this.relStart(b) + b.duration > to);
  }

  close() {
    void this.buffers.return();
  }

  private relStart(b: WrappedAudioBuffer) {
    return b.timestamp - this.origin;
  }
}

/** Piecewise-linear volume curve as [seconds, gain] points. */
type Envelope = [number, number][];

const valueAt = (env: Envelope, t: number) => {
  if (t <= env[0][0]) return env[0][1];
  for (let i = 1; i < env.length; i++) {
    const [t1, v1] = env[i];
    if (t <= t1) {
      const [t0, v0] = env[i - 1];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return env.at(-1)![1];
};

/** Applies the part of an envelope that falls inside the window [from, to). */
const applyEnvelope = (param: AudioParam, env: Envelope, from: number, to: number, scale: number) => {
  param.setValueAtTime(scale * valueAt(env, from), 0);
  for (const [t] of env) if (t > from && t < to) param.linearRampToValueAtTime(scale * valueAt(env, t), t - from);
  param.linearRampToValueAtTime(scale * valueAt(env, to), to - from);
};

/**
 * Stateless soft limiter: transparent below -2 dBFS, smoothly rounds peaks above it so a loud
 * voice + music + clip sound can never clip. Stateless means no artefacts between mixing windows.
 * The curve covers input -2..2 (the mix is halved before it, so the curve re-doubles it).
 */
const LIMITER_CURVE = (() => {
  const n = 4097;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
  }
  return curve;
})();

/** Splits text into lines that fit `maxWidth` with the current canvas font. */
const wrapText = (ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number) => {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
};

/** Lays out a text pill once and returns a function that draws it at a given opacity. */
const createPill = (ctx: OffscreenCanvasRenderingContext2D, pill: TextPill, width: number, height: number) => {
  const { text, position, background, color, fontFamily } = pill;
  const base = Math.min(width, height);
  const fontSize = Math.round(base * 0.042);
  const font = `600 ${fontSize}px ${fontFamily}`;
  const padX = fontSize * 0.9;
  const padY = fontSize * 0.55;
  const lineHeight = fontSize * 1.3;
  const margin = base * 0.06;

  ctx.font = font;
  const lines = wrapText(ctx, text.trim(), width * 0.8 - padX * 2);
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const boxH = lines.length * lineHeight + padY * 2;
  const radius = Math.min(boxH / 2, fontSize * 1.1);

  const [vertical, horizontal] = position.split('-');
  const x = horizontal === 'left' ? margin : horizontal === 'right' ? width - margin - boxW : (width - boxW) / 2;
  const y = vertical === 'top' ? margin : vertical === 'bottom' ? height - margin - boxH : (height - boxH) / 2;
  const align: CanvasTextAlign = horizontal === 'left' ? 'left' : horizontal === 'right' ? 'right' : 'center';
  const textX = align === 'left' ? x + padX : align === 'right' ? x + boxW - padX : x + boxW / 2;

  return (alpha: number) => {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, radius);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, textX, y + padY + lineHeight * (i + 0.5)));
    ctx.restore();
  };
};

/** Fits an image (keeping its proportions) inside the grid cells it covers; returns a draw-at-opacity function. */
const createImageOverlay = (ctx: OffscreenCanvasRenderingContext2D, bitmap: ImageBitmap, cells: number[], width: number, height: number) => {
  const { col, row, cols, rows } = cellBounds(cells);
  const inset = Math.min(width, height) * 0.02;
  const areaW = (cols * width) / GRID - inset * 2;
  const areaH = (rows * height) / GRID - inset * 2;
  const scale = Math.min(areaW / bitmap.width, areaH / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  const x = (col * width) / GRID + inset + (areaW - w) / 2;
  const y = (row * height) / GRID + inset + (areaH - h) / 2;

  return (alpha: number) => {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(bitmap, x, y, w, h);
    ctx.restore();
  };
};

/** Smooth start and end for transitions and camera moves. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** How one clip is drawn on a given frame. */
type Layer = { alpha: number; offsetX: number; reveal: number; scale: number };

/** Works out a clip's opacity, position, wipe and zoom for local frame `k`. */
function layerAt(clip: PlannedClip, motion: Motion, k: number): Layer {
  const layer: Layer = { alpha: 1, offsetX: 0, reveal: 1, scale: 1 };
  const t = clip.frames > 1 ? k / (clip.frames - 1) : 0;
  if (motion === 'zoom-in') layer.scale = 1 + (MOTION_SCALE - 1) * ease(t);
  if (motion === 'zoom-out') layer.scale = MOTION_SCALE - (MOTION_SCALE - 1) * ease(t);
  if (motion === 'zoom-in-out') layer.scale = 1 + (MOTION_SCALE - 1) * ease(t < 0.5 ? t * 2 : 2 - t * 2);

  if (k < clip.inFrames) {
    const p = ease((k + 0.5) / clip.inFrames);
    if (clip.inType === 'dissolve' || clip.inType === 'fade') layer.alpha = p;
    if (clip.inType === 'slide') layer.offsetX = 1 - p;
    if (clip.inType === 'wipe') layer.reveal = p;
  }
  const outStart = clip.frames - clip.outFrames;
  if (k >= outStart) {
    const p = ease((k - outStart + 0.5) / clip.outFrames);
    if (clip.outType === 'fade') layer.alpha *= 1 - p;
    if (clip.outType === 'slide') layer.offsetX = -p;
    // Dissolve and wipe: the outgoing clip stays put while the next one is drawn over it.
  }
  return layer;
}

/** Builds the clip's audio volume curve: fades match its transitions; cuts stay hard. */
function clipEnvelope(start: number, end: number, fadeIn: number, fadeOut: number): Envelope {
  return [
    [start, fadeIn > 0 ? 0 : 1],
    [start + fadeIn, 1],
    [end - fadeOut, 1],
    [end, fadeOut > 0 ? 0 : 1],
  ];
}

/**
 * Renders: logo intro → every clip in order (with transitions, zoom, text pills) → logo outro,
 * into one constant-frame-rate MP4, mixed with clip sound, voiceovers and background music.
 * Decoding and encoding run on the GPU/media engine through WebCodecs; nothing is uploaded.
 */
export async function renderVideo(options: RenderOptions): Promise<Blob> {
  try {
    try {
      return await render(options, false);
    } catch (error) {
      if (!(error instanceof StallError) || options.signal.aborted) throw error;
      // Some devices' hardware encoders (or their AAC audio encoder) never return frames. Start again with
      // software video encoding and Opus audio, which behave the same everywhere.
      console.warn(`${error.message}; retrying with compatible encoder settings.`);
      try {
        return await render(options, true);
      } catch (retryError) {
        if (retryError instanceof StallError) {
          throw new Error(`${retryError.message}, even in compatibility mode. Please update Chrome and try again, or choose a smaller output size.`);
        }
        throw retryError;
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error(
        'Not enough free disk space for this export. Free up space on your computer, or choose a smaller output size or lower quality.',
      );
    }
    throw error;
  }
}

/** `compatible` = the retry profile: software video encoding and Opus audio first. */
async function render(options: RenderOptions, compatible: boolean): Promise<Blob> {
  const { clips, logo, size, fps, logoSeconds, transitionSeconds, clipVolume, voiceVolume, musicVolume, voiceover, music, signal, onProgress } =
    options;
  const { width, height } = size;
  let progress = 0;
  let stage = '';
  /** Names the current step in the UI, so a slow or stuck export always shows where it is. */
  const setStage = (name: string) => {
    stage = compatible ? `${name} (compatibility mode)` : name;
    onProgress(progress, stage);
  };
  setStage('Checking encoders');

  const videoBitrate = { 'very-high': QUALITY_VERY_HIGH, high: QUALITY_HIGH, medium: QUALITY_MEDIUM }[options.quality];
  const software = { hardwareAcceleration: 'prefer-software' as const };
  const videoCodecOptions = { width, height, bitrate: videoBitrate };
  const softwareVideo = compatible && (await getFirstEncodableVideoCodec(['avc'], { ...videoCodecOptions, ...software })) === 'avc';
  const videoCodec = softwareVideo ? 'avc' : await getFirstEncodableVideoCodec(['avc', 'hevc'], videoCodecOptions);
  if (!videoCodec) throw new Error(`This browser cannot encode ${width}×${height} video. Try a smaller output size.`);
  const audioCodec = await getFirstEncodableAudioCodec(compatible ? ['opus', 'aac'] : ['aac', 'opus'], {
    numberOfChannels: CHANNELS,
    sampleRate: SAMPLE_RATE,
    bitrate: QUALITY_VERY_HIGH,
  });
  if (!audioCodec) throw new Error('This browser cannot encode audio for MP4.');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingQuality = 'high';

  // Plan every frame up front so progress is exact and transitions and fades land precisely.
  const plan = planTimeline(
    clips.map((c) => c.info.duration),
    clips.map((c) => c.transition),
    fps,
    logoSeconds,
    transitionSeconds,
  );
  const { logoFrames, totalFrames } = plan;

  // Exact packet counts let the muxer reserve the index up front (fast start without buffering in memory).
  // Audio packets are 960 (Opus) or 1024 (AAC) samples; the smaller size gives the safe upper bound.
  const audioPackets = Math.ceil(((totalFrames / fps) * SAMPLE_RATE) / 960);
  setStage('Preparing output file');
  const sink = await createTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate: videoBitrate,
    keyFrameInterval: 2,
    ...(softwareVideo ? software : {}),
  });
  const audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_VERY_HIGH });
  output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: totalFrames + 16 });
  output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(audioPackets * 1.1) + 16 });
  const clipsEnd = totalFrames - logoFrames;
  const audioChunkFrames = Math.max(1, Math.round(AUDIO_CHUNK_SECONDS * fps));

  const totalSeconds = totalFrames / fps;
  const voiceStart = logoFrames / fps;
  const musicFadeOutStart = Math.max(MUSIC_FADE_IN, totalSeconds - MUSIC_FADE_OUT);
  const musicEnvelope: Envelope = [
    [0, 0],
    [MUSIC_FADE_IN, 1],
    [musicFadeOutStart, 1],
    [Math.max(musicFadeOutStart, totalSeconds), 0],
  ];
  const useLimiter = Boolean(voiceover || music || clips.some((c) => c.voiceover));

  let frameIndex = 0;
  let audioWritten = 0;

  // Timestamps derive from the global frame index, so video and audio can never drift apart.
  const addVideoFrame = async () => {
    signal.throwIfAborted();
    await withTimeout(videoSource.add(frameIndex / fps, 1 / fps), 'The video encoder', STALL_MS, signal);
    frameIndex++;
    progress = frameIndex / totalFrames;
    onProgress(progress, stage);
  };

  /** A clip's span on the timeline (seconds) and the audio that belongs to it. */
  type Segment = { start: number; end: number; envelope: Envelope; fadeOut: number; reader?: ClipAudioReader; voiceover?: AudioBuffer };
  /** Clips currently on screen — one, or two during a transition. */
  const activeSegments = new Set<Segment>();

  /** Plays `buffer` from `start`, fading out just before `end`, within the window [from, to). */
  const scheduleVoice = (
    context: OfflineAudioContext,
    bus: AudioNode,
    buffer: AudioBuffer,
    start: number,
    end: number,
    fade: number,
    from: number,
    to: number,
  ) => {
    if (voiceVolume <= 0 || start >= to || Math.min(end, start + buffer.duration) <= from) return;
    const envelope: Envelope = [
      [start, 1],
      [Math.max(start, end - fade), 1],
      [end, 0],
    ];
    const source = new AudioBufferSourceNode(context, { buffer });
    const gain = new GainNode(context);
    applyEnvelope(gain.gain, envelope, from, to, voiceVolume);
    source.connect(gain).connect(bus);
    source.start(Math.max(0, start - from), Math.max(0, from - start));
  };

  /** Mixes clip sound, voiceovers and music for one window of the timeline. */
  const mixWindow = async (fromSample: number, frames: number): Promise<AudioBuffer> => {
    const from = fromSample / SAMPLE_RATE;
    const to = from + frames / SAMPLE_RATE;
    const context = new OfflineAudioContext(CHANNELS, frames, SAMPLE_RATE);

    let bus: AudioNode = context.destination;
    if (useLimiter) {
      const limiter = context.createWaveShaper();
      limiter.curve = LIMITER_CURVE;
      limiter.connect(context.destination);
      bus = new GainNode(context, { gain: 0.5 });
      bus.connect(limiter);
    }

    for (const segment of activeSegments) {
      if (segment.reader) {
        const gain = new GainNode(context);
        applyEnvelope(gain.gain, segment.envelope, from, to, clipVolume);
        gain.connect(bus);
        await segment.reader.schedule(context, gain, from - segment.start, to - segment.start);
      }
      if (segment.voiceover) {
        const fade = Math.max(CLIP_VOICE_FADE_OUT, segment.fadeOut);
        scheduleVoice(context, bus, segment.voiceover, segment.start, segment.end, fade, from, to);
      }
    }
    if (voiceover) {
      scheduleVoice(context, bus, voiceover, voiceStart, totalSeconds, VOICE_FADE_OUT, from, to);
    }
    if (music && musicVolume > 0) {
      const source = new AudioBufferSourceNode(context, { buffer: music, loop: true });
      const gain = new GainNode(context);
      applyEnvelope(gain.gain, musicEnvelope, from, to, musicVolume);
      source.connect(gain).connect(bus);
      source.start(0, from % music.duration);
    }

    return context.startRendering();
  };

  /** Encodes audio up to the current video position. */
  const syncAudio = async () => {
    const target = Math.round((frameIndex * SAMPLE_RATE) / fps);
    const frames = target - audioWritten;
    if (frames <= 0) return;
    await withTimeout(audioSource.add(await mixWindow(audioWritten, frames)), `The ${audioCodec.toUpperCase()} audio encoder`, STALL_MS, signal);
    audioWritten = target;
  };

  const renderLogo = async () => {
    const fadeFrames = Math.max(1, Math.min(Math.round(0.6 * fps), Math.floor(logoFrames / 3)));
    const scale = Math.min((width * 0.5) / logo.width, (height * 0.45) / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;

    for (let i = 0; i < logoFrames; i++) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = Math.min(1, i / fadeFrames, (logoFrames - 1 - i) / fadeFrames);
      ctx.drawImage(logo, (width - w) / 2, (height - h) / 2, w, h);
      await addVideoFrame();
      if ((i + 1) % audioChunkFrames === 0) await syncAudio();
    }
    ctx.globalAlpha = 1;
    await syncAudio();
  };

  /** A photo, decoded at output size, letterboxed onto a canvas once and reused for every frame. */
  const stillSource = async (file: File) => {
    const bitmap = await decodeImage(file, Math.max(width, height));
    const still = new OffscreenCanvas(width, height);
    const g = still.getContext('2d', { alpha: false })!;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#000000';
    g.fillRect(0, 0, width, height);
    const s = Math.min(width / bitmap.width, height / bitmap.height);
    g.drawImage(bitmap, (width - bitmap.width * s) / 2, (height - bitmap.height * s) / 2, bitmap.width * s, bitmap.height * s);
    bitmap.close();
    return { next: async () => still, close: () => {} };
  };

  /** A video file: frames decoded in order (letterboxed, rotation applied), its sound fed to the mixer. */
  const videoFileSource = async (file: File, frames: number, segment: Segment) => {
    const input = openInput(file);
    const videoTrack = (await input.getPrimaryVideoTrack())!;
    const audioTrack = await input.getPrimaryAudioTrack();
    const origin = await input.getFirstTimestamp();
    if (clipVolume > 0 && audioTrack && (await audioTrack.canDecode())) {
      segment.reader = new ClipAudioReader(new AudioBufferSink(audioTrack).buffers(origin), origin);
    }
    const sink = new CanvasSink(videoTrack, { width, height, fit: 'contain', poolSize: 2 });
    const canvases = sink.canvasesAtTimestamps(
      (function* () {
        for (let i = 0; i < frames; i++) yield origin + i / fps;
      })(),
    );
    return {
      next: async () => {
        const next = await canvases.next();
        return !next.done && next.value ? next.value.canvas : null;
      },
      close: () => {
        void canvases.return();
        segment.reader?.close();
        input.dispose();
      },
    };
  };

  /** Opens a clip (video or photo) for sequential frame drawing and registers its audio for mixing. */
  const openClip = async (clip: RenderClip, planned: PlannedClip) => {
    const start = planned.start / fps;
    const end = (planned.start + planned.frames) / fps;
    const fadeOut = planned.outFrames / fps;
    const segment: Segment = {
      start,
      end,
      fadeOut,
      envelope: clipEnvelope(start, end, planned.inFrames / fps, fadeOut),
      voiceover: clip.voiceover,
    };
    const source = clip.photo ? await stillSource(clip.file) : await videoFileSource(clip.file, planned.frames, segment);
    activeSegments.add(segment);

    const drawPill = clip.pill?.text.trim() ? createPill(ctx, clip.pill, width, height) : null;
    // Overlay images are decoded only while their clip is on screen, then released.
    const overlays = await Promise.all(
      clip.images.map(async ({ file, cells }) => ({ bitmap: await decodeImage(file, OVERLAY_MAX_EDGE), cells })),
    );
    const drawImages = overlays.map(({ bitmap, cells }) => createImageOverlay(ctx, bitmap, cells, width, height));
    const overlayFadeFrames = Math.max(1, Math.min(Math.round(OVERLAY_FADE * fps), Math.floor(planned.frames / 3)));
    let k = 0;

    return {
      /** Draws this clip's next frame onto the output canvas, applying transition and zoom. */
      async draw() {
        const frame = await source.next();
        const { alpha, offsetX, reveal, scale } = layerAt(planned, clip.motion, k);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(offsetX * width, 0);
        if (reveal < 1) {
          ctx.beginPath();
          ctx.rect(0, 0, reveal * width, height);
          ctx.clip();
        }
        if (frame) {
          const w = width * scale;
          const h = height * scale;
          ctx.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h);
        }
        const overlayAlpha = alpha * Math.min(1, k / overlayFadeFrames, (planned.frames - 1 - k) / overlayFadeFrames);
        drawImages.forEach((draw) => draw(overlayAlpha));
        drawPill?.(overlayAlpha);
        ctx.restore();
        k++;
      },
      /** True once every frame of this clip has been drawn. */
      get finished() {
        return k >= planned.frames;
      },
      close() {
        source.close();
        overlays.forEach(({ bitmap }) => bitmap.close());
        activeSegments.delete(segment);
      },
    };
  };

  type OpenClip = Awaited<ReturnType<typeof openClip>>;

  /** Walks the clip section frame by frame; clips overlap during dissolve, slide and wipe. */
  const renderClips = async () => {
    const open: OpenClip[] = [];
    let nextClip = 0;
    try {
      for (let f = logoFrames; f < clipsEnd; f++) {
        while (nextClip < clips.length && plan.clips[nextClip].start === f) {
          setStage(`Clip ${nextClip + 1} of ${clips.length}`);
          open.push(await openClip(clips[nextClip], plan.clips[nextClip]));
          nextClip++;
        }
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
        for (const clip of open) await clip.draw(); // older clip first, the incoming one on top
        await addVideoFrame();

        const finished = open.filter((c) => c.finished);
        if (finished.length || (f + 1) % audioChunkFrames === 0) await syncAudio();
        for (const clip of finished) {
          clip.close();
          open.splice(open.indexOf(clip), 1);
        }
      }
      await syncAudio();
    } finally {
      open.forEach((c) => c.close());
    }
  };

  try {
    setStage('Starting encoders');
    await withTimeout(output.start(), 'The output file');
    setStage('Logo intro');
    await renderLogo();
    await renderClips();
    setStage('Logo outro');
    await renderLogo();
    setStage('Finishing file');
    await withTimeout(output.finalize(), 'Finishing the file', 120_000);
    return await sink.result();
  } catch (error) {
    // A stuck encoder can also block cancelling, so neither clean-up step may wait forever.
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await withTimeout(output.cancel(), 'Cancelling', 5_000).catch(() => {});
    }
    await withTimeout(sink.discard(), 'Clean-up', 5_000).catch(() => {});
    throw error;
  }
}
