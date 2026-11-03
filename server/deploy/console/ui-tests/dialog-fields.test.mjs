import test from 'node:test';
import assert from 'node:assert/strict';
import { pub } from './helpers.mjs';

// Minimal DOM for exercising the real dialog tree and event handlers without a browser.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.dataset = {}; this.value = ''; }
  append(...items) { for (const item of items) { if (typeof item === 'object') item.parent = this; this.children.push(item); } }
  before(item) { this.parent.children.splice(this.parent.children.indexOf(this), 0, item); item.parent = this.parent; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'value') this.value = v; }
  addEventListener(k, fn) { (this.events[k] ??= []).push(fn); }
  fire(k) { for (const fn of this.events[k] ?? []) fn({ preventDefault() {} }); }
  get firstChild() { return this.children[0]; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  focus() {}
  showModal() { this.open = true; }
}
const descendants = node => [node, ...(node.children ?? []).flatMap(descendants)];

test('quota dialog exposes its own numeric field, validates bounds and reaches confirmation', async () => {
  const priorNode = globalThis.Node, priorDocument = globalThis.document;
  const dlg = new Element('dialog');
  globalThis.Node = Element;
  globalThis.document = { getElementById: () => dlg, createElement: t => new Element(t), createElementNS: (_, t) => new Element(t), createTextNode: text => ({ text }) };
  try {
    const { createDialogs } = await import(pub('js/dialogs.js'));
    createDialogs({}).quota(null, { customer: 'Synthetic', quotaGiB: null });
    const find = predicate => descendants(dlg).find(predicate);
    const own = find(n => n.attrs?.['aria-label'] === 'Cota própria em GiB');
    assert.ok(own, 'the numeric field must be attached to the visible dialog');
    assert.equal(own.attrs.min, '1'); assert.equal(own.attrs.max, '1024');
    const radio = find(n => n.attrs?.type === 'radio' && n.value === 'propria');
    for (const n of descendants(dlg)) if (n.attrs?.type === 'radio') n.checked = n === radio;
    radio.fire('change');
    for (const invalid of ['', '0', '1.5', '1025']) {
      own.value = invalid; own.fire('input'); find(n => n.tag === 'form').fire('submit');
      assert.equal(find(n => n.attrs?.role === 'alert').hidden, false);
    }
    own.value = '20'; own.fire('input'); find(n => n.tag === 'form').fire('submit');
    assert.ok(find(n => n.attrs?.autocomplete === 'off'), 'valid quota reaches the typed confirmation');
    createDialogs({ clock: { now: () => Date.parse('2026-11-03T00:00:00Z') } }).renew(null, { customer: 'Synthetic', expiresAt: '2026-12-01T00:00:00Z' });
    assert.ok(find(n => n.attrs?.['aria-label'] === 'Outro: dias'), 'renewal retains its custom numeric field');
  } finally { globalThis.Node = priorNode; globalThis.document = priorDocument; }
});
