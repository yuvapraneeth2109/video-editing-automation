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
  CODEC_SHORT,
  CUSTOM_SIZE_LIMITS,
  DOWNLOAD_CODEC_LABELS,
  DOWNLOAD_SIZE_MB,
  PILL_FONTS,
  QUALITY_LABELS,
  customSize,
  type DownloadCodec,
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

type PillStyle = { background: string; opacity: number; color: string; font: PillFont; size: number };
/** One caption. `start`/`end` are its on-screen window in seconds from the clip's start (end 0 = until the clip ends). */
type Pill = { id: string; text: string; position: PillPosition; start: number; end: number } & PillStyle;

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
  /** Seconds to delay this clip's (per-clip) voiceover past the start of the clip. */
  voiceOffset: number;
  /** Which part of this clip's (per-clip) voiceover audio to use. */
  voiceTrim: Trim;
  /** Captions over this clip — any number, each independently placed, sized and timed. */
  pills: Pill[];
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

/** One voiceover file that covers a run of clips, by their position (inclusive). `startOffset` delays it within the span. */
type VoiceRange = { id: string; track: AudioTrack; start: number; end: number; startOffset: number; trim: Trim };

type Job =
  | { state: 'idle' }
  | { state: 'rendering'; progress: number; stage: string; startedAt: number; updatedAt: number }
  | {
      state: 'done';
      url: string;
      blob: Blob;
      size: number;
      seconds: number;
      /** The exported video's own size, length and frame rate — used to predict the H.264 download. */
      outWidth: number;
      outHeight: number;
      durationSeconds: number;
      videoFps: number;
    };

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

const DEFAULT_PILL_STYLE: PillStyle = { background: '#0f1115', opacity: 72, color: '#ffffff', font: 'system', size: 100 };
/** Pill text size range, as a percentage of the default. */
const PILL_SIZE = { min: 40, max: 250, step: 5 };
/** A fresh caption centred near the bottom, taking the current shared style. */
const makePill = (style: PillStyle): Pill => ({ id: crypto.randomUUID(), text: '', position: { ...CENTER_BOTTOM }, start: 0, end: 0, ...style });
/** The CSS font-size (in cqmin) for a pill preview, matching the engine's base×0.042×size maths. */
const pillPreviewFont = (size: number) => `calc(${(4.2 * Math.min(4, Math.max(0.3, size / 100))).toFixed(2)} * 1cqmin)`;

/** The file's name without any folder path, for matching Excel references against uploaded files. */
const baseName = (p: string) => p.replace(/^.*[\\/]/, '').trim();
/** Normalises a hex colour from the Excel ('0f1115' or '#0F1115') to '#rrggbb', or a fallback. */
const normHex = (v: string, dflt: string) => {
  const s = (v || '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toLowerCase()}` : dflt;
};
/** Snaps a number to the nearest value the matching dropdown offers. */
const snap = (v: number, opts: readonly number[]) => opts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), opts[0]);
/** Turns an Excel output-size string into a preset name (if it is one of the two) or a custom width/height. */
const parseSize = (s: string): { preset?: string; width: number; height: number } => {
  const m = String(s).toLowerCase().match(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/);
  const width = m ? Number(m[1]) : 960;
  const height = m ? Number(m[2]) : 960;
  if (width === 960 && height === 960) return { preset: '960 × 960 px (required)', width, height };
  if (width === 1024 && height === 1024) return { preset: '1024 × 1024 px (maximum)', width, height };
  return { width, height };
};
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
  /** Show the built-in "listen" player. Off for voiceovers, where the VoiceTrimmer provides its own. */
  preview?: boolean;
};

/** Trim an audio file to a kept span and preview that span with a "Play selection" button. */
function VoiceTrimmer({ file, duration, trim, disabled, onChange }: { file: File; duration: number; trim: Trim; disabled: boolean; onChange: (patch: Partial<Trim>) => void }) {
  const url = useObjectUrl(file);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // An end of 0 (or outside the file) means "to the end" → show the full length.
  const endEff = trim.end > trim.start && trim.end < duration ? trim.end : duration;
  const setStart = (v: number) => onChange({ start: clamp(0, Math.max(0, endEff - 0.1), v) });
  // Dragging "To" to the far end stores 0 = "to the end".
  const setEnd = (v: number) => onChange({ end: v >= duration ? 0 : clamp(trim.start + 0.1, duration, v) });
  const playSelection = () => {
    const a = audioRef.current;
    if (!a) return;
    clearTimeout(timer.current);
    a.currentTime = trim.start;
    void a.play();
    // Stop at the end of the selection (one shot, so native controls still play the whole file freely).
    timer.current = setTimeout(() => a.pause(), Math.max(100, (endEff - trim.start) * 1000) + 80);
  };
  return (
    <div className="voice-trim">
      <span className="muted">
        Use {formatTime(trim.start)} to {endEff >= duration ? 'the end' : formatTime(endEff)} ({formatTime(Math.max(0, endEff - trim.start))} of {formatTime(duration)})
      </span>
      <div className="trim-bar">
        <div style={{ left: `${(trim.start / duration) * 100}%`, right: `${100 - (endEff / duration) * 100}%` }} />
      </div>
      <label className="offset">
        <span>From</span>
        <input type="range" min={0} max={duration} step={0.1} value={trim.start} disabled={disabled} onChange={(e) => setStart(Number(e.target.value))} />
        <input className="text seconds" type="number" min={0} max={duration} step={0.1} value={Number(trim.start.toFixed(1))} disabled={disabled} onChange={(e) => setStart(Number(e.target.value) || 0)} />
        <span className="meta">s</span>
      </label>
      <label className="offset">
        <span>To</span>
        <input type="range" min={0} max={duration} step={0.1} value={endEff} disabled={disabled} onChange={(e) => setEnd(Number(e.target.value))} />
        <input className="text seconds" type="number" min={0} max={duration} step={0.1} value={Number(endEff.toFixed(1))} disabled={disabled} onChange={(e) => setEnd(Number(e.target.value) || duration)} />
        <span className="meta">s</span>
      </label>
      <div className="voice-trim-play">
        <button type="button" className="secondary small" disabled={disabled} onClick={playSelection}>▶ Play selection</button>
        {url && <audio ref={audioRef} className="audio-preview" controls preload="metadata" src={url} />}
      </div>
    </div>
  );
}

/** Shows a "+ Add" button, or the chosen file with its duration, a remove button and a listen preview. */
function AudioPicker({ label, track, disabled, onFile, onRemove, preview = true }: AudioPickerProps) {
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
      {preview && track.status === 'ready' && url && <audio className="audio-preview" controls preload="metadata" src={url} />}
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
        <label>
          Text size
          <span className="color-row">
            <input type="range" min={PILL_SIZE.min} max={PILL_SIZE.max} step={PILL_SIZE.step} value={pill.size} disabled={disabled} onChange={(e) => onChange({ size: Number(e.target.value) })} />
            <span className="meta">{pill.size}%</span>
          </span>
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

/** Chooses when the pill appears and disappears within the clip. A "Hides at" of the full length means "until the clip ends". */
function PillTiming({ start, end, playLen, disabled, onChange }: { start: number; end: number; playLen: number; disabled: boolean; onChange: (patch: { start?: number; end?: number }) => void }) {
  // A stored end of 0 (or one outside the window) means "stay until the clip ends" → show the full length.
  const shownEnd = end > start && end < playLen ? end : playLen;
  const max = Math.max(0.2, playLen);
  const setStart = (v: number) => onChange({ start: clamp(0, Math.max(0, playLen - 0.2), v) });
  // Dragging to the far end stores 0 = "until the clip ends"; anything less is a real hide time.
  const setEnd = (v: number) => onChange({ end: v >= playLen ? 0 : clamp(start + 0.2, playLen, v) });
  return (
    <div className="pill-timing">
      <span className="muted">
        Pill timing — shows from {formatTime(start)} to {shownEnd >= playLen ? 'the end' : formatTime(shownEnd)} of this clip
      </span>
      <label className="offset">
        <span>Appears at</span>
        <input type="range" min={0} max={max} step={0.1} value={start} disabled={disabled} onChange={(e) => setStart(Number(e.target.value))} />
        <input className="text seconds" type="number" min={0} max={playLen} step={0.1} value={Number(start.toFixed(1))} disabled={disabled} onChange={(e) => setStart(Number(e.target.value) || 0)} />
        <span className="meta">s</span>
      </label>
      <label className="offset">
        <span>Hides at</span>
        <input type="range" min={0} max={max} step={0.1} value={shownEnd} disabled={disabled} onChange={(e) => setEnd(Number(e.target.value))} />
        <input className="text seconds" type="number" min={0} max={playLen} step={0.1} value={Number(shownEnd.toFixed(1))} disabled={disabled} onChange={(e) => setEnd(Number(e.target.value) || playLen)} />
        <span className="meta">s</span>
      </label>
    </div>
  );
}

/** The full editor for ONE caption: text, style, placement (over the frame) and on-screen timing. */
function PillEditor({
  pill,
  index,
  others,
  preview,
  aspect,
  playLen,
  disabled,
  onChange,
  onRemove,
  onApplyAll,
}: {
  pill: Pill;
  index: number;
  others: ReactNode;
  preview: string | null;
  aspect: number;
  playLen: number;
  disabled: boolean;
  onChange: (patch: Partial<Pill>) => void;
  onRemove: () => void;
  onApplyAll: () => void;
}) {
  const has = pill.text.trim().length > 0;
  return (
    <div className="pill-item">
      <div className="pill-head">
        <input
          className="text"
          type="text"
          placeholder={`Pill ${index + 1} — e.g. Fresh dough, made every morning`}
          maxLength={PILL_MAX_LENGTH}
          value={pill.text}
          disabled={disabled}
          onChange={(e) => onChange({ text: e.target.value })}
        />
        <button className="x" onClick={onRemove} disabled={disabled} aria-label={`Remove pill ${index + 1}`}>✕</button>
      </div>
      {has && <PillStyleEditor pill={pill} disabled={disabled} onChange={onChange} onApplyAll={onApplyAll} />}
      {has && (
        <PlacementEditor
          x={pill.position.x}
          y={pill.position.y}
          aspect={aspect}
          background={preview}
          disabled={disabled}
          hint="Drag the pill over the frame, or type its X and Y."
          others={others}
          onChange={(patch) => onChange({ position: { x: patch.x ?? pill.position.x, y: patch.y ?? pill.position.y } })}
          renderVisual={(style) => (
            <span
              className="place-pill"
              style={{ ...style, background: toRgba(pill.background, pill.opacity), color: pill.color, fontFamily: PILL_FONTS[pill.font].family, fontSize: pillPreviewFont(pill.size) }}
            >
              {pill.text || 'Text'}
            </span>
          )}
        />
      )}
      {has && <PillTiming start={pill.start} end={pill.end} playLen={playLen} disabled={disabled} onChange={onChange} />}
    </div>
  );
}

/**
 * Shows a single decoded video frame at `time` (seconds), re-decoding a short moment after `time`
 * stops changing so dragging a trim handle doesn't trigger a decode on every step. Owns its object URL.
 */
function FramePreview({ file, time, label }: { file: File; time: number; label: string }) {
  const [url, setUrl] = useState<string>();
  const current = useRef<string | undefined>(undefined);
  useEffect(() => {
    current.current = url;
  }, [url]);
  // Final clean-up on unmount: release whichever URL is showing.
  useEffect(() => () => void (current.current && URL.revokeObjectURL(current.current)), []);
  useEffect(() => {
    let active = true;
    const handle = setTimeout(() => {
      void loadEngine()
        .then(({ makeFrames }) => makeFrames(file, [time], 260))
        .then(
          ([next]) => {
            if (!active) {
              if (next) URL.revokeObjectURL(next);
              return;
            }
            setUrl((prev) => {
              if (prev) URL.revokeObjectURL(prev);
              return next;
            });
          },
          () => {},
        );
    }, 200);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [file, time]);
  return (
    <figure className="frame-preview">
      {url ? <img src={url} alt="" draggable={false} /> : <span className="frame-ph" />}
      <figcaption>
        {label} · {formatTime(time)}
      </figcaption>
    </figure>
  );
}

/** Trim a video to a kept start..end range: a filmstrip to see where to cut, live start/end frames, sliders and exact seconds. */
function TrimControl({ clip, disabled, onChange }: { clip: Clip & { status: 'ready' }; disabled: boolean; onChange: (patch: Partial<Trim>) => void }) {
  const dur = clip.info.duration;
  const { start, end } = clip.trim;
  const setStart = (v: number) => onChange({ start: clamp(0, end - 0.2, v) });
  const setEnd = (v: number) => onChange({ end: clamp(start + 0.2, dur, v) });

  // A strip of frames across the whole clip, decoded once, so the user can see the content while trimming.
  const [strip, setStrip] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    let made: string[] = [];
    const count = 8;
    const times = Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * dur);
    void loadEngine()
      .then(({ makeFrames }) => makeFrames(clip.file, times, 170))
      .then(
        (urls) => {
          if (!active) {
            urls.forEach(URL.revokeObjectURL);
            return;
          }
          made = urls;
          setStrip(urls);
        },
        () => {},
      );
    return () => {
      active = false;
      made.forEach(URL.revokeObjectURL);
    };
  }, [clip.file, dur]);

  const pct = (t: number) => `${(t / dur) * 100}%`;
  return (
    <div className="trim">
      <span className="muted">
        Trim — keep {formatTime(start)} to {formatTime(end)} ({formatTime(Math.max(0, end - start))} of {formatTime(dur)})
      </span>
      <div className="filmstrip" aria-hidden="true">
        {strip.length ? (
          strip.map((u, i) => <img key={i} src={u} alt="" draggable={false} />)
        ) : (
          <span className="filmstrip-loading">Loading frames…</span>
        )}
        <span className="trim-dim" style={{ left: 0, width: pct(start) }} />
        <span className="trim-dim" style={{ right: 0, width: `${100 - (end / dur) * 100}%` }} />
        <span className="trim-edge" style={{ left: pct(start) }} />
        <span className="trim-edge" style={{ left: pct(end) }} />
      </div>
      <div className="frame-previews">
        <FramePreview file={clip.file} time={start} label="Start frame" />
        <FramePreview file={clip.file} time={Math.max(start, end - 0.05)} label="End frame" />
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
  // Which entry path the user is in: the initial chooser, the Excel-automation intake, or the manual editor.
  const [mode, setMode] = useState<'choose' | 'excel' | 'manual'>('choose');
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [excelMedia, setExcelMedia] = useState<File[]>([]);
  const [excelStatus, setExcelStatus] = useState<{ state: 'idle' | 'building' | 'error'; message?: string }>({ state: 'idle' });
  const [excelDragging, setExcelDragging] = useState(false);
  const [ingestWarnings, setIngestWarnings] = useState<string[]>([]);
  // True once a project was built from an Excel blueprint: the voiceover add/trim controls are then hidden,
  // because the voiceovers are defined by the spreadsheet.
  const [fromExcel, setFromExcel] = useState(false);
  const [logoOverlay, setLogoOverlay] = useState<Overlay | null>(null);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('whole');
  const [voiceover, setVoiceover] = useState<AudioTrack | null>(null);
  const [voiceTrim, setVoiceTrim] = useState<Trim>({ start: 0, end: 0 });
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
  const [fill, setFill] = useState<'contain' | 'cover'>('contain');
  const [logoSeconds, setLogoSeconds] = useState(3);
  // Default to matching the clips' frame rate — no frames are skipped, so motion stays at full quality.
  const [fastFps, setFastFps] = useState(false);
  const [transitionSeconds, setTransitionSeconds] = useState(0.75);
  const [pillDefaults, setPillDefaults] = useState<PillStyle>(DEFAULT_PILL_STYLE);
  const [defaults, setDefaults] = useState<{ transition: Transition; motion: Motion; motionSpeed: MotionSpeed }>({ transition: 'dissolve', motion: 'none', motionSpeed: 'medium' });
  const [job, setJob] = useState<DoneOrError>({ state: 'idle' });
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Optional smaller-file download, prepared from the finished video only when the user asks for it.
  const [h264, setH264] = useState<
    | { status: 'idle' }
    | { status: 'working'; progress: number }
    | { status: 'ready'; url: string; size: number; codec: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const h264Abort = useRef<AbortController | null>(null);
  // Smaller-file download settings: which codec, and the size budget (2 MB mobile / 5 MB desktop).
  const [downloadCodec, setDownloadCodec] = useState<DownloadCodec>('auto');
  const [downloadMB, setDownloadMB] = useState(5);

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
  // A per-clip voiceover makes its clip wait: the clip's on-screen time is the longer of its own length and
  // the voiceover's (offset + duration), so the voice always plays in full and the clip always plays in full.
  const clipVoiceSeconds = (c: Clip & { status: 'ready' }) =>
    voiceMode === 'per-clip' && c.voiceover?.status === 'ready' ? (c.voiceOffset || 0) + c.voiceover.buffer.duration : 0;
  const effectiveSeconds = (c: Clip & { status: 'ready' }) => Math.max(clipPlaySeconds(c), clipVoiceSeconds(c));
  const plan = planTimeline(ready.map(effectiveSeconds), ready.map((c) => c.transition), fps, logoSeconds, transitionSeconds);
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
  const wholeVoiceTrack = voiceover?.status === 'ready' ? voiceover : null;
  const outputSize = preset === CUSTOM_PRESET ? customSize(custom.width, custom.height) : SIZE_PRESETS[preset];
  const aspect = outputSize.width / outputSize.height;
  const firstPreview = ready[0]?.preview ?? null;

  // The smaller-file download keeps the exact size the user chose (never downscaled), so the view is unchanged.
  const targetBytes = downloadMB * 1024 * 1024;
  const downloadFits = job.state === 'done' && job.size <= targetBytes;

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
      voiceOffset: 0,
      voiceTrim: { start: 0, end: 0 },
      images: [],
      pills: [],
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

  const updatePill = (clipId: string, pillId: string, patch: Partial<Pill>) =>
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, pills: c.pills.map((p) => (p.id === pillId ? { ...p, ...patch } : p)) } : c)));
  const addPill = (clip: Clip) => update(clip.id, { pills: [...clip.pills, makePill(pillDefaults)] });
  const removePill = (clipId: string, pillId: string) =>
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, pills: c.pills.filter((p) => p.id !== pillId) } : c)));
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

  const applyPillStyleToAll = ({ background, opacity, color, font, size }: PillStyle) => {
    const style = { background, opacity, color, font, size };
    setPillDefaults(style);
    setClips((prev) => prev.map((c) => ({ ...c, pills: c.pills.map((p) => ({ ...p, ...style })) })));
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
      update(clipId, { voiceover: loading, voiceOffset: 0, voiceTrim: { start: 0, end: 0 } });
      void decodeAudio(file, (track) =>
        setClips((prev) => prev.map((c) => (c.id === clipId && c.voiceover?.file === file ? { ...c, voiceover: track } : c))),
      );
    } else {
      setVoiceover(loading);
      setVoiceTrim({ start: 0, end: 0 });
      setVoiceStartOffset(0);
      void decodeAudio(file, (track) => setVoiceover((current) => (current?.file === file ? track : current)));
    }
  };

  const addRangeVoice = (file: File) => {
    setClipVolume((v) => Math.min(v, CLIP_VOLUME_UNDER_VOICE));
    const id = crypto.randomUUID();
    setRanges((prev) => [...prev, { id, track: { file, status: 'loading' }, start: 0, end: Math.max(0, clips.length - 1), startOffset: 0, trim: { start: 0, end: 0 } }]);
    void decodeAudio(file, (track) => setRanges((prev) => prev.map((r) => (r.id === id && r.track.file === file ? { ...r, track } : r))));
  };
  const updateRange = (id: string, patch: Partial<Pick<VoiceRange, 'start' | 'end' | 'startOffset' | 'trim'>>) => setRanges((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
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
          info: { ...c.info, duration: effectiveSeconds(c) },
          photo: c.photo,
          motion: c.motion,
          motionSpeed: c.motionSpeed,
          trimStart: c.photo ? 0 : c.trim.start,
          transition: c.transition,
          voiceover: perClip ? readyBuffer(c.voiceover) : undefined,
          voiceOffset: perClip ? c.voiceOffset : 0,
          voiceTrim: perClip ? c.voiceTrim : undefined,
          images: c.images.flatMap((o) => (o.status === 'ready' ? [{ file: o.file, x: o.x, y: o.y, scale: o.scale }] : [])),
          pills: c.pills.flatMap((p) =>
            p.text.trim()
              ? [
                  {
                    text: p.text,
                    position: p.position,
                    background: toRgba(p.background, p.opacity),
                    color: p.color,
                    fontFamily: PILL_FONTS[p.font].family,
                    size: p.size,
                    start: p.start,
                    end: p.end,
                  },
                ]
              : [],
          ),
        })),
        logo,
        size: outputSize,
        fps,
        logoSeconds,
        transitionSeconds,
        quality,
        fill,
        logoOverlay: logoOverlay?.status === 'ready' ? { file: logoOverlay.file, x: logoOverlay.x, y: logoOverlay.y, scale: logoOverlay.scale } : undefined,
        clipVolume: clipVolume / 100,
        voiceVolume: voiceVolume / 100,
        musicVolume: musicVolume / 100,
        voiceover: voiceMode === 'whole' ? readyBuffer(voiceover) : undefined,
        voiceTrim: voiceMode === 'whole' ? voiceTrim : undefined,
        voiceStartOffset,
        voiceRanges:
          voiceMode === 'ranges'
            ? ranges.flatMap((r) => {
                const buffer = readyBuffer(r.track);
                if (!buffer) return [];
                const start = Math.max(0, Math.min(lastClip, r.start));
                const end = Math.max(start, Math.min(lastClip, r.end));
                return [{ buffer, start, end, startOffset: Math.max(0, r.startOffset), trim: r.trim }];
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
      setJob({
        state: 'done',
        url: URL.createObjectURL(result),
        blob: result,
        size: result.size,
        seconds: (performance.now() - startedAt) / 1000,
        outWidth: outputSize.width,
        outHeight: outputSize.height,
        durationSeconds: totalSeconds,
        videoFps: fps,
      });
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
      const { transcodeCompressed } = await loadEngine();
      const { blob, codec } = await transcodeCompressed(job.blob, downloadMB * 1024 * 1024, downloadCodec, controller.signal, (progress) =>
        setH264({ status: 'working', progress }),
      );
      setH264({ status: 'ready', url: URL.createObjectURL(blob), size: blob.size, codec });
    } catch (e) {
      if (controller.signal.aborted) setH264({ status: 'idle' });
      else setH264({ status: 'error', message: e instanceof Error ? e.message : 'Could not create the smaller file.' });
    } finally {
      h264Abort.current = null;
    }
  };

  /** Download the sample/template workbook — the exact format the Excel intake reads. */
  const downloadSample = async () => {
    const { sampleWorkbookBlob } = await import('./excel');
    const url = URL.createObjectURL(await sampleWorkbookBlob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'roothoot-video-template.xlsx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /** Adds media files to the Excel intake, accumulating across selections/folders and de-duplicating by name+size. */
  const addExcelMedia = (files: File[]) => {
    if (!files.length) return;
    setExcelStatus({ state: 'idle' });
    setExcelMedia((prev) => {
      const map = new Map(prev.map((f) => [`${f.name}:${f.size}`, f]));
      for (const f of files) map.set(`${f.name}:${f.size}`, f);
      return [...map.values()];
    });
  };
  const removeExcelMedia = (key: string) => setExcelMedia((prev) => prev.filter((f) => `${f.name}:${f.size}` !== key));

  /** Reads the uploaded Excel + media and builds a complete project, then lands in the editor ready to export. */
  const buildFromExcel = async () => {
    if (!excelFile || !excelMedia.length || excelStatus.state === 'building') return;
    setExcelStatus({ state: 'building' });
    try {
      const { parseWorkbook } = await import('./excel');
      const engine = await loadEngine();
      const bp = await parseWorkbook(await excelFile.arrayBuffer());

      const media = new Map<string, File>();
      for (const f of excelMedia) media.set(baseName(f.name).toLowerCase(), f);
      const grab = (name: string) => media.get(baseName(name).toLowerCase());

      // Report every missing file at once, rather than failing on the first.
      const missing = new Set<string>();
      const need = (name: string) => {
        if (name && !grab(name)) missing.add(name);
      };
      bp.clips.forEach((c) => need(c.file));
      bp.images.forEach((i) => need(i.file));
      bp.voices.forEach((v) => need(v.file));
      need(bp.settings.watermarkFile);
      need(bp.settings.musicFile);
      if (!bp.clips.length) {
        setExcelStatus({ state: 'error', message: 'The Excel has no clips — add rows to the “Clips” sheet (at least a File for each).' });
        return;
      }
      if (missing.size) {
        setExcelStatus({ state: 'error', message: `These files named in the Excel weren't among the uploaded files: ${[...missing].join(', ')}.` });
        return;
      }

      // Clear any project already loaded.
      clips.forEach(freeClip);
      if (logoOverlay) URL.revokeObjectURL(logoOverlay.url);

      // With per-clip narration, default to hard cuts so two clips' voiceovers never overlap at a cross-fade.
      const defaultTransition: Transition = bp.settings.voiceMode === 'per-clip' && bp.voices.length ? 'cut' : (bp.settings.transition as Transition);
      const orderToId = new Map<number, string>();
      const built: Clip[] = [];
      const pending: { id: string; file: File; photo: boolean; trimStart?: number; trimEnd?: number; photoSeconds?: number }[] = [];

      for (const bc of bp.clips) {
        const file = grab(bc.file)!;
        const photo = isPhoto(file);
        const id = crypto.randomUUID();
        orderToId.set(bc.order, id);
        const pills: Pill[] = bp.pills
          .filter((p) => p.clip === bc.order)
          .map((p) => ({
            id: crypto.randomUUID(),
            text: p.text,
            position: { x: clamp01(p.x / 100), y: clamp01(p.y / 100) },
            start: Math.max(0, p.start),
            end: Math.max(0, p.end),
            background: normHex(p.background, '#0f1115'),
            opacity: clamp(0, 100, p.opacity),
            color: normHex(p.textColor, '#ffffff'),
            font: (PILL_FONT_KEYS.includes(p.font as PillFont) ? p.font : 'system') as PillFont,
            size: clamp(PILL_SIZE.min, PILL_SIZE.max, p.size),
          }));
        const images: Overlay[] = bp.images
          .filter((im) => im.clip === bc.order)
          .map((im) => {
            const f = grab(im.file)!;
            return { id: crypto.randomUUID(), file: f, url: URL.createObjectURL(f), x: clamp01(im.x / 100), y: clamp01(im.y / 100), scale: clamp(0.05, 1, im.size / 100), status: 'loading' as const };
          });
        built.push({
          id,
          file,
          preview: null,
          status: 'probing',
          voiceover: null,
          voiceOffset: 0,
          voiceTrim: { start: 0, end: 0 },
          images,
          pills,
          motion: bc.motion as Motion,
          motionSpeed: bc.motionSpeed as MotionSpeed,
          trim: { start: 0, end: 0 },
          transition: (bc.transition as Transition) ?? defaultTransition,
        } as Clip);
        pending.push({ id, file, photo, trimStart: bc.trimStart, trimEnd: bc.trimEnd, photoSeconds: bc.photoSeconds });
      }

      // Settings → editor state.
      const sz = parseSize(bp.settings.outputSize);
      if (sz.preset) setPreset(sz.preset);
      else {
        setPreset(CUSTOM_PRESET);
        setCustom(customSize(sz.width, sz.height));
      }
      setLogoSeconds(snap(bp.settings.logoSeconds, LOGO_SECONDS));
      setTransitionSeconds(snap(bp.settings.transitionSeconds, TRANSITION_SECONDS));
      setFastFps(bp.settings.frameRate === 'fast');
      setDefaults((d) => ({ ...d, transition: bp.settings.transition as Transition }));
      setClipVolume(clamp(0, 100, bp.settings.clipVolume));
      setVoiceVolume(clamp(0, 100, bp.settings.voiceVolume));
      setMusicVolume(clamp(0, 100, bp.settings.musicVolume));
      setDownloadCodec(bp.settings.downloadCodec);
      setDownloadMB(bp.settings.targetSizeMB >= 4 ? 5 : 2);
      setVoiceMode(bp.settings.voiceMode);
      setFill(bp.settings.fill);

      // Watermark logo.
      if (bp.settings.watermarkFile) {
        const wf = grab(bp.settings.watermarkFile)!;
        const url = URL.createObjectURL(wf);
        setLogoOverlay({ id: 'logo', file: wf, url, x: clamp01(bp.settings.watermarkX / 100), y: clamp01(bp.settings.watermarkY / 100), scale: clamp(0.02, 1, bp.settings.watermarkSize / 100), status: 'loading' });
        engine.probeImage(wf).then(
          (s) => setLogoOverlay((o) => (o && o.file === wf ? ({ ...o, status: 'ready', ...s } as Overlay) : o)),
          (e: Error) => setLogoOverlay((o) => (o && o.file === wf ? ({ ...o, status: 'error', error: e.message } as Overlay) : o)),
        );
      } else setLogoOverlay(null);

      // Music.
      if (bp.settings.musicFile) {
        const mf = grab(bp.settings.musicFile)!;
        setMusic({ file: mf, status: 'loading' });
        setMusicStartOffset(Math.max(0, bp.settings.musicStartOffset));
        engine.loadAudio(mf).then(
          (buffer) => setMusic((c) => (c?.file === mf ? { file: mf, status: 'ready', buffer } : c)),
          (e: Error) => setMusic((c) => (c?.file === mf ? { file: mf, status: 'error', error: e.message } : c)),
        );
      } else setMusic(null);

      // Voiceovers, by the chosen mode.
      setVoiceover(null);
      setRanges([]);
      if (bp.settings.voiceMode === 'whole') {
        const v = bp.voices[0];
        if (v) {
          const f = grab(v.file)!;
          setVoiceTrim({ start: Math.max(0, v.trimStart), end: Math.max(0, v.trimEnd) });
          setVoiceStartOffset(Math.max(0, v.startOffset));
          setVoiceover({ file: f, status: 'loading' });
          engine.loadAudio(f).then(
            (buffer) => setVoiceover((c) => (c?.file === f ? { file: f, status: 'ready', buffer } : c)),
            (e: Error) => setVoiceover((c) => (c?.file === f ? { file: f, status: 'error', error: e.message } : c)),
          );
        }
      } else if (bp.settings.voiceMode === 'ranges') {
        const rangesBuilt: VoiceRange[] = bp.voices.map((v) => {
          const f = grab(v.file)!;
          const from = v.fromClip ?? v.clip ?? bp.clips[0].order;
          const to = v.toClip ?? v.clip ?? from;
          const startIdx = Math.max(0, bp.clips.findIndex((c) => c.order === from));
          const endIdxRaw = bp.clips.findIndex((c) => c.order === to);
          const id = crypto.randomUUID();
          const range: VoiceRange = { id, track: { file: f, status: 'loading' }, start: startIdx, end: endIdxRaw < 0 ? startIdx : Math.max(startIdx, endIdxRaw), startOffset: Math.max(0, v.startOffset), trim: { start: Math.max(0, v.trimStart), end: Math.max(0, v.trimEnd) } };
          engine.loadAudio(f).then(
            (buffer) => setRanges((prev) => prev.map((r) => (r.id === id ? { ...r, track: { file: f, status: 'ready', buffer } } : r))),
            (e: Error) => setRanges((prev) => prev.map((r) => (r.id === id ? { ...r, track: { file: f, status: 'error', error: e.message } } : r))),
          );
          return range;
        });
        setRanges(rangesBuilt);
      } else {
        for (const v of bp.voices) {
          if (v.clip == null) continue;
          const cid = orderToId.get(v.clip);
          if (!cid) continue;
          const f = grab(v.file)!;
          const idx = built.findIndex((c) => c.id === cid);
          if (idx >= 0) built[idx] = { ...built[idx], voiceover: { file: f, status: 'loading' }, voiceOffset: Math.max(0, v.startOffset), voiceTrim: { start: Math.max(0, v.trimStart), end: Math.max(0, v.trimEnd) } };
          engine.loadAudio(f).then(
            (buffer) => setClips((prev) => prev.map((c) => (c.id === cid && c.voiceover?.file === f ? { ...c, voiceover: { file: f, status: 'ready', buffer } } : c))),
            (e: Error) => setClips((prev) => prev.map((c) => (c.id === cid && c.voiceover?.file === f ? { ...c, voiceover: { file: f, status: 'error', error: e.message } } : c))),
          );
        }
        if (bp.voices.length) setClipVolume((v) => Math.min(v, CLIP_VOLUME_UNDER_VOICE));
      }

      // Commit clips, then probe each (size, duration, thumbnail, overlay images) in the background.
      setClips(built);
      setJob({ state: 'idle' });
      setIngestWarnings(bp.warnings);
      setFromExcel(true);
      setMode('manual');
      setExcelStatus({ state: 'idle' });

      for (const pc of pending) {
        const probe = pc.photo
          ? engine.probeImage(pc.file).then(({ width, height }) => ({ width, height, duration: Math.max(PHOTO_SECONDS.min, Math.min(PHOTO_SECONDS.max, pc.photoSeconds ?? PHOTO_SECONDS.default)), fps: NaN }))
          : engine.probeClip(pc.file);
        probe.then(
          (info) => {
            const trim = pc.photo
              ? { start: 0, end: 0 }
              : {
                  start: clamp(0, Math.max(0, info.duration - 0.2), pc.trimStart ?? 0),
                  end: pc.trimEnd != null && pc.trimEnd > 0 ? clamp(0.2, info.duration, pc.trimEnd) : info.duration,
                };
            update(pc.id, { status: 'ready', info, photo: pc.photo, trim } as Partial<Clip>);
            engine.makeThumbnail(pc.file, pc.photo).then((preview) => update(pc.id, { preview }), () => {});
          },
          (e: Error) => update(pc.id, { status: 'error', error: e.message }),
        );
      }
      for (const c of built) for (const o of c.images) {
        engine.probeImage(o.file).then(
          (size) => updateImage(c.id, o.id, { status: 'ready', ...size }),
          (e: Error) => updateImage(c.id, o.id, { status: 'error', error: e.message }),
        );
      }
    } catch (e) {
      setExcelStatus({ state: 'error', message: e instanceof Error ? e.message : 'Could not read that Excel file.' });
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
    setFill('contain');
    setFromExcel(false);
    setIngestWarnings([]);
    setExcelFile(null);
    setExcelMedia([]);
    setExcelStatus({ state: 'idle' });
    setMode('choose');
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

      {mode === 'choose' && (
        <section className="card chooser">
          <h2>How do you want to start?</h2>
          <div className="chooser-grid">
            <button className="choice" onClick={() => setMode('excel')}>
              <strong>Add Excel and files</strong>
              <span className="muted">Upload a blueprint spreadsheet and all your media — the video is built automatically, no manual editing.</span>
            </button>
            <button className="choice" onClick={() => { setFromExcel(false); setMode('manual'); }}>
              <strong>Manually edit</strong>
              <span className="muted">Build the video by hand — add clips, trims, captions, voiceovers and settings yourself.</span>
            </button>
          </div>
        </section>
      )}

      {mode === 'excel' && (
        <section className="card intake">
          <div className="card-head">
            <h2>Add Excel and files</h2>
            <button className="link" onClick={() => setMode('choose')}>← Back</button>
          </div>
          <p className="muted">Upload the blueprint spreadsheet, then all your media (videos, photos, audio, logo). The file names written in the Excel must match the uploaded files.</p>
          <div className="intake-grid">
            <label className="dropzone small">
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                hidden
                onChange={(e) => {
                  setExcelFile(e.target.files?.[0] ?? null);
                  setExcelStatus({ state: 'idle' });
                  e.target.value = '';
                }}
              />
              <strong>1 · Excel blueprint</strong>
              <span className="muted">{excelFile ? excelFile.name : '.xlsx or .csv — clips, pills, voiceovers, settings'}</span>
            </label>
            <label
              className={`dropzone small${excelDragging ? ' active' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setExcelDragging(true);
              }}
              onDragLeave={() => setExcelDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setExcelDragging(false);
                addExcelMedia(Array.from(e.dataTransfer.files ?? []));
              }}
            >
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addExcelMedia(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <strong>2 · Add media files</strong>
              <span className="muted">Videos, photos, audio, logo — add from any folder, as many times as you like (or drag them here)</span>
            </label>
          </div>
          {excelMedia.length > 0 && (
            <div className="file-chips">
              <span className="muted">{excelMedia.length} file{excelMedia.length > 1 ? 's' : ''} added:</span>
              {excelMedia.map((f) => (
                <span key={`${f.name}:${f.size}`} className="chip" title={f.name}>
                  {f.name}
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => removeExcelMedia(`${f.name}:${f.size}`)}>✕</button>
                </span>
              ))}
              <button type="button" className="link" onClick={() => setExcelMedia([])}>Clear all</button>
            </div>
          )}
          <div className="intake-actions">
            <button className="link" onClick={downloadSample}>⬇ Download sample Excel template</button>
          </div>
          {excelStatus.state === 'error' && <p className="hint error">{excelStatus.message}</p>}
          <button className="primary" disabled={!SUPPORTED || !excelFile || !excelMedia.length || excelStatus.state === 'building'} onClick={buildFromExcel}>
            {excelStatus.state === 'building' ? 'Building your video…' : 'Build the video →'}
          </button>
          <p className="hint muted">Everything runs on your device — no server, no cost. After building, you land in the editor with everything filled in, ready to export (and free to tweak).</p>
        </section>
      )}

      {mode === 'manual' && (
      <>
      {ingestWarnings.length > 0 && (
        <div className="notice">
          <strong>Built from your Excel.</strong> {ingestWarnings.length} note{ingestWarnings.length > 1 ? 's' : ''}:
          <ul className="warn-list">
            {ingestWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <button className="link" onClick={() => setIngestWarnings([])}>Dismiss</button>
        </div>
      )}

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
              const clipVoice = clip.voiceover?.status === 'ready' ? clip.voiceover : null;
              const playSeconds = clip.status === 'ready' ? clipPlaySeconds(clip) : 0;
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

                      {perClip && fromExcel && (
                        clipVoice ? (
                          <p className="hint muted">Voiceover: {clipVoice.file.name} — this clip waits for it to finish playing.</p>
                        ) : (
                          <p className="hint muted">No voiceover on this clip.</p>
                        )
                      )}
                      {perClip && !fromExcel && (
                        <>
                          <AudioPicker label="Voiceover" track={clip.voiceover} disabled={busy} preview={false} onFile={(file) => addVoiceover(file, clip.id)} onRemove={() => update(clip.id, { voiceover: null, voiceOffset: 0, voiceTrim: { start: 0, end: 0 } })} />
                          {clipVoice && (
                            <>
                              <VoiceTrimmer file={clipVoice.file} duration={clipVoice.buffer.duration} trim={clip.voiceTrim} disabled={busy} onChange={(patch) => update(clip.id, { voiceTrim: { ...clip.voiceTrim, ...patch } })} />
                              <StartOffset value={clip.voiceOffset} max={Math.max(1, playSeconds)} disabled={busy} onChange={(v) => update(clip.id, { voiceOffset: v })} />
                            </>
                          )}
                          {clipVoice && clipVoice.buffer.duration > playSeconds + 0.3 && (
                            <p className="hint muted">This clip will hold its last frame until the voiceover finishes ({formatTime(clipVoice.buffer.duration)}).</p>
                          )}
                        </>
                      )}

                      <div className="pills">
                        <span className="muted">Text pills (captions) — add as many as you like</span>
                        {clip.pills.map((pill, pidx) => (
                          <PillEditor
                            key={pill.id}
                            pill={pill}
                            index={pidx}
                            preview={clip.preview}
                            aspect={aspect}
                            playLen={playSeconds}
                            disabled={busy}
                            others={clip.pills
                              .filter((o) => o.id !== pill.id && o.text.trim())
                              .map((o) => (
                                <span
                                  key={o.id}
                                  className="place-pill other"
                                  style={{
                                    left: `${o.position.x * 100}%`,
                                    top: `${o.position.y * 100}%`,
                                    transform: 'translate(-50%, -50%)',
                                    background: toRgba(o.background, o.opacity),
                                    color: o.color,
                                    fontFamily: PILL_FONTS[o.font].family,
                                    fontSize: pillPreviewFont(o.size),
                                  }}
                                >
                                  {o.text}
                                </span>
                              ))}
                            onChange={(patch) => updatePill(clip.id, pill.id, patch)}
                            onRemove={() => removePill(clip.id, pill.id)}
                            onApplyAll={() => applyPillStyleToAll(pill)}
                          />
                        ))}
                        <button type="button" className="slot-pick" disabled={busy} onClick={() => addPill(clip)}>
                          + Add {clip.pills.length ? 'another ' : ''}text pill
                        </button>
                      </div>

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
                  {fromExcel ? 'Set from your Excel' : perClip ? 'Add a file to each clip above' : voiceMode === 'ranges' ? 'Add files that each cover a run of clips' : 'Starts with the first clip'}
                </span>
              </div>

              {fromExcel && (
                <p className="hint muted">
                  Voiceovers come from your Excel and play in full — each clip waits for its voiceover. Re-upload the Excel to change them. You can still adjust the volume below.
                </p>
              )}

              {voiceMode === 'whole' && !fromExcel && (
                <>
                  <AudioPicker label="Voiceover" track={voiceover} disabled={busy} preview={false} onFile={(file) => addVoiceover(file)} onRemove={() => setVoiceover(null)} />
                  {wholeVoiceTrack && (
                    <>
                      <VoiceTrimmer file={wholeVoiceTrack.file} duration={wholeVoiceTrack.buffer.duration} trim={voiceTrim} disabled={busy} onChange={(patch) => setVoiceTrim((t) => ({ ...t, ...patch }))} />
                      <StartOffset value={voiceStartOffset} max={Math.max(1, totalSeconds - logoSeconds)} disabled={busy} onChange={setVoiceStartOffset} />
                    </>
                  )}
                  {voiceOverflow > 0.5 && <p className="hint warn">The voiceover is {formatTime(voiceOverflow)} longer than the remaining video and will be cut at the end.</p>}
                </>
              )}

              {voiceMode === 'ranges' && !fromExcel && (
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
                        {buffer && <VoiceTrimmer file={r.track.file} duration={buffer.duration} trim={r.trim} disabled={busy} onChange={(patch) => updateRange(r.id, { trim: { ...r.trim, ...patch } })} />}
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
                        {r.track.status === 'ready' && spanSeconds > 0 && (
                          <StartOffset value={Math.min(r.startOffset, Math.max(1, spanSeconds))} max={Math.max(1, spanSeconds)} disabled={busy} onChange={(v) => updateRange(r.id, { startOffset: v })} />
                        )}
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
              Frame fill
              <select value={fill} disabled={busy} onChange={(e) => setFill(e.target.value as 'contain' | 'cover')}>
                <option value="contain">Fit — show the whole clip (black bars)</option>
                <option value="cover">Fill — crop clips to fill the frame</option>
              </select>
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
          <div className="download-opts">
            <label>
              Smaller file — codec
              <select
                value={downloadCodec}
                disabled={h264.status === 'working'}
                onChange={(e) => {
                  setDownloadCodec(e.target.value as DownloadCodec);
                  setH264({ status: 'idle' });
                }}
              >
                {(Object.keys(DOWNLOAD_CODEC_LABELS) as DownloadCodec[]).map((c) => (
                  <option key={c} value={c}>{DOWNLOAD_CODEC_LABELS[c]}</option>
                ))}
              </select>
            </label>
            <label>
              Target size
              <select
                value={downloadMB}
                disabled={h264.status === 'working'}
                onChange={(e) => {
                  setDownloadMB(Number(e.target.value));
                  setH264({ status: 'idle' });
                }}
              >
                {DOWNLOAD_SIZE_MB.map((mb) => (
                  <option key={mb} value={mb}>{mb} MB {mb === 2 ? '(mobile)' : '(desktop)'}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <a className="button primary" href={job.url} download={downloadName()}>
              Download (best quality) · {job.outWidth}×{job.outHeight}
            </a>
            {h264.status === 'ready' ? (
              <a className="button secondary" href={h264.url} download={downloadName(`-${(CODEC_SHORT[h264.codec] || 'small').toLowerCase()}`)}>
                Download {CODEC_SHORT[h264.codec] || 'file'} ({formatBytes(h264.size)} · {job.outWidth}×{job.outHeight})
              </a>
            ) : h264.status === 'working' ? (
              <span className="button secondary" aria-busy="true">Preparing… {Math.round(h264.progress * 100)}%</span>
            ) : (
              <button className="secondary" onClick={prepareH264}>
                Prepare smaller file (≤{downloadMB} MB · {job.outWidth}×{job.outHeight})
              </button>
            )}
            <button className="secondary" onClick={reset}>Start a new video</button>
          </div>
          <p className="hint muted">
            <strong>“Download (best quality)” is your {job.outWidth}×{job.outHeight} H.264 file</strong> — exactly as made, plays everywhere. The smaller file keeps the same {job.outWidth}×{job.outHeight} view but squeezes it under {downloadMB} MB using a modern codec (Auto picks AV1 or H.265 when your browser can make them, else H.264), so it looks far cleaner than H.264 at the same size.
            {downloadFits && (downloadCodec === 'auto' || downloadCodec === 'avc') ? ' This video already fits, so Auto/H.264 copies it with no quality loss — pick AV1 or H.265 to shrink it further.' : ''}
            {' '}AV1/H.265 play in modern players and phones; use H.264 (or best quality) for the widest compatibility.
          </p>
          {h264.status === 'error' && <p className="hint error">{h264.message}</p>}
        </section>
      )}
      </>
      )}
    </div>
  );
}
