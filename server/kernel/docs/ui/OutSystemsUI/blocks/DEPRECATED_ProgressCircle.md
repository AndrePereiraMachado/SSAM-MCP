# DEPRECATED_ProgressCircle

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 7 widgets internos

Circular progress indicator, with a label on the center of the circle showing the input text. If no input text is specified the progress, in percentage, is shown.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Progress | Integer | sim |  | Progress percentage. Usually a number from from 0 to 100. |
| Text | Text | nao | "-" | The text that will be displayed inside the circle. If no text is specified, the progress percentage will be shown. |
| ProgressColor | Text | nao | "rgba(0,0,0,0.6)" | The color that will fill in the cicle, as progress goes up, in hexadecimal format. E.g: "#C2C2C2". |
| TrailColor | Text | nao | "rgba(0,0,0,0.2)" | The color of the empty part of the cicle, in hexadecimal format. E.g: "#C2C2C2". |
| TextColor | Text | nao | "#333" | Color of the text that will appear in the center of the circle, in hexadecimal format. E.g: "#000000". |
| CircleThickness | Integer | nao | 8 | The thickness of the circle that marks the progress. |
| AnimateInitialProgress | Boolean | nao | True | When True, the progress circle will show an animation going from zero to its initial progress. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Scripts exigidos: DEPRECATED_ProgressCircle
- Ciclo de vida: OnParametersChanged -> OnParametersChanged; OnReady -> OnReady
- Actions do bloco: OnParametersChanged, OnReady

## JavaScript

`OnParametersChanged` / no `UpdateProgress`:

```js
var circle = $parameters.CircleObject ;

circle.animate( $parameters.Progress / 100, {
    duration: 300,
    step: function(state, circle) {
        circle.path.setAttribute('stroke', state.color);
    },
    from: { color: $parameters.PreviousProgressColor },
    to: { color: $parameters.ProgressColor }
});

circle.setText( $parameters.Text );
circle.text.style.color = $parameters.TextColor ;
```

`OnReady` / no `InitCircle`:

```js
var element = document.getElementById($parameters.ContainerId);
var isRTL = document.querySelector(".is-rtl");
var animation = $parameters.Progress / 100;

var circle = new ProgressBar.Circle(element, {
    duration: $parameters.AnimationDuration,
    color: $parameters.PrimaryColorHex,
    trailColor: $parameters.SecondaryColorHex,
    strokeWidth: $parameters.StrokeWidth 
});

circle.setText( $parameters.Text );
circle.text.style.color = $parameters.TextColor;

if(isRTL) {
    animation = -($parameters.Progress / 100);
}

if( $parameters.AnimationDuration > 0 ) {
    circle.animate(animation);
} else {
    circle.set(animation);
}

$parameters.CircleObject = circle;

element.parentElement.offsetHeight;

$parameters.ContainerWidth = element.parentElement.offsetWidth;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_ProgressCircle1","source":"IMobileBlock:DEPRECATED_ProgressCircle","as":"$b"}
{"op":"set","target":"$b/Progress","prop":"Value","value":"<Integer>"}
```
