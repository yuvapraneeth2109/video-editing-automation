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
/** Audio is encoded in step with video every ~second so the muxer never buffers a whole clip. */
const AUDIO_CHUNK_SECONDS = 1;
const MAX_FPS = 60;
const MAX_LONG_EDGE = 3840;

export type ClipInfo = { width: number; height: number; duration: number; fps: number };

export type Size = { width: number; height: number };

export type RenderOptions = {
  clips: { file: File; info: ClipInfo }[];
  logo: ImageBitmap;
  size: Size;
  fps: number;
  logoSeconds: number;
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
 * Turns a clip's decoded audio (any sample rate / channel layout, possibly with gaps)
 * into gap-free 48 kHz stereo windows that line up exactly with the video timeline.
 */
class AudioWindowReader {
  private pending: WrappedAudioBuffer[] = [];
  private done = false;

  constructor(
    private readonly buffers: AsyncGenerator<WrappedAudioBuffer, void, unknown>,
    private readonly origin: number,
  ) {}

  async read(from: number, frames: number): Promise<AudioBuffer> {
    const to = from + frames / SAMPLE_RATE;

    while (!this.done && (this.pending.length === 0 || this.relStart(this.pending.at(-1)!) < to)) {
      const next = await this.buffers.next();
      if (next.done) this.done = true;
      else this.pending.push(next.value);
    }

    const context = new OfflineAudioContext(CHANNELS, frames, SAMPLE_RATE);
    for (const wrapped of this.pending) {
      const start = this.relStart(wrapped);
      if (start >= to || start + wrapped.duration <= from) continue;
      const node = context.createBufferSource();
      node.buffer = wrapped.buffer;
      node.connect(context.destination);
      if (start >= from) node.start(start - from);
      else node.start(0, from - start);
    }

    this.pending = this.pending.filter((b) => this.relStart(b) + b.duration > to);
    return context.startRendering();
  }

  close() {
    void this.buffers.return();
  }

  private relStart(b: WrappedAudioBuffer) {
    return b.timestamp - this.origin;
  }
}

const silence = (frames: number) =>
  new AudioBuffer({ length: frames, numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE });

/**
 * Renders: logo intro → every clip in order → logo outro, into one constant-frame-rate MP4.
 * Decoding and encoding run on the GPU/media engine through WebCodecs; nothing is uploaded.
 */
export async function renderVideo({ clips, logo, size, fps, logoSeconds, signal, onProgress }: RenderOptions): Promise<Blob> {
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

  // Plan the timeline up front so progress is exact.
  const logoFrames = Math.max(1, Math.round(logoSeconds * fps));
  const clipFrames = clips.map(({ info }) => Math.max(1, Math.round(info.duration * fps)));
  const totalFrames = logoFrames * 2 + clipFrames.reduce((a, b) => a + b, 0);
  const audioChunkFrames = Math.max(1, Math.round(AUDIO_CHUNK_SECONDS * fps));

  let frameIndex = 0;
  let audioWritten = 0;

  // Timestamps derive from the global frame index, so video and audio can never drift apart.
  const addVideoFrame = async () => {
    signal.throwIfAborted();
    await videoSource.add(frameIndex / fps, 1 / fps);
    frameIndex++;
    onProgress(frameIndex / totalFrames);
  };

  /** Encodes audio up to the current video position. `read` supplies audio relative to the segment start. */
  const syncAudio = async (segmentStartSample: number, read?: (from: number, frames: number) => Promise<AudioBuffer>) => {
    const target = Math.round((frameIndex * SAMPLE_RATE) / fps);
    const frames = target - audioWritten;
    if (frames <= 0) return;
    const buffer = read ? await read((audioWritten - segmentStartSample) / SAMPLE_RATE, frames) : silence(frames);
    await audioSource.add(buffer);
    audioWritten = target;
  };

  const renderLogo = async () => {
    const segmentStart = audioWritten;
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
      if ((i + 1) % audioChunkFrames === 0) await syncAudio(segmentStart);
    }
    ctx.globalAlpha = 1;
    await syncAudio(segmentStart);
  };

  const renderClip = async (file: File, frames: number) => {
    const input = openInput(file);
    let audio: AudioWindowReader | null = null;
    let canvases: AsyncGenerator<{ canvas: HTMLCanvasElement | OffscreenCanvas } | null, void, unknown> | null = null;
    try {
      const videoTrack = (await input.getPrimaryVideoTrack())!;
      const audioTrack = await input.getPrimaryAudioTrack();
      const origin = await input.getFirstTimestamp();
      const segmentStart = audioWritten;

      if (audioTrack && (await audioTrack.canDecode())) {
        audio = new AudioWindowReader(new AudioBufferSink(audioTrack).buffers(origin), origin);
      }
      const read = audio ? audio.read.bind(audio) : undefined;

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
        await addVideoFrame();
        if ((i + 1) % audioChunkFrames === 0) await syncAudio(segmentStart, read);
      }
      await syncAudio(segmentStart, read);
    } finally {
      void canvases?.return();
      audio?.close();
      input.dispose();
    }
  };

  try {
    await output.start();
    await renderLogo();
    for (let i = 0; i < clips.length; i++) await renderClip(clips[i].file, clipFrames[i]);
    await renderLogo();
    await output.finalize();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } catch (error) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    throw error;
  }
}
