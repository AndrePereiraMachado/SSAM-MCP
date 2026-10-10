# DEPRECATED_Sidebar

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 15 widgets internos

This pattern is DEPRECATED. Consider using OutSystems UI's Sidebar instead. 
Get more information about changes at https://outsystemsui.outsystems.com/OutSystemsUIWebsite/MigrationPath?PatternName=Sidebar

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsOpen | Boolean | sim |  | Assign a variable that handles the state of the Sidebar |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Header**: Add your header content in this placeholder (em `Sidebar/content`)
- **Content**: Add your Sidebar content in this placeholder (em `Sidebar/content`)

## Eventos

- **OnToggle**(): Triggered when the Sidebar is toggled.

## Composicao interna

- Usa os blocos: TouchEvents
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: UpdateUI, OnParametersChanged, OnDestroy, GestureStart, GestureMove, GestureEnd, Accessibility, OnInitialize, OnReady
- Chama actions do modulo: SetFocus, IsMenuDraggable (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.Accessibility.SetFocus`, `OutSystems.OSUI.Utils.Menu.IsMenuDraggable`

`UpdateUI` / no `MoveMenu`:

```js
var el = document.getElementById($parameters.WidgetId);

el.style.transform =  "translateX(" + $parameters.OffsetX + "px)";
el.style.webkitTransform =  "translateX(" + $parameters.OffsetX + "px)";

requestAnimationFrame($actions.UpdateUI);
```

`OnParametersChanged` / no `CheckOpen`:

```js
$parameters.IsOpenIf = !document.getElementById($parameters.WidgetId).classList.contains("sidebar-open");

```

`OnDestroy` / no `OnDestroy`:

```js
var elem = document.getElementById($parameters.WidgetId);

if(elem && elem.parentElement) {
    elem.parentElement.remove();
}
```

`GestureStart` / no `AddNoTransition`:

```js
var sideBarMenu = document.getElementById($parameters.WidgetId);
sideBarMenu.classList.add('no-transition');

sideBarMenu.offsetHeight;
```

`GestureStart` / no `CheckSideBarOpen`:

```js
var layout = document.getElementById($parameters.WidgetId);
var isRTL = document.querySelector('.is-rtl');

if (layout.classList.contains('sidebar-open')) {
    $parameters.IsOpen = true;
}

if(isRTL) {
    $parameters.isRTL = true;
}

$parameters.SidebarWidth = layout.offsetWidth;
```

`GestureMove` / no `PreventDefaut`:

```js

$parameters.Evt.preventDefault();
```

`GestureMove` / no `UpdateUI`:

```js
requestAnimationFrame($actions.UpdateUI);
```

`GestureEnd` / no `SendSideBarToStart`:

```js
var el = document.getElementById($parameters.WidgetId);

el.style.transform =  "";
el.style.webkitTransform =  "";

```

`GestureEnd` / no `OpenEnitreSideBar`:

```js
var el = document.getElementById($parameters.WidgetId);

el.style.transform =  "";
el.style.webkitTransform =  "";
```

`GestureEnd` / no `RemoveNoTransition`:

```js
var sideBarMenu = document.getElementById($parameters.WidgetId);
sideBarMenu.classList.remove('no-transition');
```

`Accessibility` / no `AddKeypressEvent`:

```js
var sidebar = document.getElementById($parameters.WidgetId);
var focusableEls = sidebar.querySelectorAll('a[href]:not([disabled]),[tabindex="0"], button:not([disabled]), textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]),input[type="submit"]:not([disabled]), select:not([disabled])');
var firstFocusableEl = focusableEls[0]; 
var lastFocusableEl = focusableEls[focusableEls.length - 1];
var keycodeTab = 9;
var keycodeEscape = 27;

var onSidebarKeypress = function(e) {
    var isTabPressed = (e.key === 'Tab' || e.keyCode === keycodeTab);
    var isEscapedPressed = (e.key === 'Escape' || e.keyCode === keycodeEscape);
    
    if(!isTabPressed && !isEscapedPressed) {
        return;
    }
    
    if(e.keyCode === keycodeEscape && sidebar.classList.contains("sidebar-open")) {
        $actions.OnParametersChanged();
        sidebar.removeEventListener('keydown', onSidebarKeypress);
    }
    
    if ( e.shiftKey ) /* shift + tab */ {
        if (document.activeElement === firstFocusableEl) {
            lastFocusableEl.focus();
            e.preventDefault();
        }
    } else if (document.activeElement === lastFocusableEl) {
        firstFocusableEl.focus();
        e.preventDefault();
    } 
};

sidebar.addEventListener('keydown', onSidebarKeypress);

focusableEls = [].slice.call(focusableEls);

// Toggle tabindex value if Sidebar is closed or open
if(sidebar.classList.contains("sidebar-open")) {
    // apply tabindex = -1 by default to disable the navigation inside the sidebar when is hidden
    focusableEls.forEach(function(item) {
        item.setAttribute('tabindex', '0');
    }); 
} else {
    focusableEls.forEach(function(item) {
        item.setAttribute('tabindex', '-1');
    }); 
}

 





```

`OnReady` / no `InitWeb`:

```js
var el = document.getElementById($parameters.WidgetId).parentNode.id;

$actions.MoveElement(el, ".active-screen .content-top");   

```

`OnReady` / no `CheckRenderBar`:

```js
$parameters.RenderMenu = document.querySelector('.active-screen .app-menu-icon.back') === null;
```

`OnReady` / no `InitMobile`:

```js
var el = document.getElementById($parameters.WidgetId).parentNode.id;
var layout = document.querySelector('.layout');

if(layout) {
    var nativeLayout = layout.classList.contains('layout-native');
    
    if(nativeLayout) { // new native layouts
        $actions.MoveElement(el, ".active-screen .content-top");   
    } else {// Old native layouts
        $actions.MoveElement(el, ".active-screen .content-top");
    }
}



```

`OnReady` / no `CheckIsSidebarList`:

```js
var element = document.getElementById($parameters.WidgetId).closest('.list');

if(element){
    $parameters.IsList = true;
} else {
    $parameters.IsList = false;
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Sidebar1","source":"IMobileBlock:DEPRECATED_Sidebar","as":"$b"}
{"op":"set","target":"$b/IsOpen","prop":"Value","value":"<Boolean>"}
{"op":"create","parent":"$b/Header","type":"IExpression","as":"$eHeader"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnToggle` resolve o IEventHandler pelo nome do evento e `$b/OnToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_Sidebar1_OnToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnToggle","prop":"Handler","value":"$h"}
```
