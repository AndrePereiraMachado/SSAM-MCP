import { recipes, toggleFavorite } from 'store';
import { listView, detailView } from './views.mjs';

const root = document.getElementById('root');

function render() {
  const [page, id] = (location.hash.slice(1) || 'recipes').split('/');
  const content = page === 'recipe' ? detailView(recipes.find(item => item.Id === Number(id))) : listView(recipes);
  root.innerHTML = '<header class="bar"><a href="#recipes">Recipes</a></header><main class="page">' + content + '</main>';
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action="favorite"]');
  if (!button) return;
  toggleFavorite(Number(button.dataset.id));
  render();
});
window.addEventListener('hashchange', render);
render();
