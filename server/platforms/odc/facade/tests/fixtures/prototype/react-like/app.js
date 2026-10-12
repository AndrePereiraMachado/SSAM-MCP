(function () {
  var h = MiniReact.h;
  window.ShopData = { seed: function () { return { Item: [{ Id: 1, Name: 'Mug', Qty: 0 }, { Id: 2, Name: 'Shirt', Qty: 0 }] }; } };
  var db = ShopData.seed();
  var view = 'shop';
  var app = MiniReact.createRoot(document.getElementById('root'));
  function add(id) {
    db.Item.forEach(function (item) { if (item.Id === id) item.Qty += 1; });
    localStorage.setItem('counter-shop', JSON.stringify(db));
    render();
  }
  function render() {
    var nav = h('nav', { className: 'tabs' },
      h('span', { className: view === 'shop' ? 'tab on' : 'tab', onClick: function () { view = 'shop'; render(); } }, 'Shop'),
      h('span', { className: view === 'cart' ? 'tab on' : 'tab', onClick: function () { view = 'cart'; render(); } }, 'Cart'));
    var body = view === 'shop'
      ? h('section', { className: 'shop' }, h('h1', {}, 'Shop'), h('div', { className: 'products' }, db.Item.map(function (item) {
          return h('div', { className: 'product' }, h('span', { className: 'name' }, item.Name), h('span', { className: 'qty' }, String(item.Qty)), h('span', { className: 'add', onClick: function () { add(item.Id); } }, 'Add'));
        })))
      : h('section', { className: 'cart' }, h('h1', {}, 'Cart'), h('p', { className: 'count' }, String(db.Item.reduce(function (sum, item) { return sum + item.Qty; }, 0)) + ' items'));
    app.render(h('div', { className: 'app' }, nav, body));
  }
  render();
})();
