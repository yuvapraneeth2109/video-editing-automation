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
    const vm = norm(asStr(get(['VoiceMode', 'Voice Mode']), settings.voiceMode));
    settings.voiceMode = vm === 'perclip' || vm === 'per-clip' ? 'per-clip' : vm === 'ranges' || vm === 'range' ? 'ranges' : 'whole';
    settings.musicFile = asStr(get(['MusicFile', 'Music File', 'Music']));
    settings.musicStartOffset = asNum(get(['MusicStartOffset', 'Music Start Offset', 'MusicOffset']), settings.musicStartOffset);
    settings.musicVolume = asNum(get(['MusicVolume', 'Music Volume']), settings.musicVolume);
    settings.clipVolume = asNum(get(['ClipVolume', 'Clip Volume']), settings.clipVolume);
    settings.voiceVolume = asNum(get(['VoiceVolume', 'Voice Volume']), settings.voiceVolume);
    settings.watermarkFile = asStr(get(['WatermarkFile', 'Watermark File', 'Watermark', 'Logo', 'LogoFile']));
    settings.watermarkX = asNum(get(['WatermarkX', 'Watermark X']), settings.watermarkX);
    settings.watermarkY = asNum(get(['WatermarkY', 'Watermark Y']), settings.watermarkY);
    settings.watermarkSize = asNum(get(['WatermarkSize', 'Watermark Size']), settings.watermarkSize);
    settings.downloadCodec = oneOf(get(['DownloadCodec', 'Download Codec', 'Codec']), CODECS, settings.downloadCodec, warn, 'DownloadCodec') as BpSettings['downloadCodec'];
    settings.targetSizeMB = asNum(get(['TargetSizeMB', 'Target Size MB', 'TargetMB']), settings.targetSizeMB);
  }

  // Clips sheet.
  const clips: BpClip[] = [];
  sheet(['Clips', 'Clip', 'Videos']).forEach((row, i) => {
    const file = asStr(field(row, ['File', 'FileName', 'Video', 'Clip']));
    if (!file) return;
    clips.push({
      order: asNum(field(row, ['Order', 'No', '#', 'Index']), i + 1),
      file,
      photoSeconds: asOpt(field(row, ['PhotoSeconds', 'Photo Seconds', 'Seconds', 'Duration'])),
      trimStart: asOpt(field(row, ['TrimStart', 'Trim Start', 'Start'])),
      trimEnd: asOpt(field(row, ['TrimEnd', 'Trim End', 'End'])),
      motion: oneOf(field(row, ['Motion']), MOTIONS, 'none', warn, 'Motion'),
      motionSpeed: oneOf(field(row, ['MotionSpeed', 'Motion Speed', 'Speed']), SPEEDS, 'medium', warn, 'MotionSpeed'),
      transition: asStr(field(row, ['Transition', 'TransitionToNext'])) ? oneOf(field(row, ['Transition', 'TransitionToNext']), TRANSITIONS, settings.transition, warn, 'Transition') : undefined,
    });
  });
  clips.sort((a, b) => a.order - b.order);

  // Pills sheet.
  const pills: BpPill[] = [];
  sheet(['Pills', 'Pill', 'Captions', 'Text']).forEach((row) => {
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

  // Images sheet.
  const images: BpImage[] = [];
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

  // Voiceovers sheet.
  const voices: BpVoice[] = [];
  sheet(['Voiceovers', 'Voiceover', 'Voice', 'Narration']).forEach((row) => {
    const file = asStr(field(row, ['File', 'FileName', 'Voiceover', 'Audio']));
    if (!file) return;
    const m = norm(asStr(field(row, ['Mode', 'Type']), settings.voiceMode));
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

  if (!clips.length) warn('No clips were found. Add rows to the "Clips" sheet with at least a File for each.');
  return { settings, clips, pills, images, voices, warnings };
}

/** Builds the sample/template workbook as a .xlsx Blob — the exact format `parseWorkbook` reads. */
export async function sampleWorkbookBlob(): Promise<Blob> {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();

  const instructions = [
    ['Roothoot Video Editor — automation template'],
    [''],
    ['Fill in the sheets below, then in the app choose "Add Excel and files", upload this file in the first box'],
    ['and ALL your media (videos, photos, audio, logo) in the second box. File names here must match exactly.'],
    [''],
    ['Clips sheet    : one row per video/photo, in play order (Order). Photos use PhotoSeconds. Videos can set TrimStart/TrimEnd.'],
    ['Pills sheet    : one row per caption. Clip = the clip Order it sits on. X/Y/Size are %. Start/End are seconds into the clip (End 0 = until the clip ends).'],
    ['Images sheet   : one row per overlay picture. Clip = clip Order. X/Y/Size are %.'],
    ['Voiceovers     : Mode = whole (one file for the video), clip (Clip = order), or range (FromClip..ToClip). TrimStart/TrimEnd cut the audio; StartOffset delays it (seconds).'],
    ['Settings sheet : OutputSize like 960x960 or 1024x1024 or 1080x1350. Watermark = your logo file + position %. Music optional.'],
    [''],
    ['Anything left blank uses a sensible default. Motion: none, zoom-in, zoom-out, zoom-in-out, pan-left, pan-right, pan-up, pan-down.'],
    ['Transition: cut, dissolve, fade, slide, wipe. Font: system, helvetica, verdana, trebuchet, georgia, times, courier, impact. Codec: auto, av1, hevc, avc.'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');

  const clips = [
    ['Order', 'File', 'PhotoSeconds', 'TrimStart', 'TrimEnd', 'Motion', 'MotionSpeed', 'Transition'],
    [1, 'clip1.mp4', '', 0, 6, 'zoom-in', 'medium', 'dissolve'],
    [2, 'photo1.jpg', 4, '', '', 'pan-left', 'slow', 'dissolve'],
    [3, 'clip2.mp4', '', 1.5, 10, 'none', 'medium', 'cut'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(clips), 'Clips');

  const pills = [
    ['Clip', 'Text', 'X', 'Y', 'Size', 'Start', 'End', 'Background', 'Opacity', 'TextColor', 'Font'],
    [1, 'Fresh dough, made every morning', 50, 85, 100, 0, 0, '#0f1115', 72, '#ffffff', 'system'],
    [1, 'Since 1998', 50, 15, 80, 2, 5, '#0f1115', 60, '#ffd54a', 'impact'],
    [3, 'Order online today', 50, 85, 120, 1, 0, '#0f1115', 72, '#ffffff', 'helvetica'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pills), 'Pills');

  const images = [
    ['Clip', 'File', 'X', 'Y', 'Size'],
    [2, 'badge.png', 80, 20, 22],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(images), 'Images');

  const voices = [
    ['Mode', 'Clip', 'FromClip', 'ToClip', 'File', 'TrimStart', 'TrimEnd', 'StartOffset'],
    ['range', '', 1, 2, 'intro_vo.mp3', 0, 0, 0],
    ['clip', 3, '', '', 'clip3_vo.mp3', 0.5, 0, 0.5],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(voices), 'Voiceovers');

  const settings = [
    ['Setting', 'Value'],
    ['OutputSize', '1024x1024'],
    ['LogoSeconds', 3],
    ['Transition', 'dissolve'],
    ['TransitionSeconds', 0.75],
    ['FrameRate', 'smooth'],
    ['VoiceMode', 'range'],
    ['MusicFile', 'music.mp3'],
    ['MusicStartOffset', 0],
    ['MusicVolume', 20],
    ['ClipVolume', 100],
    ['VoiceVolume', 100],
    ['WatermarkFile', 'logo.png'],
    ['WatermarkX', 84],
    ['WatermarkY', 14],
    ['WatermarkSize', 18],
    ['DownloadCodec', 'auto'],
    ['TargetSizeMB', 5],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(settings), 'Settings');

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
