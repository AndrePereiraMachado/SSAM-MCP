# Tooltip

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 13 widgets internos

Dynamic tooltip displaying simple content.

Use when you want to add information related to the element. It is recomended that not a lot of information is placed in the content (for example, a sentence).

Drag the Block to the screen, add your content and then add the tooltip text in the placeholders.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Trigger | Trigger Identifier | nao | Entities.Trigger.Hover | Set the type of trigger for the content.  Manual will require the tooltip to be triggered programmatically. |
| IsVisible | Boolean | nao | False | If set as true, the block is visible when the page is first loaded (without the need for the initial trigger). |
| Position | PositionBase Identifier | nao | Entities.PositionBase.Top | Set the position around the widget element. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |
| AdvancedFormat | Text | nao |  | Allow for more options beyond what it's provided through the input parameters.  Example: "{     arrow: false }"  For more information visit:  https://atomiks.github.io/tippyjs/ |

Valores possiveis (static entities):

- **Entities.Trigger**: Click, Manual, Hover
- **Entities.PositionBase**: Right, Bottom, Top, Left

## Placeholders

- **Widget**: Element that will trigger the Tooltip. (em `TooltipWrapper`)
- **Content**: Drag your content to this placeholder. (em `TooltipWrapper`)

## Eventos

- **OnShow**(): Event triggered once the tooltip is shown.
- **OnHide**(): Event triggered once the tooltip is hidden.

## Composicao interna

- Usa os blocos: JavaScriptNode, Tippy_3_0_6, EventThroughExtensibility

## JavaScript

JavaScript do bloco:

```js
var Tooltip = function() {
    
    /* Object variables */
    var widget;
    var content;
    var visible;
    var trigger;
    var position;
    var tippyObj;
    
    /* Starting functions */
    var start = function(widgetId, contentId, visibleParam, positionParam, triggerParam, onShowId, onHideId, advancedFormat) {
         // Sets objects and variables
        widget = document.getElementById(widgetId);
        content = document.getElementById(contentId);
        visible = (visibleParam === 'True');
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
            content: content,
            arrow: true,
            placement: position,
            trigger: trigger,
            interactive: true,
            zIndex: 102,
            showOnInit: visible,
            appendTo: function(ref) {
                return ref.parentNode
            },
            onShow: function() { // done to add accessibility to the balloon the same way that we had on the previous version
                content.setAttribute('aria-hidden','false');
                content.setAttribute('aria-expanded','true');
                widget.setAttribute('aria-expanded','true');
                
                //Check if IE and addEventListener to close tooltip/ballon on focus out
                if(document.querySelector('.ie11') && trigger === "mouseenter focus"){
                    setTimeout(function(){
                        widget.parentElement.querySelector('.tippy-popper').addEventListener("blur", closeTippyObj);
                    }, 0);
                }
                
                TriggerEvents(onShowId);
            },
            onHide: function() { // done to add accessibility to the balloon the same way that we had on the previous version
                content.setAttribute('aria-hidden','true');
                content.setAttribute('aria-expanded','false');
                widget.setAttribute('aria-expanded','false');
                
                TriggerEvents(onHideId);
            }
        };
    
        if(advancedFormat.length > 0) {
            advancedFormat = eval('(' + advancedFormat + ')');
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
        init: function(widgetId, contentId, visibleParam, positionParam, triggerParam, onShowId, onHideId, advancedFormat) {
            start(widgetId, contentId, visibleParam, positionParam, triggerParam, onShowId, onHideId, advancedFormat);
        }
    };
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Tooltip1","source":"IWebBlock:Tooltip","as":"$b"}
{"op":"create","parent":"$b/Widget","type":"IExpressionWidget","as":"$eWidget"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
