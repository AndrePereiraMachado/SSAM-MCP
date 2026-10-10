# FloatingActions

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 26 widgets internos

Display an action that floats on the bottom right of the screen, providing access to a set of additional actions.

Add the pattern to your screen. Drag as many FloatingActionsItems as you need to the Items placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Trigger | Trigger Identifier | nao | Entities.Trigger.Click | Set the type of trigger for the Button. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Trigger**: Click, Manual, Hover

## Placeholders

- **Items**: Drag FloatingActionItems blocks to this placeholder (em `FloatingAction`) | nasce com: WebBlockInstance:FloatingActionsItem, WebBlockInstance:FloatingActionsItem, WebBlockInstance:FloatingActionsItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Button**: Drag the Icon widget to this placeholder. (em `FloatingAction`) | nasce com: WebBlockInstance:Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnToggle**(): Event fired after the floating actions are toggled

## Composicao interna

- Usa os blocos: FloatingActionsItem, Icon, JavaScriptNode, EventThroughExtensibility

## JavaScript

JavaScript do bloco:

```js
var FloatingActions = function() {
    // Objects
    var floatingActions;
    var floatingActionsButton;
    var floatingActionsItem = document.querySelectorAll('.floating-actions-item');
    var floatingActionsItems = document.querySelector('.floating-actions-items');
    var trigger;
    var indexArray = [];
    var toggleId;
    
    var start = function(floatingId, triggerParam, onToggleId) {
        floatingActions = document.getElementById(floatingId);
        floatingActionsButton = floatingActions.querySelector('.floating-actions-button');
        trigger = (triggerParam === "hover") ? "mouseenter" : triggerParam;
        toggleId = onToggleId;
        
        // Check if there are FloatingActionsItems
        if(floatingActionsItem.length > 0) {
            // Set initial Accessability roles
            setAriaAttributes();
            
            // Push every floating-item index into a empty array
            for (var i = 0; i < floatingActionsItem.length; i++) { 
                indexArray.push(i);
            }
            
            // reverse order of array for css animation
            indexArray.reverse();
            
            // set var --delay on style with each items index, to perform sequential css animation
            for (var i = 0; i < floatingActionsItem.length; i++) {
                floatingActionsItem[i].setAttribute("style", "--delay: " + (indexArray[i] + 1));  
            }
            
            // Set eventListeners
            floatingActionsButton.addEventListener(trigger, onButtonTrigger);
            floatingActionsButton.addEventListener('keydown', onButtonKeypress);
            
            // Add excaption for Esc on Items wrapper
            floatingActionsItems.addEventListener('keydown', function(e) {
                if (e.keyCode == "27") {
                    // Fire event
                    TriggerEvents(toggleId);
                    floatingActions.classList.remove('is--open');
                    // Set Accessability roles
                    setAriaAttributes();
                    // focus again on Button after close
                    floatingActionsButton.focus();
                }
            });
            
            // Exception for hover trigger, so that it closes only when leaving the whole area of the floating-actions block, and not only the floating-button
            if(trigger === "mouseenter") {
                floatingActions.addEventListener("mouseleave", function(){
                    // Fire event
                    TriggerEvents(toggleId);
                    
                    if(floatingActions.classList.contains('is--open')) {
                        floatingActions.classList.remove('is--open');
                        // Set Accessability roles
                        setAriaAttributes();
                    } 
                });
            }
        } else {
            floatingActionsButton.setAttribute("role", "button");
        }
    };
    
    // Set keyboard interaction - Accessibility
    var onButtonKeypress = function(e) {
        //If esc, Close Items
        if (e.keyCode == "27") {
            // Fire event
            TriggerEvents(toggleId);
            floatingActions.classList.remove('is--open');
            // Set Accessability roles
            setAriaAttributes();
        }
        
        //If enter or space toggle Items
        if (e.keyCode == "32" || e.keyCode == "13") {
            toggleItems();
            e.preventDefault();
            e.stopPropagation();
        }
    };
    
    //  Set onTrigger interaction 
    var onButtonTrigger = function() {
        toggleItems();
    }
    
    // Toggle function
    var toggleItems = function () {
        // Fire event
        TriggerEvents(toggleId);
        
        if(floatingActions.classList.contains('is--open')) {
            floatingActions.classList.remove('is--open');
            // Set Accessability roles
            floatingActionsButton.focus();
            setAriaAttributes();
        } else {
            floatingActions.classList.add('is--open');

            // Set Accessability roles
            floatingActionsItems.querySelectorAll(".floating-actions-item")[0].focus();
            setAriaAttributes();
        }
    }

    // Accessibility SetTabIndex values
    var setTabIndex = function (value) {
        var tabIndexItems = floatingActionsItems.querySelectorAll('[tabindex]');
        tabIndexItems = [].slice.call(tabIndexItems);
        tabIndexItems.forEach(function(item) {
            item.setAttribute('tabindex', value);
        });
    };

     // Set visibility through ARIA states - Accessibility
    var setAriaAttributes = function() {
        if(floatingActions.classList.contains('is--open')){
            floatingActionsItems.setAttribute("aria-hidden", "false");
            floatingActionsButton.setAttribute("aria-expanded", "true");

            setTabIndex("0");

        } else {           
            floatingActionsItems.setAttribute("aria-hidden", "true");
            floatingActionsButton.setAttribute("aria-expanded", "false");

            setTabIndex("-1");
        }
    };
          
    return {
        init: function(floatingId, triggerParam, onToggleEvent) {
            start(floatingId, triggerParam, onToggleEvent);
        }
    };
};


```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"FloatingActions1","source":"IWebBlock:FloatingActions","empty":true,"as":"$b"}
```
