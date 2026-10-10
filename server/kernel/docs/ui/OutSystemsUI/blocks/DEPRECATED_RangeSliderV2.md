# DEPRECATED_RangeSliderV2

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 11 widgets internos

Select a single value within a range, using a sliding handle.

For advanced options, read the official documentation:
https://refreshless.com/nouislider/

Note: To ensure the correct behavior of the component, we recommend not using different versions of it in the same page.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MinValue | Decimal | sim |  | Slider's minimum value |
| MaxValue | Decimal | sim |  | Slider's maximum value |
| InitialValue | Decimal | sim |  | Value selected by default. Must be between min and max values. |
| Step | Decimal | nao | 1 | Slider moves in increments of Step. If Step is 10, the slider will go from 0 to 10, to 20, to 30, etc. |
| ShowPips | Boolean | nao | True | Show pips below the slider |
| PipsStep | Integer | nao | 0 | Range interval after which a Pip is drawn (when ShowPips is enabled). If not specified the component will try to guess what step fit your data. |
| ChangeEventDuringSlide | Boolean | nao | True | Trigger Change events while the slider is being dragged. If set to False, the change events will only be triggered when the user releases the slider.  Tip: if you're refreshing a query based on the value of the slider, you probably want to set this to False. |
| IsDisabled | Boolean | nao | False | Set as True to disable the RangeSlider. |
| IsVertical | Boolean | nao | False | Set to True to change the orientation to vertical. |
| VerticalHeight | Integer | nao | 100 | If IsVertical is true, use this parameter to set the height in px. |
| AdvancedFormat | Text | nao |  | Allow for more options beyond what it's provided through the inputs.  Example:  "{ pips: {mode: 'range', density: 3} }"  For more information visit: https://refreshless.com/nouislider/ |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

- **OnChange**(Value: Decimal) [obrigatorio]: Action to execute after selecting a new value on the slider.
Returns the new IntervalStart and the new IntervalEnd.

## Composicao interna

- Scripts exigidos: wNumb, DEPRECATED_NoUISliderV2
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, OnInitialize, ValuesChange, SetRTLObserver, OnReady, OnDestroy, ToggleSlidingStatus
- Chama actions do modulo: IsRTL, AddRTLObserver, RemoveRTLObserver (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.GetIsRTL`, `OSFramework.OSUI.Event.DOMEvents.Observers.GlobalObserverManager.Instance.addHandler`, `OSFramework.OSUI.Event.DOMEvents.Observers.ObserverEvent.RTL`, `OSFramework.OSUI.Event.DOMEvents.Observers.GlobalObserverManager.Instance.removeHandler`

`OnParametersChanged` / no `CheckObjectStatus`:

```js
$parameters.ObjectIsDefined = $parameters.Object !== null;
```

`OnParametersChanged` / no `UpdateValue`:

```js
$parameters.SliderObj.noUiSlider.set($parameters.Value);
```

`ValuesChange` / no `GetSelectedValue`:

```js
$parameters.Value = parseFloat($parameters.InValue[0]);

```

`SetRTLObserver` / no `SetActionAsObj`:

```js
$parameters.Action = $actions.OnParametersChanged;
```

`OnReady` / no `InitSlider`:

```js
$parameters.SliderObject = document.getElementById($parameters.SliderContainerId);
var orientation = $parameters.IsVertical ? 'vertical' : 'horizontal';

var options = {
    direction: $parameters.Direction,
    start: [$parameters.Initial],
    step: $parameters.Step,
    connect: 'lower',
    orientation: orientation,
    range: {
        'min': $parameters.Min,
        'max': $parameters.Min === $parameters.Max ? 100 : $parameters.Max 
    }
};

if($parameters.ShowPips) {
    var mode = 'count';
    
    // Limit the number of pips to prevent memory issues
    var pipsValues = parseFloat($parameters.PipsStep);
    
    if(pipsValues > 10) { // when there are too many pips steps to be shown
        mode = 'range';
    }
    
    if(pipsValues <= 1) { // steps, when they exist, can't be less than 2 (library restraint)
        pipsValues = 2;
    }

    var pipsDensity = (pipsValues - 1) * 100; // -1 to compensate the first position: 0;
    
    // Create the pips
    options.pips = {
        mode: mode,
        values: pipsValues,
        density: pipsDensity,
        stepped: true
    };
}

var str = $parameters.AdvancedFormat;

if(str.length > 0) {
    var json = eval('(' + str + ')');   
    options = mergeJSON(options, json);
}

noUiSlider.create($parameters.SliderObject, options);

if($parameters.ChangeEventDuringSlide) {
    // trigger events while sliding
    $parameters.SliderObject.noUiSlider.on("update", throttle($actions.ValuesChange, 200));
    $parameters.SliderObject.noUiSlider.on("start", $actions.ToggleSlidingStatus);
    $parameters.SliderObject.noUiSlider.on("end", $actions.ToggleSlidingStatus);
} else {
    // only trigger events on release or tap
    $parameters.SliderObject.noUiSlider.on("set", $actions.ValuesChange);
}

function mergeJSON(target, add) {
    function isObject(obj) {
        if (typeof obj == 'object') {
            for (var key in obj) {
                if (obj.hasOwnProperty(key)) {
                    return true; // search for first object prop
                }
            }
        }
        return false;
    }
    for (var key in add) {
        if (add.hasOwnProperty(key)) {
            if (target[key] && isObject(target[key]) && isObject(add[key])) {
                mergeJSON(target[key], add[key]);
            } else {
                target[key] = add[key];
            }
        }
    }
    return target;
}

function throttle(func, limit) {
  var lastFunc;
  var lastRan;
  
  return function() {
    var context = this;
    var args = arguments;
    
    if (!lastRan) {
      func.apply(context, args);
      lastRan = Date.now();
    } else {
      clearTimeout(lastFunc);
      lastFunc = setTimeout(function() {
        if ((Date.now() - lastRan) >= limit) {
          func.apply(context, args);
          lastRan = Date.now();
        }
      }, limit - (Date.now() - lastRan));
    }
  };
}
```

`OnDestroy` / no `Destroy`:

```js
$parameters.SliderObj.noUiSlider.destroy();
```

## CSS

Classes: `.SliderInterval`, `.noUi-base`, `.range-slider`, `.noUi-origin`, `.noUi-target`, `.noUi-vertical`, `.noUi-touch-area`, `.noUi-connects`, `.noUi-connect`, `.noUi-horizontal`, `.noUi-handle`, `.noUi-active`, `.noUi-pips`, `.noUi-background`, `.noUi-pips-margin`, `.noUi-pips-vertical`, `.noUi-value-vertical`, `.noUi-marker-vertical`, `.noUi-marker`, `.noUi-marker-sub`, `.noUi-marker-large`, `.noUi-tooltip`, `.noUi-rtl`, `.is-rtl`, `.noUi-value`, `.noUi-pips-horizontal`, `.noUi-marker-horizontal`, `.noUi-value-sub`, `.noUi-value-horizontal`, `.has-accessible-features`

Variaveis: `--color-neutral-5`, `--color-primary`, `--border-radius-soft`, `--border-size-none`, `--space-m`, `--space-none`, `--color-neutral-0`, `--border-size-s`, `--color-neutral-7`, `--border-radius-circle`, `--shadow-xs`, `--color-neutral-6`, `--color-neutral-8`, `--space-base`, `--space-s`, `--color-neutral-10`, `--space-xs`, `--color-neutral-4`, `--color-neutral-2`, `--color-focus-inner`, `--color-focus-outer`

```css
.SliderInterval .noUi-base {
    background-color: var(--color-neutral-5);
}

.range-slider .noUi-base {
    background-color: var(--color-primary);
    border-radius: var(--border-radius-soft);
}

.range-slider .noUi-origin {
    background-color: var(--color-neutral-5);
}

.range-slider .noUi-target,
.range-slider .noUi-target * {
    box-sizing: border-box;
    -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
    -ms-touch-action: none;
    touch-action: none;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
}

.range-slider .noUi-target {
    background: var(--color-neutral-5);
    border: var(--border-size-none);
    border-radius: var(--border-radius-soft);
    box-shadow: none;
    height: 4px;
    margin: var(--space-m) var(--space-none) 45px;
    position: relative;
}

.range-slider .noUi-vertical {
    margin: var(--space-m) var(--space-none);
    width: 4px;
}

.range-slider .noUi-touch-area {
    height: 100%;
    width: 100%;
}

.range-slider .noUi-base,
.range-slider .noUi-connects {
    height: 100%;
    position: relative;
    width: 100%;
    z-index: 1;
}

.range-slider .noUi-connect,
.range-slider .noUi-origin {
    position: absolute;
    right: 0;
    top: 0;
    -ms-transform-origin: 0 0;
    -webkit-transform-origin: 0 0;
    transform-origin: 0 0;
    -webkit-transform-style: preserve-3d;
    transform-style: flat;
    will-change: transform;
    z-index: 1;
}

.range-slider .noUi-connects {
    border-radius: var(--border-radius-soft);
    overflow: hidden;
    z-index: 0;
}

.range-slider .noUi-horizontal .noUi-handle,
.range-slider .noUi-vertical .noUi-handle {
    background-color: var(--color-neutral-0);
    border: var(--border-size-s) solid var(--color-neutral-7);
    border-radius: var(--border-radius-circle);
    box-shadow: var(--shadow-xs);
    cursor: pointer;
    display: inline-block;
    height: 24px;
    left: -10px;
    position: relative;
    top: -10px;
    transition: transform 150ms ease-out;
    width: 24px;
}

.range-slider .noUi-vertical .noUi-handle {
    left: -14px;
}

.range-slider .noUi-horizontal .noUi-handle:before,
.range-slider .noUi-horizontal .noUi-handle:after,
.range-slider .noUi-vertical .noUi-handle:before,
.range-slider .noUi-vertical .noUi-handle:after {
    background: transparent;
    border-color: var(--color-neutral-6);
    border-style: solid;
    content: '';
    height: 10px;
    margin-top: -5px;
    position: absolute;
    top: 50%;
}

.range-slider .noUi-horizontal .noUi-handle:before,
.range-slider .noUi-vertical .noUi-handle:before {
    border-width: var(--border-size-none) var(--border-size-none) var(--border-size-none) var(--border-size-s);
    content: '';
    left: 6px;
    right: auto;
}

.range-slider .noUi-horizontal .noUi-handle:after,
.range-slider .noUi-vertical .noUi-handle:after {
    border-style: solid;
    border-width: var(--border-size-none) var(--border-size-s);
    left: 10px;
    width: 3px;
}

.range-slider .noUi-horizontal .noUi-handle.noUi-active,
.range-slider .noUi-horizontal .noUi-handle:hover,
.range-slider .noUi-vertical .noUi-handle.noUi-active,
.range-slider .noUi-vertical .noUi-handle:hover {
    border: var(--border-size-s) solid var(--color-primary);
}

.range-slider .noUi-horizontal .noUi-handle.noUi-active:before,
.range-slider .noUi-horizontal .noUi-handle.noUi-active:after,
.range-slider .noUi-horizontal .noUi-handle:hover:before,
.range-slider .noUi-horizontal .noUi-handle:hover:after,
.range-slider .noUi-vertical .noUi-handle.noUi-active:before,
.range-slider .noUi-vertical .noUi-handle.noUi-active:after,
.range-slider .noUi-vertical .noUi-handle:hover:before,
.range-slider .noUi-vertical .noUi-handle:hover:after {
    border-color: var(--color-primary);
}

.range-slider .noUi-horizontal .noUi-pips {
    color: var(--color-neutral-8);
    position: absolute;
}

.range-slider .noUi-background {
    box-shadow: none;
}

.range-slider .noUi-origin.noUi-connect {
    background-color: var(--color-primary);
    box-shadow: none;
}

.range-slider .noUi-horizontal.noUi-pips-margin {
    margin-bottom: 60px;
}

.range-slider .noUi-origin {
    height: 10%;
    width: 10%;
}

.range-slider .noUi-vertical .noUi-origin {
    top: 0;
    width: 0;
}

.range-slider .noUi-horizontal .noUi-origin {
    height: 0;
}

.range-slider .noUi-pips-vertical {
    color: var(--color-neutral-8);
    height: 100%;
    left: 100%;
    padding: 0 0 0 var(--space-base);
    top: 0;
}

.range-slider .noUi-value-vertical {
    padding-left: var(--space-s);
    -webkit-transform: translate(0, -50%);
    transform: translate(0, -50%);
}

.range-slider .noUi-marker-vertical.noUi-marker {
    height: 2px;
    margin-top: -1px;
    width: 5px;
}

.range-slider .noUi-marker-vertical.noUi-marker-sub {
    width: 10px;
}

.range-slider .noUi-marker-vertical.noUi-marker-large {
    width: 4px;
}

.range-slider .noUi-tooltip {
    background: var(--color-neutral-0);
    border: var(--border-size-s) solid var(--color-neutral-5);
    border-radius: var(--border-radius-soft);
    color: var(--color-neutral-10);
    display: block;
    padding: var(--space-xs);
    position: absolute;
    text-align: center;
    white-space: nowrap;
}

.range-slider .noUi-horizontal .noUi-tooltip {
    bottom: 120%;
    left: 50%;
    -webkit-transform: translate(-50%, 0);
    transform: translate(-50%, 0);
}

.range-slider .noUi-vertical .noUi-tooltip {
    right: 120%;
    top: 50%;
    -webkit-transform: translate(0, -50%);
    transform: translate(0, -50%);
}

/* RTL */
.range-slider .noUi-rtl .noUi-value-vertical {
    -webkit-transform: translate(0, 50%);
    transform: translate(0, 50%);
}

.is-rtl .noUi-value.noUi-value-vertical {
    padding-left: var(--space-none);
    padding-right: var(--space-m);
}

.is-rtl .noUi-marker.noUi-marker-vertical {
    margin-right: var(--space-base);
}

/* $4.3.12 - Patterns - Interaction - RangeSlider */
.range-slider {
    padding: 0 12px;
}

.range-slider .noUi-base {
    background-color: transparent;
}

.range-slider .noUi-horizontal .noUi-handle {
    left: auto;
    position: absolute;
    right: -12px;
}

.range-slider .noUi-connect {
    background-color: var(--color-primary);
    height: 100%;
    width: 100%;
}

.range-slider .noUi-handle {
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
    position: absolute;
}

.range-slider .noUi-pips-horizontal {
    height: 40px;
    left: 0;
    padding: 12px 0 0;
    top: 100%;
    width: 100%;
}

.range-slider .noUi-marker {
    position: absolute;
}

.range-slider .noUi-marker-sub {
    background-color: var(--color-neutral-5);
}

.range-slider .noUi-marker-large {
    background-color: var(--color-neutral-6);
}

.range-slider .noUi-marker-horizontal.noUi-marker {
    height: 4px;
    margin-left: -1px;
    width: 2px;
}

.range-slider .noUi-marker-horizontal.noUi-marker-sub {
    height: 10px;
}

.range-slider .noUi-marker-horizontal.noUi-marker-large {
    height: 4px;
}

.range-slider .noUi-value {
    position: absolute;
    text-align: center;
    white-space: nowrap;
}

.range-slider .noUi-value-sub {
    background-color: var(--color-neutral-6);
    font-size: 10px;
}

.range-slider .noUi-value-horizontal {
    top: 6px;
    -webkit-transform: translate(-50%, 50%);
    transform: translate(-50%, 50%);
}

.range-slider .noUi-rtl .noUi-value-horizontal {
    -webkit-transform: translate(50%, 50%);
    transform: translate(50%, 50%);
}

/* Range Slider - Disabled */
.range-slider[data-disabled='true'] {
    pointer-events: none;
}

.range-slider[data-disabled='true'].noUi-target {
    background-color: var(--color-neutral-4);
}

.range-slider[data-disabled='true'] .noUi-connect {
    background-color: var(--color-neutral-6);
}

.range-slider[data-disabled='true'] .noUi-handle {
    background-color: var(--color-neutral-2);
    border: var(--border-size-s) solid var(--color-neutral-5);
    box-shadow: none;
}

.range-slider[data-disabled='true'] .noUi-handle:before,
.range-slider[data-disabled='true'] .noUi-handle:after {
    border-color: var(--color-neutral-6);
}

.range-slider[data-disabled='true'] .noUi-pips {
    color: var(--color-neutral-6);
}

/* Accessibility Styles */
.has-accessible-features .range-slider .noUi-handle:focus {
    border-color: var(--color-focus-inner);
    box-shadow: 0px 0px 0px 3px var(--color-focus-outer);
}

```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_RangeSliderV21","source":"IMobileBlock:DEPRECATED_RangeSliderV2","as":"$b"}
{"op":"set","target":"$b/MinValue","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/MaxValue","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/InitialValue","prop":"Value","value":"<Decimal>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnChange` resolve o IEventHandler pelo nome do evento e `$b/OnChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_RangeSliderV21_OnChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Value","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Decimal"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnChange/Value","prop":"Value","value":"Value"}
```
