// Icons of the owner console (SPEC painel v2, section 6): one closed list of hand-authored 20 x 20 stroke shapes, built
// with createElementNS from constant geometry only (no data ever reaches an icon). Color comes from `color` of the parent
// (CSS: .ico strokes with currentColor; the `f` shapes fill with it). Unknown names throw, so the list stays closed.

const NS = 'http://www.w3.org/2000/svg';

// ['p', d] path · ['c', cx, cy, r] circle · ['r', x, y, w, h, rx] rect; a trailing 'f' fills the shape instead of stroking.
const CAL = [['r', 3, 4.5, 14, 12.5, 2], ['p', 'M3 8.5h14M7 2.5v4M13 2.5v4']];
const BELL = 'M5 13.5h10l-1.5-2V8.5a3.5 3.5 0 0 0-7 0v3zM8.5 16.5h3';
const VPS = [['r', 3, 3.5, 14, 5.5, 1.5], ['r', 3, 11, 14, 5.5, 1.5], ['p', 'M9 6.25h5M9 13.75h5'], ['c', 6, 6.25, 0.9, 'f'], ['c', 6, 13.75, 0.9, 'f']];

const ICONS = {
  brand: [['p', 'M3 4.5h14M3 8.5h14M3 12.5h14M3 16.5h14M7 4.5v12']],
  visao: [['r', 3, 3, 6, 8, 1.5], ['r', 11, 3, 6, 5, 1.5], ['r', 11, 10, 6, 7, 1.5], ['r', 3, 13, 6, 4, 1.5]],
  licencas: [['c', 7, 13, 3.5], ['p', 'M9.5 10.5L16.5 3.5M14 6l2 2M12 8l1.5 1.5']],
  uso: [['p', 'M3 17h14M6 14V9M10 14V5M14 14v-3']],
  qualidade: [['c', 10, 10, 7], ['c', 10, 10, 3.5], ['c', 10, 10, 1, 'f']],
  agentes: [['p', 'M7 3v4M13 3v4M5 7h10v2.5a5 5 0 0 1-10 0zM10 14.5V17']],
  vps: VPS,
  server: VPS,
  eventos: [['p', 'M2.5 10h3l2-5 4 10 2-5h4']],
  historico: [['p', 'M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.2 3.5v3h3M10 6.5V10l2.5 1.5']],
  keyboard: [['r', 2.5, 5, 15, 10, 2], ['p', 'M5.5 8h1M8.5 8h1M11.5 8h1M14 8h.5M6.5 12h7']],
  sun: [['c', 10, 10, 3], ['p', 'M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1 1M14.3 14.3l1 1M4.7 15.3l1-1M14.3 5.7l1-1']],
  moon: [['p', 'M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5z']],
  'theme-auto': [['c', 10, 10, 7], ['p', 'M10 3a7 7 0 0 1 0 14z', 'f']],
  refresh: [['p', 'M16 4.5v4h-4M15.6 8.5A6 6 0 1 0 16 11.5']],
  radar: [['c', 10, 10, 7], ['c', 10, 10, 3.5], ['p', 'M10 10l4.5-4.5']],
  bolt: [['p', 'M11 2.5L4.5 11h5l-1 6.5L15 9h-5z']],
  clock: [['c', 10, 10, 7], ['p', 'M10 6v4l2.5 1.5']],
  'check-circle': [['c', 10, 10, 7], ['p', 'M7 10.2l2 2 4-4.5']],
  'alert-triangle': [['p', 'M10 3l7.5 13h-15zM10 8v3.5'], ['c', 10, 14, 0.9, 'f']],
  'alert-octagon': [['p', 'M7 2.8h6l4.2 4.2v6L13 17.2H7L2.8 13V7zM10 6.5v4'], ['c', 10, 13.5, 0.9, 'f']],
  info: [['c', 10, 10, 7], ['p', 'M10 9v4.5'], ['c', 10, 6.5, 0.9, 'f']],
  help: [['c', 10, 10, 7], ['p', 'M8 8a2 2 0 1 1 2.8 1.8c-.5.2-.8.7-.8 1.2v.5'], ['c', 10, 14, 0.9, 'f']],
  cpu: [['r', 5.5, 5.5, 9, 9, 1.5], ['r', 8, 8, 4, 4, 0.5], ['p', 'M8 2.5v3M12 2.5v3M8 14.5v3M12 14.5v3M2.5 8h3M2.5 12h3M14.5 8h3M14.5 12h3']],
  disk: [['r', 2.5, 11, 15, 5.5, 1.5], ['p', 'M2.5 11.5L5 4.5h10l2.5 7'], ['c', 14, 13.75, 0.9, 'f']],
  network: [['p', 'M7 16.5v-13M4 6.5l3-3 3 3M13 3.5v13M10 13.5l3 3 3-3']],
  load: [['p', 'M3.5 14a7 7 0 1 1 13 0M10 13l3-4']],
  container: [['p', 'M10 2.8l7 3.7v7L10 17.2 3 13.5v-7zM3 6.5l7 3.7 7-3.7M10 10.2V17.2']],
  backup: [['r', 2.5, 3.5, 15, 4, 1], ['p', 'M4 7.5v8A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-8M8 11h4']],
  lock: [['r', 4, 9, 12, 8.5, 2], ['p', 'M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9']],
  shield: [['p', 'M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z']],
  update: [['c', 10, 10, 7], ['p', 'M10 13.5v-7M7 9.5l3-3 3 3']],
  session: [['r', 2.5, 3.5, 15, 13, 2], ['p', 'M6 8l2.5 2L6 12M10.5 12.5H14']],
  'x-circle': [['c', 10, 10, 7], ['p', 'M7.5 7.5l5 5M12.5 7.5l-5 5']],
  ban: [['c', 10, 10, 7], ['p', 'M5 5l10 10']],
  timer: [['c', 10, 11, 6.5], ['p', 'M10 11V7.5M8 2.5h4']],
  wrench: [['p', 'M12.5 3.5a4 4 0 0 0-4.6 5.4L3.5 13.3a1.6 1.6 0 0 0 2.2 2.2l4.4-4.4a4 4 0 0 0 5.4-4.6l-2.3 2.3-2-.5-.5-2z']],
  layers: [['p', 'M10 3l7 3.5-7 3.5-7-3.5zM3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5']],
  loop: [['p', 'M4 8.5v-1A2.5 2.5 0 0 1 6.5 5H16M13.5 2.5L16 5l-2.5 2.5M16 11.5v1a2.5 2.5 0 0 1-2.5 2.5H4M6.5 17.5L4 15l2.5-2.5']],
  calendar: CAL,
  'calendar-plus': [...CAL, ['p', 'M10 11v4M8 13h4']],
  'key-rotate': [['c', 7, 13, 3.5], ['p', 'M9.5 10.5l5-5M13 3.5h3v3']],
  bell: [['p', BELL]],
  'bell-off': [['p', BELL], ['p', 'M3 3l14 14']],
  eye: [['p', 'M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z'], ['c', 10, 10, 2.5]],
  'arrow-right': [['p', 'M4 10h12M11.5 5.5L16 10l-4.5 4.5']],
  'chevron-right': [['p', 'M8 5l5 5-5 5']],
  'chevron-down': [['p', 'M5 8l5 5 5-5']],
  plus: [['p', 'M10 4v12M4 10h12']],
  download: [['p', 'M10 3v9.5M6.5 9l3.5 3.5L13.5 9M3.5 14.5v1A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5v-1']],
  search: [['c', 9, 9, 5.5], ['p', 'M13 13l4 4']],
  pause: [['p', 'M7 4.5v11M13 4.5v11']],
  play: [['p', 'M6.5 4.5v11l9-5.5z']],
  copy: [['r', 7, 7, 10, 10, 2], ['p', 'M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7']],
  x: [['p', 'M5 5l10 10M15 5L5 15']],
};

/** The closed list of icon names. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** Shapes of one icon (pure, unit-tested); throws on an unknown name. */
export function iconShapes(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(ICONS, name)) throw new Error(`ícone desconhecido: ${name}`);
  return ICONS[name];
}

/** SVG element of an icon: aria-hidden, sized by width/height (14, 16, 18 or 20), stroke = currentColor. */
export function icon(name, size = 20) {
  const shapes = iconShapes(name);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `ico ico-${name}`);
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  for (const s of shapes) {
    let el;
    if (s[0] === 'p') {
      el = document.createElementNS(NS, 'path');
      el.setAttribute('d', s[1]);
    } else if (s[0] === 'c') {
      el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', String(s[1]));
      el.setAttribute('cy', String(s[2]));
      el.setAttribute('r', String(s[3]));
    } else {
      el = document.createElementNS(NS, 'rect');
      el.setAttribute('x', String(s[1]));
      el.setAttribute('y', String(s[2]));
      el.setAttribute('width', String(s[3]));
      el.setAttribute('height', String(s[4]));
      el.setAttribute('rx', String(s[5]));
    }
    if (s[s.length - 1] === 'f') el.setAttribute('class', 'f');
    svg.append(el);
  }
  return svg;
}
