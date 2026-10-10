# ProgressCircle

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Numbers** | publico | 14 widgets internos

Easy to create circular or semi circular progress indicators. Create your custom content and put it inside the content placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Progress | Integer | sim |  | Percentage to display, you can use functions or local variables. |
| ProgressColor | Color Identifier | nao | Entities.Color.Primary | The color of the stroke on progress circle. |
| TrailColor | Color Identifier | nao | Entities.Color.Neutral5 | The color of the empty part of the progress circle. |
| CircleThickness | Integer | nao | 4 | The thickness of the circle that marks the progress. |
| AnimateInitialProgress | Boolean | nao | True | Animate the progress circle from zero to progress value. |
| IsSemiCircle | Boolean | nao | False | Change the type of progress bar from circle to semi circle. |
| AdvancedFormat | Text | nao | "{}" | Allow for more options beyond what it's provided through the input parameters.  Example: "{     duration: 1400,     easing: 'bounce', }"  For more information visit:  https://kimmobrunfeldt.github.io/progressbar.js/ |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9

## Placeholders

- **Content**: Drag your content here.
You can use an Expression to display the Progress value.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: ProgressBarJS_1_0_0, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var newProgressCircle = function() { 
    // Objects
    var circle;
    var progressCircleWrapper;
    var progressCircleElement;
    var progressCircleColorsWrapper;
    var progressCircleStrokeColors;
    var progressValue;
    var progressColorValue;
    var trailColorValue;
    var circleThicknessValue;
    var animateInitialProgressValue;
    var isSemiCircleValue;
    var checkIEBrowser = document.querySelector('.ie11');
    var options;
    var initialAnimationTime = 0;
    var animation;
    var isRTL = document.querySelector('.is-rtl');
    var advancedFormat;
    

    var start = function(widgetIdParam, progressParam, progressColorParam, trailColorParam, circleThicknessParam, animateInitialProgressParam, isSemeCircleParam, advancedFormatParam) {
        // Fills objects
        progressCircleWrapper = document.getElementById(widgetIdParam).querySelector('.progress-circle-outer');
        progressCircleElement = progressCircleWrapper.querySelector('.progress-circle');
        progressCircleColorsWrapper = progressCircleWrapper.querySelector('.progress-circle-colors');
        progressCircleStrokeColors = progressCircleWrapper.getElementsByTagName('path');
        progressValue = progressParam;
        progressColorValue = progressColorParam;
        trailColorValue = trailColorParam;
        circleThicknessValue = circleThicknessParam;
        animateInitialProgressValue = (animateInitialProgressParam === 'true');
        isSemiCircleValue = (isSemeCircleParam === 'true');
        
        // set options of progressCircle
        options = {
            strokeWidth: Number(circleThicknessParam),
            color: progressColorValue,
            trailColor: trailColorValue,
            duration: Number(initialAnimationTime)
        };
        
        // Merge options of advancedFormat    
        if(advancedFormatParam.length > 0) {
            advancedFormat = eval('(' + advancedFormatParam + ')');
            options = mergeJSON(options, advancedFormat);
        }
        
        // set type of progressCircle
        if(isSemiCircleValue){
            circle = new ProgressBar.SemiCircle(progressCircleElement, options);
        } else {
            circle = new ProgressBar.Circle(progressCircleElement, options);
        }
        
        // set animation time
        if(animateInitialProgressValue){
            initialAnimationTime = 500;
        }
        
        // set progressCircle value
        animation = progressValue / 100;
        
        //invert the value of progressCircle for RTL
        if(isRTL) {
            animation = -(progressValue / 100);
        }

        // set initial animation of progressCircle
        if(initialAnimationTime > 0){
            circle.animate(animation);
        } else {
            circle.set(animation);
        }
        
        // if IE, call specific actions
        // if not, call function to remove unused elements on DOM
        if(checkIEBrowser){
            checkProgressCircleColors();
        } else {
            removeProgressCircleColors();
        }
        
    };
    
    // get colors of progressCircle to set on IE browsers
    function checkProgressCircleColors() {
        getTrailColor = window.getComputedStyle(progressCircleColorsWrapper.querySelector('.color-trail')).backgroundColor;
        getStrokeColor = window.getComputedStyle(progressCircleColorsWrapper.querySelector('.color-stroke')).backgroundColor;
        
        // compared with transparent because IE add transparent property to elements without background-color
        if(getStrokeColor === "transparent"){
            
            // timeout created to prevent infinite lacks of memory
            setTimeout(function(){
                checkProgressCircleColors();
            }, 0);
            
        } else {
            // set new strokes to progressCircle and remove unused elements from DOM
            progressCircleStrokeColors[0].setAttribute('stroke', getTrailColor);
            progressCircleStrokeColors[1].setAttribute('stroke', getStrokeColor);
            removeProgressCircleColors();
        }
    }
    
    // remove unused elements from DOM
    function removeProgressCircleColors() {
        progressCircleWrapper.removeChild(progressCircleColorsWrapper);
    }
    
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
        init: function(widgetIdParam, progressParam, progressColorParam, trailColorParam, circleThicknessParam, animateInitialProgressParam, isSemeCircleParam, advancedFormatParam) {
            start(widgetIdParam, progressParam, progressColorParam, trailColorParam, circleThicknessParam, animateInitialProgressParam, isSemeCircleParam, advancedFormatParam);

        }
    }
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ProgressCircle1","source":"IWebBlock:ProgressCircle","as":"$b"}
{"op":"set","target":"$b/Progress","prop":"Value","value":"<Integer>"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
