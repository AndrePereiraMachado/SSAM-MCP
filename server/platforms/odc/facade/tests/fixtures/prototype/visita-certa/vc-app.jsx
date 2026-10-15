// vc-app.jsx: the app (VisitaCerta's shapes): a side menu of div items, a page switched by state, the places table whose
// every row has the same five .btn buttons (a star, Clima, Agendar, a pencil, a bin), segmented filters written
// {icon} {label}, a select without id, a weather modal mounted on the body, a toast that stays and a visit written with
// the date of the day (a text the store keeps, a Date Time of the entity).
var VC_KEY = 'vc-fixture-v1';
var stored = null;
try { stored = JSON.parse(localStorage.getItem(VC_KEY) || 'null'); } catch (e) { stored = null; }
var seed = stored || JSON.parse(document.getElementById('seed-data').textContent);
var app = { page: 'places', places: seed.places, visits: seed.visits, weather: null, toast: null, type: 'visita técnica' };
var TYPES = [{ id: 'entrega', label: 'Entrega', icon: '📦' }, { id: 'visita técnica', label: 'Visita técnica', icon: '🔧' }];
function typeOf(id) { return TYPES.filter(function (t) { return t.id === id; })[0]; }
function save() { localStorage.setItem(VC_KEY, JSON.stringify({ places: app.places, visits: app.visits })); }
function set(change) { Object.assign(app, change); render(); }
function Sidebar() {
  var item = function (id, label, icon) {
    return h(Sidebar, 'div', { 'class': 'nav-item' + (app.page === id ? ' active' : ''), onClick: function () { set({ page: id }); } },
      h(Sidebar, 'span', { 'class': 'ico' }, icon), h(Sidebar, 'span', {}, label));
  };
  return h(Sidebar, 'aside', { 'class': 'sidebar' },
    h(Sidebar, 'div', { 'class': 'brand' }, 'Visita Certa'),
    item('places', 'Locais salvos', I.pin()),
    item('register', 'Cadastrar local', I.plus()));
}
function PagePlaces() {
  var rows = app.places.slice().sort(function (a, b) { return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0); });
  return h(PagePlaces, 'div', { 'class': 'page' },
    h(PagePlaces, 'h1', {}, 'Locais salvos'),
    h(PagePlaces, 'div', { 'class': 'sub' }, String(app.visits.length), ' visitas'),
    h(PagePlaces, 'div', { 'class': 'seg' },
      h(PagePlaces, 'button', { 'class': 'on' }, 'Todos'),
      TYPES.map(function (t) { return h(PagePlaces, 'button', {}, t.icon, ' ', t.label); })),
    h(PagePlaces, 'table', { 'class': 'tbl' },
      h(PagePlaces, 'tbody', {},
        rows.map(function (p) {
          return h(PagePlaces, 'tr', {},
            h(PagePlaces, 'td', {}, h(PagePlaces, 'button', { 'class': 'btn ghost icon sm', onClick: function () { p.favorite = !p.favorite; save(); render(); } }, p.favorite ? I.starFill() : I.star())),
            h(PagePlaces, 'td', {}, h(PagePlaces, 'div', {}, p.name), h(PagePlaces, 'div', { 'class': 'muted' }, p.city, '/', p.uf)),
            h(PagePlaces, 'td', {}, h(PagePlaces, 'div', {},
              h(PagePlaces, 'button', { 'class': 'btn sm ghost', onClick: function () { set({ weather: p }); } }, I.eye(), 'Clima'),
              h(PagePlaces, 'button', { 'class': 'btn sm ghost', onClick: function () { set({ page: 'register' }); } }, I.calendar(), 'Agendar'),
              h(PagePlaces, 'button', { 'class': 'btn sm ghost icon', onClick: function () { window.prompt('Novo nome', p.name); } }, I.edit()),
              h(PagePlaces, 'button', { 'class': 'btn sm ghost icon', onClick: function () { set({ toast: 'Local removido' }); } }, I.trash()))));
        }))));
}
function PageRegister() {
  return h(PageRegister, 'div', { 'class': 'page' },
    h(PageRegister, 'h1', {}, 'Cadastrar local'),
    h(PageRegister, 'label', { 'class': 'label' }, 'Tipo'),
    h(PageRegister, 'select', { 'class': 'input', onChange: function (event) { set({ type: event.target.value }); } }, TYPES.map(function (t) { return h(PageRegister, 'option', t.id === app.type ? { value: t.id, selected: 'selected' } : { value: t.id }, t.label); })),
    h(PageRegister, 'span', { 'class': 'chip' }, typeOf(app.type).icon, ' ', typeOf(app.type).label),
    h(PageRegister, 'button', { 'class': 'btn primary', onClick: function () { app.visits.unshift({ id: 'v' + (app.visits.length + 1), placeId: 'p1', date: new Date().toISOString().slice(0, 10), score: 94 }); save(); set({ page: 'places' }); } }, 'Agendar visita'));
}
function WeatherPeekModal(place) {
  return Modal('Clima hoje · ' + place.name, h(WeatherPeekModal, 'div', {}, h(WeatherPeekModal, 'b', {}, '13', ' km/h')), function () { set({ weather: null }); });
}
function App() {
  return h(App, 'div', { 'class': 'app' },
    Sidebar(),
    h(App, 'main', { 'class': 'main' }, app.page === 'places' ? PagePlaces() : PageRegister()),
    app.toast ? h(App, 'div', { 'class': 'toast' }, app.toast) : null,
    TweaksPanel());
}
var root = document.getElementById('root');
var portal = null;
function render() {
  root.innerHTML = '';
  root.appendChild(mount(App()));
  if (portal) { portal.remove(); portal = null; }
  if (app.weather) { portal = mount(WeatherPeekModal(app.weather), WeatherPeekModal); document.body.appendChild(portal); }
}
window.render = render;
document.addEventListener('change', function (event) {
  var props = event.target[PROPS];
  if (props && typeof props.onChange === 'function') props.onChange({ target: event.target });
});
document.addEventListener('click', function (event) {
  for (var node = event.target; node && node !== document; node = node.parentNode) {
    var props = node[PROPS];
    if (props && typeof props.onClick === 'function') {
      var stopped = false;
      props.onClick({ target: event.target, stopPropagation: function () { stopped = true; } });
      return;
    }
  }
});
render();
