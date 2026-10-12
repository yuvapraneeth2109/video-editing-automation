import { useEffect, useRef, useState } from 'react';
import logoUrl from './assets/logo.png';
import type { ClipInfo, Size } from './render';

// The media engine is loaded on demand so the page itself paints instantly.
const loadEngine = () => import('./render');

type Clip = { id: string; file: File } & (
  | { status: 'probing' }
  | { status: 'ready'; info: ClipInfo }
  | { status: 'error'; error: string }
);

type AudioTrack = { file: File } & (
  | { status: 'loading' }
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'error'; error: string }
);

type Job =
  | { state: 'idle' }
  | { state: 'rendering'; progress: number; startedAt: number }
  | { state: 'done'; url: string; size: number; seconds: number }
  | { state: 'error'; message: string };

const SIZE_PRESETS: Record<string, Size | null> = {
  'Match first clip': null,
  '1080p landscape (1920×1080)': { width: 1920, height: 1080 },
  '1080p portrait (1080×1920)': { width: 1080, height: 1920 },
  '4K landscape (3840×2160)': { width: 3840, height: 2160 },
};

const LOGO_SECONDS = [2, 3, 4, 5];
/** Clip sound is lowered to this when a voiceover is added, so the voice stays clear. */
const CLIP_VOLUME_UNDER_VOICE = 30;
const SUPPORTED = typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

const formatTime = (s: number) => {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const formatBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

type AudioSlotProps = {
  label: string;
  hint: string;
  track: AudioTrack | null;
  volume: number;
  disabled: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
  onVolume: (volume: number) => void;
};

function AudioSlot({ label, hint, track, volume, disabled, onFile, onRemove, onVolume }: AudioSlotProps) {
  return (
    <div className={`slot${track?.status === 'error' ? ' error' : ''}`}>
      <div className="slot-head">
        <strong>{label}</strong>
        <span className="muted">{hint}</span>
      </div>
      {track ? (
        <div className="slot-file">
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
      ) : (
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
      )}
      {track?.status === 'ready' && <VolumeSlider value={volume} onChange={onVolume} disabled={disabled} />}
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

export default function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [voiceover, setVoiceover] = useState<AudioTrack | null>(null);
  const [music, setMusic] = useState<AudioTrack | null>(null);
  const [clipVolume, setClipVolume] = useState(100);
  const [voiceVolume, setVoiceVolume] = useState(100);
  const [musicVolume, setMusicVolume] = useState(20);
  const [preset, setPreset] = useState(Object.keys(SIZE_PRESETS)[0]);
  const [logoSeconds, setLogoSeconds] = useState(3);
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const ready = clips.filter((c): c is Clip & { status: 'ready' } => c.status === 'ready');
  const busy = job.state === 'rendering';
  const audioPending = [voiceover, music].some((t) => t && t.status !== 'ready');
  const canExport = SUPPORTED && !busy && clips.length > 0 && ready.length === clips.length && !audioPending;
  const clipsSeconds = ready.reduce((sum, c) => sum + c.info.duration, 0);
  const totalSeconds = clipsSeconds + (ready.length ? logoSeconds * 2 : 0);
  const voiceOverflow =
    voiceover?.status === 'ready' && ready.length ? voiceover.buffer.duration - (clipsSeconds + logoSeconds) : 0;

  // Warn before closing the tab mid-render; release the output file when it is replaced.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  useEffect(() => () => void (job.state === 'done' && URL.revokeObjectURL(job.url)), [job]);
  useEffect(() => void loadEngine(), []);

  const addFiles = async (files: FileList | null) => {
    const videos = Array.from(files ?? []).filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
    if (!videos.length) return;
    const added: Clip[] = videos.map((file) => ({ id: crypto.randomUUID(), file, status: 'probing' }));
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

  /** Decodes an audio file; ignores the result if the user replaced or removed it meanwhile. */
  const addAudio = async (file: File, setTrack: typeof setVoiceover) => {
    setTrack({ file, status: 'loading' });
    setJob({ state: 'idle' });
    const settle = (track: AudioTrack) => setTrack((current) => (current?.file === file ? track : current));
    try {
      const { loadAudio } = await loadEngine();
      settle({ file, status: 'ready', buffer: await loadAudio(file) });
    } catch (e) {
      settle({ file, status: 'error', error: e instanceof Error ? e.message : 'This audio file could not be read.' });
    }
  };

  const update = (id: string, patch: Partial<Clip>) =>
    setClips((prev) => prev.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)));

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
    setJob({ state: 'rendering', progress: 0, startedAt });

    try {
      const { autoFps, autoSize, renderVideo } = await loadEngine();
      const logo = await createImageBitmap(await (await fetch(logoUrl)).blob());
      const infos = ready.map((c) => c.info);
      let lastPaint = 0;
      const blob = await renderVideo({
        clips: ready.map((c) => ({ file: c.file, info: c.info })),
        logo,
        size: SIZE_PRESETS[preset] ?? autoSize(infos[0]),
        fps: autoFps(infos),
        logoSeconds,
        clipVolume: clipVolume / 100,
        voiceover: voiceover?.status === 'ready' ? { buffer: voiceover.buffer, volume: voiceVolume / 100 } : undefined,
        music: music?.status === 'ready' ? { buffer: music.buffer, volume: musicVolume / 100 } : undefined,
        signal: controller.signal,
        onProgress: (progress) => {
          const now = performance.now();
          if (now - lastPaint < 100 && progress < 1) return; // throttle re-renders
          lastPaint = now;
          setJob({ state: 'rendering', progress, startedAt });
        },
      });
      logo.close();
      setJob({ state: 'done', url: URL.createObjectURL(blob), size: blob.size, seconds: (performance.now() - startedAt) / 1000 });
    } catch (e) {
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
          <ol className="clips">
            <li className="clip fixed">
              <span className="index">★</span>
              <span className="name">Logo intro</span>
              <span className="meta">{logoSeconds}s</span>
            </li>
            {clips.map((clip, i) => (
              <li key={clip.id} className={`clip ${clip.status}`}>
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
              </li>
            ))}
            <li className="clip fixed">
              <span className="index">★</span>
              <span className="name">Logo outro</span>
              <span className="meta">{logoSeconds}s</span>
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
            <AudioSlot
              label="Voiceover"
              hint="Starts with the first clip"
              track={voiceover}
              volume={voiceVolume}
              disabled={busy}
              onFile={(file) => {
                setClipVolume((v) => Math.min(v, CLIP_VOLUME_UNDER_VOICE));
                void addAudio(file, setVoiceover);
              }}
              onRemove={() => setVoiceover(null)}
              onVolume={setVoiceVolume}
            />
            <AudioSlot
              label="Music"
              hint="Plays under the whole video, loops and fades out"
              track={music}
              volume={musicVolume}
              disabled={busy}
              onFile={(file) => void addAudio(file, setMusic)}
              onRemove={() => setMusic(null)}
              onVolume={setMusicVolume}
            />
            {voiceOverflow > 0.5 && (
              <p className="hint warn">
                The voiceover is {formatTime(voiceOverflow)} longer than the video and will be cut at the end.
              </p>
            )}
          </div>

          <div className="settings">
            <label>
              Output size
              <select value={preset} onChange={(e) => setPreset(e.target.value)} disabled={busy}>
                {Object.keys(SIZE_PRESETS).map((p) => (
                  <option key={p}>{p}</option>
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
          </div>

          {job.state === 'rendering' ? (
            <div className="progress-row">
              <div className="progress" role="progressbar" aria-valuenow={Math.round(job.progress * 100)}>
                <div style={{ width: `${job.progress * 100}%` }} />
              </div>
              <span className="muted">{Math.floor(job.progress * 100)}%</span>
              <button className="secondary" onClick={() => abortRef.current?.abort()}>Cancel</button>
            </div>
          ) : (
            <button className="primary" onClick={exportVideo} disabled={!canExport}>
              Export MP4
            </button>
          )}
          {(clips.some((c) => c.status === 'error') || [voiceover, music].some((t) => t?.status === 'error')) && (
            <p className="hint error">Remove the files marked in red to export.</p>
          )}
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
