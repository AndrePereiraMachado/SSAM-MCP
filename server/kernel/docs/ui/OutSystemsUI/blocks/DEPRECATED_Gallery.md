# DEPRECATED_Gallery

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Adaptive** | publico | 2 widgets internos

Display content in gallery style with different columns per device type/orientation

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ColumnsInPhonePortrait | Phone Number | nao | 1 | Number of columns in a Portrait phone. Defaut value is 1 |
| ColumnsInPhoneLandscape | Phone Number | nao | 2 | Number of columns in a Landscape phone. Defaut value is 2 |
| ColumnsInTabletPortrait | Integer | nao | 3 | Number of columns in a portrait tablet. Defaut value is 3 |
| ColumnsInTabletLandscape | Integer | nao | 4 | Number of columns in a Landscape tablet. Defaut value is 4 |
| UseGutter | Boolean | nao | True | If set, add a gutter to all the columns except the first |

## Placeholders

- **Content**: Drag widgets or other content | nasce com: List (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Scripts exigidos: DEPRECATED_Gallery
- Ciclo de vida: OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnRender, OnReady, OnOrientationChange

## JavaScript

`OnDestroy` / no `Destroy`:

```js
window.removeEventListener("orientationchange", $actions.OnOrientationChange, false);
```

`OnRender` / no `Update`:

```js
var isPortrait = $actions.GetDeviceOrientation().Orientation === "portrait";
$parameters.GalleryObj.update($parameters.WidgetId, $parameters.ColumnsInTabletLandscape, $parameters.ColumnsInTabletPortrait, $parameters.ColumnsInPhoneLandscape, $parameters.ColumnsInPhonePortrait, $actions.IsPhone().IsPhone, $actions.IsTablet().IsTablet, isPortrait, $parameters.UseGutter);
```

`OnReady` / no `Init`:

```js
$parameters.GalleryObj = new Gallery();

var isPortrait = $actions.GetDeviceOrientation().Orientation === "portrait";
$parameters.GalleryObj.init($parameters.WidgetId, $parameters.ColumnsInTabletLandscape, $parameters.ColumnsInTabletPortrait, $parameters.ColumnsInPhoneLandscape, $parameters.ColumnsInPhonePortrait, $actions.IsPhone().IsPhone, $actions.IsTablet().IsTablet, isPortrait, $parameters.UseGutter);
```

`OnReady` / no `OrientationChange`:

```js
window.addEventListener("orientationchange", $actions.OnOrientationChange, false);
```

`OnOrientationChange` / no `OrientationChange`:

```js
setTimeout(function() {  
    var isPortrait = $actions.GetDeviceOrientation().Orientation === "portrait";
    $parameters.GalleryObj.update($parameters.WidgetId, $parameters.ColumnsInTabletLandscape, $parameters.ColumnsInTabletPortrait, $parameters.ColumnsInPhoneLandscape, $parameters.ColumnsInPhonePortrait, $actions.IsPhone().IsPhone, $actions.IsTablet().IsTablet, isPortrait, $parameters.UseGutter);
}, 500);
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Gallery1","source":"IMobileBlock:DEPRECATED_Gallery","empty":true,"as":"$b"}
```
