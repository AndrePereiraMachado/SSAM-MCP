// Icons (docs/PROTOTIPO-NATIVO.md 2.9): after the prototype's own script draws them (lucide.createIcons), each
// <svg class="lucide lucide-<name>"> is annotated icon:{name, strokeWidth, from} with the effective stroke-width (the
// winning prototype rule outside @media, else the attribute). The IR keeps the SVG of each name once and the default
// stroke width (the most frequent one). An icon counts as one element, never its paths. Native substitute tag: span.
import { walk, isElement } from './ir.mjs';

export function iconInstances(trees) {
  const out = [];
  for (const tree of trees) walk(tree, node => { if (isElement(node) && node.icon) out.push(node.icon); });
  return out;
}

export function defaultStrokeWidth(instances) {
  const counts = new Map();
  for (const icon of instances) if (icon.strokeWidth != null) counts.set(icon.strokeWidth, (counts.get(icon.strokeWidth) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0]?.[0] ?? null;
}

export function iconSet(svgByName, instances, names = null) {
  const used = names ?? [...new Set(instances.map(icon => icon.name))];
  const set = {};
  for (const name of [...used].sort()) if (svgByName.has(name)) set[name] = svgByName.get(name);
  return {
    library: used.length ? 'lucide' : null,
    defaultStrokeWidth: defaultStrokeWidth(instances),
    tag: 'span',
    set
  };
}

export function iconClass(name, strokeWidth, defaultWidth) {
  return strokeWidth == null || strokeWidth === defaultWidth ? 'ssam-icon-' + name : 'ssam-icon-' + name + '-w' + Math.round(strokeWidth * 100);
}
