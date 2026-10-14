import { useEffect, useRef, useState } from 'react';
import logoUrl from './assets/logo.png';
import {
  MOTION_LABELS,
  TRANSITION_LABELS,
  autoFps,
  autoSize,
  planTimeline,
  type ClipInfo,
  type Motion,
  GRID,
  CUSTOM_SIZE_LIMITS,
  PILL_FONTS,
  QUALITY_LABELS,
  cellBounds,
  customSize,
  type PillFont,
  type PillPosition,
  type Quality,
  type Size,
  type Transition,
} from './timeline';

// The media engine is loaded on demand so the page itself paints instantly.
const loadEngine = () => import('./render');

type AudioTrack = { file: File } & (
  | { status: 'loading' }
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'error'; error: string }
);

type PillStyle = { background: string; opacity: number; color: string; font: PillFont };
type Pill = { enabled: boolean; text: string; position: PillPosition } & PillStyle;

/** An image overlay: decoded once when chosen; `url` previews it in the placement grid. */
type Overlay = { id: string; file: File; url: string; cells: number[] } & (
  | { status: 'loading' }
  | { status: 'ready'; width: number; height: number }
  | { status: 'error'; error: string }
);

type Clip = {
  id: string;
  file: File;
  voiceover: AudioTrack | null;
  pill: Pill;
  images: Overlay[];
  motion: Motion;
  transition: Transition;
} & (
  | { status: 'probing' }
  /** For photos, `info.duration` is the on-screen time the user chose. */
  | { status: 'ready'; info: ClipInfo; photo: boolean }
  | { status: 'error'; error: string }
);

type VoiceMode = 'whole' | 'per-clip';

type Job =
  | { state: 'idle' }
  | { state: 'rendering'; progress: number; stage: string; startedAt: number; updatedAt: number }
  | { state: 'done'; url: string; size: number; seconds: number }
  | { state: 'error'; message: string };

const CUSTOM_PRESET = 'Custom size (type width × height)';
const SIZE_PRESETS: Record<string, (first: ClipInfo) => Size> = {
  '1080p, shape of first clip (recommended)': (first) => autoSize(first, 1080),
  '720p, shape of first clip (fastest)': (first) => autoSize(first, 720),
  'Original size, up to 4K (slower)': (first) => autoSize(first),
  '1080p landscape (1920×1080)': () => ({ width: 1920, height: 1080 }),
  '720p landscape (1280×720)': () => ({ width: 1280, height: 720 }),
  '4K landscape (3840×2160)': () => ({ width: 3840, height: 2160 }),
  '1080p portrait (1080×1920)': () => ({ width: 1080, height: 1920 }),
  '720p portrait (720×1280)': () => ({ width: 720, height: 1280 }),
  '1080p square (1080×1080)': () => ({ width: 1080, height: 1080 }),
};
const SIZE_GROUPS: [string, string[]][] = [
  ['Match your clips', Object.keys(SIZE_PRESETS).slice(0, 3)],
  ['Custom', [CUSTOM_PRESET]],
  ['Landscape', Object.keys(SIZE_PRESETS).slice(3, 6)],
  ['Portrait & square', Object.keys(SIZE_PRESETS).slice(6)],
];
const DEFAULT_PILL_STYLE: PillStyle = { background: '#0f1115', opacity: 72, color: '#ffffff', font: 'system' };
const PILL_FONT_KEYS = Object.keys(PILL_FONTS) as PillFont[];
const PHOTO_SECONDS = { default: 4, min: 1, max: 60 };
const isPhoto = (f: File) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|heic)$/i.test(f.name);
const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
/** New images start in a free corner (2×2 boxes): top-right, top-left, bottom-right, bottom-left. */
const CORNERS = [
  [GRID - 2, GRID - 1, 2 * GRID - 2, 2 * GRID - 1],
  [0, 1, GRID, GRID + 1],
  [GRID * GRID - GRID - 2, GRID * GRID - GRID - 1, GRID * GRID - 2, GRID * GRID - 1],
  [GRID * (GRID - 2), GRID * (GRID - 2) + 1, GRID * (GRID - 1), GRID * (GRID - 1) + 1],
];

/** Releases an overlay's preview URL. Pixels are only decoded during export, so nothing else is held. */
const freeOverlay = (overlay: Overlay) => URL.revokeObjectURL(overlay.url);

/** '#rrggbb' + 0–100 opacity → CSS rgba(). */
const toRgba = (hex: string, opacity: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`;
};
const TRANSITION_SECONDS = [0.5, 0.75, 1, 1.5];
const TRANSITIONS = Object.keys(TRANSITION_LABELS) as Transition[];
const MOTIONS = Object.keys(MOTION_LABELS) as Motion[];

const LOGO_SECONDS = [2, 3, 4, 5];
/** Clip sound is lowered to this when a voiceover is added, so the voice stays clear. */
const CLIP_VOLUME_UNDER_VOICE = 30;
const PILL_MAX_LENGTH = 120;
const PILL_POSITIONS: PillPosition[] = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];
/** If progress stops moving for this long, the export is flagged as stuck. */
const STALL_SECONDS = 60;
const SUPPORTED = typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

const formatTime = (s: number) => {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const formatBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const readyBuffer = (track: AudioTrack | null) => (track?.status === 'ready' ? track.buffer : undefined);

type AudioPickerProps = {
  label: string;
  track: AudioTrack | null;
  disabled: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
};

/** Shows a "+ Add" button, or the chosen file with its duration and a remove button. */
function AudioPicker({ label, track, disabled, onFile, onRemove }: AudioPickerProps) {
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
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={pill.opacity}
              disabled={disabled}
              onChange={(e) => onChange({ opacity: Number(e.target.value) })}
            />
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

/** A miniature frame: click boxes to choose where the image goes; it fills the rectangle around them. */
type ImagePlacementProps = { overlay: Overlay; others: Overlay[]; aspect: number; disabled: boolean; onChange: (cells: number[]) => void };

/** Positions an image preview over the grid boxes it covers. */
const areaStyle = (cells: number[]) => {
  const { col, row, cols, rows } = cellBounds(cells);
  return { left: `${(col / GRID) * 100}%`, top: `${(row / GRID) * 100}%`, width: `${(cols / GRID) * 100}%`, height: `${(rows / GRID) * 100}%` };
};

function ImagePlacement({ overlay, others, aspect, disabled, onChange }: ImagePlacementProps) {
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  /** The grid box under the pointer, clamped to the frame. */
  const cellAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID)));
    return clamp((e.clientY - r.top) / r.height) * GRID + clamp((e.clientX - r.left) / r.width);
  };
  /** Every box in the rectangle between two corner boxes. */
  const rectangle = (a: number, b: number) => {
    const { col, row, cols, rows } = cellBounds([a, b]);
    return Array.from({ length: cols * rows }, (_, i) => (row + Math.floor(i / cols)) * GRID + col + (i % cols));
  };
  const toggle = (cell: number) =>
    onChange(overlay.cells.includes(cell) ? overlay.cells.filter((c) => c !== cell) : [...overlay.cells, cell]);

  const preview = drag ? rectangle(drag.from, drag.to) : null;
  const shown = preview ?? overlay.cells;

  return (
    <div className="position">
      <span className="muted">Placement and size — drag across the boxes the image should cover (or click boxes to add/remove)</span>
      <div
        className="frame large"
        style={{ aspectRatio: aspect, gridTemplate: `repeat(${GRID}, 1fr) / repeat(${GRID}, 1fr)` }}
        aria-label="Image placement"
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const cell = cellAt(e);
          setDrag({ from: cell, to: cell });
        }}
        onPointerMove={(e) => drag && setDrag({ ...drag, to: cellAt(e) })}
        onPointerUp={() => {
          if (!drag) return;
          if (drag.from === drag.to) toggle(drag.from);
          else onChange(rectangle(drag.from, drag.to));
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {Array.from({ length: GRID * GRID }, (_, cell) => (
          <button
            key={cell}
            tabIndex={0}
            aria-pressed={overlay.cells.includes(cell)}
            aria-label={`Box ${cell + 1}`}
            className={shown.includes(cell) ? 'selected' : ''}
            disabled={disabled}
            // Pointer clicks are handled by the frame; this keeps Enter/Space working for keyboard users.
            onClick={(e) => e.detail === 0 && toggle(cell)}
          />
        ))}
        {others
          .filter((o) => o.cells.length)
          .map((o) => (
            <img key={o.id} className="frame-image other" src={o.url} alt="" style={areaStyle(o.cells)} />
          ))}
        {shown.length > 0 && <img className="frame-image" src={overlay.url} alt="" style={areaStyle(shown)} />}
      </div>
      {!overlay.cells.length && <p className="hint warn">Select at least one box, or this image won't be shown.</p>}
    </div>
  );
}

/** A miniature frame: click a cell to place the pill there. */
function PositionPicker({ value, aspect, disabled, onChange }: { value: PillPosition; aspect: number; disabled: boolean; onChange: (p: PillPosition) => void }) {
  return (
    <div className="position">
      <span className="muted">Position</span>
      <div className="frame" style={{ aspectRatio: aspect }} role="radiogroup" aria-label="Pill position">
        {PILL_POSITIONS.map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={p === value}
            aria-label={p.replace('-', ' ')}
            className={p === value ? 'selected' : ''}
            disabled={disabled}
            onClick={() => onChange(p)}
          >
            {p === value && <span className="mini-pill" />}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('whole');
  const [voiceover, setVoiceover] = useState<AudioTrack | null>(null);
  const [music, setMusic] = useState<AudioTrack | null>(null);
  const [clipVolume, setClipVolume] = useState(100);
  const [voiceVolume, setVoiceVolume] = useState(100);
  const [musicVolume, setMusicVolume] = useState(20);
  const [preset, setPreset] = useState(Object.keys(SIZE_PRESETS)[0]);
  const [custom, setCustom] = useState<Size>({ width: 1920, height: 1080 });
  const [quality, setQuality] = useState<Quality>('very-high');
  const [logoSeconds, setLogoSeconds] = useState(3);
  const [fastFps, setFastFps] = useState(true);
  const [transitionSeconds, setTransitionSeconds] = useState(0.75);
  const [pillDefaults, setPillDefaults] = useState<PillStyle>(DEFAULT_PILL_STYLE);
  const [defaults, setDefaults] = useState<{ transition: Transition; motion: Motion }>({ transition: 'dissolve', motion: 'none' });
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const ready = clips.filter((c): c is Clip & { status: 'ready' } => c.status === 'ready');
  const busy = job.state === 'rendering';
  const perClip = voiceMode === 'per-clip';
  const activeTracks = [music, ...(perClip ? clips.map((c) => c.voiceover) : [voiceover])];
  const audioPending = activeTracks.some((t) => t && t.status !== 'ready');
  const overlays = clips.flatMap((c) => c.images);
  const hasError =
    clips.some((c) => c.status === 'error') || [...activeTracks, ...overlays].some((t) => t?.status === 'error');
  const canExport =
    SUPPORTED && !busy && clips.length > 0 && ready.length === clips.length && !audioPending && !overlays.some((o) => o?.status === 'loading');
  const fps = ready.length ? autoFps(ready.map((c) => c.info), fastFps) : 30;
  const plan = planTimeline(ready.map((c) => c.info.duration), ready.map((c) => c.transition), fps, logoSeconds, transitionSeconds);
  const totalSeconds = ready.length ? plan.totalFrames / fps : 0;
  const voiceOverflow =
    !perClip && voiceover?.status === 'ready' && ready.length ? voiceover.buffer.duration - (totalSeconds - logoSeconds) : 0;
  const hasAnyVoice = perClip ? clips.some((c) => c.voiceover?.status === 'ready') : voiceover?.status === 'ready';
  const sizeFor = (first: ClipInfo) => (preset === CUSTOM_PRESET ? customSize(custom.width, custom.height) : SIZE_PRESETS[preset](first));
  const outputSize = ready[0] ? sizeFor(ready[0].info) : null;
  const aspect = outputSize ? outputSize.width / outputSize.height : 16 / 9;
  /** The value shared by every clip, or 'mixed' when clips differ. */
  const common = <K extends 'transition' | 'motion'>(key: K) =>
    clips.length && clips.some((c) => c[key] !== clips[0][key]) ? 'mixed' : (clips[0]?.[key] ?? defaults[key]);

  // Warn before closing the tab mid-render; release the output file when it is replaced.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  useEffect(() => () => void (job.state === 'done' && URL.revokeObjectURL(job.url)), [job]);
  // Load the engine early, and remove export files left on disk by an earlier visit.
  useEffect(() => void loadEngine().then(({ clearExports }) => clearExports()), []);

  // A 1-second clock while exporting keeps the time-left estimate and the stall check current.
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
      status: 'probing',
      voiceover: null,
      images: [],
      pill: { enabled: false, text: '', position: 'bottom-center', ...pillDefaults },
      ...defaults,
    }));
    setClips((prev) => [...prev, ...added]);
    setJob({ state: 'idle' });

    const { probeClip, probeImage } = await loadEngine();
    for (const clip of added) {
      const photo = isPhoto(clip.file);
      const probe = photo
        ? probeImage(clip.file).then(({ width, height }) => ({ width, height, duration: PHOTO_SECONDS.default, fps: NaN }))
        : probeClip(clip.file);
      probe.then(
        (info) => update(clip.id, { status: 'ready', info, photo }),
        (e: Error) => update(clip.id, { status: 'error', error: e.message }),
      );
    }
  };

  /** Sets how long a photo stays on screen. */
  const setPhotoSeconds = (clip: Clip & { status: 'ready' }, seconds: number) =>
    update(clip.id, { info: { ...clip.info, duration: Math.min(PHOTO_SECONDS.max, Math.max(PHOTO_SECONDS.min, seconds || PHOTO_SECONDS.min)) } });

  /** Releases the preview URLs a clip holds. */
  const freeClip = (clip: Clip) => clip.images.forEach(freeOverlay);

  const update = (id: string, patch: Partial<Clip>) =>
    setClips((prev) => prev.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)));

  const updatePill = (clip: Clip, patch: Partial<Pill>) => update(clip.id, { pill: { ...clip.pill, ...patch } });

  /** Patches one image of a clip. */
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

  /** Adds images to a clip, each starting in the next free corner, and checks they can be read. */
  const addImages = (clip: Clip, files: File[]) => {
    const added: Overlay[] = files.map((file, i) => ({
      id: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file),
      cells: CORNERS[(clip.images.length + i) % CORNERS.length],
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

  /** Copies one pill's colours and font to every clip's pill and to clips added later. */
  const applyPillStyleToAll = ({ background, opacity, color, font }: PillStyle) => {
    const style = { background, opacity, color, font };
    setPillDefaults(style);
    setClips((prev) => prev.map((c) => ({ ...c, pill: { ...c.pill, ...style } })));
  };

  /** Applies a transition or motion to every clip and to clips added later. */
  const setForAll = (patch: Partial<{ transition: Transition; motion: Motion }>) => {
    setDefaults((d) => ({ ...d, ...patch }));
    setClips((prev) => prev.map((c) => ({ ...c, ...patch })));
  };

  /** Decodes an audio file; `settle` ignores the result if the user replaced or removed it meanwhile. */
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

    try {
      const { renderVideo } = await loadEngine();
      // Keep the screen (and so the computer) awake during long exports. Not awaited: never delays the export.
      navigator.wakeLock?.request('screen').then((lock) => (wakeLock.current = lock), () => {});
      const logo = await createImageBitmap(await (await fetch(logoUrl)).blob());
      let lastPaint = 0;
      let lastStage = '';
      const result = await renderVideo({
        clips: ready.map((c) => ({
          file: c.file,
          info: c.info,
          photo: c.photo,
          motion: c.motion,
          transition: c.transition,
          voiceover: perClip ? readyBuffer(c.voiceover) : undefined,
          images: c.images.flatMap((o) => (o.status === 'ready' && o.cells.length ? [{ file: o.file, cells: o.cells }] : [])),
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
        size: sizeFor(ready[0].info),
        fps,
        logoSeconds,
        transitionSeconds,
        quality,
        clipVolume: clipVolume / 100,
        voiceVolume: voiceVolume / 100,
        musicVolume: musicVolume / 100,
        voiceover: perClip ? undefined : readyBuffer(voiceover),
        music: readyBuffer(music),
        signal: controller.signal,
        onProgress: (progress, stage) => {
          const now = performance.now();
          // Throttle re-renders, but always show a new step immediately.
          if (now - lastPaint < 100 && progress < 1 && stage === lastStage) return;
          lastPaint = now;
          lastStage = stage;
          setJob({ state: 'rendering', progress, stage, startedAt, updatedAt: now });
        },
      });
      logo.close();
      setJob({ state: 'done', url: URL.createObjectURL(result), size: result.size, seconds: (performance.now() - startedAt) / 1000 });
    } catch (e) {
      console.error('Export failed', e);
      if (controller.signal.aborted) setJob({ state: 'idle' });
      else setJob({ state: 'error', message: e instanceof Error ? e.message : 'Export failed.' });
    } finally {
      abortRef.current = null;
      void wakeLock.current?.release();
    }
  };

  const reset = () => {
    void loadEngine().then(({ clearExports }) => clearExports());
    clips.forEach(freeClip);
    setClips([]);
    setVoiceover(null);
    setMusic(null);
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

      {!SUPPORTED && (
        <div className="notice error">This browser can't encode video. Please use the latest Chrome, Edge or Safari.</div>
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
            {(['whole', 'per-clip'] as const).map((mode) => (
              <button
                key={mode}
                role="radio"
                aria-checked={voiceMode === mode}
                className={voiceMode === mode ? 'selected' : ''}
                disabled={busy}
                onClick={() => setVoiceMode(mode)}
              >
                {mode === 'whole' ? 'One file for the whole video' : 'Separate file for each clip'}
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
              const overflow = perClip && clip.status === 'ready' && voiceSeconds ? voiceSeconds - clip.info.duration : 0;
              return (
                <li key={clip.id} className={`clip ${clip.status}`}>
                  <div className="clip-row">
                    <span className="index">{i + 1}</span>
                    <span className="name" title={clip.file.name}>
                      {clip.file.name}
                      {clip.status === 'error' && <small>{clip.error}</small>}
                    </span>
                    <span className="meta">
                      {clip.status === 'probing' && 'Reading…'}
                      {clip.status === 'ready' && !clip.photo &&
                        `${clip.info.width}×${clip.info.height} · ${Math.round(clip.info.fps)} fps · ${formatTime(clip.info.duration)}`}
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
                          Zoom
                          <select value={clip.motion} disabled={busy} onChange={(e) => update(clip.id, { motion: e.target.value as Motion })}>
                            {MOTIONS.map((m) => (
                              <option key={m} value={m}>{MOTION_LABELS[m]}</option>
                            ))}
                          </select>
                        </label>
                        {i < clips.length - 1 && (
                          <label>
                            Transition to next clip
                            <select
                              value={clip.transition}
                              disabled={busy}
                              onChange={(e) => update(clip.id, { transition: e.target.value as Transition })}
                            >
                              {TRANSITIONS.map((t) => (
                                <option key={t} value={t}>{TRANSITION_LABELS[t]}</option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>

                      {perClip && (
                        <>
                          <AudioPicker
                            label="Voiceover"
                            track={clip.voiceover}
                            disabled={busy}
                            onFile={(file) => addVoiceover(file, clip.id)}
                            onRemove={() => update(clip.id, { voiceover: null })}
                          />
                          {overflow > 0.5 && (
                            <p className="hint warn">
                              This voiceover is {formatTime(overflow)} longer than the clip and will be cut at the end.
                              {clip.status === 'ready' && clip.photo && (
                                <>
                                  {' '}
                                  <button
                                    className="link"
                                    disabled={busy}
                                    onClick={() => setPhotoSeconds(clip, Math.ceil(voiceSeconds * 2) / 2)}
                                  >
                                    Show the photo for the whole voiceover
                                  </button>
                                </>
                              )}
                            </p>
                          )}
                        </>
                      )}

                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={clip.pill.enabled}
                          disabled={busy}
                          onChange={(e) => updatePill(clip, { enabled: e.target.checked })}
                        />
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
                        <PillStyleEditor
                          pill={clip.pill}
                          disabled={busy}
                          onChange={(patch) => updatePill(clip, patch)}
                          onApplyAll={() => applyPillStyleToAll(clip.pill)}
                        />
                      )}

                      {clip.pill.enabled && clip.pill.text.trim() && (
                        <PositionPicker
                          value={clip.pill.position}
                          aspect={aspect}
                          disabled={busy}
                          onChange={(position) => updatePill(clip, { position })}
                        />
                      )}

                      <div className="images">
                        <span className="muted">Images over this clip</span>
                        {clip.images.map((overlay, n) => (
                          <div key={overlay.id} className="image-item">
                            <div className={`slot-file${overlay.status === 'error' ? ' error' : ''}`}>
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
                              <ImagePlacement
                                overlay={overlay}
                                others={clip.images.filter((o) => o !== overlay)}
                                aspect={aspect}
                                disabled={busy}
                                onChange={(cells) => updateImage(clip.id, overlay.id, { cells })}
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
                <span className="muted">{perClip ? 'Add a file to each clip above' : 'Starts with the first clip'}</span>
              </div>
              {!perClip && (
                <AudioPicker
                  label="Voiceover"
                  track={voiceover}
                  disabled={busy}
                  onFile={(file) => addVoiceover(file)}
                  onRemove={() => setVoiceover(null)}
                />
              )}
              {hasAnyVoice && <VolumeSlider value={voiceVolume} onChange={setVoiceVolume} disabled={busy} />}
              {voiceOverflow > 0.5 && (
                <p className="hint warn">
                  The voiceover is {formatTime(voiceOverflow)} longer than the video and will be cut at the end.
                </p>
              )}
            </div>

            <div className="slot">
              <div className="slot-head">
                <strong>Music</strong>
                <span className="muted">Plays under the whole video, loops and fades out</span>
              </div>
              <AudioPicker label="Music" track={music} disabled={busy} onFile={addMusic} onRemove={() => setMusic(null)} />
              {music?.status === 'ready' && <VolumeSlider value={musicVolume} onChange={setMusicVolume} disabled={busy} />}
            </div>
          </div>

          <div className="settings">
            <label>
              Transitions (all clips)
              <select
                value={common('transition')}
                disabled={busy}
                onChange={(e) => setForAll({ transition: e.target.value as Transition })}
              >
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
              Zoom (all clips)
              <select value={common('motion')} disabled={busy} onChange={(e) => setForAll({ motion: e.target.value as Motion })}>
                {common('motion') === 'mixed' && <option value="mixed" disabled>Mixed</option>}
                {MOTIONS.map((m) => (
                  <option key={m} value={m}>{MOTION_LABELS[m]}</option>
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
                {SIZE_GROUPS.map(([group, options]) => (
                  <optgroup key={group} label={group}>
                    {options.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </optgroup>
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
              {outputSize && (
                <span className="meta">
                  Exports at {outputSize.width}×{outputSize.height}
                  {preset === CUSTOM_PRESET && ` · ${CUSTOM_SIZE_LIMITS.min}–${CUSTOM_SIZE_LIMITS.max} px, even numbers`}
                </span>
              )}
            </label>
            <label>
              Quality
              <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)} disabled={busy}>
                {(Object.keys(QUALITY_LABELS) as Quality[]).map((q) => (
                  <option key={q} value={q}>{QUALITY_LABELS[q]}</option>
                ))}
              </select>
            </label>
            <label>
              Frame rate
              <select value={fastFps ? 'fast' : 'smooth'} onChange={(e) => setFastFps(e.target.value === 'fast')} disabled={busy}>
                <option value="fast">Up to 30 fps (faster export)</option>
                <option value="smooth">Match clips, up to 60 fps (smoother)</option>
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
            <p className="hint warn">
              No progress for {STALL_SECONDS} seconds on “{job.stage}”. Press Cancel, then try a 720p output size, or remove
              the clip named above and add it again after re-saving it from your phone.
            </p>
          )}
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
            <a className="button primary" href={job.url} download={`roothoot-video-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`}>
              Download MP4
            </a>
            <button className="secondary" onClick={reset}>Start a new video</button>
          </div>
        </section>
      )}
    </div>
  );
}
