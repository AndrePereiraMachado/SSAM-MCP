// v1-app.jsx: the functional version (tabs Bater and Espelho, a day sheet, a reset button with only an icon)
var state = { tab: 'home', punches: Number(localStorage.getItem('fx-punches') || 1), sheet: null };
var root = document.getElementById('root');
var timer = setInterval(function () {}, 1000);
function setState(change) { Object.assign(state, change); localStorage.setItem('fx-punches', String(state.punches)); render(); }
function StatusBar() {
  var c = TOK.ink;
  return h(StatusBar, 'div', { style: { display: 'flex', justifyContent: 'space-between', padding: '18px 30px 8px' } },
    h(StatusBar, 'span', { style: { fontWeight: '600' } }, '11:47'),
    h(StatusBar, 'span', { style: { display: 'flex', gap: '5px' } },
      h(StatusBar, 'svg', { width: '17', height: '11', viewBox: '0 0 17 11' }, h(StatusBar, 'rect', { x: '0', y: '6', width: '3', height: '5', fill: c }), h(StatusBar, 'rect', { x: '4', y: '3', width: '3', height: '8', fill: c })),
      h(StatusBar, 'svg', { width: '22', height: '10', viewBox: '0 0 22 10' }, h(StatusBar, 'rect', { x: '0.5', y: '0.5', width: '19', height: '9', rx: '2.5', stroke: c, fill: 'none' }), h(StatusBar, 'rect', { x: '2', y: '2', width: '16', height: '6', fill: c }))));
}
function TabBar(active) {
  return h(TabBar, 'div', { style: { display: 'flex', gap: '6px', padding: '8px' } },
    h(TabBar, 'button', { onClick: function () { setState({ tab: 'home', sheet: null }); }, style: { flex: '1', background: active === 'home' ? TOK.green : 'transparent' } }, 'Bater'),
    h(TabBar, 'button', { onClick: function () { setState({ tab: 'cal' }); }, style: { flex: '1', background: active === 'cal' ? TOK.green : 'transparent' } }, 'Espelho'));
}
function Home() {
  var next = STEPS[state.punches];
  return h(Home, 'div', { style: { width: '402px', background: TOK.paper } },
    StatusBar(),
    h(Home, 'div', { style: { margin: '18px 16px 0', background: TOK.green, color: '#fff' } },
      h(Home, 'div', { style: { fontSize: '12px', textTransform: 'uppercase' } }, next ? 'Trabalhando há' : 'Dia encerrado'),
      h(Home, 'div', { style: { marginTop: '8px', fontSize: '86px', fontWeight: '300' } }, '02:49')),
    h(Home, 'button', { onClick: function () { if (next) setState({ punches: state.punches + 1 }); }, style: { width: '100%', border: 'none' } },
      h(Home, 'div', { style: { fontSize: '12px' } }, next ? 'Bater ponto' : 'Tudo pronto'),
      h(Home, 'div', { style: { fontSize: '24px' } }, next ? next.label : 'Encerrado')),
    h(Home, 'div', { style: { display: 'flex', flexDirection: 'column' } },
      STEPS.map(function (step, i) {
        return h(Home, 'div', { style: { display: 'flex', gap: '14px', borderBottom: i < STEPS.length - 1 ? '1px solid #ddd' : 'none' } },
          h(Home, 'div', { style: { flex: '1' } }, step.label),
          h(Home, 'div', { style: { fontWeight: '700' } }, String(Math.floor(step.plan / 60)).padStart(2, '0') + ':00'));
      })),
    TabBar('home'));
}
function DaySheet(day) {
  return h(DaySheet, 'div', { onClick: function () { setState({ sheet: null }); }, style: { position: 'absolute', inset: '0', background: 'rgba(15,26,20,0.45)', zIndex: '100' } },
    h(DaySheet, 'div', { onClick: function (event) { event.stopPropagation(); }, style: { position: 'absolute', left: '0', right: '0', bottom: '0', background: TOK.paper } },
      h(DaySheet, 'div', { style: { fontSize: '13px' } }, 'Dia ' + day),
      h(DaySheet, 'button', { onClick: function () { setState({ sheet: null }); }, style: { width: '100%' } }, 'Fechar')));
}
function Mirror() {
  var days = [];
  for (var d = 1; d <= 12; d++) days.push(d);
  return h(Mirror, 'div', { style: { width: '402px', background: TOK.paper, position: 'relative' } },
    StatusBar(),
    h(Mirror, 'div', { style: { padding: '8px 24px 0' } }, h(Mirror, 'div', { style: { fontSize: '24px' } }, 'Maio 2026')),
    h(Mirror, 'div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' } },
      days.map(function (day) { return h(Mirror, 'button', { onClick: function () { setState({ sheet: day }); }, style: { border: 'none' } }, String(day)); })),
    state.sheet ? DaySheet(state.sheet) : null,
    TabBar('cal'));
}
function App() {
  return h(App, 'div', { style: { display: 'flex', justifyContent: 'center' } },
    h(App, 'div', { style: { width: '402px', height: '874px', position: 'relative', overflow: 'hidden', borderRadius: '48px' } },
      h(App, 'div', { style: { position: 'absolute', top: '11px', width: '126px', height: '37px', background: '#000' } }),
      state.tab === 'home' ? Home() : Mirror(),
      h(App, 'button', { title: 'Resetar batidas', onClick: function () { setState({ punches: 0, tab: 'home', sheet: null }); }, style: { position: 'absolute', top: '16px', right: '54px' } }, '↺')));
}
function render() { root.innerHTML = ''; root.appendChild(mount(App())); }
root.addEventListener('click', function (event) {
  for (var node = event.target; node && node !== root.parentNode; node = node.parentNode) {
    var props = node[PROPS];
    if (props && typeof props.onClick === 'function') {
      var stopped = false;
      props.onClick({ target: event.target, stopPropagation: function () { stopped = true; } });
      return;
    }
  }
});
render();
