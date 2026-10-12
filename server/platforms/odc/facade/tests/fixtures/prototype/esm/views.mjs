export function listView(items) {
  return '<h1>Recipes</h1><ul class="recipes">' + items.map(item => '<li class="recipe' + (item.Favorite ? ' fav' : '') + '"><a href="#recipe/' + item.Id + '">' + item.Name + '</a> <button data-action="favorite" data-id="' + item.Id + '">' + (item.Favorite ? 'Unstar' : 'Star') + '</button></li>').join('') + '</ul>';
}

export function detailView(item) {
  if (!item) return '<p class="missing">Not found</p>';
  return '<article class="detail"><h1>' + item.Name + '</h1><p class="minutes">' + item.Minutes + ' min</p><a href="#recipes">Back</a></article>';
}
