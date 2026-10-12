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
  type PillPosition,
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

type Pill = { enabled: boolean; text: string; position: PillPosition };

type Clip = { id: string; file: File; voiceover: AudioTrack | null; pill: Pill; motion: Motion; transition: Transition } & (
  | { status: 'probing' }
  | { status: 'ready'; info: ClipInfo }
  | { status: 'error'; error: string }
);

type VoiceMode = 'whole' | 'per-clip';

type Job =
  | { state: 'idle' }
  | { state: 'rendering'; progress: number; stage: string; startedAt: number; updatedAt: number }
  | { state: 'done'; url: string; size: number; seconds: number }
  | { state: 'error'; message: string };

const SIZE_PRESETS: Record<string, (first: ClipInfo) => Size> = {
  '1080p, shape of first clip (recommended)': (first) => autoSize(first, 1080),
  'Original size, up to 4K (slower)': (first) => autoSize(first),
  '1080p landscape (1920×1080)': () => ({ width: 1920, height: 1080 }),
  '1080p portrait (1080×1920)': () => ({ width: 1080, height: 1920 }),
  '4K landscape (slowest)': () => ({ width: 3840, height: 2160 }),
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
const STALL_SECONDS = 45;
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
  const [logoSeconds, setLogoSeconds] = useState(3);
  const [fastFps, setFastFps] = useState(true);
  const [transitionSeconds, setTransitionSeconds] = useState(0.75);
  const [defaults, setDefaults] = useState<{ transition: Transition; motion: Motion }>({ transition: 'dissolve', motion: 'none' });
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const ready = clips.filter((c): c is Clip & { status: 'ready' } => c.status === 'ready');
  const busy = job.state === 'rendering';
  const perClip = voiceMode === 'per-clip';
  const activeTracks = [music, ...(perClip ? clips.map((c) => c.voiceover) : [voiceover])];
  const audioPending = activeTracks.some((t) => t && t.status !== 'ready');
  const hasError = clips.some((c) => c.status === 'error') || activeTracks.some((t) => t?.status === 'error');
  const canExport = SUPPORTED && !busy && clips.length > 0 && ready.length === clips.length && !audioPending;
  const fps = ready.length ? autoFps(ready.map((c) => c.info), fastFps) : 30;
  const plan = planTimeline(ready.map((c) => c.info.duration), ready.map((c) => c.transition), fps, logoSeconds, transitionSeconds);
  const totalSeconds = ready.length ? plan.totalFrames / fps : 0;
  const voiceOverflow =
    !perClip && voiceover?.status === 'ready' && ready.length ? voiceover.buffer.duration - (totalSeconds - logoSeconds) : 0;
  const hasAnyVoice = perClip ? clips.some((c) => c.voiceover?.status === 'ready') : voiceover?.status === 'ready';
  const outputSize = ready[0] ? SIZE_PRESETS[preset](ready[0].info) : null;
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
  useEffect(() => void loadEngine(), []);

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
    const videos = Array.from(files ?? []).filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
    if (!videos.length) return;
    const added: Clip[] = videos.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: 'probing',
      voiceover: null,
      pill: { enabled: false, text: '', position: 'bottom-center' },
      ...defaults,
    }));
    setClips((prev) => [...prev, ...added]);
    setJob({ state: 'idle' });

    const { probeClip } = await loadEngine();
    for (const clip of added) {
      probeClip(clip.file).then(
        (info) => update(clip.id, { status: 'ready', info }),
        (e: Error) => update(clip.id, { status: 'error', error: e.message }),
      );
    }
  };

  const update = (id: string, patch: Partial<Clip>) =>
    setClips((prev) => prev.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)));

  const updatePill = (clip: Clip, patch: Partial<Pill>) => update(clip.id, { pill: { ...clip.pill, ...patch } });

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

  const remove = (id: string) => setClips((prev) => prev.filter((c) => c.id !== id));

  const exportVideo = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = performance.now();
    setJob({ state: 'rendering', progress: 0, stage: 'Preparing', startedAt, updatedAt: startedAt });

    try {
      const { renderVideo } = await loadEngine();
      const logo = await createImageBitmap(await (await fetch(logoUrl)).blob());
      let lastPaint = 0;
      const blob = await renderVideo({
        clips: ready.map((c) => ({
          file: c.file,
          info: c.info,
          motion: c.motion,
          transition: c.transition,
          voiceover: perClip ? readyBuffer(c.voiceover) : undefined,
          pill: c.pill.enabled && c.pill.text.trim() ? { text: c.pill.text, position: c.pill.position } : undefined,
        })),
        logo,
        size: SIZE_PRESETS[preset](ready[0].info),
        fps,
        logoSeconds,
        transitionSeconds,
        clipVolume: clipVolume / 100,
        voiceVolume: voiceVolume / 100,
        musicVolume: musicVolume / 100,
        voiceover: perClip ? undefined : readyBuffer(voiceover),
        music: readyBuffer(music),
        signal: controller.signal,
        onProgress: (progress, stage) => {
          const now = performance.now();
          if (now - lastPaint < 100 && progress < 1) return; // throttle re-renders
          lastPaint = now;
          setJob({ state: 'rendering', progress, stage, startedAt, updatedAt: now });
        },
      });
      logo.close();
      setJob({ state: 'done', url: URL.createObjectURL(blob), size: blob.size, seconds: (performance.now() - startedAt) / 1000 });
    } catch (e) {
      console.error('Export failed', e);
      if (controller.signal.aborted) setJob({ state: 'idle' });
      else setJob({ state: 'error', message: e instanceof Error ? e.message : 'Export failed.' });
    } finally {
      abortRef.current = null;
    }
  };

  const reset = () => {
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
          accept="video/*"
          multiple
          hidden
          disabled={busy}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <strong>Drop videos here or click to browse</strong>
        <span className="muted">MP4, MOV or WebM · add as many as you need</span>
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
              const overflow =
                perClip && clip.status === 'ready' && clip.voiceover?.status === 'ready'
                  ? clip.voiceover.buffer.duration - clip.info.duration
                  : 0;
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
                      {clip.status === 'ready' &&
                        `${clip.info.width}×${clip.info.height} · ${Math.round(clip.info.fps)} fps · ${formatTime(clip.info.duration)}`}
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
                        <PositionPicker
                          value={clip.pill.position}
                          aspect={aspect}
                          disabled={busy}
                          onChange={(position) => updatePill(clip, { position })}
                        />
                      )}
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
                {Object.keys(SIZE_PRESETS).map((p) => (
                  <option key={p}>{p}</option>
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
              No progress for {STALL_SECONDS} seconds on “{job.stage}”. This file may be too heavy for this browser. Press Cancel,
              then try “1080p” output and “Up to 30 fps”, or re-export that clip from your phone and add it again.
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
