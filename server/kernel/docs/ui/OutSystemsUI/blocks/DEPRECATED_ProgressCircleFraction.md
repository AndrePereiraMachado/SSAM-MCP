# DEPRECATED_ProgressCircleFraction

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 12 widgets internos

Circular progress indicator, with a label on the center of the circle showing progress as a fraction.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Numerator | Integer | sim |  | Number above the line in a fraction |
| Denominator | Integer | sim |  | Number below the line in a fraction |
| ProgressColor | Text | nao | "rgba(0,0,0,0.6)" | Color that will fill in the cicle, as progress goes up. E.g: "#C2C2C2". |
| TrailColor | Text | nao | "rgba(0,0,0,0.2)" | Color of the empty part of the cicle, in hexadecimal format. E.g: "C2C2C2". |
| TextColor | Text | nao | "#333" | Color of the text that will appear in the center of the circle. E.g: "#000000". |
| CircleThickness | Integer | nao | 8 | Thickness of the circle that marks the progress. |
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
var circle = $parameters.CircleObject;

// animate progress and pogress color
circle.animate( $parameters.Progress , {
    duration: 300,
    step: function(state, circle) {
        circle.path.setAttribute('stroke', state.color);
    },
    from: { color: $parameters.PreviousProgressColor },
    to: { color: $parameters.ProgressColor }
});
```

`OnReady` / no `InitCircle`:

```js
var element = document.getElementById($parameters.ContainerId);
var isRTL = document.querySelector(".is-rtl");

var circle = new ProgressBar.Circle(element, {
    duration: $parameters.AnimationDuration ,
    color: $parameters.ProgressColor,
    trailColor: $parameters.TrailColor,
    strokeWidth: $parameters.StrokeWidth    
});

var progress = $parameters.Progress;
if(isRTL) {
    progress = -progress;
} 

if( $parameters.AnimationDuration > 0 ) {
    circle.animate(progress);
} else {
    circle.set(progress);
    circle.path.setAttribute('stroke', $parameters.ProgressColor);
}

$parameters.CircleObject = circle;

$parameters.ContainerWidth = element.parentElement.offsetWidth;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_ProgressCircleFraction1","source":"IMobileBlock:DEPRECATED_ProgressCircleFraction","as":"$b"}
{"op":"set","target":"$b/Numerator","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/Denominator","prop":"Value","value":"<Integer>"}
```
