const data = {
  Recipe: [
    { Id: 1, Name: 'Tomato soup', Minutes: 30, Favorite: false },
    { Id: 2, Name: 'Lemon cake', Minutes: 55, Favorite: true },
    { Id: 3, Name: 'Green salad', Minutes: 10, Favorite: false }
  ]
};

export const recipes = data.Recipe;

export function toggleFavorite(id) {
  const recipe = data.Recipe.find(item => item.Id === id);
  if (recipe) recipe.Favorite = !recipe.Favorite;
  localStorage.setItem('recipe-box', JSON.stringify(data));
}

window.RecipeData = { seed: () => JSON.parse(JSON.stringify({ Recipe: [
  { Id: 1, Name: 'Tomato soup', Minutes: 30, Favorite: false },
  { Id: 2, Name: 'Lemon cake', Minutes: 55, Favorite: true },
  { Id: 3, Name: 'Green salad', Minutes: 10, Favorite: false }
] })) };
