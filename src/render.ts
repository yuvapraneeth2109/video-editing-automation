import {
  MATROSKA,
  MP4,
  QTFF,
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
  type WrappedAudioBuffer,
} from 'mediabunny';

/** Output audio format. 48 kHz stereo is the delivery standard for video. */
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** Audio is mixed and encoded in step with video every ~second so memory stays flat. */
const AUDIO_CHUNK_SECONDS = 1;
const MAX_FPS = 60;
const MAX_LONG_EDGE = 3840;
const MUSIC_FADE_IN = 1;
const MUSIC_FADE_OUT = 2.5;
const VOICE_FADE_OUT = 0.4;
const CLIP_VOICE_FADE_OUT = 0.3;
const PILL_FADE = 0.4;

export type ClipInfo = { width: number; height: number; duration: number; fps: number };

export type Size = { width: number; height: number };

export type PillPosition = `${'top' | 'middle' | 'bottom'}-${'left' | 'center' | 'right'}`;

/** A caption shown in a rounded box over one clip. */
export type TextPill = { text: string; position: PillPosition };

export type RenderClip = {
  file: File;
  info: ClipInfo;
  /** Plays from the start of this clip and is cut at its end. */
  voiceover?: AudioBuffer;
  pill?: TextPill;
};

export type RenderOptions = {
  clips: RenderClip[];
  logo: ImageBitmap;
  size: Size;
  fps: number;
  logoSeconds: number;
  /** Volumes (0–1) of the clips' own sound, every voiceover, and the music. */
  clipVolume: number;
  voiceVolume: number;
  musicVolume: number;
  /** One voiceover for the whole video: starts with the first clip and plays once. */
  voiceover?: AudioBuffer;
  /** Plays under the whole video, looping if shorter, with fades at both ends. */
  music?: AudioBuffer;
  signal: AbortSignal;
  onProgress: (fraction: number) => void;
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

/** Decodes an audio file (MP3, WAV, M4A, AAC…) straight to the output format: 48 kHz stereo. */
export async function loadAudio(file: File): Promise<AudioBuffer> {
  try {
    return await new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('This audio file could not be read.');
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Matches the first clip's frame size, capped at 4K, with even dimensions as H.264 requires. */
export function autoSize(first: ClipInfo): Size {
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(first.width, first.height));
  return { width: even(first.width * scale), height: even(first.height * scale) };
}

/** Uses the highest clip frame rate so no source is decimated, capped at 60 fps. */
export function autoFps(clips: ClipInfo[]): number {
  const fps = Math.max(...clips.map((c) => c.fps).filter(Number.isFinite));
  return Math.min(MAX_FPS, fps > 0 ? fps : 30);
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
const createPill = (ctx: OffscreenCanvasRenderingContext2D, { text, position }: TextPill, width: number, height: number) => {
  const base = Math.min(width, height);
  const fontSize = Math.round(base * 0.042);
  const font = `600 ${fontSize}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
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
    ctx.fillStyle = 'rgba(15, 17, 21, 0.72)';
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, radius);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, textX, y + padY + lineHeight * (i + 0.5)));
    ctx.restore();
  };
};

/**
 * Renders: logo intro → every clip in order → logo outro, into one constant-frame-rate MP4,
 * with optional text pills, voiceovers (whole-video or per clip) and background music.
 * Decoding and encoding run on the GPU/media engine through WebCodecs; nothing is uploaded.
 */
export async function renderVideo(options: RenderOptions): Promise<Blob> {
  const { clips, logo, size, fps, logoSeconds, clipVolume, voiceVolume, musicVolume, voiceover, music, signal, onProgress } = options;
  const { width, height } = size;

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc'], { width, height, bitrate: QUALITY_VERY_HIGH });
  if (!videoCodec) throw new Error(`This browser cannot encode ${width}×${height} video. Try a smaller output size.`);
  const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: CHANNELS,
    sampleRate: SAMPLE_RATE,
    bitrate: QUALITY_VERY_HIGH,
  });
  if (!audioCodec) throw new Error('This browser cannot encode audio for MP4.');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingQuality = 'high';

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY_VERY_HIGH, keyFrameInterval: 2 });
  const audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_VERY_HIGH });
  output.addVideoTrack(videoSource, { frameRate: fps });
  output.addAudioTrack(audioSource);

  // Plan the timeline up front so progress is exact and fades land in the right place.
  const logoFrames = Math.max(1, Math.round(logoSeconds * fps));
  const clipFrames = clips.map(({ info }) => Math.max(1, Math.round(info.duration * fps)));
  const totalFrames = logoFrames * 2 + clipFrames.reduce((a, b) => a + b, 0);
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
    await videoSource.add(frameIndex / fps, 1 / fps);
    frameIndex++;
    onProgress(frameIndex / totalFrames);
  };

  /** A clip's place on the timeline and the audio that belongs to it. */
  type Segment = { start: number; end: number; startSample: number; reader?: ClipAudioReader; voiceover?: AudioBuffer };

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
  const mixWindow = async (fromSample: number, frames: number, segment?: Segment): Promise<AudioBuffer> => {
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

    if (segment?.reader) {
      const gain = new GainNode(context, { gain: clipVolume });
      gain.connect(bus);
      const offset = segment.startSample / SAMPLE_RATE;
      await segment.reader.schedule(context, gain, from - offset, to - offset);
    }
    if (segment?.voiceover) {
      scheduleVoice(context, bus, segment.voiceover, segment.start, segment.end, CLIP_VOICE_FADE_OUT, from, to);
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
  const syncAudio = async (segment?: Segment) => {
    const target = Math.round((frameIndex * SAMPLE_RATE) / fps);
    const frames = target - audioWritten;
    if (frames <= 0) return;
    await audioSource.add(await mixWindow(audioWritten, frames, segment));
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

  const renderClip = async ({ file, voiceover: clipVoice, pill }: RenderClip, frames: number) => {
    const input = openInput(file);
    let canvases: AsyncGenerator<{ canvas: HTMLCanvasElement | OffscreenCanvas } | null, void, unknown> | null = null;
    const segment: Segment = {
      start: frameIndex / fps,
      end: (frameIndex + frames) / fps,
      startSample: audioWritten,
      voiceover: clipVoice,
    };
    try {
      const videoTrack = (await input.getPrimaryVideoTrack())!;
      const audioTrack = await input.getPrimaryAudioTrack();
      const origin = await input.getFirstTimestamp();

      if (clipVolume > 0 && audioTrack && (await audioTrack.canDecode())) {
        segment.reader = new ClipAudioReader(new AudioBufferSink(audioTrack).buffers(origin), origin);
      }

      const drawPill = pill?.text.trim() ? createPill(ctx, pill, width, height) : null;
      const pillFadeFrames = Math.max(1, Math.min(Math.round(PILL_FADE * fps), Math.floor(frames / 3)));

      // Letterboxed to the output size; rotation metadata is applied by the sink.
      const sink = new CanvasSink(videoTrack, { width, height, fit: 'contain', poolSize: 2 });
      canvases = sink.canvasesAtTimestamps(
        (function* () {
          for (let i = 0; i < frames; i++) yield origin + i / fps;
        })(),
      );

      for (let i = 0; i < frames; i++) {
        const next = await canvases.next();
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
        if (!next.done && next.value) ctx.drawImage(next.value.canvas, 0, 0);
        drawPill?.(Math.min(1, i / pillFadeFrames, (frames - 1 - i) / pillFadeFrames));
        await addVideoFrame();
        if ((i + 1) % audioChunkFrames === 0) await syncAudio(segment);
      }
      await syncAudio(segment);
    } finally {
      void canvases?.return();
      segment.reader?.close();
      input.dispose();
    }
  };

  try {
    await output.start();
    await renderLogo();
    for (let i = 0; i < clips.length; i++) await renderClip(clips[i], clipFrames[i]);
    await renderLogo();
    await output.finalize();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } catch (error) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    throw error;
  }
}
