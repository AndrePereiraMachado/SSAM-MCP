# DEPRECATED_GalleryV2

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Adaptive** | publico | 2 widgets internos

Display content in gallery style with different columns per device type/orientation

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ItemInPhone | Phone Number | nao | 1 | Number of items on phone. Defaut value is 1. |
| ItemsInTablet | Integer | nao | 3 | Number of items on tablet. Defaut value is 3. |
| ItemsInDesktop | Integer | nao | 4 | Number of items in Desktop. Defaut value is 4. |
| GutterSize | Space Identifier | nao | Entities.Space.Base | Defines the space between items. |

Valores possiveis (static entities):

- **Entities.Space**: XXLarge, ExtraLarge, Large, None, Medium, ExtraSmall, Base, Small

## Placeholders

- **Content**: Drag widgets or other content | nasce com: List (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnParametersChanged -> OnReady; OnReady -> OnReady
- Actions do bloco: OnReady

## JavaScript

`OnReady` / no `Init`:

```js
var root = document.documentElement;
var gallery = document.getElementById($parameters.GalleryId);
var IsEdge = document.body.classList.contains('edge');
var itemsDesktop = $parameters.ColumnsInDesktop;
var itemsTablet = $parameters.ColumnsInTablet;
var itemsPhone = $parameters.ColumnsInPhone;

// Set Items
gallery.style.setProperty('--grid-desktop', itemsDesktop);
gallery.style.setProperty('--grid-tablet', itemsTablet);
gallery.style.setProperty('--grid-phone', itemsPhone);

// Set Gutter
gallery.style.setProperty("--grid-gap", "var(--space-"+$parameters.GutterSize+")");

// Fix for Edge, as css calc() doesn't work on all scenarios for this browser
itemsDesktop++;
itemsTablet++;
itemsPhone++;
gallery.style.setProperty('--grid-list-desktop', itemsDesktop);
gallery.style.setProperty('--grid-list-tablet', itemsTablet);
gallery.style.setProperty('--grid-list-phone', itemsPhone);

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_GalleryV21","source":"IMobileBlock:DEPRECATED_GalleryV2","empty":true,"as":"$b"}
```
