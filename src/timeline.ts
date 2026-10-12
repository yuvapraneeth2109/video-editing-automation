/**
 * Pure timeline maths shared by the UI (durations, previews) and the render engine (exact frames).
 * Kept free of media APIs so the UI can use it without loading the engine.
 */

export type ClipInfo = { width: number; height: number; duration: number; fps: number };

export type Size = { width: number; height: number };

export type PillPosition = `${'top' | 'middle' | 'bottom'}-${'left' | 'center' | 'right'}`;

/** How a clip hands over to the next one. */
export type Transition = 'cut' | 'dissolve' | 'fade' | 'slide' | 'wipe';

/** Slow camera move applied across a whole clip. */
export type Motion = 'none' | 'zoom-in' | 'zoom-out' | 'zoom-in-out';

export const TRANSITION_LABELS: Record<Transition, string> = {
  cut: 'Cut',
  dissolve: 'Dissolve',
  fade: 'Fade through black',
  slide: 'Slide',
  wipe: 'Wipe',
};

export const MOTION_LABELS: Record<Motion, string> = {
  none: 'None',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  'zoom-in-out': 'Zoom in, then out',
};

/** Fonts for text pills: installed on virtually every Mac, Windows PC and phone, so no download is needed. */
export const PILL_FONTS = {
  system: { label: 'System (clean sans)', family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  helvetica: { label: 'Helvetica / Arial', family: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  verdana: { label: 'Verdana', family: 'Verdana, Geneva, sans-serif' },
  trebuchet: { label: 'Trebuchet', family: "'Trebuchet MS', sans-serif" },
  georgia: { label: 'Georgia (serif)', family: "Georgia, 'Times New Roman', serif" },
  times: { label: 'Times New Roman', family: "'Times New Roman', Times, serif" },
  courier: { label: 'Courier (typewriter)', family: "'Courier New', Courier, monospace" },
  impact: { label: 'Impact (bold headline)', family: "Impact, 'Arial Black', sans-serif" },
} as const;

export type PillFont = keyof typeof PILL_FONTS;

/** Overlays are placed on a 3×3 grid; cells are numbered 0–8, left to right, top to bottom. */
export const GRID = 3;

/** The rectangle (in whole cells) that covers every selected cell. */
export function cellBounds(cells: number[]) {
  const cols = cells.map((c) => c % GRID);
  const rows = cells.map((c) => Math.floor(c / GRID));
  return { col: Math.min(...cols), row: Math.min(...rows), cols: Math.max(...cols) - Math.min(...cols) + 1, rows: Math.max(...rows) - Math.min(...rows) + 1 };
}

/** Transitions where the next clip starts before the current one ends. */
const OVERLAPS: ReadonlySet<Transition> = new Set(['dissolve', 'slide', 'wipe']);

const MAX_FPS = 60;
const FAST_FPS = 30;
const MAX_LONG_EDGE = 3840;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Output size with the first clip's shape. `shortEdge` caps the smaller side (1080 = Full HD);
 * without it the clip's own size is kept, capped at 4K. Never upscales.
 */
export function autoSize(first: ClipInfo, shortEdge?: number): Size {
  const limits = [1, MAX_LONG_EDGE / Math.max(first.width, first.height)];
  if (shortEdge) limits.push(shortEdge / Math.min(first.width, first.height));
  const scale = Math.min(...limits);
  return { width: even(first.width * scale), height: even(first.height * scale) };
}

/** The highest clip frame rate (so motion stays smooth), capped at 60 — or at 30 when `fast`. */
export function autoFps(clips: ClipInfo[], fast: boolean): number {
  const fps = Math.max(...clips.map((c) => c.fps).filter(Number.isFinite));
  return Math.min(fast ? FAST_FPS : MAX_FPS, fps > 0 ? fps : FAST_FPS);
}

export type PlannedClip = {
  /** First output frame of this clip. */
  start: number;
  frames: number;
  /** Frames at the start / end that belong to a transition, and which transition it is. */
  inFrames: number;
  inType: Transition;
  outFrames: number;
  outType: Transition;
};

export type Plan = { logoFrames: number; clips: PlannedClip[]; totalFrames: number };

/**
 * Lays out every clip on the output frame grid. `transitions[i]` is the transition after clip i.
 * Transition length is capped at half of the shorter neighbouring clip so clips never fully overlap.
 */
export function planTimeline(
  durations: number[],
  transitions: Transition[],
  fps: number,
  logoSeconds: number,
  transitionSeconds: number,
): Plan {
  const logoFrames = Math.max(1, Math.round(logoSeconds * fps));
  const frames = durations.map((d) => Math.max(1, Math.round(d * fps)));
  const clips: PlannedClip[] = frames.map((n) => ({ start: 0, frames: n, inFrames: 0, inType: 'cut', outFrames: 0, outType: 'cut' }));

  let start = logoFrames;
  clips.forEach((clip, i) => {
    clip.start = start;
    const next = clips[i + 1];
    const type = transitions[i] ?? 'cut';
    const length = next && type !== 'cut'
      ? Math.min(Math.round(transitionSeconds * fps), Math.floor(clip.frames / 2), Math.floor(next.frames / 2))
      : 0;

    if (next && length > 0) {
      clip.outType = next.inType = type;
      if (OVERLAPS.has(type)) {
        clip.outFrames = next.inFrames = length;
      } else {
        clip.outFrames = Math.floor(length / 2);
        next.inFrames = length - clip.outFrames;
      }
    }
    start += clip.frames - (OVERLAPS.has(clip.outType) ? clip.outFrames : 0);
  });

  return { logoFrames, clips, totalFrames: start + logoFrames };
}
