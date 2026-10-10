# RangeSliderInterval

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 20 widgets internos

Select an interval between two range values.

It's used for letting users select a value or range from a fixed set of options.

Place the range slider on your screen. On the pattern properties, you have to set the minValue, MaxValue and InitialIntervalStart and InitialIntervalEnd.

For advanced scenarios, use the AdvancedFormat parameter. To know how to use this, read the official documentation: 
https://refreshless.com/nouislider/

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MinValue | Decimal | sim |  | Set lowest possible value. |
| MaxValue | Decimal | sim |  | Set highest possible value. |
| InitialIntervalStart | Decimal | sim |  | Default value for the interval's start. Must be between min and max values. |
| InitialIntervalEnd | Decimal | sim |  | Default value for the interval's end. Must be between min and max values. |
| Step | Decimal | nao | 1 | Increment value for each step.   For instance, a step of 5 would make the slider jump across 0-5-10-15-20 and so on. |
| ShowPips | Boolean | nao | True | If true, displays the range values near the slider. |
| PipsStepsNumber | Integer | nao | 0 | Set the number of Pip Steps. Only applied if ShowPips is true. |
| IsVertical | Boolean | nao | False | Set to True to change the orientation to vertical. |
| VerticalHeight | Integer | nao | 100 | If IsVertical is true, use this parameter to set the height in px. |
| IsDisabled | Boolean | nao |  |  |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |
| AdvancedFormat | Text | nao | "{}" | Allow for more options beyond what it's provided through the inputs.  Example:  "{     pips: {             density: 1     } }"  For more information visit:  https://refreshless.com/nouislider/ |

## Placeholders

- **Label**: Drag the Label widget to this placeholder. (em `RangeSliderWrapper`)

## Eventos

- **OnChange**(SelectedMinValue: Decimal, SelectedMaxValue: Decimal) [obrigatorio]: Event triggered once a handler is dragged and the values change

## Composicao interna

- Usa os blocos: NoUiSlider_14_1_1, wNumb_1_2_0, JavaScriptNode, EventThroughExtensibility
- Actions do bloco: RangeChange

## JavaScript

JavaScript do bloco:

```js
/* Configures and starts the range slider */
var RangeSliderInterval = function() {
    // Variables
    var widget;
    var input1;
    var input2;
    var direction = 'ltr';
    var options = {};
    var advancedFormat;
    var min;
    var max;
    var minInit;
    var maxInit;
    var step;
    var showPips;
    var pipsStepsNumber;
    var eventId;
    var lowerValue;
    var upperValue;
    var orientation;
    
    // Starting functions
    var start = function(widgetId, minInputId, maxInputId, minValue, maxValue,
                        minInitValue, maxInitValue, stepValue, showPipsValue, pipsStepsValue, 
                        advancedFormatParam, eventChangeId, isVerticalParam) {
        // Get DOM objects
        var widgetWrapper = document.getElementById(widgetId);
        widget = widgetWrapper.querySelector('.range-slider-object');
        input1 = document.querySelector('#' + minInputId);
        input2 = document.querySelector('#' + maxInputId);
        
        min = parseFloat(minValue);
        max = parseFloat(maxValue);
        minInit = parseFloat(minInitValue);
        maxInit = parseFloat(maxInitValue);
        step = parseFloat(stepValue);
        showPips = (showPipsValue === 'True');
        pipsStepsNumber = parseFloat(pipsStepsValue);
        advancedFormat = advancedFormatParam;
        eventId = eventChangeId;
        orientation = (isVerticalParam === 'True') ? "vertical" : "horizontal";
        
        // Checks for RTL
        if(document.body.classList.contains('is-rtl')) {
            direction = 'rtl';
        }
            
        var options = {
            start: [minInit, maxInit],
            connect: true,
            range: {
                'min': min,
                'max': max
            },
            direction: direction,
            orientation: orientation,
            step: step
        }
        
        if(showPips) {
            
            // Defines values
            var pipsValue = pipsStepsNumber;
            var pipsDensity = (pipsValue - 1) * 100; // -1 to compensate the first position: 0;
            var mode = 'count';
            
            if(pipsValue > 10) { // when there are too many pips steps to be shown
                mode = 'range';
            }
            
            if(pipsValue <= 1) { // steps, when they exist, can't be less than 2 (library restraint)
                pipsValue = 2;
            }

            options.pips = {
                mode: mode,
                values: pipsValue,
                density: pipsDensity,
                stepped: true
            };
        }
        
        // Prepares the options considering the advancedFormat  
         if(advancedFormat.length > 0) {
            var advancedObj = eval('(' + advancedFormat + ')');
            options = mergeJSON(options, advancedObj);
        }
    
        // Destroy the slider if it already exists
        if(widget.classList.contains('noUi-target')) {
            widget.noUiSlider.destroy();
        }
        
        create(options);
    };
    
    function create(options) {
        // Builds the slider using the library
        var slider = noUiSlider.create(widget, options);
    
        setListeners(slider);
    };
    
    function setListeners(slider) {
        
        // Add eventListener for keyboard interaction
        var handleLower = widget.querySelector('.noUi-handle.noUi-handle-lower');
        var handleUpper = widget.querySelector('.noUi-handle.noUi-handle-upper');
        
        slider.on("update", function(values, handle) {
            updateValues(values);
        })
    
        slider.on("set", function(values, handle) {            
            TriggerEvents(eventId, updateValues(values)[0], updateValues(values)[1]);
        });
    };
    
    function updateValues(values) {
        var valMin = parseFloat(values[0]);
        var valMax = parseFloat(values[1]);
        
        input1.innerText = valMin;
        input2.innerText = valMax;
        
        return [valMin, valMax];
    };
    
    function mergeJSON(target, add) {
        function isObject(obj) {
            if (typeof obj == "object") {
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
    };
    
    return {
        init: function(widgetId, minInputId, maxInputId, min, max,
                        minInitValue, maxInitValue, step, showPips, pipsSteps, 
                        advancedFormatParam, eventChangeId, isVerticalParam) {
                        
                start(widgetId, minInputId, maxInputId, min, max,
                        minInitValue, maxInitValue, step, showPips, pipsSteps, 
                        advancedFormatParam, eventChangeId, isVerticalParam);
        }
    };
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"RangeSliderInterval1","source":"IWebBlock:RangeSliderInterval","as":"$b"}
{"op":"set","target":"$b/MinValue","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/MaxValue","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/InitialIntervalStart","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/InitialIntervalEnd","prop":"Value","value":"<Decimal>"}
{"op":"create","parent":"$b/Label","type":"IExpressionWidget","as":"$eLabel"}
```
