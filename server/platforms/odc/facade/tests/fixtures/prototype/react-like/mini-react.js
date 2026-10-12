// A tiny React-like renderer for the capture fixture: elements carry their props in __reactProps$<id> and every
// event is handled by one delegated listener on the root container, like React 17+.
(function (root) {
  'use strict';
  var key = '__reactProps$fx01';
  function h(tag, props) {
    var children = Array.prototype.concat.apply([], Array.prototype.slice.call(arguments, 2));
    return { tag: tag, props: props || {}, children: children };
  }
  function create(node) {
    if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
    var element = document.createElement(node.tag);
    Object.keys(node.props).forEach(function (name) {
      if (/^on[A-Z]/.test(name)) return;
      if (name === 'className') element.setAttribute('class', node.props[name]);
      else element.setAttribute(name, node.props[name]);
    });
    element[key] = node.props;
    node.children.forEach(function (child) { if (child !== null && child !== false) element.appendChild(create(child)); });
    return element;
  }
  function createRoot(container) {
    ['click', 'input', 'change'].forEach(function (type) {
      container.addEventListener(type, function (event) {
        var name = 'on' + type[0].toUpperCase() + type.slice(1);
        for (var node = event.target; node && node !== container.parentNode; node = node.parentNode) {
          var props = node[key];
          if (props && typeof props[name] === 'function') { props[name](event); return; }
        }
      });
    });
    return { render: function (tree) { container.innerHTML = ''; container.appendChild(create(tree)); } };
  }
  root.MiniReact = { h: h, createRoot: createRoot };
})(window);
