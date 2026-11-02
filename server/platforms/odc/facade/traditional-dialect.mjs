// C-13 (F-FT-02, -15, -16, -21, -27; 27/10): the Traditional dialect of ssam-html/1, generated from the kernel's own table
// (TraditionalDocumentRules.AttributesOf, the allowlist its Check reads; exported to catalog/traditional-dialect.json and held
// equal by kernel/tests/Anvil.Tests/TraditionalDialectTests.cs). The grammar card of a Traditional module and the work packet
// serve these lines: the dialect was learned from 35 and 67 refusals before.
import fs from 'node:fs';

let cached;
/** The dialect as the kernel exports it, or null when the catalog file is missing. */
export function traditionalDialect() {
  if (cached !== undefined) return cached;
  try { cached = JSON.parse(fs.readFileSync(new URL('./catalog/traditional-dialect.json', import.meta.url), 'utf8')); } catch { cached = null; }
  return cached;
}

/** The rules of the Traditional card: the tags with their attributes, the adapted HTML, what has no widget, the enums. */
export function traditionalDialectRules() {
  const d = traditionalDialect();
  if (!d) return [];
  const tags = Object.entries(d.tags).map(([tag, row]) => `<${tag}> ${row.attributes.join(' ')}`).join('; ');
  const adapted = Object.entries(d.adapted).map(([from, to]) => `${from} -> ${to}`).join(', ');
  const none = Object.keys(d.noWidget).join(', ');
  return [
    `Root: <screen> or <block> with ${d.root.attributes.join(', ')}; layout="blank" is the screen without the template's layout block (its content at the root), "theme" (the default) puts the content in the layout's MainContent. Direct children: <var ${d.data.attributes.join(' ')}>, <input name type mandatory> (a parameter), <style> (the root's CSS), then the widgets.`,
    `Tags and their attributes (every widget also takes k, os-<Property>, ext:<name> and plain names as extended properties): ${tags}.`,
    `method ${d.method.join('|')} (Ajax = Ajax Submit: the page stays; Navigate for a screen or a URL); validation ${d.validation.join('|')}; line-separator ${d.lineSeparator.join('|')} (list-records and div list). A condition is <div if="..."> ... <div else> ...; a dynamic class is ext:class="{{ expression }}" (class and style are literal); a list inside a list's row is a block with the list at its root.`,
    `Written as their Traditional widget (listed in migration.adapted): ${adapted}.`,
    `No Traditional widget (refused with what to write): ${none}.`,
  ];
}
