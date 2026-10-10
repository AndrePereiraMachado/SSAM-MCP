# DEPRECATED_RangeSliderInterval

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 11 widgets internos

Select an interval within a range of values, using two sliding handles

For advanced options, read the official documentation:
https://refreshless.com/nouislider/

Note: To ensure the correct behavior of the component, we recommend not using different versions of it in the same page.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MinValue | Integer | sim |  | Slider's minimum value |
| MaxValue | Integer | sim |  | Slider's maximum value |
| InitialIntervalStart | Integer | sim |  | Default value for the interval's start. Must be between min and max values. |
| InitialIntervalEnd | Integer | sim |  | Default value for the interval's end. Must be between min and max values. |
| Step | Integer | nao | 1 | Slider moves in increments of Step. If Step is 10, the slider will go from 0 to 10, to 20, to 30, etc. |
| ShowPips | Boolean | nao | True | Show pips below the slider |
| PipsStep | Integer | nao | -1 | Range interval after which a Pip is drawn (when ShowPips is enabled). If not specified the component will try to guess what step fit your data. |
| ChangeEventDuringSlide | Boolean | nao | True | Trigger Change events while the slider is being dragged. If set to False, the change events will only be triggered when the user releases the slider.  Tip: if you're refreshing a query based on the value of the slider, you probably want to set this to False. |
| AdvancedFormat | Text | nao |  | Allow for more options beyond what it's provided through the inputs.  Example:  "{ pips: {mode: 'range', density: 3} }"  For more information visit: https://refreshless.com/nouislider/ |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

Nenhum.

## Eventos

- **OnChange**(IntervalStart: Integer, IntervalEnd: Integer) [obrigatorio]: Action to execute after selecting a new value on the slider.
Returns the new IntervalStart and the new IntervalEnd.

## Composicao interna

- Scripts exigidos: DEPRECATED_NoUISlider
- Ciclo de vida: OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, OnDestroy, OnReady, ValuesChange

## JavaScript

`OnParametersChanged` / no `UpdateSlider`:

```js
var options = {
    start: [ $parameters.InitialIntervalStart , $parameters.InitialIntervalEnd ],
    connect: true,
    step: $parameters.Step ,
    range: {
        'min': $parameters.Min ,
        'max': $parameters.Max 
    }
};

if( $parameters.ShowPips ) {
    options.pips = {
        mode: 'count',
        values: (($parameters.Max - $parameters.Min))/($parameters.PipsStep) + 1,
        density: ( $parameters.Max - $parameters.Min ) * 100
    };
}

$parameters.SliderObj.noUiSlider.destroy();
noUiSlider.create($parameters.SliderObj, options);

if( $parameters.ChangeEventDuringSlide ) {
    // trigger events while sliding
    $parameters.SliderObj.noUiSlider.on("update", $actions.ValuesChange);
} else {
    // only trigger events on release or tap
    $parameters.SliderObj.noUiSlider.on("set", $actions.ValuesChange);
}
```

`OnParametersChanged` / no `UpdateValue`:

```js
$parameters.SliderObj.noUiSlider.set([$parameters.Value1, $parameters.Value2]);
```

`OnDestroy` / no `Destroy`:

```js
$parameters.SliderObj.noUiSlider.destroy();
```

`OnReady` / no `InitSlider`:

```js
$parameters.SliderObj = document.getElementById( $parameters.SliderContainerId );
var rtl = document.querySelector(".is-rtl");
var direction = "ltr"

if(rtl) {
    direction = "rtl";
}

var options = {
    direction: direction,
    start: [ $parameters.InitialIntervalStart , $parameters.InitialIntervalEnd ],
    connect: true,
    step: $parameters.Step,
    range: {
        'min': $parameters.Min,
        'max': $parameters.Max 
    }
};

if($parameters.ShowPips) {
    
    // Find a PipsStep value if it was not defined
    if($parameters.PipsStep === 0) {
        if($parameters.Step !== 0) {
            $parameters.PipsStep = $parameters.Step;
        } else {
            $parameters.PipsStep = ($parameters.Max - $parameters.Min) / 5;
        }
    }
    
    // Limit the number of pips to prevent memory issues
    var pipsValues = Math.round((($parameters.Max - $parameters.Min) / $parameters.PipsStep) + 1);
    if(pipsValues > 100) {
        pipsValues = 100;
    }
    
    // Create the pips
    options.pips = {
        mode: 'count',
        values: pipsValues,
        density: 20,
        stepped: true
    };
}

var str = $parameters.AdvancedFormat;

if(str.length > 0) {
    var json = eval('(' + str + ')');   
    options = mergeJSON(options, json);
}

noUiSlider.create($parameters.SliderObj, options);

if( $parameters.ChangeEventDuringSlide ) {
    // trigger events while sliding
    $parameters.SliderObj.noUiSlider.on("update", throttle($actions.ValuesChange, 1000));
} else {
    // only trigger events on release or tap
    $parameters.SliderObj.noUiSlider.on("set", $actions.ValuesChange);
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

`ValuesChange` / no `GetSelectedValue`:

```js
$parameters.IntervalStart = Math.round( $parameters.values [0] );
$parameters.IntervalEnd = Math.round( $parameters.values [1] );
```

## CSS

Classes: `.noUi-wrapper`, `.noUi-target`, `.noUi-base`, `.noUi-origin`, `.noUi-handle`, `.noUi-stacking`, `.noUi-state-tap`, `.noUi-state-drag`, `.noUi-horizontal`, `.noUi-vertical`, `.noUi-background`, `.noUi-connect`, `.noUi-draggable`, `.noUi-active`, `.css`, `.noUi-pips`, `.noUi-value`, `.noUi-marker`, `.noUi-marker-sub`, `.noUi-marker-large`, `.noUi-pips-horizontal`, `.noUi-pips-margin`, `.noUi-value-horizontal`, `.noUi-marker-horizontal`, `.noUi-pips-vertical`, `.noUi-value-vertical`, `.noUi-marker-vertical`, `.noUi-tooltip`, `.noUi-handle-lower`, `.noUi-handle-upper`, `.SliderInterval`, `.noUi-touch-area`, `.noUi-connects`, `.range-slider`, `.noUi-rtl`, `.is-rtl`

Variaveis: `--color-neutral-5`, `--color-primary`, `--border-radius-soft`, `--border-size-none`, `--space-m`, `--space-none`, `--color-neutral-0`, `--border-size-s`, `--color-neutral-7`, `--border-radius-circle`, `--shadow-xs`, `--color-neutral-6`, `--color-neutral-8`, `--space-base`, `--space-s`, `--color-neutral-10`, `--space-xs`

```css
/* Functional styling;
 * These styles are required for noUiSlider to function.
 * You don't need to change these rules to apply your design.
 */
 .noUi-wrapper {
     padding: 0px 20px;
 }
 
.noUi-target,
.noUi-target * {
-webkit-touch-callout: none;
-webkit-user-select: none;
-ms-touch-action: none;
    touch-action: none;    
-ms-user-select: none;
-moz-user-select: none;
-moz-box-sizing: border-box;
    box-sizing: border-box;
}
.noUi-target {
    position: relative;
    direction: ltr;
}
.noUi-base {
    width: 100%;
    height: 100%;
    position: relative;
    z-index: 1; /* Fix 401 */
}
.noUi-origin {
    position: absolute;
    right: 0;
    top: 0;
    left: 0;
    bottom: 0;
}
.noUi-handle {
    position: relative;
    z-index: 1;
}
.noUi-stacking .noUi-handle {
/* This class is applied to the lower origin when
   its values is > 50%. */
    z-index: 10;
}
.noUi-state-tap .noUi-origin {
-webkit-transition: left 0.3s, top 0.3s;
    transition: left 0.3s, top 0.3s;
}
.noUi-state-drag * {
    cursor: inherit !important;
}

/* Painting and performance;
 * Browsers can paint handles in their own layer.
 */
.noUi-base {
    -webkit-transform: translate3d(0,0,0);
    transform: translate3d(0,0,0);
}

/* Slider size and handle placement;
 */
.noUi-horizontal {
    height: 18px;
}
.noUi-horizontal .noUi-handle {
    width: 34px;
    height: 28px;
    left: -17px;
    top: -6px;
}
.noUi-vertical {
    width: 18px;
}
.noUi-vertical .noUi-handle {
    width: 28px;
    height: 34px;
    left: -6px;
    top: -17px;
}

/* Styling;
 */
.noUi-background {
    background: #FAFAFA;
    box-shadow: inset 0 1px 1px #f0f0f0;
}
.noUi-connect {
    background: #3FB8AF;
    box-shadow: inset 0 0 3px rgba(51,51,51,0.45);
-webkit-transition: background 450ms;
    transition: background 450ms;
}
.noUi-origin {
    border-radius: 2px;
}
.noUi-target {
    border-radius: 4px;
    border: 1px solid #D3D3D3;
    box-shadow: inset 0 1px 1px #F0F0F0, 0 3px 6px -5px #BBB;
}
.noUi-target.noUi-connect {
    box-shadow: inset 0 0 3px rgba(51,51,51,0.45), 0 3px 6px -5px #BBB;
}

/* Handles and cursors;
 */
.noUi-draggable {
    cursor: w-resize;
}
.noUi-vertical .noUi-draggable {
    cursor: n-resize;
}
.noUi-handle {
    border: 1px solid #D9D9D9;
    border-radius: 3px;
    background: #FFF;
    cursor: default;
    box-shadow: inset 0 0 1px #FFF,
                inset 0 1px 7px #EBEBEB,
                0 3px 6px -3px #BBB;
}
.noUi-active {
    box-shadow: inset 0 0 1px #FFF,
                inset 0 1px 7px #DDD,
                0 3px 6px -3px #BBB;
}

/* Disabled state;
 */
[disabled].noUi-connect,
[disabled] .noUi-connect {
    background: #B8B8B8;
}
[disabled].noUi-origin,
[disabled] .noUi-handle {
    cursor: not-allowed;
}


/********* Pips.css ************/
/** Base;
 *
 */
.noUi-pips,
.noUi-pips * {
-moz-box-sizing: border-box;
    box-sizing: border-box;
}
.noUi-pips {
    position: absolute;
    color: #999;
}

/* Values;
 *
 */
.noUi-value {
    width: 40px;
    position: absolute;
    text-align: center;
}

/* Markings;
 *
 */
.noUi-marker {
    position: absolute;
    background: #CCC;
}
.noUi-marker-sub {
    background: #AAA;
}
.noUi-marker-large {
    background: #AAA;
}

/* Horizontal layout;
 *
 */
.noUi-pips-horizontal {
    padding: 10px 0;
    height: 40px;
    top: 100%;
    left: 0;
    width: 100%;
}
.noUi-horizontal.noUi-pips-margin {
    margin-bottom: 40px;
}

.noUi-value-horizontal {
    margin-left: -20px;
    padding-top: 5px;
}

.noUi-marker-horizontal.noUi-marker {
    margin-left: -1px;
    width: 2px;
    height: 5px;
}
.noUi-marker-horizontal.noUi-marker-sub {
    height: 3px;
}
.noUi-marker-horizontal.noUi-marker-large {
    height: 5px;
}

/* Vertical layout;
 *
 */
.noUi-pips-vertical {
    padding: 0 10px;
    height: 100%;
    top: 0;
    left: 100%;
}
.noUi-value-vertical {
    width: 15px;
    margin-left: 20px;
    margin-top: -5px;
}

.noUi-marker-vertical.noUi-marker {
    width: 5px;
    height: 2px;
    margin-top: -1px;
}
.noUi-marker-vertical.noUi-marker-sub {
    width: 10px;
}
.noUi-marker-vertical.noUi-marker-large {
    width: 15px;
}

/************** Tooltips ***********/
.noUi-tooltip {
    display: block;
    position: absolute;
    border: 1px solid #D9D9D9;
    border-radius: 3px;
    background: #fff;
    padding: 5px;
    text-align: center;
}

.noUi-horizontal .noUi-handle-lower .noUi-tooltip {
    top: -32px;
}
.noUi-horizontal .noUi-handle-upper .noUi-tooltip {
    bottom: -32px;
}
.noUi-vertical .noUi-handle-lower .noUi-tooltip {
    left: 120%;
}
.noUi-vertical .noUi-handle-upper .noUi-tooltip {
    right: 120%;
}

/*! Patterns - Interaction - RangeSlider Deprecated */
.SliderInterval .noUi-base {
    background-color: var(--color-neutral-5);
}

.noUi-base {
    background-color: var(--color-primary);
    border-radius: var(--border-radius-soft);
}

.noUi-origin {
    background-color: var(--color-neutral-5);
}

.noUi-target,
.noUi-target * {
    box-sizing: border-box;
    -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
    touch-action: none;
    user-select: none;
}

.noUi-target {
    background: var(--color-neutral-5);
    border: var(--border-size-none);
    border-radius: var(--border-radius-soft);
    box-shadow: none;
    height: 4px;
    margin: var(--space-m) var(--space-none) 45px;
    position: relative;
}

.noUi-vertical {
    margin: var(--space-m) var(--space-none);
    width: 4px;
}

.noUi-touch-area {
    height: 100%;
    width: 100%;
}

.noUi-base,
.noUi-connects {
    height: 100%;
    position: relative;
    width: 100%;
    z-index: 1;
}

.noUi-connect,
.noUi-origin {
    position: absolute;
    right: 0;
    top: 0;
    transform-origin: 0 0;
    transform-style: flat;
    will-change: transform;
    z-index: 1;
}

.noUi-connects {
    border-radius: var(--border-radius-soft);
    overflow: hidden;
    z-index: 0;
}

.noUi-horizontal .noUi-handle,
.noUi-vertical .noUi-handle {
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

.noUi-vertical .noUi-handle {
    left: -14px;
}

.noUi-horizontal .noUi-handle:before,
.noUi-horizontal .noUi-handle:after,
.noUi-vertical .noUi-handle:before,
.noUi-vertical .noUi-handle:after {
    background: transparent;
    border-color: var(--color-neutral-6);
    border-style: solid;
    content: '';
    height: 10px;
    margin-top: -5px;
    position: absolute;
    top: 50%;
}

.noUi-horizontal .noUi-handle:before,
.noUi-vertical .noUi-handle:before {
    border-width: var(--border-size-none) var(--border-size-none) var(--border-size-none) var(--border-size-s);
    content: '';
    left: 6px;
    right: auto;
}

.noUi-horizontal .noUi-handle:after,
.noUi-vertical .noUi-handle:after {
    border-style: solid;
    border-width: var(--border-size-none) var(--border-size-s);
    left: 10px;
    width: 3px;
}

.noUi-horizontal .noUi-handle.noUi-active,
.noUi-horizontal .noUi-handle:hover,
.noUi-vertical .noUi-handle.noUi-active,
.noUi-vertical .noUi-handle:hover {
    border: var(--border-size-s) solid var(--color-primary);
}

.noUi-horizontal .noUi-handle.noUi-active:before,
.noUi-horizontal .noUi-handle.noUi-active:after,
.noUi-horizontal .noUi-handle:hover:before,
.noUi-horizontal .noUi-handle:hover:after,
.noUi-vertical .noUi-handle.noUi-active:before,
.noUi-vertical .noUi-handle.noUi-active:after,
.noUi-vertical .noUi-handle:hover:before,
.noUi-vertical .noUi-handle:hover:after {
    border-color: var(--color-primary);
}

.noUi-horizontal .noUi-pips {
    color: var(--color-neutral-8);
    position: absolute;
}

.noUi-background {
    box-shadow: none;
}

.noUi-origin.noUi-connect {
    background-color: var(--color-primary);
    box-shadow: none;
}

.noUi-horizontal.noUi-pips-margin {
    margin-bottom: 60px;
}

.range-slider .noUi-origin {
    height: 10%;
    width: 10%;
}

.noUi-vertical .noUi-origin {
    width: 0;
}

.range-slider .noUi-horizontal .noUi-origin {
    height: 0;
}

.noUi-pips-vertical {
    color: var(--color-neutral-8);
    height: 100%;
    left: 100%;
    padding: 0 0 0 var(--space-base);
    top: 0;
}

.noUi-value-vertical {
    padding-left: var(--space-s);
    transform: translate(0, -50%);
}

.noUi-marker-vertical.noUi-marker {
    height: 2px;
    margin-top: -1px;
    width: 5px;
}

.noUi-marker-vertical.noUi-marker-sub {
    width: 10px;
}

.noUi-marker-vertical.noUi-marker-large {
    width: 4px;
}

.noUi-tooltip {
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

.noUi-horizontal .noUi-tooltip {
    bottom: 120%;
    left: 50%;
    -webkit-transform: translate(-50%, 0);
    transform: translate(-50%, 0);
}

.noUi-vertical .noUi-tooltip {
    right: 120%;
    top: 50%;
    -webkit-transform: translate(0, -50%);
    transform: translate(0, -50%);
}

/* RTL */
.noUi-rtl .noUi-value-vertical {
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
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_RangeSliderInterval1","source":"IMobileBlock:DEPRECATED_RangeSliderInterval","as":"$b"}
{"op":"set","target":"$b/MinValue","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/MaxValue","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/InitialIntervalStart","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/InitialIntervalEnd","prop":"Value","value":"<Integer>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnChange` resolve o IEventHandler pelo nome do evento e `$b/OnChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_RangeSliderInterval1_OnChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IntervalStart","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IntervalEnd","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnChange/IntervalStart","prop":"Value","value":"IntervalStart"}
{"op":"set","target":"$b/OnChange/IntervalEnd","prop":"Value","value":"IntervalEnd"}
```
