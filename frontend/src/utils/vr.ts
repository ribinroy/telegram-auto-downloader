// How a video should be shown: flat, or wrapped onto a 180°/360° sphere, with
// the two eyes of a stereo file side by side (left eye left) or top/bottom
// (left eye top). Guessed from the filename tags VR files carry
// (`_180_sbs`, `_LR`, `_360`, `_TB`, `MKX200`, ...), the aspect ratio only
// settling the layout once the name says it is VR at all - a square video
// with no tags is an Instagram clip, not a 180° mono film.
export type Layout = 'flat' | '180' | '360';
export type Stereo = 'mono' | 'sbs' | 'tb';
export type Projection = 'flat' | `${Exclude<Layout, 'flat'>}-${Stereo}`;

export const PROJECTIONS: { value: Projection; label: string }[] = [
  { value: 'flat', label: 'Flat' },
  { value: '180-mono', label: '180° mono' },
  { value: '180-sbs', label: '180° side by side' },
  { value: '180-tb', label: '180° top/bottom' },
  { value: '360-mono', label: '360° mono' },
  { value: '360-sbs', label: '360° side by side' },
  { value: '360-tb', label: '360° top/bottom' },
];

export const isProjection = (v: unknown): v is Projection =>
  PROJECTIONS.some(p => p.value === v);

export function splitProjection(p: Projection): { layout: Layout; stereo: Stereo } {
  if (p === 'flat') return { layout: 'flat', stereo: 'mono' };
  const [layout, stereo] = p.split('-') as [Layout, Stereo];
  return { layout, stereo };
}

// Fisheye lenses (MKX200/220, RF52, VRCA220, FISHEYE190) aren't equirectangular,
// but a 180° equirect wrap is the closest a plain sphere gets and is what you
// want to see before you reach for a dedicated player.
const TAG_180 = /(?:^|[^a-z0-9])(?:180|vr180|mkx2[02]0|rf52|vrca220|fisheye(?:190)?|f180)(?=$|[^a-z0-9])/i;
const TAG_360 = /(?:^|[^a-z0-9])(?:360|vr360)(?=$|[^a-z0-9])/i;
const TAG_VR = /(?:^|[^a-z0-9])(?:vr|3d)(?=$|[^a-z0-9])/i;
const TAG_SBS = /(?:^|[^a-z0-9])(?:sbs|lr|3dh|hsbs|half-sbs)(?=$|[^a-z0-9])/i;
const TAG_TB = /(?:^|[^a-z0-9])(?:tb|ou|3dv|htb|hou|top-bottom)(?=$|[^a-z0-9])/i;
const TAG_MONO = /(?:^|[^a-z0-9])(?:mono|2d)(?=$|[^a-z0-9])/i;

const near = (a: number, b: number) => Math.abs(a - b) / b < 0.12;

/**
 * Guess a projection from the filename (basename is enough; a path works too)
 * and, when known, the video's width/height ratio.
 */
export function detectProjection(name: string, aspect?: number): Projection {
  const base = name.split('/').pop() ?? name;
  const stem = base.replace(/\.[a-z0-9]{2,4}$/i, '');

  let layout: Layout | null = null;
  if (TAG_180.test(stem)) layout = '180';
  else if (TAG_360.test(stem)) layout = '360';

  let stereo: Stereo | null = null;
  if (TAG_SBS.test(stem)) stereo = 'sbs';
  else if (TAG_TB.test(stem)) stereo = 'tb';
  else if (TAG_MONO.test(stem)) stereo = 'mono';

  if (!layout) {
    if (!TAG_VR.test(stem) && !stereo) return 'flat';
    // "VR" or a stereo tag alone: nearly always a 180° file. A 4:1 frame is
    // the one shape that can only be a 360° side-by-side.
    layout = aspect && near(aspect, 4) ? '360' : '180';
  }

  if (!stereo) {
    if (aspect) {
      if (layout === '180') stereo = near(aspect, 2) ? 'sbs' : near(aspect, 0.5) ? 'tb' : 'mono';
      else stereo = near(aspect, 4) ? 'sbs' : near(aspect, 1) ? 'tb' : 'mono';
    } else {
      // No size yet: 180° files are overwhelmingly side by side, 360° mono.
      stereo = layout === '180' ? 'sbs' : 'mono';
    }
  }
  return `${layout}-${stereo}`;
}

// A manual pick is remembered per filename, so a file whose name lies about
// its layout doesn't have to be fixed on every play.
const KEY = 'downlee:projection:';

export function recallProjection(name: string): Projection | null {
  try {
    const v = localStorage.getItem(KEY + name);
    return isProjection(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberProjection(name: string, projection: Projection | null) {
  try {
    if (projection) localStorage.setItem(KEY + name, projection);
    else localStorage.removeItem(KEY + name);
  } catch {
    // private window / blocked storage: a forgotten pick is the only cost
  }
}

/**
 * Size of a flat video plane that fills the camera's view at `distance`
 * without cropping: the plane keeps the video's aspect ratio and touches
 * either the top and bottom or the left and right of the viewport,
 * whichever comes first - `object-fit: contain`, in world units.
 */
export function fitFlatPlane(fovDeg: number, distance: number, viewAspect: number, videoAspect: number): { width: number; height: number } {
  const visH = 2 * distance * Math.tan((fovDeg * Math.PI) / 360);
  const visW = visH * viewAspect;
  const aspect = videoAspect > 0 ? videoAspect : 16 / 9;
  if (aspect > viewAspect) return { width: visW, height: visW / aspect };
  return { width: visH * aspect, height: visH };
}

/** Break subtitle text into lines that fit `maxChars`, keeping explicit breaks. */
export function wrapSubtitle(text: string, maxChars = 42): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (next.length > maxChars && line) {
        out.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
