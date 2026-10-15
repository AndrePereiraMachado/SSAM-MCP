// tweaks-panel.jsx: the design tool's own panel (a host toggles it with postMessage); closed, it renders nothing, so the
// import never sees it. Written in the fixture's plain JavaScript (its Babel is the identity).
var TWEAKS = { open: false, values: { dark: false } };
window.addEventListener('message', function (event) {
  var type = event && event.data && event.data.type;
  if (type === '__activate_edit_mode') { TWEAKS.open = true; if (window.render) window.render(); }
  if (type === '__deactivate_edit_mode') { TWEAKS.open = false; if (window.render) window.render(); }
});
window.parent.postMessage({ type: '__edit_mode_available' }, '*');
function TweaksPanel() {
  if (!TWEAKS.open) return null;
  return h(TweaksPanel, 'div', { 'class': 'twk-panel' }, h(TweaksPanel, 'b', {}, 'Tweaks'));
}
