# DEPRECATED_FloatingActions

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 28 widgets internos

Button that displays a group of buttons when pressed. Should be placed inside a Bottom Bar or the Content placeholder.

## Inputs

Nenhum.

## Placeholders

- **Button1**: Placeholder for Button 1 (em `FloatingActions/content/content/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Icon1** (em `FloatingActions/content/content/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Button2**: Placeholder for Button 2 (em `FloatingActions/content/content/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Icon2** (em `FloatingActions/content/content/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Button3**: Placeholder for Button 3 (em `FloatingActions/content/content/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Icon3** (em `FloatingActions/content/content/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Button4**: Placeholder for Button 4 (em `FloatingActions/content/content/content`)
- **Icon4** (em `FloatingActions/content/content/content`)
- **Button5**: Placeholder for Button 5 (em `FloatingActions/content/content/content`)
- **Icon5** (em `FloatingActions/content/content/content`)

## Eventos

- **OnToggle**(): Event fired after the floating actions are toggled

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnReady -> OnReady
- Actions do bloco: ToogleFloatingActions, OnReady, OnInitialize

## JavaScript

`ToogleFloatingActions` / no `HideBackground`:

```js
var menuIcon = document.querySelector(".app-menu-burger");
var textItems = document.querySelectorAll('.floating-actions-item');
var iconItems = document.querySelectorAll('.floating-actions-item-icon');
var hasContent = false;

for(var i = 0; i < textItems.length; i++) {
    var text = textItems[i];
    var icon = iconItems[i].children;
    
    if(text.innerHTML !== '') {
        hasContent = true;
    }
    
    if(icon.length !== 0) {
        hasContent = true;
    }
}

$parameters.ShowContent = hasContent;

if(!hasContent && menuIcon) {
    document.querySelector('.floating-actions').querySelector(".floating-actions-background").style.opacity = 0;
}
```

`ToogleFloatingActions` / no `OpenFloatingActions`:

```js
function OnTransitionEnd() {
    FloatingActions.classList.remove('floating-actions--animatable');  
}

var FloatingActions = document.getElementById($parameters.WidgetId);

FloatingActions.classList.add('floating-actions--animatable');

if($parameters.ShowContent) {
    FloatingActions.classList.add('floating-actions--visible');
}

FloatingActions.addEventListener("transitionend", OnTransitionEnd, false);
```

`ToogleFloatingActions` / no `CloseFloatingActions`:

```js
function OnTransitionEnd() {
    FloatingActions.classList.remove('floating-actions--animatable');  
}

var FloatingActions = document.getElementById($parameters.WidgetId);

FloatingActions.classList.add('floating-actions--animatable');

if($parameters.ShowContent) {
    FloatingActions.classList.remove('floating-actions--visible');
}

FloatingActions.addEventListener("transitionend", OnTransitionEnd, false);
```

`OnReady` / no `Init`:

```js
var el = document.getElementById($parameters.WidgetId);
var elPos = el.getBoundingClientRect();
var bodyPos = document.body.getBoundingClientRect();
var bottomBar = document.querySelector(".active-screen .bottom-bar");
var bottomBarHeight;
var insideBottomBar;
var align;

if(bottomBar && el) {
    insideBottomBar = bottomBar.contains(el);
}

if(!insideBottomBar && el) {
    $actions.MoveElement($parameters.WidgetId, ".active-screen .screen");

    if(bottomBar) {
        el.querySelector(".floating-actions-icon").classList.add("bottom-bar-exists");
    }
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_FloatingActions1","source":"IMobileBlock:DEPRECATED_FloatingActions","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnToggle` resolve o IEventHandler pelo nome do evento e `$b/OnToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_FloatingActions1_OnToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnToggle","prop":"Handler","value":"$h"}
```
