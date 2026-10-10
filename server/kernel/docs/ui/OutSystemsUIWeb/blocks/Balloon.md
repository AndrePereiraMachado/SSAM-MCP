# Balloon

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 14 widgets internos

The Balloon offers a more robust alternative to the Tooltip for displaying overlays of content. 

Used when there's the need to display additional information related to a small element on the screen, like a notifications panel.

Add the content to be displayed inside the Balloon placeholders, then, configure the WidgetId that will trigger the Balloon. You may also choose the Positon and the type of Trigger.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| WidgetId | Text | sim |  | Element name that will trigger the element to be visible. |
| Position | PositionBase Identifier | nao | Entities.PositionBase.Bottom | Set the position around the widget element. |
| Trigger | Trigger Identifier | nao | Entities.Trigger.Hover | Set the type of trigger for the content.  Manual will require the tooltip to be triggered programmatically. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |
| AdvancedFormat | Text | nao | "{}" | Allow for more options beyond what it's provided through the input parameters.  Example: "{     arrow: false,     showOnInit: true }"  For more information visit:  https://atomiks.github.io/tippyjs/ |

Valores possiveis (static entities):

- **Entities.PositionBase**: Right, Bottom, Top, Left
- **Entities.Trigger**: Click, Manual, Hover

## Placeholders

- **Title**: Use this placeholder to set title of your Balloon. (em `BalloonWrapper`)
- **Content**: Drag your content to this placeholder. (em `BalloonWrapper`)
- **Footer**: Use this placeholder to set your footer. (em `BalloonWrapper`)

## Eventos

- **OnHide**(): Event triggered once the balloon is hidden.
- **OnShow**(): Event triggered once the balloon is shown.

## Composicao interna

- Usa os blocos: JavaScriptNode, Tippy_3_0_6, EventThroughExtensibility

## JavaScript

JavaScript do bloco:

```js
/* Position, show and hide balloon */
var newBalloon = function() {
    
    /* Object variables */
    var widget;
    var balloonWrapper;
    var position;
    var trigger;
    var advancedFormat;
    var tippyObj;
    
    /* Starting functions */
    var start = function(widgetId, balloonId, positionParam, triggerParam, advancedFormatParam, onShowId, onHideId) {
        // Sets objects and variables
        widget = document.getElementById(widgetId);
        balloonWrapper = document.getElementById(balloonId);
        trigger = triggerParam === "hover" ? "mouseenter focus" : triggerParam;
        
        if(positionParam.indexOf("bottom") !== -1) {
            position = "bottom";
        } else if(positionParam.indexOf("top") !== -1) {
            position = "top";
        } else if(positionParam.indexOf("left") !== -1) {
            position = "left";
        } else if(positionParam.indexOf("right") !== -1) {
            position = "right";
        }
        
        var options = {
            content: balloonWrapper,
            arrow: true,
            theme: 'light',
            placement: position,
            trigger: trigger,
            interactive: true,
            zIndex: 102,
            appendTo: function(ref) {
                if(!ref.parentNode.classList.contains('search-balloon')) { // used to identify when it's being used inside of a search balloon
                    // or by itself
                    ref.parentNode.classList.add('only-balloon');
                }
            
                return ref.parentNode
            },
            onShow: function() { // done o add accessibility to the balloon the same way that we had on the previous version
                balloonWrapper.setAttribute('aria-hidden','false');
                balloonWrapper.setAttribute('aria-expanded','true');
                widget.setAttribute('aria-expanded','true');
                
                //Check if IE and addEventListener to close tooltip/ballon on focus out
                if(document.querySelector('.ie11') && trigger === "mouseenter focus"){
                    setTimeout(function(){
                        widget.parentElement.querySelector('.tippy-popper').addEventListener("blur", closeTippyObj);
                    }, 0);
                }
                
                TriggerEvents(onShowId);
            },
            onHide: function() { // done o add accessibility to the balloon the same way that we had on the previous version
                balloonWrapper.setAttribute('aria-hidden','true');
                balloonWrapper.setAttribute('aria-expanded','false');
                widget.setAttribute('aria-expanded','false');
                
                TriggerEvents(onHideId);
                    
            }
        };
        
        if(advancedFormatParam.length > 0) {
            advancedFormat = eval('(' + advancedFormatParam + ')');
            options = mergeJSON(options, advancedFormat);
        }
        
        tippy(widget, options);
        tippyObj = tippy;
    };
    
    //Action to close tooltips and balloon on focus out
    function closeTippyObj() {
        tippyObj.hideAllPoppers();
        widget.parentElement.querySelector('.tippy-popper').removeEventListener("blur", closeTippyObj);
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
        init: function(widgetId, balloonId, positionParam, triggerParam, advancedFormatParam, onShowEvent, onHideEvent) {
            start(widgetId, balloonId, positionParam, triggerParam, advancedFormatParam, onShowEvent, onHideEvent);
        }
    };
}

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Balloon1","source":"IWebBlock:Balloon","as":"$b"}
{"op":"set","target":"$b/WidgetId","prop":"Value","value":"<Text>"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
{"op":"create","parent":"$b/Footer","type":"IExpressionWidget","as":"$eFooter"}
```
