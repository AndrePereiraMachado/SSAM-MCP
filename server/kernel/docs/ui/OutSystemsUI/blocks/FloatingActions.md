# FloatingActions

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 20 widgets internos

Display an action that floats on the bottom right of the screen, providing access to a set of additional actions. Could also be placed inside a Bottom Bar.

Add the pattern to your screen. Drag as many FloatingActionsItems as you need to the Items placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsExpanded | Boolean | nao | False | Initial state of the Block, the default value is False |
| IsHover | Boolean | nao | False | Set to true, to use hover as interaction trigger. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Button**: Drag the Icon widget to this placeholder. (em `FloatingActions/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Items**: Drag FloatingActionItems blocks to this placeholder (em `FloatingActions/content`) | nasce com: WebBlockInstance:FloatingActionsItem, WebBlockInstance:FloatingActionsItem, WebBlockInstance:FloatingActionsItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnToggle**(): Event fired after the floating actions are toggled

## Composicao interna

- Usa os blocos: FloatingActionsItem
- Ciclo de vida: OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: ToggleTabIndex, ToggleClick, OnReady, OnDestroy

## JavaScript

`ToggleTabIndex` / no `ToggleTabindex`:

```js
var floatingActions = document.getElementById($parameters.FloatingId);
var floatingActionsButton = floatingActions.querySelector('.floating-button');
var floatingActionsItems = floatingActions.querySelector('.floating-items');
var firstItem;
var focusableElems = 'a[href]:not([disabled]),[tabindex="0"], button:not([disabled]), textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]),input[type="submit"]:not([disabled]), select:not([disabled])';

// Accessibility SetTabIndex values
var setTabIndex = function (value) {
    var tabIndexItems = floatingActionsItems.querySelectorAll(focusableElems);

    tabIndexItems.forEach(function(item) {
        item.setAttribute('tabindex', value);
    });
};

// Toggle Attributes and focus
if($parameters.IsOpen) {
    setTabIndex("0");
    firstItem = floatingActionsItems.querySelector(".floating-actions-item");
    
    if(firstItem) {
        firstItem.focus();
    }
} else {
    if($parameters.IsOnReady === false) {
        floatingActionsButton.focus();
    }

    setTabIndex("-1");
}



```

`ToggleClick` / no `ToggleEvents`:

```js
var floatingActions = document.getElementById($parameters.FloatingId);
var floatingActionsButton = floatingActions.querySelector('.floating-button');

if($parameters.IsHover) {
    floatingActionsButton.removeEventListener("focus", $actions.ToggleClick);
    
    //Handle event listeners
    if($parameters.IsOpen) {
        floatingActionsButton.removeEventListener("mouseenter", $actions.ToggleClick);
        floatingActions.addEventListener("mouseleave", $actions.ToggleClick);
    } else {
        floatingActionsButton.addEventListener("mouseenter", $actions.ToggleClick);
        floatingActions.removeEventListener("mouseleave", $actions.ToggleClick);
        floatingActionsButton.addEventListener("focus", $actions.ToggleClick);
    } 
}

```

`OnReady` / no `Init`:

```js
var toggleId;
var indexArray = [];
var insideBottomBar;
var bottomBar = document.querySelector(".active-screen .bottom-bar");
var floatingActions = document.getElementById($parameters.WidgetId);
var floatingActionsButton = floatingActions.querySelector('.floating-button');
var floatingActionsItemsWrapper = floatingActions.querySelector('.floating-items');
var floatingActionsItems = floatingActionsItemsWrapper.querySelectorAll('.floating-actions-item');
var firstButton = floatingActionsItems[0];
var lastButton = floatingActionsItems[floatingActionsItems.length - 1];

// Set the HTML Object of FloatingActions
$parameters.DOMElem = document.getElementById($parameters.WidgetId);

var setFocusTrap = function(e) {
    if(floatingActionsItems.length > 0) {
        var isShiftKey = e.shiftKey;
        
        // Focus trap to circle all buttons inside
        if(isShiftKey) {
            if(document.activeElement === firstButton) {
                lastButton.focus();
                e.preventDefault();
            }
        } else if (document.activeElement === lastButton){
            firstButton.focus();
            e.preventDefault();
        }
    }
};

// Check if there are FloatingActionsItemsWrapper
if(floatingActionsItems.length > 0) {

    // Push every floating-item index into a empty array
    for (var i = 0; i < floatingActionsItems.length; i++) { 
        indexArray.push(i);
    }
    
    // reverse order of array for css animation
    indexArray.reverse();
    
    // set CSS variable instead of inline styles for sequential animations
    for (var i = 0; i < floatingActionsItems.length; i++) { 
        floatingActionsItems[i].style.setProperty('--delay', indexArray[i] + 1);
    }
    
}

// Set keyboard interaction - Accessibility
var onButtonKeypress = function(e) {
    
    //If esc, Close Items
    if (e.keyCode == "27" && floatingActions.classList.contains('is--open')) {
        $actions.ToggleClick();
    }
    
    //If enter or space toggle Items
    if (e.keyCode == "32" || e.keyCode == "13") {
        $actions.ToggleClick();
    }
    
    setFocusTrap(e);

};

if($parameters.IsHover) {
    
    if($parameters.IsExpanded) {
        floatingActions.addEventListener("mouseleave", $actions.ToggleClick);
    } else {
        floatingActionsButton.addEventListener("mouseenter", $actions.ToggleClick);
    }

    floatingActionsButton.addEventListener("focus", $actions.ToggleClick);
    
} else {
    floatingActionsButton.addEventListener("click", $actions.ToggleClick);
    floatingActionsButton.addEventListener("keydown", onButtonKeypress);
}

// Exception for clicking Esc on items wrapper 
floatingActionsItemsWrapper.addEventListener("keydown", function(e){
    if (e.keyCode == "27") {
        if($parameters.IsHover) {
           floatingActionsButton.removeEventListener("focus", $actions.ToggleClick); 
        }        
        $actions.ToggleClick();

        if($parameters.IsHover) {
            floatingActionsButton.addEventListener("focus", $actions.ToggleClick);
        }
    }

    //If Up or Down Arrows
    if(e.keyCode == "38" || e.keyCode == "40") {
        const currTargetIndex = Array.from(floatingActionsItems).indexOf(e.target);

        // Up
        if(e.keyCode == "38") {
            if(currTargetIndex === 0) {
                $actions.ToggleClick();
            } else {
                Array.from(floatingActionsItems)[currTargetIndex-1].focus();
            }
        }

        // Down
        if(e.keyCode == "40") {
            if(currTargetIndex === floatingActionsItems.length-1) {
                $actions.ToggleClick();
            } else {
                Array.from(floatingActionsItems)[currTargetIndex+1].focus();
            }
        }
    } else {
         setFocusTrap(e);   
    }
});


// Inside Bottom Bar and IOS fix
if(bottomBar && floatingActions) {
    insideBottomBar = bottomBar.contains(floatingActions);
}

if(!insideBottomBar && floatingActions) {
    
    var layout = document.querySelector('.layout');

    if(layout) {
        var nativeLayout = layout.classList.contains('layout-native');
        
        if(nativeLayout) { // new native layouts
            $actions.MoveElement($parameters.WidgetId, ".active-screen .main");
        } else {// Old native layouts
            $actions.MoveElement($parameters.WidgetId, ".active-screen .screen"); 
        }
    }

    if(bottomBar) {
        $parameters.IsInsideBottomBar = true;
    }
}

```

`OnDestroy` / no `RemoveListeners`:

```js
if($parameters.DOMElem) {
    var floatingActionsButton = $parameters.DOMElem.querySelector('.floating-button');

    if($parameters.IsHover) {
        floatingActionsButton.removeEventListener("mouseleave",$actions.ToggleClick);
        $parameters.DOMElem.removeEventListener("mouseleave",$actions.ToggleClick);
    } else {
        floatingActionsButton.removeEventListener("click", $actions.ToggleClick);
    }

    // Remove detached DOM element
    $parameters.DOMElem.remove();
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"FloatingActions1","source":"IMobileBlock:FloatingActions","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnToggle` resolve o IEventHandler pelo nome do evento e `$b/OnToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"FloatingActions1_OnToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnToggle","prop":"Handler","value":"$h"}
```
