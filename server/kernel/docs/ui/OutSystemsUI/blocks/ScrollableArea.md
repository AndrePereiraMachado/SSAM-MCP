# ScrollableArea

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 1 widgets internos

Simple scrollable Block with a placeholder for content.

Ideal to display multiple elements in a single, scrollable row or column.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Orientation | Orientation Identifier | nao | Entities.Orientation.Horizontal | Choose from Horizontal or Vertical orientation. |
| Height | Text | nao |  | Define the height of the component. Mainly for the Vertical orientation, but also available for Horizontal. If not defined, the height of the parent is used. |
| Width | Text | nao |  | Define the width of the component. Mainly for the Horizontal orientation, but also available for Vertical. If not defined, the width of the parent is used. |
| ScrollbarStyle | ScrollbarStyle Identifier | nao | Entities.ScrollbarStyle.Default | Choose between different styles for the scrollbar. Horizontal scroll is not enabled with the mouse wheel but can be done with mousepad gestures. 'None' disables the scrollbar, but scrolling is still available with the same restrictions as the previous definition. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical
- **Entities.ScrollbarStyle**: None, Default, Compact

## Placeholders

- **Content**: Add content to this placeholder

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnParametersChanged -> OnParametersChanged; OnReady -> OnReady
- Actions do bloco: OnParametersChanged, OnReady

## JavaScript

`OnReady` / no `SetClasses`:

```js
var widget = document.getElementById($parameters.WidgetId);

var checkIfIsInteger = function(value) {
  var x;
  if (isNaN(value)) {
    return false;
  }
  x = parseFloat(value);
  return (x | 0) === x;
};

// If is integer we will add 'px' to the variable
var height = checkIfIsInteger($parameters.Height) ? $parameters.Height + 'px' : $parameters.Height;
var width = checkIfIsInteger($parameters.Width) ? $parameters.Width + 'px' : $parameters.Width;

/* Set classes */
if($parameters.Width !== '' || typeof $parameters.Width != 'undefined') {
    widget.style.setProperty('--scrollable-area-width', width);
}

if($parameters.Height !== '' || typeof $parameters.Height != 'undefined') {
    widget.style.setProperty('--scrollable-area-height', height);
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ScrollableArea1","source":"IMobileBlock:ScrollableArea","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```
