# DEPRECATED_RangeSliderInterval

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 19 widgets internos

Select an interval between two range values.

It's used for letting users select a value or range from a fixed set of options.

Place the range slider on your screen. On the pattern properties, you have to set the minValue, MaxValue and InitialIntervalStart and InitialIntervalEnd.

For advanced scenarios, use the AdvancedFormat parameter. To know how to use this, read the official documentation: 
https://refreshless.com/nouislider/

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MinValue | Integer | sim |  | Set lowest possible value. |
| MaxValue | Integer | sim |  | Set highest possible value. |
| InitialIntervalStart | Integer | sim |  | Default value for the interval's start. Must be between min and max values. |
| InitialIntervalEnd | Integer | sim |  | Default value for the interval's end. Must be between min and max values. |
| Step | Integer | nao | 1 | Increment value for each step.   For instance, a step of 5 would make the slider jump across 0-5-10-15-20 and so on. |
| ShowPips | Boolean | nao | True | If true, displays the range values near the slider. |
| PipsStepsNumber | Integer | nao | 0 | Set the number of Pip Steps. Only applied if ShowPips is true. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |
| AdvancedFormat | Text | nao | "{}" | Allow for more options beyond what it's provided through the inputs.  Example:  "{     pips: {             density: 1     } }"  For more information visit:  https://refreshless.com/nouislider/ |

## Placeholders

- **Label**: Drag the Label widget to this placeholder. (em `RangeSliderWrapper`)

## Eventos

- **OnChange**(SelectedMinValue: Integer, SelectedMaxValue: Integer) [obrigatorio]: Event triggered once a handler is dragged and the values change

## Composicao interna

- Usa os blocos: DEPRECATED_NoUiSlider_11_0_3, JavaScriptNode, EventThroughExtensibility
- Actions do bloco: RangeChange

## JavaScript

JavaScript do bloco:

```js
/* Configures and starts the range slider */
var newRangeSliderInterval = function() {
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
    var checkVerticalSlider;
    var lowerValue;
    var upperValue;
    
    // Starting functions
    var start = function(widgetId, minInputId, maxInputId, minValue, maxValue,
                        minInitValue, maxInitValue, stepValue, showPipsValue, pipsStepsValue, 
                        advancedFormatParam, eventChangeId) {
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
            step: step,
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
        handleLower.addEventListener('keydown', lowerKeyboardInteraction);
        handleUpper.addEventListener('keydown', upperKeyboardInteraction);
        
        slider.on("update", function(values, handle) {
            updateValues(values);
        })
    
        slider.on("set", function(values, handle) {            
            TriggerEvents(eventId, updateValues(values)[0], updateValues(values)[1]);
        });
    };
    
    function lowerKeyboardInteraction(e) {
        // Set main objects
        checkVerticalSlider = widget.classList.contains('noUi-vertical');
        lowerValue = Number( parseFloat(widget.noUiSlider.get()[0]).toFixed(0) );
        upperValue = Number( parseFloat(widget.noUiSlider.get()[1]).toFixed(0) );
            
        if(!checkVerticalSlider) {
            if (e.currentTarget.classList.contains('noUi-handle-lower') && e.which === 37) {
                widget.noUiSlider.set([lowerValue - step, upperValue]);
            } else if (e.currentTarget.classList.contains('noUi-handle-lower') && e.which === 39) {
                widget.noUiSlider.set([lowerValue + step, upperValue]);
            }
            
        } else {
            if (e.currentTarget.classList.contains('noUi-handle-lower') && e.which === 38) {
                widget.noUiSlider.set([lowerValue - step, upperValue]);
            } else if (e.currentTarget.classList.contains('noUi-handle-lower') && e.which === 40) {
                widget.noUiSlider.set([lowerValue + step, upperValue]);
            }
        }
    };
    
    function upperKeyboardInteraction(e) {
        // Set main objects
        checkVerticalSlider = widget.classList.contains('noUi-vertical');
        lowerValue = Number( parseFloat(widget.noUiSlider.get()[0]).toFixed(0) );
        upperValue = Number( parseFloat(widget.noUiSlider.get()[1]).toFixed(0) );
            
        if(!checkVerticalSlider) {
            if (e.currentTarget.classList.contains('noUi-handle-upper') && e.which === 37) {
                widget.noUiSlider.set([lowerValue, upperValue - step]);
            } else if (e.currentTarget.classList.contains('noUi-handle-upper') && e.which === 39) {
                widget.noUiSlider.set([lowerValue, upperValue + step]);
            }
            
        } else {
            if (e.currentTarget.classList.contains('noUi-handle-upper') && e.which === 38) {
                widget.noUiSlider.set([lowerValue, upperValue - step]);
            } else if (e.currentTarget.classList.contains('noUi-handle-upper') && e.which === 40) {
                widget.noUiSlider.set([lowerValue, upperValue
/* ... truncado: 1517 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"DEPRECATED_RangeSliderInterval1","source":"IWebBlock:DEPRECATED_RangeSliderInterval","as":"$b"}
{"op":"set","target":"$b/MinValue","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/MaxValue","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/InitialIntervalStart","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/InitialIntervalEnd","prop":"Value","value":"<Integer>"}
{"op":"create","parent":"$b/Label","type":"IExpressionWidget","as":"$eLabel"}
```
