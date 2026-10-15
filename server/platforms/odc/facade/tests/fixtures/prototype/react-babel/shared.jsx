// shared.jsx: tokens and the steps of a work day (a constant list the screens show, never written)
var TOK = { green: '#1FB57A', ink: '#0F1A14', paper: '#FAFAF6' };
var STEPS = [
  { id: 'in', label: 'Entrada', plan: 540 },
  { id: 'lunch', label: 'Saída almoço', plan: 720 },
  { id: 'back', label: 'Retorno', plan: 780 },
  { id: 'out', label: 'Saída', plan: 1080 }
];
var FIBER = '__reactFiber$fx02', PROPS = '__reactProps$fx02';
// h(component, tag, props, ...children): an element whose fiber names the component that rendered it (as React does)
function h(component, tag, props) {
  var children = Array.prototype.slice.call(arguments, 3);
  return { component: component, tag: tag, props: props || {}, children: children };
}
function mount(node) {
  if (node === null || node === false || node === undefined) return null;
  if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
  if (Array.isArray(node)) { var fragment = document.createDocumentFragment(); node.forEach(function (item) { var kid = mount(item); if (kid) fragment.appendChild(kid); }); return fragment; }
  var svg = node.tag === 'svg' || node.tag === 'rect';
  var element = svg ? document.createElementNS('http://www.w3.org/2000/svg', node.tag) : document.createElement(node.tag);
  Object.keys(node.props).forEach(function (name) {
    if (/^on[A-Z]/.test(name)) return;
    if (name === 'style') { Object.keys(node.props.style).forEach(function (key) { element.style[key] = node.props.style[key]; }); return; }
    element.setAttribute(name, node.props[name]);
  });
  element[PROPS] = node.props;
  element[FIBER] = { type: node.tag, return: node.component ? { type: node.component, return: null } : null };
  node.children.forEach(function (child) { var kid = mount(child); if (kid) element.appendChild(kid); });
  return element;
}
