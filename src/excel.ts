/**
 * Reads a project "blueprint" workbook (.xlsx / .csv) that describes a whole video — clip order, trims,
 * motion, captions, overlay images, voiceovers and settings — so a project can be built automatically from
 * a spreadsheet plus a folder of media files, with no manual editing. Also generates the matching sample
 * workbook. SheetJS is loaded on demand so it never weighs down the manual editor.
 *
 * The format is deliberately forgiving: header names are matched case-/space-insensitively, unknown values
 * fall back to sensible defaults (recorded in `warnings`), and any sheet may be omitted.
 */

const loadXLSX = () => import('xlsx');

export type BpSettings = {
  outputSize: string; // '960x960' | '1024x1024' | 'WIDTHxHEIGHT'
  logoSeconds: number;
  transition: string;
  transitionSeconds: number;
  frameRate: 'smooth' | 'fast';
  voiceMode: 'whole' | 'per-clip' | 'ranges';
  musicFile: string;
  musicStartOffset: number;
  musicVolume: number;
  clipVolume: number;
  voiceVolume: number;
  watermarkFile: string;
  watermarkX: number;
  watermarkY: number;
  watermarkSize: number;
  downloadCodec: 'auto' | 'av1' | 'hevc' | 'avc';
  targetSizeMB: number;
  fill: 'contain' | 'cover';
};

export type BpClip = {
  order: number;
  file: string;
  photoSeconds?: number;
  trimStart?: number;
  trimEnd?: number;
  motion: string;
  motionSpeed: string;
  transition?: string;
};
export type BpPill = {
  clip: number;
  text: string;
  x: number;
  y: number;
  size: number;
  start: number;
  end: number;
  background: string;
  opacity: number;
  textColor: string;
  font: string;
};
export type BpImage = { clip: number; file: string; x: number; y: number; size: number };
export type BpVoice = {
  mode: 'whole' | 'clip' | 'range';
  clip?: number;
  fromClip?: number;
  toClip?: number;
  file: string;
  trimStart: number;
  trimEnd: number;
  startOffset: number;
};

export type Blueprint = {
  settings: BpSettings;
  clips: BpClip[];
  pills: BpPill[];
  images: BpImage[];
  voices: BpVoice[];
  warnings: string[];
};

const DEFAULT_SETTINGS: BpSettings = {
  outputSize: '960x960',
  logoSeconds: 3,
  transition: 'dissolve',
  transitionSeconds: 0.75,
  frameRate: 'smooth',
  voiceMode: 'whole',
  musicFile: '',
  musicStartOffset: 0,
  musicVolume: 20,
  clipVolume: 100,
  voiceVolume: 100,
  watermarkFile: '',
  watermarkX: 84,
  watermarkY: 14,
  watermarkSize: 18,
  downloadCodec: 'auto',
  targetSizeMB: 5,
  fill: 'contain',
};

const MOTIONS = ['none', 'zoom-in', 'zoom-out', 'zoom-in-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'];
const SPEEDS = ['slow', 'medium', 'fast'];
const TRANSITIONS = ['cut', 'dissolve', 'fade', 'slide', 'wipe'];
const FONTS = ['system', 'helvetica', 'verdana', 'trebuchet', 'georgia', 'times', 'courier', 'impact'];
const CODECS = ['auto', 'av1', 'hevc', 'avc'];

/** Lower-cases and strips spaces/underscores so "Trim Start", "trim_start" and "trimstart" all match. */
const norm = (s: string) => String(s).toLowerCase().replace(/[\s_]+/g, '');

/** Reads a field from a row object by any of the given header names (case/space-insensitive). */
function field(row: Record<string, unknown>, names: string[]): unknown {
  const wanted = names.map(norm);
  for (const key of Object.keys(row)) if (wanted.includes(norm(key))) return row[key];
  return undefined;
}
const asStr = (v: unknown, dflt = '') => (v === undefined || v === null || v === '' ? dflt : String(v).trim());
const asNum = (v: unknown, dflt: number) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : dflt;
};
const asOpt = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};
const oneOf = (v: unknown, allowed: string[], dflt: string, warn: (m: string) => void, what: string) => {
  const s = norm(asStr(v, dflt));
  const hit = allowed.find((a) => norm(a) === s);
  if (!hit && asStr(v)) warn(`${what} "${asStr(v)}" is not recognised — using "${dflt}".`);
  return hit ?? dflt;
};

type Sheet = Record<string, unknown>[];

/** Parses the uploaded workbook into a Blueprint. Throws only if the file itself can't be read as a workbook. */
export async function parseWorkbook(buffer: ArrayBuffer): Promise<Blueprint> {
  const XLSX = await loadXLSX();
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'array' });
  } catch {
    throw new Error('This file could not be read as an Excel/CSV workbook.');
  }
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  let voiceModeSet = false;
  let clipVolumeSet = false;

  const sheet = (names: string[]): Sheet => {
    const name = wb.SheetNames.find((n) => names.map(norm).includes(norm(n)));
    if (!name) return [];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: '' });
  };

  // Settings sheet: a two-column key/value list.
  const settings: BpSettings = { ...DEFAULT_SETTINGS };
  const settingsName = wb.SheetNames.find((n) => norm(n) === norm('Settings'));
  if (settingsName) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[settingsName], { header: 1, defval: '' });
    const map = new Map<string, unknown>();
    for (const r of rows) if (r && r.length >= 2 && asStr(r[0])) map.set(norm(asStr(r[0])), r[1]);
    const get = (names: string[]) => {
      for (const n of names) if (map.has(norm(n))) return map.get(norm(n));
      return undefined;
    };
    settings.outputSize = asStr(get(['OutputSize', 'Output Size', 'Resolution']), settings.outputSize);
    settings.logoSeconds = asNum(get(['LogoSeconds', 'Logo Seconds']), settings.logoSeconds);
    settings.transition = oneOf(get(['Transition']), TRANSITIONS, settings.transition, warn, 'Transition');
    settings.transitionSeconds = asNum(get(['TransitionSeconds', 'Transition Seconds']), settings.transitionSeconds);
    settings.frameRate = (norm(asStr(get(['FrameRate', 'Frame Rate']), settings.frameRate)) === 'fast' ? 'fast' : 'smooth');
    voiceModeSet = asStr(get(['VoiceMode', 'Voice Mode'])) !== '';
    const vm = norm(asStr(get(['VoiceMode', 'Voice Mode']), settings.voiceMode));
    settings.voiceMode = vm === 'perclip' || vm === 'per-clip' ? 'per-clip' : vm === 'ranges' || vm === 'range' ? 'ranges' : 'whole';
    settings.musicFile = asStr(get(['MusicFile', 'Music File', 'Music']));
    settings.musicStartOffset = asNum(get(['MusicStartOffset', 'Music Start Offset', 'MusicOffset']), settings.musicStartOffset);
    settings.musicVolume = asNum(get(['MusicVolume', 'Music Volume']), settings.musicVolume);
    clipVolumeSet = asStr(get(['ClipVolume', 'Clip Volume'])) !== '';
    settings.clipVolume = asNum(get(['ClipVolume', 'Clip Volume']), settings.clipVolume);
    settings.voiceVolume = asNum(get(['VoiceVolume', 'Voice Volume']), settings.voiceVolume);
    const fillStr = norm(asStr(get(['Fill', 'Frame Fill', 'Fit'])));
    if (fillStr) settings.fill = fillStr === 'fill' || fillStr === 'cover' || fillStr === 'crop' ? 'cover' : 'contain';
    settings.watermarkFile = asStr(get(['WatermarkFile', 'Watermark File', 'Watermark', 'Logo', 'LogoFile']));
    settings.watermarkX = asNum(get(['WatermarkX', 'Watermark X']), settings.watermarkX);
    settings.watermarkY = asNum(get(['WatermarkY', 'Watermark Y']), settings.watermarkY);
    settings.watermarkSize = asNum(get(['WatermarkSize', 'Watermark Size']), settings.watermarkSize);
    settings.downloadCodec = oneOf(get(['DownloadCodec', 'Download Codec', 'Codec']), CODECS, settings.downloadCodec, warn, 'DownloadCodec') as BpSettings['downloadCodec'];
    settings.targetSizeMB = asNum(get(['TargetSizeMB', 'Target Size MB', 'TargetMB']), settings.targetSizeMB);
  }

  const clips: BpClip[] = [];
  const pills: BpPill[] = [];
  const images: BpImage[] = [];
  const voices: BpVoice[] = [];

  // Main sheet — "Videos" (or "Clips"): one row per clip. A simple file can stop here: Order, File, Seconds,
  // Caption and Voiceover are enough. The Caption and Voiceover cells are shortcuts that fill the Pills and
  // Voiceovers lists automatically, so most people never need the advanced sheets.
  sheet(['Videos', 'Clips', 'Clip']).forEach((row, i) => {
    const file = asStr(field(row, ['File', 'FileName', 'Video', 'Clip']));
    if (!file) return;
    const order = asNum(field(row, ['Order', 'No', '#', 'Index']), i + 1);
    clips.push({
      order,
      file,
      photoSeconds: asOpt(field(row, ['Seconds', 'PhotoSeconds', 'Photo Seconds', 'Duration'])),
      trimStart: asOpt(field(row, ['TrimStart', 'Trim Start', 'Start'])),
      trimEnd: asOpt(field(row, ['TrimEnd', 'Trim End', 'End'])),
      motion: oneOf(field(row, ['Motion']), MOTIONS, 'none', warn, 'Motion'),
      motionSpeed: oneOf(field(row, ['MotionSpeed', 'Motion Speed', 'Speed']), SPEEDS, 'medium', warn, 'MotionSpeed'),
      transition: asStr(field(row, ['Transition', 'TransitionToNext'])) ? oneOf(field(row, ['Transition', 'TransitionToNext']), TRANSITIONS, settings.transition, warn, 'Transition') : undefined,
    });
    // Inline shortcuts.
    const caption = asStr(field(row, ['Caption', 'Text', 'Pill']));
    if (caption) pills.push({ clip: order, text: caption, x: 50, y: 85, size: 100, start: 0, end: 0, background: '#0f1115', opacity: 72, textColor: '#ffffff', font: 'system' });
    const vo = asStr(field(row, ['Voiceover', 'Voice', 'Narration', 'VO']));
    if (vo) voices.push({ mode: 'clip', clip: order, file: vo, trimStart: 0, trimEnd: 0, startOffset: 0 });
  });
  clips.sort((a, b) => a.order - b.order);

  // Optional "Pills" sheet for full caption control (placement, size, timing, colours).
  sheet(['Pills', 'Captions']).forEach((row) => {
    const text = asStr(field(row, ['Text', 'Caption', 'Pill']));
    const clip = asNum(field(row, ['Clip', 'ClipOrder', 'Clip Order', 'Video', 'Order']), 0);
    if (!text || !clip) return;
    pills.push({
      clip,
      text,
      x: asNum(field(row, ['X', 'PositionX']), 50),
      y: asNum(field(row, ['Y', 'PositionY']), 85),
      size: asNum(field(row, ['Size', 'TextSize']), 100),
      start: asNum(field(row, ['Start', 'Appears', 'AppearsAt']), 0),
      end: asNum(field(row, ['End', 'Hides', 'HidesAt']), 0),
      background: asStr(field(row, ['Background', 'BackgroundColour', 'BackgroundColor', 'BG']), '#0f1115'),
      opacity: asNum(field(row, ['Opacity', 'BackgroundOpacity']), 72),
      textColor: asStr(field(row, ['TextColor', 'TextColour', 'Colour', 'Color']), '#ffffff'),
      font: oneOf(field(row, ['Font']), FONTS, 'system', warn, 'Font'),
    });
  });

  // Optional "Images" sheet for overlay pictures on a clip.
  sheet(['Images', 'Image', 'Pictures', 'Overlays']).forEach((row) => {
    const file = asStr(field(row, ['File', 'FileName', 'Image', 'Picture']));
    const clip = asNum(field(row, ['Clip', 'ClipOrder', 'Clip Order', 'Video', 'Order']), 0);
    if (!file || !clip) return;
    images.push({
      clip,
      file,
      x: asNum(field(row, ['X', 'PositionX']), 75),
      y: asNum(field(row, ['Y', 'PositionY']), 25),
      size: asNum(field(row, ['Size', 'Width']), 25),
    });
  });

  // Optional "Voiceovers" sheet for whole-video or multi-clip (range) narration.
  sheet(['Voiceovers', 'Voiceover', 'Narration']).forEach((row) => {
    const file = asStr(field(row, ['File', 'FileName', 'Voiceover', 'Audio']));
    if (!file) return;
    const m = norm(asStr(field(row, ['Mode', 'Type']), 'whole'));
    const mode: BpVoice['mode'] = m === 'clip' || m === 'perclip' || m === 'per-clip' ? 'clip' : m === 'range' || m === 'ranges' ? 'range' : 'whole';
    voices.push({
      mode,
      clip: asOpt(field(row, ['Clip', 'ClipOrder', 'Clip Order', 'Video'])),
      fromClip: asOpt(field(row, ['FromClip', 'From Clip', 'From', 'StartClip'])),
      toClip: asOpt(field(row, ['ToClip', 'To Clip', 'To', 'EndClip'])),
      file,
      trimStart: asNum(field(row, ['TrimStart', 'Trim Start', 'From(s)', 'AudioStart']), 0),
      trimEnd: asNum(field(row, ['TrimEnd', 'Trim End', 'To(s)', 'AudioEnd']), 0),
      startOffset: asNum(field(row, ['StartOffset', 'Start Offset', 'StartsAt', 'Offset']), 0),
    });
  });

  // If the sheet didn't say which voice mode, work it out from the rows: range beats per-clip beats whole.
  if (!voiceModeSet) {
    settings.voiceMode = voices.some((v) => v.mode === 'range') ? 'ranges' : voices.some((v) => v.mode === 'clip') ? 'per-clip' : 'whole';
  }
  // With narration and no explicit ClipVolume, mute the clips' own sound so voiceovers aren't muddied by it.
  if (!clipVolumeSet && voices.length) {
    settings.clipVolume = 0;
    warn('Clip audio was muted so the voiceovers stay clear. Add a ClipVolume setting if you want the clips’ own sound.');
  }

  if (!clips.length) warn('No clips were found. Add rows to the "Videos" sheet with at least a File for each.');
  return { settings, clips, pills, images, voices, warnings };
}

/** Builds the sample/template workbook as a .xlsx Blob — the exact format `parseWorkbook` reads. */
export async function sampleWorkbookBlob(): Promise<Blob> {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();

  // The whole simple format is ONE sheet. Fill it, upload this file and your media, and you're done.
  const videos = [
    ['Order', 'File', 'Seconds', 'Caption', 'Voiceover'],
    [1, 'clip1.mp4', '', 'Fresh dough, made every morning', 'clip1_voice.mp3'],
    [2, 'photo1.jpg', 4, 'Since 1998', ''],
    [3, 'clip2.mp4', '', 'Order online today', 'clip2_voice.mp3'],
  ];
  const videosSheet = XLSX.utils.aoa_to_sheet(videos);
  videosSheet['!cols'] = [{ wch: 7 }, { wch: 18 }, { wch: 9 }, { wch: 34 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, videosSheet, 'Videos');

  const instructions = [
    ['Roothoot Video Editor — template'],
    [''],
    ['THE SIMPLE WAY (just the "Videos" sheet):'],
    ['  Order     : play order (1, 2, 3 …)'],
    ['  File      : the video or photo file name (must match a file you upload)'],
    ['  Seconds   : for PHOTOS only — how long to show it (leave blank for videos)'],
    ['  Caption   : optional text shown near the bottom of that clip (leave blank for none)'],
    ['  Voiceover : optional narration file that plays over that clip (leave blank for none)'],
    [''],
    ['Then in the app: choose "Add Excel and files", upload this file, and add all your media'],
    ['(videos, photos, voiceover audio, music, logo). You can add files from different folders and'],
    ['add more at any time. Press "Build the video" and everything is filled in for you.'],
    [''],
    ['Leave anything blank to use a sensible default (square 960x960 output, 3s logo, dissolve between clips).'],
    [''],
    ['TIPS for a clean result:'],
    ['  - Fill: in Settings use Fill = fill so non-square clips crop to fill the frame instead of showing black bars.'],
    ['  - Voiceovers: when you use them, the clips’ own sound is muted automatically so voices stay clear.'],
    ['  - To stop two voices overlapping where clips cross-fade, add a Transition column to the Videos sheet and set it to: cut'],
    ['  - Captions sit centre-bottom by default. For exact placement/size/timing, use the optional Pills sheet below.'],
    [''],
    ['OPTIONAL — only if you want more control, add any of these extra sheets (all optional):'],
    ['  Settings   : OutputSize (e.g. 1024x1024), Fill, ClipVolume, MusicFile, WatermarkFile, and more.'],
    ['  Pills      : full caption control — Clip, Text, X, Y (%), Size (%), Start, End (seconds), colours, Font.'],
    ['  Images     : overlay pictures / your own text-pill PNGs — Clip, File, X, Y, Size (%).'],
    ['  Voiceovers : one voice across several clips — Mode=range, FromClip, ToClip, File.'],
    ['You can also add TrimStart / TrimEnd / Transition / Motion columns to the Videos sheet per clip.'],
    ['Column names are not case-sensitive, and spaces are ignored.'],
  ];
  const insSheet = XLSX.utils.aoa_to_sheet(instructions);
  insSheet['!cols'] = [{ wch: 95 }];
  XLSX.utils.book_append_sheet(wb, insSheet, 'Instructions');

  // A small, commented Settings sheet people can edit or delete entirely.
  const settings = [
    ['Setting', 'Value', 'Notes'],
    ['OutputSize', '1024x1024', '960x960, 1024x1024, or any WIDTHxHEIGHT'],
    ['Fill', 'fill', 'fill = crop clips to fill the frame (no black bars); fit = letterbox (keep whole frame)'],
    ['ClipVolume', '', 'volume of the clips’ own sound, 0–100 (left blank = muted automatically when voiceovers are used)'],
    ['MusicFile', '', 'background music file name (optional)'],
    ['WatermarkFile', '', 'logo shown on every clip (optional)'],
    ['WatermarkX', 84, 'logo position across, % (0 left … 100 right)'],
    ['WatermarkY', 14, 'logo position down, % (0 top … 100 bottom)'],
    ['WatermarkSize', 18, 'logo width, % of the frame'],
    ['TargetSizeMB', 5, 'smaller-file download budget: 2 (mobile) or 5 (desktop)'],
  ];
  const setSheet = XLSX.utils.aoa_to_sheet(settings);
  setSheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 46 }];
  XLSX.utils.book_append_sheet(wb, setSheet, 'Settings');

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
