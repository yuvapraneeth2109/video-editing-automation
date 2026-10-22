import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import logoUrl from './assets/logo.png';
import {
  MOTION_LABELS,
  MOTION_SPEED_LABELS,
  TRANSITION_LABELS,
  autoFps,
  planTimeline,
  type ClipInfo,
  type Motion,
  type MotionSpeed,
  CUSTOM_SIZE_LIMITS,
  PILL_FONTS,
  QUALITY_LABELS,
  customSize,
  type PillFont,
  type PillPosition,
  type Quality,
  type Size,
  type Transition,
} from './timeline';

// The media engine is loaded on demand so the page itself paints instantly.
const loadEngine = () => import('./render');

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const clamp = (min: number, max: number, n: number) => Math.min(max, Math.max(min, n));

type AudioTrack = { file: File } & (
  | { status: 'loading' }
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'error'; error: string }
);

type PillStyle = { background: string; opacity: number; color: string; font: PillFont };
type Pill = { enabled: boolean; text: string; position: PillPosition } & PillStyle;

/** An image overlay: `url` previews it; x/y are its centre (0–1 of the frame) and scale its width (0–1). */
type Overlay = { id: string; file: File; url: string; x: number; y: number; scale: number } & (
  | { status: 'loading' }
  | { status: 'ready'; width: number; height: number }
  | { status: 'error'; error: string }
);

type Trim = { start: number; end: number };

type Clip = {
  id: string;
  file: File;
  /** A small still preview (object URL), filled in after the file is read. */
  preview: string | null;
  voiceover: AudioTrack | null;
  pill: Pill;
  images: Overlay[];
  motion: Motion;
  motionSpeed: MotionSpeed;
  /** Seconds kept from a video (start..end of the source). Ignored for photos. */
  trim: Trim;
  transition: Transition;
} & (
  | { status: 'probing' }
  /** For photos, `info.duration` is the on-screen time the user chose; for videos it's the full source length. */
  | { status: 'ready'; info: ClipInfo; photo: boolean }
  | { status: 'error'; error: string }
);

type VoiceMode = 'whole' | 'ranges' | 'per-clip';

/** One voiceover file that covers a run of clips, by their position (inclusive). */
type VoiceRange = { id: string; track: AudioTrack; start: number; end: number };

type Job =
  | { state: 'idle' }
  | { state: 'rendering'; progress: number; stage: string; startedAt: number; updatedAt: number }
  | { state: 'done'; url: string; blob: Blob; size: number; seconds: number };

type DoneOrError = Job | { state: 'error'; message: string };

/** Output size: the two ad-canvas sizes from the spec, plus a custom option. */
const CUSTOM_PRESET = 'Custom size (type width × height)';
const SIZE_PRESETS: Record<string, Size> = {
  '960 × 960 px (required)': { width: 960, height: 960 },
  '1024 × 1024 px (maximum)': { width: 1024, height: 1024 },
};
const SIZE_OPTIONS = [...Object.keys(SIZE_PRESETS), CUSTOM_PRESET];

/** The pill starts centred near the bottom. x/y are its CENTRE as a fraction of the frame. */
const CENTER_BOTTOM: PillPosition = { x: 0.5, y: 0.85 };

const DEFAULT_PILL_STYLE: PillStyle = { background: '#0f1115', opacity: 72, color: '#ffffff', font: 'system' };
const PILL_FONT_KEYS = Object.keys(PILL_FONTS) as PillFont[];
const PHOTO_SECONDS = { default: 4, min: 1, max: 60 };
const isPhoto = (f: File) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|heic)$/i.test(f.name);
const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
/** New images start near a free corner (centre position), at 25% of the frame width. */
const IMAGE_SPOTS = [
  { x: 0.75, y: 0.25 },
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
];
const IMAGE_DEFAULT_SCALE = 0.25;
/** The watermark logo starts small in the top-right corner. */
const LOGO_OVERLAY_DEFAULT = { x: 0.84, y: 0.14, scale: 0.18 };

/** Releases an overlay's preview URL. Pixels are only decoded during export. */
const freeOverlay = (overlay: Overlay) => URL.revokeObjectURL(overlay.url);

/** '#rrggbb' + 0–100 opacity → CSS rgba(). */
const toRgba = (hex: string, opacity: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`;
};
const TRANSITION_SECONDS = [0.5, 0.75, 1, 1.5];
const TRANSITIONS = Object.keys(TRANSITION_LABELS) as Transition[];
const MOTIONS = Object.keys(MOTION_LABELS) as Motion[];
const MOTION_SPEEDS = Object.keys(MOTION_SPEED_LABELS) as MotionSpeed[];

const LOGO_SECONDS = [2, 3, 4, 5];
/** Clip sound is lowered to this when a voiceover is added, so the voice stays clear. */
const CLIP_VOLUME_UNDER_VOICE = 30;
const PILL_MAX_LENGTH = 120;
/** If progress stops moving for this long, the export is flagged as stuck. */
const STALL_SECONDS = 60;
/** Safari and all iOS browsers share the WebKit engine. */
const IS_SAFARI = navigator.vendor === 'Apple Computer, Inc.';
const SUPPORTED = typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

const formatTime = (s: number) => {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const formatBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const readyBuffer = (track: AudioTrack | null) => (track?.status === 'ready' ? track.buffer : undefined);
/** A photo's on-screen seconds, or a video's trimmed play length. */
const clipPlaySeconds = (c: Clip & { status: 'ready' }) =>
  c.photo ? c.info.duration : Math.max(0.1, c.trim.end - c.trim.start);

/** Creates (and revokes) an object URL for a File, for audio/image previews. */
function useObjectUrl(file: File | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

type AudioPickerProps = {
  label: string;
  track: AudioTrack | null;
  disabled: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
};

/** Shows a "+ Add" button, or the chosen file with its duration, a remove button and a listen preview. */
function AudioPicker({ label, track, disabled, onFile, onRemove }: AudioPickerProps) {
  const url = useObjectUrl(track?.status === 'ready' ? track.file : undefined);
  if (!track) {
    return (
      <label className={`slot-pick${disabled ? ' disabled' : ''}`}>
        + Add {label.toLowerCase()}
        <input
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac"
          hidden
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = '';
          }}
        />
      </label>
    );
  }
  return (
    <div className="audio-slot">
      <div className={`slot-file${track.status === 'error' ? ' error' : ''}`}>
        <span className="name" title={track.file.name}>
          {track.file.name}
          {track.status === 'error' && <small>{track.error}</small>}
        </span>
        <span className="meta">
          {track.status === 'loading' && 'Reading…'}
          {track.status === 'ready' && formatTime(track.buffer.duration)}
        </span>
        <span className="actions">
          <button onClick={onRemove} disabled={disabled} aria-label={`Remove ${label}`}>✕</button>
        </span>
      </div>
      {track.status === 'ready' && url && <audio className="audio-preview" controls preload="metadata" src={url} />}
    </div>
  );
}

function VolumeSlider({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <label className="volume">
      <span>Volume</span>
      <input type="range" min={0} max={100} step={5} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="meta">{value}%</span>
    </label>
  );
}

/** A "Starts at" offset (seconds) for an audio track, so it can be positioned on the timeline. */
function StartOffset({ value, max, disabled, onChange }: { value: number; max: number; disabled: boolean; onChange: (v: number) => void }) {
  return (
    <label className="offset">
      <span>Starts at</span>
      <input type="range" min={0} max={Math.max(1, Math.round(max))} step={0.5} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        className="text seconds"
        type="number"
        min={0}
        max={Math.max(1, Math.round(max))}
        step={0.5}
        value={Number(value.toFixed(1))}
        disabled={disabled}
        onChange={(e) => onChange(clamp(0, Math.max(1, max), Number(e.target.value) || 0))}
      />
      <span className="meta">s</span>
    </label>
  );
}

/** Background colour + opacity, text colour and font for one pill, with a live preview. */
function PillStyleEditor({ pill, disabled, onChange, onApplyAll }: { pill: Pill; disabled: boolean; onChange: (patch: Partial<PillStyle>) => void; onApplyAll: () => void }) {
  return (
    <div className="pill-style">
      <span
        className="pill-preview"
        style={{ background: toRgba(pill.background, pill.opacity), color: pill.color, fontFamily: PILL_FONTS[pill.font].family }}
      >
        {pill.text}
      </span>
      <div className="effects">
        <label>
          Background colour
          <span className="color-row">
            <input type="color" value={pill.background} disabled={disabled} onChange={(e) => onChange({ background: e.target.value })} />
            <span className="meta">{pill.background.toUpperCase()}</span>
          </span>
        </label>
        <label>
          Background opacity
          <span className="color-row">
            <input type="range" min={0} max={100} step={5} value={pill.opacity} disabled={disabled} onChange={(e) => onChange({ opacity: Number(e.target.value) })} />
            <span className="meta">{pill.opacity}%</span>
          </span>
        </label>
        <label>
          Text colour
          <span className="color-row">
            <input type="color" value={pill.color} disabled={disabled} onChange={(e) => onChange({ color: e.target.value })} />
            <span className="meta">{pill.color.toUpperCase()}</span>
          </span>
        </label>
        <label>
          Font
          <select value={pill.font} disabled={disabled} onChange={(e) => onChange({ font: e.target.value as PillFont })}>
            {PILL_FONT_KEYS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: PILL_FONTS[f].family }}>
                {PILL_FONTS[f].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="link" disabled={disabled} onClick={onApplyAll}>
        Use this style for all pills
      </button>
    </div>
  );
}

/** Editable X / Y (and optional Size) number inputs, in percent. */
function XYNumbers({ x, y, scale, disabled, onChange }: { x: number; y: number; scale?: number; disabled: boolean; onChange: (patch: { x?: number; y?: number; scale?: number }) => void }) {
  const field = (text: string, value: number, set: (v: number) => void, min = 0, max = 100) => (
    <label className="xy-field">
      <span>{text}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={Math.round(value)}
        disabled={disabled}
        onChange={(e) => set(clamp(min, max, Number(e.target.value) || 0))}
      />
      <span className="unit">%</span>
    </label>
  );
  return (
    <div className="xy-row">
      {field('X', x * 100, (v) => onChange({ x: v / 100 }))}
      {field('Y', y * 100, (v) => onChange({ y: v / 100 }))}
      {scale !== undefined && field('Size', scale * 100, (v) => onChange({ scale: v / 100 }), 5, 100)}
    </div>
  );
}

type PlacementEditorProps = {
  x: number;
  y: number;
  scale?: number;
  visualAspect?: number;
  aspect: number;
  background: string | null;
  disabled: boolean;
  hint: string;
  others?: ReactNode;
  renderVisual: (style: CSSProperties) => ReactNode;
  onChange: (patch: { x?: number; y?: number; scale?: number }) => void;
};

/** Drag a visual over the clip's first frame to place it, and/or type exact X / Y (and Size) numbers. */
function PlacementEditor({ x, y, scale, visualAspect, aspect, background, disabled, hint, others, renderVisual, onChange }: PlacementEditorProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const moveTo = (clientX: number, clientY: number) => {
    const r = frameRef.current?.getBoundingClientRect();
    if (!r) return;
    onChange({ x: clamp01((clientX - r.left) / r.width), y: clamp01((clientY - r.top) / r.height) });
  };
  const style: CSSProperties =
    scale !== undefined && visualAspect
      ? { left: `${x * 100}%`, top: `${y * 100}%`, width: `${scale * 100}%`, height: `${scale * (aspect / visualAspect) * 100}%`, transform: 'translate(-50%, -50%)' }
      : { left: `${x * 100}%`, top: `${y * 100}%`, transform: 'translate(-50%, -50%)' };
  return (
    <div className="position">
      <span className="muted">{hint}</span>
      <div
        ref={frameRef}
        className="placer"
        style={{ aspectRatio: aspect, backgroundImage: background ? `url(${background})` : undefined }}
        aria-label="Placement"
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          moveTo(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => dragging && moveTo(e.clientX, e.clientY)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        {others}
        {renderVisual(style)}
      </div>
      <XYNumbers x={x} y={y} scale={scale} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** The box an overlay occupies in the placement frame (in %), centred on its x/y. */
const overlayBox = (o: Overlay, frameAspect: number): CSSProperties => {
  const imgAspect = o.status === 'ready' ? o.width / o.height : 1;
  return {
    left: `${o.x * 100}%`,
    top: `${o.y * 100}%`,
    width: `${o.scale * 100}%`,
    height: `${o.scale * (frameAspect / imgAspect) * 100}%`,
    transform: 'translate(-50%, -50%)',
  };
};

/** Trim a video to a kept start..end range, with sliders and exact seconds. */
function TrimControl({ clip, disabled, onChange }: { clip: Clip & { status: 'ready' }; disabled: boolean; onChange: (patch: Partial<Trim>) => void }) {
  const dur = clip.info.duration;
  const { start, end } = clip.trim;
  const setStart = (v: number) => onChange({ start: clamp(0, end - 0.2, v) });
  const setEnd = (v: number) => onChange({ end: clamp(start + 0.2, dur, v) });
  return (
    <div className="trim">
      <span className="muted">
        Trim — keep {formatTime(start)} to {formatTime(end)} ({formatTime(Math.max(0, end - start))} of {formatTime(dur)})
      </span>
      <div className="trim-bar">
        <div style={{ left: `${(start / dur) * 100}%`, right: `${100 - (end / dur) * 100}%` }} />
      </div>
      <label className="offset">
        <span>Start</span>
        <input type="range" min={0} max={dur} step={0.1} value={start} disabled={disabled} onChange={(e) => setStart(Number(e.target.value))} />
        <input className="text seconds" type="number" min={0} max={dur} step={0.1} value={Number(start.toFixed(1))} disabled={disabled} onChange={(e) => setStart(Number(e.target.value) || 0)} />
        <span className="meta">s</span>
      </label>
      <label className="offset">
        <span>End</span>
        <input type="range" min={0} max={dur} step={0.1} value={end} disabled={disabled} onChange={(e) => setEnd(Number(e.target.value))} />
        <input className="text seconds" type="number" min={0} max={dur} step={0.1} value={Number(end.toFixed(1))} disabled={disabled} onChange={(e) => setEnd(Number(e.target.value) || dur)} />
        <span className="meta">s</span>
      </label>
    </div>
  );
}

export default function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [logoOverlay, setLogoOverlay] = useState<Overlay | null>(null);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('whole');
  const [voiceover, setVoiceover] = useState<AudioTrack | null>(null);
  const [voiceStartOffset, setVoiceStartOffset] = useState(0);
  const [ranges, setRanges] = useState<VoiceRange[]>([]);
  const [music, setMusic] = useState<AudioTrack | null>(null);
  const [musicStartOffset, setMusicStartOffset] = useState(0);
  const [clipVolume, setClipVolume] = useState(100);
  const [voiceVolume, setVoiceVolume] = useState(100);
  const [musicVolume, setMusicVolume] = useState(20);
  const [preset, setPreset] = useState(SIZE_OPTIONS[0]);
  const [custom, setCustom] = useState<Size>({ width: 1024, height: 1024 });
  const [quality, setQuality] = useState<Quality>('very-high');
  const [logoSeconds, setLogoSeconds] = useState(3);
  // Default to matching the clips' frame rate — no frames are skipped, so motion stays at full quality.
  const [fastFps, setFastFps] = useState(false);
  const [transitionSeconds, setTransitionSeconds] = useState(0.75);
  const [pillDefaults, setPillDefaults] = useState<PillStyle>(DEFAULT_PILL_STYLE);
  const [defaults, setDefaults] = useState<{ transition: Transition; motion: Motion; motionSpeed: MotionSpeed }>({ transition: 'dissolve', motion: 'none', motionSpeed: 'medium' });
  const [job, setJob] = useState<DoneOrError>({ state: 'idle' });
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Optional H.264 file (max 5 MB), prepared from the finished video only when the user asks for it.
  const [h264, setH264] = useState<
    | { status: 'idle' }
    | { status: 'working'; progress: number }
    | { status: 'ready'; url: string; size: number }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const h264Abort = useRef<AbortController | null>(null);

  const ready = clips.filter((c): c is Clip & { status: 'ready' } => c.status === 'ready');
  const busy = job.state === 'rendering';
  const perClip = voiceMode === 'per-clip';
  const voiceTracks: (AudioTrack | null)[] =
    voiceMode === 'per-clip' ? clips.map((c) => c.voiceover) : voiceMode === 'ranges' ? ranges.map((r) => r.track) : [voiceover];
  const activeTracks = [music, ...voiceTracks];
  const audioPending = activeTracks.some((t) => t && t.status !== 'ready');
  const overlays = clips.flatMap((c) => c.images);
  const logoPending = logoOverlay?.status === 'loading';
  const hasError =
    clips.some((c) => c.status === 'error') ||
    logoOverlay?.status === 'error' ||
    [...activeTracks, ...overlays].some((t) => t?.status === 'error');
  const canExport =
    SUPPORTED && !busy && clips.length > 0 && ready.length === clips.length && !audioPending && !logoPending && !overlays.some((o) => o?.status === 'loading');
  const fps = ready.length ? autoFps(ready.map((c) => c.info), fastFps) : 30;
  const plan = planTimeline(ready.map(clipPlaySeconds), ready.map((c) => c.transition), fps, logoSeconds, transitionSeconds);
  const totalSeconds = ready.length ? plan.totalFrames / fps : 0;
  const voiceOverflow =
    voiceMode === 'whole' && voiceover?.status === 'ready' && ready.length
      ? voiceover.buffer.duration - (totalSeconds - logoSeconds - voiceStartOffset)
      : 0;
  const hasAnyVoice =
    voiceMode === 'per-clip'
      ? clips.some((c) => c.voiceover?.status === 'ready')
      : voiceMode === 'ranges'
        ? ranges.some((r) => r.track.status === 'ready')
        : voiceover?.status === 'ready';
  const outputSize = preset === CUSTOM_PRESET ? customSize(custom.width, custom.height) : SIZE_PRESETS[preset];
  const aspect = outputSize.width / outputSize.height;
  const firstPreview = ready[0]?.preview ?? null;

  /** The value shared by every clip, or 'mixed' when clips differ. */
  const common = <K extends 'transition' | 'motion' | 'motionSpeed'>(key: K) =>
    clips.length && clips.some((c) => c[key] !== clips[0][key]) ? 'mixed' : (clips[0]?.[key] ?? defaults[key]);

  // Warn before closing the tab mid-render.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  useEffect(() => () => void (job.state === 'done' && URL.revokeObjectURL(job.url)), [job]);
  useEffect(() => () => void (h264.status === 'ready' && URL.revokeObjectURL(h264.url)), [h264]);
  useEffect(() => void loadEngine().then(({ clearExports }) => clearExports()), []);

  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const elapsed = job.state === 'rendering' ? (now - job.startedAt) / 1000 : 0;
  const stalled = job.state === 'rendering' && (now - job.updatedAt) / 1000 > STALL_SECONDS;

  const addFiles = async (files: FileList | null) => {
    const media = Array.from(files ?? []).filter((f) => isVideo(f) || isPhoto(f));
    if (!media.length) return;
    const added: Clip[] = media.map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: null,
      status: 'probing',
      voiceover: null,
      images: [],
      pill: { enabled: false, text: '', position: { ...CENTER_BOTTOM }, ...pillDefaults },
      trim: { start: 0, end: 0 },
      ...defaults,
    }));
    setClips((prev) => [...prev, ...added]);
    setJob({ state: 'idle' });

    const { probeClip, probeImage, makeThumbnail } = await loadEngine();
    for (const clip of added) {
      const photo = isPhoto(clip.file);
      const probe = photo
        ? probeImage(clip.file).then(({ width, height }) => ({ width, height, duration: PHOTO_SECONDS.default, fps: NaN }))
        : probeClip(clip.file);
      probe.then(
        (info) => {
          update(clip.id, { status: 'ready', info, photo, trim: { start: 0, end: photo ? 0 : info.duration } });
          makeThumbnail(clip.file, photo).then((preview) => update(clip.id, { preview }), () => {});
        },
        (e: Error) => update(clip.id, { status: 'error', error: e.message }),
      );
    }
  };

  const setPhotoSeconds = (clip: Clip & { status: 'ready' }, seconds: number) =>
    update(clip.id, { info: { ...clip.info, duration: Math.min(PHOTO_SECONDS.max, Math.max(PHOTO_SECONDS.min, seconds || PHOTO_SECONDS.min)) } });

  const freeClip = (clip: Clip) => {
    if (clip.preview) URL.revokeObjectURL(clip.preview);
    clip.images.forEach(freeOverlay);
  };

  const update = (id: string, patch: Partial<Clip>) =>
    setClips((prev) => prev.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)));

  const updatePill = (clip: Clip, patch: Partial<Pill>) => update(clip.id, { pill: { ...clip.pill, ...patch } });
  const updateTrim = (clip: Clip & { status: 'ready' }, patch: Partial<Trim>) => update(clip.id, { trim: { ...clip.trim, ...patch } });

  const updateImage = (clipId: string, imageId: string, patch: Partial<Overlay>) =>
    setClips((prev) =>
      prev.map((c) =>
        c.id === clipId ? { ...c, images: c.images.map((o) => (o.id === imageId ? ({ ...o, ...patch } as Overlay) : o)) } : c,
      ),
    );

  const removeImage = (clip: Clip, overlay: Overlay) => {
    freeOverlay(overlay);
    update(clip.id, { images: clip.images.filter((o) => o !== overlay) });
  };

  const addImages = (clip: Clip, files: File[]) => {
    const added: Overlay[] = files.map((file, i) => ({
      id: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file),
      ...IMAGE_SPOTS[(clip.images.length + i) % IMAGE_SPOTS.length],
      scale: IMAGE_DEFAULT_SCALE,
      status: 'loading',
    }));
    update(clip.id, { images: [...clip.images, ...added] });
    void loadEngine().then(({ probeImage }) => {
      for (const overlay of added) {
        probeImage(overlay.file).then(
          (size) => updateImage(clip.id, overlay.id, { status: 'ready', ...size }),
          (e: Error) => updateImage(clip.id, overlay.id, { status: 'error', error: e.message }),
        );
      }
    });
  };

  /** The watermark logo shown on the whole video. */
  const addLogoOverlay = (file: File) => {
    const url = URL.createObjectURL(file);
    setLogoOverlay({ id: 'logo', file, url, ...LOGO_OVERLAY_DEFAULT, status: 'loading' });
    void loadEngine().then(({ probeImage }) =>
      probeImage(file).then(
        (size) => setLogoOverlay((o) => (o && o.file === file ? { ...o, status: 'ready', ...size } : o)),
        (e: Error) => setLogoOverlay((o) => (o && o.file === file ? { ...o, status: 'error', error: e.message } : o)),
      ),
    );
  };
  const updateLogoOverlay = (patch: Partial<Pick<Overlay, 'x' | 'y' | 'scale'>>) => setLogoOverlay((o) => (o ? ({ ...o, ...patch } as Overlay) : o));
  const removeLogoOverlay = () => {
    if (logoOverlay) URL.revokeObjectURL(logoOverlay.url);
    setLogoOverlay(null);
  };

  const applyPillStyleToAll = ({ background, opacity, color, font }: PillStyle) => {
    const style = { background, opacity, color, font };
    setPillDefaults(style);
    setClips((prev) => prev.map((c) => ({ ...c, pill: { ...c.pill, ...style } })));
  };

  const setForAll = (patch: Partial<{ transition: Transition; motion: Motion; motionSpeed: MotionSpeed }>) => {
    setDefaults((d) => ({ ...d, ...patch }));
    setClips((prev) => prev.map((c) => ({ ...c, ...patch })));
  };

  const decodeAudio = async (file: File, settle: (track: AudioTrack) => void) => {
    setJob({ state: 'idle' });
    try {
      const { loadAudio } = await loadEngine();
      settle({ file, status: 'ready', buffer: await loadAudio(file) });
    } catch (e) {
      settle({ file, status: 'error', error: e instanceof Error ? e.message : 'This audio file could not be read.' });
    }
  };

  const addVoiceover = (file: File, clipId?: string) => {
    setClipVolume((v) => Math.min(v, CLIP_VOLUME_UNDER_VOICE));
    const loading: AudioTrack = { file, status: 'loading' };
    if (clipId) {
      update(clipId, { voiceover: loading });
      void decodeAudio(file, (track) =>
        setClips((prev) => prev.map((c) => (c.id === clipId && c.voiceover?.file === file ? { ...c, voiceover: track } : c))),
      );
    } else {
      setVoiceover(loading);
      void decodeAudio(file, (track) => setVoiceover((current) => (current?.file === file ? track : current)));
    }
  };

  const addRangeVoice = (file: File) => {
    setClipVolume((v) => Math.min(v, CLIP_VOLUME_UNDER_VOICE));
    const id = crypto.randomUUID();
    setRanges((prev) => [...prev, { id, track: { file, status: 'loading' }, start: 0, end: Math.max(0, clips.length - 1) }]);
    void decodeAudio(file, (track) => setRanges((prev) => prev.map((r) => (r.id === id && r.track.file === file ? { ...r, track } : r))));
  };
  const updateRange = (id: string, patch: Partial<Pick<VoiceRange, 'start' | 'end'>>) => setRanges((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRange = (id: string) => setRanges((prev) => prev.filter((r) => r.id !== id));

  const addMusic = (file: File) => {
    setMusic({ file, status: 'loading' });
    void decodeAudio(file, (track) => setMusic((current) => (current?.file === file ? track : current)));
  };

  const move = (index: number, delta: number) =>
    setClips((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });

  const remove = (id: string) => {
    const clip = clips.find((c) => c.id === id);
    if (clip) freeClip(clip);
    setClips((prev) => prev.filter((c) => c.id !== id));
  };

  const exportVideo = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = performance.now();
    setJob({ state: 'rendering', progress: 0, stage: 'Preparing', startedAt, updatedAt: startedAt });
    const wakeLock: { current?: WakeLockSentinel } = {};
    const lastClip = ready.length - 1;

    try {
      const { renderVideo } = await loadEngine();
      navigator.wakeLock?.request('screen').then((lock) => (wakeLock.current = lock), () => {});
      const logo = await createImageBitmap(await (await fetch(logoUrl)).blob());
      let lastPaint = 0;
      let lastStage = '';
      const result = await renderVideo({
        clips: ready.map((c) => ({
          file: c.file,
          info: { ...c.info, duration: clipPlaySeconds(c) },
          photo: c.photo,
          motion: c.motion,
          motionSpeed: c.motionSpeed,
          trimStart: c.photo ? 0 : c.trim.start,
          transition: c.transition,
          voiceover: perClip ? readyBuffer(c.voiceover) : undefined,
          images: c.images.flatMap((o) => (o.status === 'ready' ? [{ file: o.file, x: o.x, y: o.y, scale: o.scale }] : [])),
          pill:
            c.pill.enabled && c.pill.text.trim()
              ? {
                  text: c.pill.text,
                  position: c.pill.position,
                  background: toRgba(c.pill.background, c.pill.opacity),
                  color: c.pill.color,
                  fontFamily: PILL_FONTS[c.pill.font].family,
                }
              : undefined,
        })),
        logo,
        size: outputSize,
        fps,
        logoSeconds,
        transitionSeconds,
        quality,
        logoOverlay: logoOverlay?.status === 'ready' ? { file: logoOverlay.file, x: logoOverlay.x, y: logoOverlay.y, scale: logoOverlay.scale } : undefined,
        clipVolume: clipVolume / 100,
        voiceVolume: voiceVolume / 100,
        musicVolume: musicVolume / 100,
        voiceover: voiceMode === 'whole' ? readyBuffer(voiceover) : undefined,
        voiceStartOffset,
        voiceRanges:
          voiceMode === 'ranges'
            ? ranges.flatMap((r) => {
                const buffer = readyBuffer(r.track);
                if (!buffer) return [];
                const start = Math.max(0, Math.min(lastClip, r.start));
                const end = Math.max(start, Math.min(lastClip, r.end));
                return [{ buffer, start, end }];
              })
            : undefined,
        music: readyBuffer(music),
        musicStartOffset,
        signal: controller.signal,
        onProgress: (progress, stage) => {
          const t = performance.now();
          if (t - lastPaint < 100 && progress < 1 && stage === lastStage) return;
          lastPaint = t;
          lastStage = stage;
          setJob({ state: 'rendering', progress, stage, startedAt, updatedAt: t });
        },
      });
      logo.close();
      setH264({ status: 'idle' });
      setJob({ state: 'done', url: URL.createObjectURL(result), blob: result, size: result.size, seconds: (performance.now() - startedAt) / 1000 });
    } catch (e) {
      console.error('Export failed', e);
      if (controller.signal.aborted) setJob({ state: 'idle' });
      else setJob({ state: 'error', message: e instanceof Error ? e.message : 'Export failed.' });
    } finally {
      abortRef.current = null;
      void wakeLock.current?.release();
    }
  };

  const downloadName = (suffix = '') => `roothoot-video-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}${suffix}.mp4`;

  const prepareH264 = async () => {
    if (job.state !== 'done' || h264.status === 'working') return;
    const controller = new AbortController();
    h264Abort.current = controller;
    setH264({ status: 'working', progress: 0 });
    try {
      const { transcodeH264 } = await loadEngine();
      const blob = await transcodeH264(job.blob, undefined, controller.signal, (progress) => setH264({ status: 'working', progress }));
      setH264({ status: 'ready', url: URL.createObjectURL(blob), size: blob.size });
    } catch (e) {
      if (controller.signal.aborted) setH264({ status: 'idle' });
      else setH264({ status: 'error', message: e instanceof Error ? e.message : 'Could not create the H.264 file.' });
    } finally {
      h264Abort.current = null;
    }
  };

  const reset = () => {
    void loadEngine().then(({ clearExports }) => clearExports());
    clips.forEach(freeClip);
    setClips([]);
    removeLogoOverlay();
    setVoiceover(null);
    setRanges([]);
    setMusic(null);
    setH264({ status: 'idle' });
    setJob({ state: 'idle' });
  };

  return (
    <div className="page">
      <header className="header">
        <img src={logoUrl} alt="Roothoot" className="brand" />
        <div>
          <h1>Video Editor</h1>
          <p className="muted">Join your clips with the Roothoot intro and outro. Everything runs on your device — nothing is uploaded.</p>
        </div>
      </header>

      {!SUPPORTED && <div className="notice error">This browser can't encode video. Please use the latest Chrome, Edge or Safari.</div>}

      <label
        className={`dropzone${dragging ? ' active' : ''}${busy ? ' disabled' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) void addFiles(e.dataTransfer.files);
        }}
      >
        <input
          type="file"
          accept="video/*,image/*"
          multiple
          hidden
          disabled={busy}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <strong>Drop videos and photos here or click to browse</strong>
        <span className="muted">Videos: MP4, MOV, WebM · Photos: JPG, PNG, WebP · add as many as you need</span>
      </label>

      {clips.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Timeline</h2>
            <span className="muted">
              {clips.length} clip{clips.length > 1 ? 's' : ''} · {formatTime(totalSeconds)} with logo
            </span>
          </div>

          <div className="mode" role="radiogroup" aria-label="Voiceover">
            <span className="muted">Voiceover</span>
            {(['whole', 'ranges', 'per-clip'] as const).map((mode) => (
              <button key={mode} role="radio" aria-checked={voiceMode === mode} className={voiceMode === mode ? 'selected' : ''} disabled={busy} onClick={() => setVoiceMode(mode)}>
                {mode === 'whole' ? 'One file for the whole video' : mode === 'ranges' ? 'One file for a range of clips' : 'Separate file for each clip'}
              </button>
            ))}
          </div>

          <ol className="clips">
            <li className="clip fixed">
              <div className="clip-row">
                <span className="index">★</span>
                <span className="name">Logo intro</span>
                <span className="meta">{logoSeconds}s</span>
              </div>
            </li>
            {clips.map((clip, i) => {
              const voiceSeconds = clip.voiceover?.status === 'ready' ? clip.voiceover.buffer.duration : 0;
              const playSeconds = clip.status === 'ready' ? clipPlaySeconds(clip) : 0;
              const overflow = perClip && clip.status === 'ready' && voiceSeconds ? voiceSeconds - playSeconds : 0;
              return (
                <li key={clip.id} className={`clip ${clip.status}`}>
                  <div className="clip-row">
                    <span className="index">{i + 1}</span>
                    <span className="name">
                      {clip.preview ? <img className="thumb" src={clip.preview} alt="" /> : <span className="thumb placeholder" aria-hidden="true" />}
                      <span className="label" title={clip.file.name}>
                        {clip.file.name}
                        {clip.status === 'error' && <small>{clip.error}</small>}
                      </span>
                    </span>
                    <span className="meta">
                      {clip.status === 'probing' && 'Reading…'}
                      {clip.status === 'ready' && !clip.photo && `${clip.info.width}×${clip.info.height} · ${Math.round(clip.info.fps)} fps · ${formatTime(playSeconds)}`}
                      {clip.status === 'ready' && clip.photo && (
                        <span className="photo-meta">
                          Photo · {clip.info.width}×{clip.info.height} ·
                          <input
                            className="text seconds"
                            type="number"
                            aria-label="Seconds on screen"
                            min={PHOTO_SECONDS.min}
                            max={PHOTO_SECONDS.max}
                            step={0.5}
                            value={clip.info.duration}
                            disabled={busy}
                            onChange={(e) => setPhotoSeconds(clip, Number(e.target.value))}
                          />
                          s
                        </span>
                      )}
                    </span>
                    <span className="actions">
                      <button onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label="Move up">↑</button>
                      <button onClick={() => move(i, 1)} disabled={busy || i === clips.length - 1} aria-label="Move down">↓</button>
                      <button onClick={() => remove(clip.id)} disabled={busy} aria-label="Remove">✕</button>
                    </span>
                  </div>

                  {clip.status === 'ready' && (
                    <div className="clip-extras">
                      <div className="effects">
                        <label>
                          Motion
                          <select value={clip.motion} disabled={busy} onChange={(e) => update(clip.id, { motion: e.target.value as Motion })}>
                            {MOTIONS.map((m) => (
                              <option key={m} value={m}>{MOTION_LABELS[m]}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Motion speed
                          <select value={clip.motionSpeed} disabled={busy || clip.motion === 'none'} onChange={(e) => update(clip.id, { motionSpeed: e.target.value as MotionSpeed })}>
                            {MOTION_SPEEDS.map((s) => (
                              <option key={s} value={s}>{MOTION_SPEED_LABELS[s]}</option>
                            ))}
                          </select>
                        </label>
                        {i < clips.length - 1 && (
                          <label>
                            Transition to next clip
                            <select value={clip.transition} disabled={busy} onChange={(e) => update(clip.id, { transition: e.target.value as Transition })}>
                              {TRANSITIONS.map((t) => (
                                <option key={t} value={t}>{TRANSITION_LABELS[t]}</option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>

                      {!clip.photo && <TrimControl clip={clip} disabled={busy} onChange={(patch) => updateTrim(clip, patch)} />}

                      {perClip && (
                        <>
                          <AudioPicker label="Voiceover" track={clip.voiceover} disabled={busy} onFile={(file) => addVoiceover(file, clip.id)} onRemove={() => update(clip.id, { voiceover: null })} />
                          {overflow > 0.5 && (
                            <p className="hint warn">
                              This voiceover is {formatTime(overflow)} longer than the clip and will be cut at the end.
                              {clip.photo && (
                                <>
                                  {' '}
                                  <button className="link" disabled={busy} onClick={() => setPhotoSeconds(clip, Math.ceil(voiceSeconds * 2) / 2)}>
                                    Show the photo for the whole voiceover
                                  </button>
                                </>
                              )}
                            </p>
                          )}
                        </>
                      )}

                      <label className="toggle">
                        <input type="checkbox" checked={clip.pill.enabled} disabled={busy} onChange={(e) => updatePill(clip, { enabled: e.target.checked })} />
                        Add a text pill that explains this clip
                      </label>

                      {clip.pill.enabled && (
                        <input
                          className="text"
                          type="text"
                          placeholder="e.g. Fresh dough, made every morning"
                          maxLength={PILL_MAX_LENGTH}
                          value={clip.pill.text}
                          disabled={busy}
                          autoFocus
                          onChange={(e) => updatePill(clip, { text: e.target.value })}
                        />
                      )}

                      {clip.pill.enabled && clip.pill.text.trim() && (
                        <PillStyleEditor pill={clip.pill} disabled={busy} onChange={(patch) => updatePill(clip, patch)} onApplyAll={() => applyPillStyleToAll(clip.pill)} />
                      )}

                      {clip.pill.enabled && clip.pill.text.trim() && (
                        <PlacementEditor
                          x={clip.pill.position.x}
                          y={clip.pill.position.y}
                          aspect={aspect}
                          background={clip.preview}
                          disabled={busy}
                          hint="Drag the pill over the frame, or type its X and Y."
                          onChange={(patch) => updatePill(clip, { position: { x: patch.x ?? clip.pill.position.x, y: patch.y ?? clip.pill.position.y } })}
                          renderVisual={(style) => (
                            <span
                              className="place-pill"
                              style={{ ...style, background: toRgba(clip.pill.background, clip.pill.opacity), color: clip.pill.color, fontFamily: PILL_FONTS[clip.pill.font].family }}
                            >
                              {clip.pill.text || 'Text'}
                            </span>
                          )}
                        />
                      )}

                      <div className="images">
                        <span className="muted">Images over this clip</span>
                        {clip.images.map((overlay, n) => (
                          <div key={overlay.id} className="image-item">
                            <div className={`slot-file${overlay.status === 'error' ? ' error' : ''}`}>
                              <img className="thumb" src={overlay.url} alt="" />
                              <span className="name" title={overlay.file.name}>
                                {n + 1}. {overlay.file.name}
                                {overlay.status === 'error' && <small>{overlay.error}</small>}
                              </span>
                              <span className="meta">
                                {overlay.status === 'loading' && 'Reading…'}
                                {overlay.status === 'ready' && `${overlay.width}×${overlay.height}`}
                              </span>
                              <span className="actions">
                                <button onClick={() => removeImage(clip, overlay)} disabled={busy} aria-label="Remove image">✕</button>
                              </span>
                            </div>
                            {overlay.status === 'ready' && (
                              <PlacementEditor
                                x={overlay.x}
                                y={overlay.y}
                                scale={overlay.scale}
                                visualAspect={overlay.width / overlay.height}
                                aspect={aspect}
                                background={clip.preview}
                                disabled={busy}
                                hint="Drag the image, or type its X, Y and size."
                                others={clip.images
                                  .filter((o) => o !== overlay)
                                  .map((o) => (
                                    <img key={o.id} className="place-img other" src={o.url} alt="" style={overlayBox(o, aspect)} draggable={false} />
                                  ))}
                                renderVisual={(style) => <img className="place-img" src={overlay.url} alt="" style={style} draggable={false} />}
                                onChange={(patch) => updateImage(clip.id, overlay.id, patch)}
                              />
                            )}
                          </div>
                        ))}
                        <label className={`slot-pick${busy ? ' disabled' : ''}`}>
                          + Add image{clip.images.length ? ' (another)' : ''} — PNG, JPG, WebP
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            multiple
                            hidden
                            disabled={busy}
                            onChange={(e) => {
                              addImages(clip, Array.from(e.target.files ?? []));
                              e.target.value = '';
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            <li className="clip fixed">
              <div className="clip-row">
                <span className="index">★</span>
                <span className="name">Logo outro</span>
                <span className="meta">{logoSeconds}s</span>
              </div>
            </li>
          </ol>

          <div className="sound">
            <h3>Logo / watermark</h3>
            <div className="slot">
              <div className="slot-head">
                <strong>Watermark logo</strong>
                <span className="muted">Shown at a fixed spot on every clip, through the whole video</span>
              </div>
              {logoOverlay ? (
                <>
                  <div className={`slot-file${logoOverlay.status === 'error' ? ' error' : ''}`}>
                    <img className="thumb" src={logoOverlay.url} alt="" />
                    <span className="name" title={logoOverlay.file.name}>
                      {logoOverlay.file.name}
                      {logoOverlay.status === 'error' && <small>{logoOverlay.error}</small>}
                    </span>
                    <span className="meta">
                      {logoOverlay.status === 'loading' && 'Reading…'}
                      {logoOverlay.status === 'ready' && `${logoOverlay.width}×${logoOverlay.height}`}
                    </span>
                    <span className="actions">
                      <button onClick={removeLogoOverlay} disabled={busy} aria-label="Remove watermark">✕</button>
                    </span>
                  </div>
                  {logoOverlay.status === 'ready' && (
                    <PlacementEditor
                      x={logoOverlay.x}
                      y={logoOverlay.y}
                      scale={logoOverlay.scale}
                      visualAspect={logoOverlay.width / logoOverlay.height}
                      aspect={aspect}
                      background={firstPreview}
                      disabled={busy}
                      hint="Drag the logo, or type its X, Y and size. It stays here for the whole video."
                      renderVisual={(style) => <img className="place-img" src={logoOverlay.url} alt="" style={style} draggable={false} />}
                      onChange={updateLogoOverlay}
                    />
                  )}
                </>
              ) : (
                <label className={`slot-pick${busy ? ' disabled' : ''}`}>
                  + Add a watermark logo — PNG (transparent works best)
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) addLogoOverlay(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          <div className="sound">
            <h3>Sound</h3>
            <div className="slot">
              <div className="slot-head">
                <strong>Clip sound</strong>
                <span className="muted">The original audio of your videos</span>
              </div>
              <VolumeSlider value={clipVolume} onChange={setClipVolume} disabled={busy} />
            </div>

            <div className="slot">
              <div className="slot-head">
                <strong>Voiceover</strong>
                <span className="muted">
                  {perClip ? 'Add a file to each clip above' : voiceMode === 'ranges' ? 'Add files that each cover a run of clips' : 'Starts with the first clip'}
                </span>
              </div>

              {voiceMode === 'whole' && (
                <>
                  <AudioPicker label="Voiceover" track={voiceover} disabled={busy} onFile={(file) => addVoiceover(file)} onRemove={() => setVoiceover(null)} />
                  {voiceover?.status === 'ready' && <StartOffset value={voiceStartOffset} max={Math.max(1, totalSeconds - logoSeconds)} disabled={busy} onChange={setVoiceStartOffset} />}
                  {voiceOverflow > 0.5 && <p className="hint warn">The voiceover is {formatTime(voiceOverflow)} longer than the remaining video and will be cut at the end.</p>}
                </>
              )}

              {voiceMode === 'ranges' && (
                <div className="ranges">
                  {ranges.map((r) => {
                    const buffer = readyBuffer(r.track);
                    const start = Math.max(0, Math.min(clips.length - 1, r.start));
                    const end = Math.max(start, Math.min(clips.length - 1, r.end));
                    const spanSeconds = ready.length && plan.clips[start] && plan.clips[end] ? (plan.clips[end].start + plan.clips[end].frames - plan.clips[start].start) / fps : 0;
                    const overflow = buffer ? buffer.duration - spanSeconds : 0;
                    return (
                      <div key={r.id} className="range-item">
                        <div className={`slot-file${r.track.status === 'error' ? ' error' : ''}`}>
                          <span className="name" title={r.track.file.name}>
                            {r.track.file.name}
                            {r.track.status === 'error' && <small>{r.track.error}</small>}
                          </span>
                          <span className="meta">
                            {r.track.status === 'loading' && 'Reading…'}
                            {r.track.status === 'ready' && formatTime(r.track.buffer.duration)}
                          </span>
                          <span className="actions">
                            <button onClick={() => removeRange(r.id)} disabled={busy} aria-label="Remove voiceover">✕</button>
                          </span>
                        </div>
                        <div className="range-span">
                          <span>Plays over</span>
                          <select value={start} disabled={busy} onChange={(e) => updateRange(r.id, { start: Number(e.target.value), end: Math.max(Number(e.target.value), end) })}>
                            {clips.map((_, idx) => (
                              <option key={idx} value={idx}>Clip {idx + 1}</option>
                            ))}
                          </select>
                          <span>to</span>
                          <select value={end} disabled={busy} onChange={(e) => updateRange(r.id, { end: Math.max(start, Number(e.target.value)) })}>
                            {clips.map((_, idx) => (idx >= start ? <option key={idx} value={idx}>Clip {idx + 1}</option> : null))}
                          </select>
                        </div>
                        {overflow > 0.5 && <p className="hint warn">This voiceover is {formatTime(overflow)} longer than clips {start + 1}–{end + 1} and will be cut at the end.</p>}
                      </div>
                    );
                  })}
                  <label className={`slot-pick${busy ? ' disabled' : ''}`}>
                    + Add voiceover for a range of clips
                    <input
                      type="file"
                      accept="audio/*,.mp3,.wav,.m4a,.aac"
                      hidden
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) addRangeVoice(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {clips.length < 2 && <p className="hint muted">Add at least two clips to span a voiceover across a range.</p>}
                </div>
              )}

              {hasAnyVoice && <VolumeSlider value={voiceVolume} onChange={setVoiceVolume} disabled={busy} />}
            </div>

            <div className="slot">
              <div className="slot-head">
                <strong>Music</strong>
                <span className="muted">Plays under the whole video, loops and fades out</span>
              </div>
              <AudioPicker label="Music" track={music} disabled={busy} onFile={addMusic} onRemove={() => setMusic(null)} />
              {music?.status === 'ready' && (
                <>
                  <StartOffset value={musicStartOffset} max={Math.max(1, totalSeconds)} disabled={busy} onChange={setMusicStartOffset} />
                  <VolumeSlider value={musicVolume} onChange={setMusicVolume} disabled={busy} />
                </>
              )}
            </div>
          </div>

          <div className="settings">
            <label>
              Transitions (all clips)
              <select value={common('transition')} disabled={busy} onChange={(e) => setForAll({ transition: e.target.value as Transition })}>
                {common('transition') === 'mixed' && <option value="mixed" disabled>Mixed</option>}
                {TRANSITIONS.map((t) => (
                  <option key={t} value={t}>{TRANSITION_LABELS[t]}</option>
                ))}
              </select>
            </label>
            <label>
              Transition length
              <select value={transitionSeconds} disabled={busy} onChange={(e) => setTransitionSeconds(Number(e.target.value))}>
                {TRANSITION_SECONDS.map((s) => (
                  <option key={s} value={s}>{s} seconds</option>
                ))}
              </select>
            </label>
            <label>
              Motion (all clips)
              <select value={common('motion')} disabled={busy} onChange={(e) => setForAll({ motion: e.target.value as Motion })}>
                {common('motion') === 'mixed' && <option value="mixed" disabled>Mixed</option>}
                {MOTIONS.map((m) => (
                  <option key={m} value={m}>{MOTION_LABELS[m]}</option>
                ))}
              </select>
            </label>
            <label>
              Motion speed (all clips)
              <select value={common('motionSpeed')} disabled={busy} onChange={(e) => setForAll({ motionSpeed: e.target.value as MotionSpeed })}>
                {common('motionSpeed') === 'mixed' && <option value="mixed" disabled>Mixed</option>}
                {MOTION_SPEEDS.map((s) => (
                  <option key={s} value={s}>{MOTION_SPEED_LABELS[s]}</option>
                ))}
              </select>
            </label>
            <label>
              Logo duration
              <select value={logoSeconds} onChange={(e) => setLogoSeconds(Number(e.target.value))} disabled={busy}>
                {LOGO_SECONDS.map((s) => (
                  <option key={s} value={s}>{s} seconds</option>
                ))}
              </select>
            </label>
            <label>
              Output size
              <select value={preset} onChange={(e) => setPreset(e.target.value)} disabled={busy}>
                {SIZE_OPTIONS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
              {preset === CUSTOM_PRESET ? (
                <span className="custom-size">
                  {(['width', 'height'] as const).map((side, i) => (
                    <span key={side} className="custom-side">
                      {i > 0 && <span aria-hidden="true">×</span>}
                      <input
                        className="text"
                        type="number"
                        inputMode="numeric"
                        aria-label={`${side} in pixels`}
                        min={CUSTOM_SIZE_LIMITS.min}
                        max={CUSTOM_SIZE_LIMITS.max}
                        step={2}
                        value={custom[side]}
                        disabled={busy}
                        onChange={(e) => setCustom((c) => ({ ...c, [side]: Number(e.target.value) }))}
                        onBlur={() => setCustom((c) => customSize(c.width, c.height))}
                      />
                    </span>
                  ))}
                  <span>px</span>
                </span>
              ) : null}
              <span className="meta">
                Exports at {outputSize.width}×{outputSize.height}
                {preset === CUSTOM_PRESET && ` · ${CUSTOM_SIZE_LIMITS.min}–${CUSTOM_SIZE_LIMITS.max} px, even numbers`}
              </span>
            </label>
            <label>
              Quality
              <select value={quality} disabled={busy} onChange={(e) => setQuality(e.target.value as Quality)}>
                {(Object.keys(QUALITY_LABELS) as Quality[]).map((q) => (
                  <option key={q} value={q}>{QUALITY_LABELS[q]}</option>
                ))}
              </select>
            </label>
            <label>
              Frame rate
              <select value={fastFps ? 'fast' : 'smooth'} onChange={(e) => setFastFps(e.target.value === 'fast')} disabled={busy}>
                <option value="smooth">Match your clips — no frames skipped (best)</option>
                <option value="fast">Cap at 30 fps (smaller, faster)</option>
              </select>
            </label>
          </div>

          {job.state === 'rendering' ? (
            <div className="progress-row">
              <div className="progress" role="progressbar" aria-valuenow={Math.round(job.progress * 100)}>
                <div style={{ width: `${job.progress * 100}%` }} />
              </div>
              <span className="muted">
                {job.progress < 0.1 ? (job.progress * 100).toFixed(1) : Math.floor(job.progress * 100)}%
                {job.progress > 0 && elapsed > 3 && ` · ~${formatTime(elapsed * (1 / job.progress - 1))} left`}
              </span>
              <button className="secondary" onClick={() => abortRef.current?.abort()}>Cancel</button>
              <span className="stage muted">{job.stage}…</span>
            </div>
          ) : (
            <button className="primary" onClick={exportVideo} disabled={!canExport}>
              Export MP4
            </button>
          )}
          {stalled && job.state === 'rendering' && (
            <p className="hint warn">No progress for {STALL_SECONDS} seconds on “{job.stage}”. Press Cancel, then try a smaller output size, or re-add the clip after re-saving it from your phone.</p>
          )}
          {IS_SAFARI && <p className="hint muted">Safari keeps the finished video in memory. For very long videos, export in Chrome or Edge.</p>}
          {hasError && <p className="hint error">Remove the files marked in red to export.</p>}
        </section>
      )}

      {job.state === 'error' && <div className="notice error">{job.message}</div>}

      {job.state === 'done' && (
        <section className="card">
          <div className="card-head">
            <h2>Your video is ready</h2>
            <span className="muted">
              {formatBytes(job.size)} · exported in {formatTime(job.seconds)}
            </span>
          </div>
          <video className="preview" src={job.url} controls playsInline />
          <div className="row">
            <a className="button primary" href={job.url} download={downloadName()}>
              Download (best quality)
            </a>
            {h264.status === 'ready' ? (
              <a className="button secondary" href={h264.url} download={downloadName('-h264')}>
                Download H.264 ({formatBytes(h264.size)})
              </a>
            ) : h264.status === 'working' ? (
              <span className="button secondary" aria-busy="true">Preparing H.264… {Math.round(h264.progress * 100)}%</span>
            ) : (
              <button className="secondary" onClick={prepareH264}>Prepare H.264 (max 5 MB)</button>
            )}
            <button className="secondary" onClick={reset}>Start a new video</button>
          </div>
          <p className="hint muted">
            “Download (best quality)” gives the file exactly as made. “Prepare H.264” makes an H.264 MP4 under 5 MB: if your video already fits it is copied at identical quality; if it is larger, the resolution is lowered just enough to keep it smooth — never pixelated.
            {h264.status === 'ready' ? ' Your file is ready — click “Download H.264”.' : ''}
          </p>
          {h264.status === 'error' && <p className="hint error">{h264.message}</p>}
        </section>
      )}
    </div>
  );
}
