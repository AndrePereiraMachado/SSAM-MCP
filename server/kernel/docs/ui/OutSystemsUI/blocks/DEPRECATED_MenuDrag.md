# DEPRECATED_MenuDrag

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Private** | publico | 4 widgets internos

Contains the mobile phone screen gestures logic to apply on the menu to show its content.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MenuId | Text | sim |  |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: TouchEvents
- Ciclo de vida: OnInitialize -> OnInitialize; OnReady -> OnReady
- Actions do bloco: OnInitialize, GestureStart, GestureEnd, UpdateUI, OnReady, GestureMove

## JavaScript

`GestureStart` / no `CheckMenuOpen`:

```js
var layoutOpen = document.querySelector('.menu.menu--visible');
var menu = document.querySelector('.menu');
var appMenu = document.querySelector('.app-menu-container');
var isTablet = document.querySelector('body.tablet.landscape');
var isRTL = document.querySelector('.is-rtl');

var burgerIcon = document.querySelector('.app-menu-icon .app-menu-burger');
var backIcon = document.querySelector('.app-menu-icon.back .app-menu-back');

if(!$parameters.BackExists) {
    menu.classList.add("no-transition");
    appMenu.classList.add("no-transition");
}

if (layoutOpen !== null) {
    $parameters.IsOpen = true;
}

$parameters.MenuWidth = document.querySelector('.app-menu').offsetWidth;
var floatingActions = document.querySelector('.floating-actions--visible');

if (floatingActions !== null) {
    $parameters.isFloatingAction = true;
}

 if (burgerIcon !== null && backIcon === null) {
    $parameters.isBurgerIconVisible = true;
} else if (backIcon !== null) {
    $parameters.isBackIconVisible = true;
} else if (burgerIcon === null && backIcon === null) {
    $parameters.IsMenuHidden = true;
}

if(isRTL) {
    $parameters.isRTL = true;
}



```

`GestureEnd` / no `SendMenuToStart`:

```js
var menu = document.querySelector('.menu');

if(!$parameters.IsRTL) {
    if($parameters.OffsetX < 0 || !$parameters.IsOpen) {    
        close();
    }
} else {
    if($parameters.OffsetX > 0 || !$parameters.IsOpen) {
        close();
    }
}


function close() {
    var appMenu = document.querySelector('.app-menu-container');
    var menuOverlay = document.querySelector('.menu-background');

    if(menuOverlay) {
        menuOverlay.style.opacity = "";
    }
    
    appMenu.style.transform =  "";
    appMenu.style.webkitTransform =  "";
    
    menu.classList.remove('menu--visible');
    
    menu.addEventListener("transitionend", OnTransitionEnd, false);
}

function OnTransitionEnd() {
    menu.classList.remove('menu--animatable');
    menu.removeEventListener("transitionend", OnTransitionEnd);
}

```

`GestureEnd` / no `RemoveClasses2`:

```js
var menu = document.querySelector('.menu');
var appMenu = document.querySelector('.app-menu-container');
var content = document.querySelector('.screen');

appMenu.classList.remove("no-transition");
menu.classList.remove("no-transition");
content.classList.remove("no-transition");
```

`GestureEnd` / no `GoBack`:

```js
window.history.back();
```

`GestureEnd` / no `OpenEnitreMenu`:

```js
var el = document.querySelector('.app-menu-container');

el.style.transform =  "";
el.style.webkitTransform =  "";

var menu = document.querySelector('.menu');

menu.classList.add('menu--visible');

var menuOverlay = document.querySelector('.menu-background');
if(menuOverlay) {
    menuOverlay.style.opacity = "";
}
```

`GestureEnd` / no `RemoveTransition`:

```js
var menu = document.querySelector('.menu');
var appMenu = document.querySelector('.app-menu-container');
var menuBackground = document.querySelector('.menu-background');

menu.classList.remove('no-transition');
appMenu.classList.remove("no-transition");

if(menuBackground) {
    menuBackground.classList.remove("no-transition");
}

menu.classList.add('menu--animatable');


```

`UpdateUI` / no `MoveMenu`:

```js
var el = document.querySelector('.app-menu-container');

el.style.transform =  "translateX(" + $parameters.MoveX + "px)";
el.style.webkitTransform =  "translateX(" + $parameters.MoveX + "px)";

requestAnimationFrame($actions.UpdateUI);
```

`GestureMove` / no `SetOpacity`:

```js
var overlay = document.querySelector('.menu-background');

if(overlay) {
    overlay.classList.add('no-transition');
    
    var percentageBeforeDif = (Math.abs($parameters.MoveX) * 100) / $parameters.MenuWidth;
    var percentage = 100 - percentageBeforeDif;
    
    var newOpacity = percentage.toFixed(0)/100;
    
    if(overlay.style.opacity !== newOpacity && newOpacity.toFixed % 1 !== 0) {
        overlay.style.opacity = newOpacity;
    }
}

```

`GestureMove` / no `UpdateUI`:

```js
requestAnimationFrame($actions.UpdateUI);
```

`GestureMove` / no `PreventDefaultWDirection`:

```js
$parameters.Evt.preventDefault();
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_MenuDrag1","source":"IMobileBlock:DEPRECATED_MenuDrag","as":"$b"}
{"op":"set","target":"$b/MenuId","prop":"Value","value":"<Text>"}
```
