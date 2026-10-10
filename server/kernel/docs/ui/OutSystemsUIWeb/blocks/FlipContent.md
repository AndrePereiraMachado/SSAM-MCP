# FlipContent

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Utilities** | publico | 10 widgets internos

A container that builds a flippable widget, has placeholders for front and back elements.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Trigger | Trigger Identifier | nao | Entities.Trigger.Hover | Set the trigger event for the flip. It can be a mouse hover or a click event. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Trigger**: Click, Manual, Hover

## Placeholders

- **CardFront**: Place the content of the front side in this placeholder (em `FlipContentWrapper`)
- **CardBack**: Place the content of the back side in this placeholder (em `FlipContentWrapper`)

## Eventos

- **OnFlipped**(IsFlipped: Boolean): Event triggered when the flip content shows the back content

## Composicao interna

- Usa os blocos: JavaScriptNode, EventThroughExtensibility
- Actions do bloco: OnFlippedEvent

## JavaScript

JavaScript do bloco:

```js
var flipContent = function() {
    // Objects
    var flipContentWidget;
    var flipContentWrapper;
    var flipContentFront;
    var flipContentBack;
    var onFlippedEvent;
    var elementsOnFlipContent;
    
    var start = function(widgetIdParam, onFlippedEventParam, triggerEventParam) {
        // Sets main objects
        flipContentWidget = document.getElementById(widgetIdParam);
        flipContentWrapper = flipContentWidget.querySelector('.flip-content');
        flipContentFront = flipContentWidget.querySelector('.flip-content-front');
        flipContentBack = flipContentWidget.querySelector('.flip-content-back');
        onFlippedEvent = onFlippedEventParam;
        
        // Add eventListener if the selected trigger is Click
        if(triggerEventParam === 'click'){
            flipContentWrapper.addEventListener('click', onFlipContentClick);
            flipContentWrapper.addEventListener('keydown', onFlipContentKeypress);
            flipContentWrapper.setAttribute('role','button');
            flipContentWrapper.setAttribute('tabindex','0');
        }
        
        // Prevent events if the selected trigger is Hover
        if(!flipContentWrapper.classList.contains('is--hover')){
            flipContentFront.addEventListener('transitionend', onFlipContentTransitionFront);
        }
        
    };
    
    // Action to add or remove classes on flipContent
    var onFlipContentClick = function(e) {
        elementsOnFlipContent = ['input', 'select', 'button', 'textarea', 'a'];
            
        // Verify if exists inputs, textareas, select, links or buttons inside flipContent.
        //If exists, the click must be disabled
        if (elementsOnFlipContent.indexOf(e.target.tagName.toLowerCase()) !== -1) {
           return false;
        } else {
            if(flipContentWrapper.classList.contains('is--flipped')) {
                flipContentWrapper.classList.remove('is--flipped');
                changeAriaStates();
            } else {
                flipContentWrapper.classList.add('is--flipped');
                changeAriaStates();
            }
        }
    };
    
    // Action to change aria states
    var changeAriaStates = function() {
        if(flipContentWrapper.classList.contains('is--flipped')) {
            flipContentBack.setAttribute('aria-hidden','false');
            flipContentFront.setAttribute('aria-hidden','true');
            
        } else {
            flipContentBack.setAttribute('aria-hidden','true');
            flipContentFront.setAttribute('aria-hidden','false');
        }
    };
    
    // Function to add and remove transition eventListeners to prevents flipped events
    var onFlipContentTransitionFront = function() {
        flipContentFront.removeEventListener('transitionend', onFlipContentTransitionFront);
        flipContentBack.addEventListener('transitionend', onFlipContentTransitionBack);
        changeAriaStates();
        onFlipContentEvent();
    };
    
    // Function to add and remove transition eventListeners to prevents flipped events
    var onFlipContentTransitionBack = function() {
        flipContentFront.addEventListener('transitionend', onFlipContentTransitionFront);
        flipContentBack.removeEventListener('transitionend', onFlipContentTransitionBack);
        changeAriaStates();
        onFlipContentEvent();
    };
    
    // Action handdle the event when is flipped
    var onFlipContentEvent = function() {
        if(flipContentWrapper.classList.contains('is--flipped')) {
            TriggerEvents(onFlippedEvent, true); 
        } else {
            TriggerEvents(onFlippedEvent, false); 
        }
    };
    
    //Set keyboard interaction
    var onFlipContentKeypress = function(e) {
        if(e.keyCode == "32" || e.keyCode == "13") {
            onFlipContentClick();
            e.preventDefault();
            e.stopPropagation();
        } else if(e.keyCode == "27") {
            flipContentWrapper.classList.remove('is--flipped');
            changeAriaStates();
        }
    };
    
    return {
        init: function(widgetIdParam, onFlippedEventParam, triggerEventParam) {
            start(widgetIdParam, onFlippedEventParam, triggerEventParam);
        }
    }
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"FlipContent1","source":"IWebBlock:FlipContent","as":"$b"}
{"op":"create","parent":"$b/CardFront","type":"IExpressionWidget","as":"$eCardFront"}
{"op":"create","parent":"$b/CardBack","type":"IExpressionWidget","as":"$eCardBack"}
```
