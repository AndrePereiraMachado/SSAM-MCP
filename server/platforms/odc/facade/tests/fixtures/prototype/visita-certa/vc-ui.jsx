// vc-ui.jsx: a React stand-in (elements carry the fiber of the component that rendered them, as React does), the line icons
// of the prototype (an inline style that paints nothing, an outlined and a filled star of the same path) and a portal.
var FIBER = '__reactFiber$vc01', PROPS = '__reactProps$vc01';
function h(component, tag, props) {
  var children = Array.prototype.slice.call(arguments, 3);
  return { component: component, tag: tag, props: props || {}, children: children };
}
function mount(node, owner) {
  if (node === null || node === false || node === undefined) return null;
  if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
  if (Array.isArray(node)) { var fragment = document.createDocumentFragment(); node.forEach(function (item) { var kid = mount(item, owner); if (kid) fragment.appendChild(kid); }); return fragment; }
  var svg = node.tag === 'svg' || node.tag === 'path' || node.tag === 'circle';
  var element = svg ? document.createElementNS('http://www.w3.org/2000/svg', node.tag) : document.createElement(node.tag);
  Object.keys(node.props).forEach(function (name) {
    if (/^on[A-Z]/.test(name)) return;
    if (name === 'style') { element.setAttribute('style', node.props.style); return; }
    element.setAttribute(name, node.props[name]);
  });
  element[PROPS] = node.props;
  // the fiber chain: the component that rendered the element, then the one that used it (a Modal inside WeatherPeekModal)
  element[FIBER] = { type: node.tag, return: node.component ? { type: node.component, return: owner ? { type: owner, return: null } : null } : null };
  node.children.forEach(function (child) { var kid = mount(child, owner); if (kid) element.appendChild(kid); });
  return element;
}
function Icon(d, fill) {
  return h(Icon, 'svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: fill || 'none', stroke: fill ? 'none' : 'currentColor', 'stroke-width': '1.6', style: 'flex-shrink: 0;' },
    h(Icon, 'path', { d: d }));
}
var STAR = 'm12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 3Z';
var I = {
  pin: function () { return Icon('M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z'); },
  plus: function () { return Icon('M12 5v14M5 12h14'); },
  star: function () { return Icon(STAR); },
  starFill: function () { return Icon(STAR, 'currentColor'); },
  eye: function () { return Icon('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z'); },
  calendar: function () { return Icon('M3 10h18M8 3v4M16 3v4'); },
  edit: function () { return Icon('M4 20h4l11-11-4-4L4 16v4Z'); },
  trash: function () { return Icon('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'); }
};
// A modal mounted on the body (ReactDOM.createPortal): the backdrop is styled by its class, no role
function Modal(title, body, onClose) {
  return h(Modal, 'div', { 'class': 'modal-bg', onClick: onClose },
    h(Modal, 'div', { 'class': 'modal', onClick: function (event) { event.stopPropagation(); } },
      h(Modal, 'h3', {}, title),
      h(Modal, 'div', { 'class': 'modal-body' }, body),
      h(Modal, 'button', { 'class': 'btn primary', onClick: onClose }, 'Fechar')));
}
