# MasterDetail

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Adaptive** | publico | 17 widgets internos

Displays a list of items and their related details, for example, a list of employees and their corresponding details.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| LeftPercentage | Decimal | nao | 50 | Set the LeftContent width, using percentage. |
| OpenedOnPhone | Boolean | nao | False | Variable to hold if the detail is opened on phone. |
| Height | Text | nao | "" | By default, the height will be the same as window, minus the title and header.  Use the Height parameter to set a custom height. The parameter accepts pixels or %. |

## Placeholders

- **LeftContent**: Add content for the Left side (em `SplitScreenWrapper/content`) | nasce com: List (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **RightContent**: Add content for the Right side (em `SplitScreenWrapper/content/SplitRight/content/content`)

## Eventos

- **DetailClose**(): Event triggered after a detail is closed.

## Composicao interna

- Ciclo de vida: OnParametersChanged -> OnParametersChanged; OnReady -> OnReady
- Actions do bloco: FocusTrap, SetAttributes, OnDetailClose, OnDetailOpen, OnParametersChanged, GetActiveElement, OnReady, FocusOnSpan

## JavaScript

`FocusTrap` / no `FocusTrap`:

```js
// Elements
var rightElem = document.getElementById($parameters.RightPanelId);
var closeButton = document.getElementById($parameters.CloseButtonId);
var focusableEls = rightElem.querySelectorAll('a[href]:not([disabled]),[tabindex="0"], button:not([disabled]), textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]),input[type="submit"]:not([disabled]), select:not([disabled])');
var firstFocusableEl = closeButton; 
var lastFocusableEl = focusableEls[focusableEls.length - 1];

// get event from eventListener
var e = $parameters.Event;

// Keycodes
var isTabPressed = (e.keyCode == "9");
var isShiftKey = e.shiftKey;
var isEsc = (e.keyCode == "27");

var setFocusTrap = function(){
    
    // Close on Esc
    if(isEsc) {
        $actions.OnDetailClose();
    }
    
    if(!isTabPressed) {
        return;
    } 
    
    // Focus trap to circle all buttons inside
    if(isShiftKey) {
        if(document.activeElement === firstFocusableEl) {
            lastFocusableEl.focus();
            e.preventDefault();
        }
    } else if (document.activeElement === lastFocusableEl){
        firstFocusableEl.focus();
        e.preventDefault();
    }
}();
```

`SetAttributes` / no `setAttributes`:

```js
// Elements
var rightElem = document.getElementById($parameters.RightPanelId);
var isOpenedOnPhone = $parameters.IsOpenedOnPhone;

if(rightElem) {
    if(isOpenedOnPhone) {
        rightElem.setAttribute('aria-hidden', false);
        rightElem.setAttribute('aria-expanded', true);
    } else {
        rightElem.setAttribute('aria-hidden', true);
        rightElem.setAttribute('aria-expanded', false);
    }
} else {
    setTimeout(function(){
        $actions.SetAttributes()
    }, 0)
}

```

`OnDetailClose` / no `CloseRightContent`:

```js
var layout = document.querySelector('.layout');
var elemId = document.getElementById($parameters.ElemId);
var rightPanel = elemId.querySelector('.split-right');
var isPhone = document.body.classList.contains('phone');

var close = function () {
    rightPanel.classList.remove('open');
    
    if(isPhone) {
       rightPanel.removeEventListener('keydown', $actions.FocusTrap);
       $actions.SetAttributes();
    }
    
    layout.classList.remove('detail-open');
    
    if(isPhone && $parameters.ActiveDOMElem) {
        $parameters.ActiveDOMElem.focus();
    }
};

close();



```

`OnDetailOpen` / no `OpenRightContent`:

```js
var layout = document.querySelector('.layout');
var elemId = document.getElementById($parameters.ElemId);
var rightPanel = elemId.querySelector('.split-right');
var isPhone = document.body.classList.contains('phone');

var open = function () {
    
    if(!layout.classList.contains('detail-open')) {
        $actions.GetActiveElement(document.activeElement);
    }
    
    rightPanel.classList.add('open');
    
    if(isPhone) {
       rightPanel.addEventListener('keydown', $actions.FocusTrap);
       $actions.SetAttributes();
    }
    
    layout.classList.add('detail-open');
};

open();
```

`OnParametersChanged` / no `ToogleRightContent`:

```js
/* Shows or hides the right content. This only has effect on Phone */
if ($parameters.ToOpen) {
    $actions.OnDetailOpen();
}
else {
    $actions.OnDetailClose();
}
```

`OnReady` / no `Init`:

```js
var elemId = document.getElementById($parameters.ElemId);
var leftPanel = elemId.querySelector('.split-left');
var layout = document.querySelector('.layout');
var isPhone = document.body.classList.contains('phone');
$parameters.IsPhone = isPhone;
var elemHeight;

if($parameters.IsWebApp || ($parameters.IsLayoutNative && !isPhone)) {
    if($parameters.Height === "") {
        var contentMiddle = document.querySelector('.content-middle');
        var footer = document.querySelector('.footer');
        var elDistanceToTop = window.pageYOffset + contentMiddle.getBoundingClientRect().top;
        var padding = $parameters.IsLayoutNative ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-m'));
        
        if(footer) {
            var footerHeight = footer.getBoundingClientRect().height;
            elemHeight = elDistanceToTop + (padding * 2) + footerHeight + 'px';
        } else {
            elemHeight = elDistanceToTop + (padding * 2) + 'px';
        }
        
    } else {
        elemHeight = $parameters.Height;
    }
    
    elemId.style.setProperty('--master-detail-height', elemHeight);
    

}

// Set 50% for each, in case parameters are not correctly set
if ($parameters.LeftPercentage < 0 || $parameters.LeftPercentage > 100) {
    $parameters.LeftPercentage = 50;
}

elemId.style.setProperty('--left-percentage', $parameters.LeftPercentage + "%");

// fix for arrow on phone
if(layout) {
    var nativeLayout = layout.classList.contains('layout-native');
    
    if(!nativeLayout) { // old native layouts
       $actions.MoveElement($parameters.RightClose, ".active-screen .screen"); 
    }
}

if(!isPhone) {
  // Set tab navigation behaviour based on focus event
var focusSpanTop = elemId.querySelector("span.focus-item.top"),
    focusSpanBottom = elemId.querySelector("span.focus-item.bottom");

    if(focusSpanTop) {
        focusSpanTop.removeEventListener("focus", $actions.FocusOnSpan);
        focusSpanTop.addEventListener("focus", $actions.FocusOnSpan);
    }
    
    if(focusSpanBottom){
        focusSpanBottom.removeEventListener("focus", $actions.FocusOnSpan);
        focusSpanBottom.addEventListener("focus", $actions.FocusOnSpan); 
    }
}

```

`FocusOnSpan` / no `FocusOnSpan`:

```js
var clickedItem = $parameters.event.target;

if(clickedItem.getAttribute("focusItemId")) {
	document.getElementById(clickedItem.getAttribute("focusItemId")).focus();
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"MasterDetail1","source":"IMobileBlock:MasterDetail","empty":true,"as":"$b"}
{"op":"create","parent":"$b/RightContent","type":"IExpression","as":"$eRightContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/DetailClose` resolve o IEventHandler pelo nome do evento e `$b/DetailClose/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"MasterDetail1_DetailClose","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/DetailClose","prop":"Handler","value":"$h"}
```
