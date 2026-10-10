# MenuDrag

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Private** | publico | 4 widgets internos

Contains the mobile phone screen gestures logic to apply on the menu to show its content.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MenuId | Text | sim |  |  |

## Placeholders

Nenhum.

## Eventos

- **OnOpen**(): Event triggered when the Menu is opened.
- **OnClose**(): Event triggered when the Menu is closed.

## Composicao interna

- Usa os blocos: TouchEvents
- Ciclo de vida: OnInitialize -> OnInitialize
- Actions do bloco: GestureStart, GestureMove, UpdateUI, GestureEnd, OnInitialize

## JavaScript

`GestureStart` / no `CheckMenuOpen`:

```js
var layoutOpen = document.querySelector('.layout.menu-visible');
var menu = document.querySelector('.layout');
var appMenu = document.querySelector('.app-menu-content');
var isTablet = document.querySelector('body.tablet.landscape');
var isRTL = document.querySelector('.is-rtl');

var burgerIcon = document.querySelector('.app-menu-icon .menu-icon');
var backIcon = document.querySelector('.app-menu-icon.back .menu-back');

if(menu && appMenu) {
    if(!$parameters.BackExists) {
        appMenu.classList.add("no-transition");
    }
    
    if (layoutOpen !== null) {
        $parameters.IsOpen = true;
    }
    
    $parameters.MenuWidth = document.querySelector('.app-menu-content').offsetWidth;
    
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
    
}



```

`GestureMove` / no `UpdateUI`:

```js
requestAnimationFrame($actions.UpdateUI);
```

`GestureMove` / no `SetOpacity`:

```js
var overlay = document.querySelector('.app-menu-overlay');

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

`GestureMove` / no `PreventDefaultWDirection`:

```js
$parameters.Evt.preventDefault();
```

`UpdateUI` / no `MoveMenu`:

```js
var el = document.querySelector('.app-menu-content');

el.style.transform =  "translateX(" + ($parameters.MoveX + $parameters.MenuWidth) + "px)";
el.style.webkitTransform =  "translateX(" + ($parameters.MoveX + $parameters.MenuWidth) + "px)";

requestAnimationFrame($actions.UpdateUI);
```

`GestureEnd` / no `SendMenuToStart`:

```js
var menu = document.querySelector('.layout');

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
    var appMenu = document.querySelector('.app-menu-content');
    var menuOverlay = document.querySelector('.app-menu-overlay');

    if(menuOverlay) {
        menuOverlay.style.opacity = "";
    }
    
    appMenu.style.transform =  "";
    appMenu.style.webkitTransform =  "";
    
    menu.classList.remove('menu-visible');
    
    menu.addEventListener("transitionend", OnTransitionEnd, false);
}

function OnTransitionEnd() {
    menu.removeEventListener("transitionend", OnTransitionEnd);
}

```

`GestureEnd` / no `RemoveClasses`:

```js
var menu = document.querySelector('.layout');
var appMenu = document.querySelector('.app-menu-content');

appMenu.classList.remove("no-transition");
menu.classList.remove("no-transition");
```

`GestureEnd` / no `GoBack`:

```js
window.history.back();
```

`GestureEnd` / no `RemoveTransition`:

```js
var menu = document.querySelector('.layout');
var appMenu = document.querySelector('.app-menu-content');
var menuBackground = document.querySelector('.app-menu-overlay');

menu.classList.remove('no-transition');
appMenu.classList.remove("no-transition");

if(menuBackground) {
    menuBackground.classList.remove("no-transition");
}


```

`GestureEnd` / no `OpenEntireMenu`:

```js
var el = document.querySelector('.app-menu-content');

el.style.transform =  "";
el.style.webkitTransform =  "";

var menu = document.querySelector('.layout');

menu.classList.add('menu-visible');

var menuOverlay = document.querySelector('.app-menu-overlay');
if(menuOverlay) {
    menuOverlay.style.opacity = "";
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"MenuDrag1","source":"IMobileBlock:MenuDrag","as":"$b"}
{"op":"set","target":"$b/MenuId","prop":"Value","value":"<Text>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnOpen` resolve o IEventHandler pelo nome do evento e `$b/OnOpen/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"MenuDrag1_OnOpen","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnOpen","prop":"Handler","value":"$h"}
```
