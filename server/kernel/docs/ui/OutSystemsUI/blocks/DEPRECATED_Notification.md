# DEPRECATED_Notification

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 6 widgets internos

Simple notification Block displayed on top of the screen. Has a placeholder for content and can be used to call user actions.

Drag to the screen, add the notificaction content and bind the variable to control the visibility of the message.

Ideal to create a native looking notification message.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsOpen | Boolean | sim |  | Is notification visible on the screen |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Add content to this placeholder (em `notification/content`)

## Eventos

- **OnClose**(): Event triggered when the Notification is closed.

## Composicao interna

- Usa os blocos: TouchEvents
- Ciclo de vida: OnParametersChanged -> OpenCloseNotification; OnReady -> OnReady
- Actions do bloco: OnGestureMove, OnGestureEnd, OnReady, OnNotificationClose, OpenCloseNotification, UpdateUI, OnGestureStart

## JavaScript

`OnGestureMove` / no `JsPreventDefaultWDirection`:

```js
$parameters.Evt.preventDefault();
```

`OnGestureMove` / no `JsUpdateUI`:

```js
requestAnimationFrame($actions.UpdateUI);
```

`OnGestureEnd` / no `JsAnimateLeaveScreen`:

```js
var Notification = document.getElementById($parameters.Id);

Notification.style.transform = '';
Notification.style.webkitTransform = '';
```

`OnGestureEnd` / no `JsAnimateEnterScreen`:

```js
var Notification = document.getElementById($parameters.Id);

Notification.classList.add('notification--animatable');

Notification.style.transform = '';
Notification.style.webkitTransform = '';
```

`OnReady` / no `JsAddKeypressEvent`:

```js
var Notification = document.querySelector('.notification');

Notification.addEventListener('keydown', function(e){
    if (e.keyCode == "27" && document.activeElement === Notification) {
        $actions.OnNotificationClose();
    } 
});
```

`OnReady` / no `JsInitMobile`:

```js
var Notification = document.querySelector('.notification');
var layout = document.querySelector('.layout');

if(layout) {
    var nativeLayout = layout.classList.contains('layout-native');
    
    if(nativeLayout) { // new native layouts
        $actions.MoveElement($parameters.WidgetId, ".active-screen .main");
    } else {// Old native layouts
        $actions.MoveElement($parameters.WidgetId, ".active-screen .screen"); 
    }
}

if($parameters.IsOpen) {
    Notification.classList.add('notification--visible');
    Notification.focus();
} else {
    Notification.classList.remove('notification--visible');
}

```

`OnReady` / no `JsInitWeb`:

```js
var Notification = document.querySelector('.notification');

$actions.MoveElement($parameters.WidgetId, ".active-screen .content-top");

if($parameters.IsOpen) {
    Notification.classList.add('notification--visible');
    Notification.focus();
} else {
    Notification.classList.remove('notification--visible');
}
```

`OpenCloseNotification` / no `JsCloseNotification`:

```js
function OnTransitionEnd() {
    Notification.classList.remove('notification--animatable'); 
    Notification.removeEventListener('transitionend', OnTransitionEnd, false);
}

var Notification = document.getElementById($parameters.Id);

Notification.classList.add('notification--animatable');
Notification.classList.remove('notification--visible'); 

Notification.addEventListener("transitionend", OnTransitionEnd, false);
```

`OpenCloseNotification` / no `JsOpenNotification`:

```js
function OnTransitionEnd() {
    Notification.classList.remove('notification--animatable');
    Notification.focus();
    Notification.removeEventListener("transitionend", OnTransitionEnd, false);
}

var Notification = document.getElementById($parameters.Id);

Notification.classList.add('notification--animatable');
Notification.classList.add('notification--visible');

Notification.addEventListener("transitionend", OnTransitionEnd, false);
```

`UpdateUI` / no `JsMoveNotification`:

```js
requestAnimationFrame($actions.UpdateUI);

var el = document.getElementById($parameters.Id);

el.style.transform =  "translateY(" + $parameters.OffsetY + "px) translateZ(0)";
el.style.webkitTransform =  "translateY(" + $parameters.OffsetY + "px) translateZ(0)";
```

`OnGestureStart` / no `JsCleanAnimationClasses`:

```js
var el = document.getElementById($parameters.Id);

$parameters.Height = el.offsetHeight;

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Notification1","source":"IMobileBlock:DEPRECATED_Notification","as":"$b"}
{"op":"set","target":"$b/IsOpen","prop":"Value","value":"<Boolean>"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClose` resolve o IEventHandler pelo nome do evento e `$b/OnClose/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_Notification1_OnClose","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClose","prop":"Handler","value":"$h"}
```
