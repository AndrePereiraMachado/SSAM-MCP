# ActionSheet

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 17 widgets internos

Menu with several buttons and a slide-up animation. You can also use action sheets to prompt the user to confirm a potentially dangerous action. 

There should only be one action sheet per screen and it should contain links or buttons. In use cases with dynamic content, if you want to change the content of an action sheet, you should edit the existing content accordingly.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsOpen | Boolean | sim |  | Assign a varibable to open / close the Action Sheet |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Button1**: Placeholder for Button 1 (em `ActionSheetContainer/content/content/ActionSheetButtons/content`)
- **Button2**: Placeholder for Button 2 (em `ActionSheetContainer/content/content/ActionSheetButtons/content`)
- **Button3**: Placeholder for Button 3 (em `ActionSheetContainer/content/content/ActionSheetButtons/content`)
- **Button4**: Placeholder for Button 4 (em `ActionSheetContainer/content/content/ActionSheetButtons/content`)
- **Button5**: Placeholder for Button 5 (em `ActionSheetContainer/content/content/ActionSheetButtons/content`)

## Eventos

- **OnClose**(): Action to execute after closing the Action Sheet

## Composicao interna

- Ciclo de vida: OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: ToggleActionSheet, OnDestroy, OnParametersChanged, OnCancelClick, OnReady, SetTabindex, FocusTrap

## JavaScript

`ToggleActionSheet` / no `ToggleActionSheet`:

```js
var actionSheetAnimatableClass = 'action-sheet-container--animatable';
var actionSheet = document.getElementById($parameters.WidgetId);
actionSheet.classList.add(actionSheetAnimatableClass);
var firstButton = actionSheet.getElementsByTagName('BUTTON');

function OnTransitionEnd() {
    actionSheet.classList.remove(actionSheetAnimatableClass);
    
    setTimeout(function(){
        if(actionSheet.classList.contains('action-sheet-container--visible')){
            firstButton[0].focus();
        }
    }, 0)
    
    actionSheet.removeEventListener("transitionend", OnTransitionEnd, false);
}

if($parameters.IsOpen){
    $parameters.ActiveDOMElem = document.activeElement;
    actionSheet.classList.add('action-sheet-container--visible');
    actionSheet.addEventListener('keydown', $actions.FocusTrap);
}
else{
    actionSheet.classList.remove('action-sheet-container--visible');
    actionSheet.removeEventListener('keydown', $actions.FocusTrap);
}

actionSheet.addEventListener("transitionend", OnTransitionEnd, false);
```

`OnDestroy` / no `RemoveDOMActionSheet`:

```js
$parameters.DOMElem.remove();
```

`OnCancelClick` / no `FocusActiveDOMElem`:

```js
var actionSheet = document.getElementById($parameters.WidgetId).querySelector('.action-sheet');

function OnTransitionEnd() {
    $parameters.ActiveDOMElem.focus(); 
    actionSheet.removeEventListener("transitionend", OnTransitionEnd, false);
}

if($parameters.ActiveDOMElem) {
    actionSheet.addEventListener("transitionend", OnTransitionEnd, false);
}
```

`OnReady` / no `AddMenuItemRole`:

```js
var buttonWrapper = document.getElementById($parameters.Buttons);
var buttons = buttonWrapper.querySelectorAll('.action-sheet-actions');

for(var i = 0; i < buttons.length; i++){
    var buttonsChildren = buttons[i].children;
    
    for(var a = 0; a < buttonsChildren.length; a++) {
        buttonsChildren[a].setAttribute('role', "menuitem");
    }
}
```

`OnReady` / no `InitMobile`:

```js
var layout = document.querySelector('.layout');

if(layout) {
    var nativeLayout = layout.classList.contains('layout-native');
    
    if(nativeLayout) { // new native layouts
        $actions.MoveElement($parameters.WidgetId, ".active-screen .main");
    } else {// Old native layouts
        $actions.MoveElement($parameters.WidgetId, ".active-screen .screen"); 
    }
}

```

`OnReady` / no `InitWeb`:

```js
$actions.MoveElement($parameters.WidgetId, ".active-screen .content-top");
```

`OnReady` / no `GetDOMElem`:

```js
$parameters.DOMElem = document.getElementById($parameters.WidgetId);
```

`SetTabindex` / no `SetTabindex`:

```js
var buttonWrapper = document.getElementById($parameters.Buttons);
var buttons = buttonWrapper.querySelectorAll('.action-sheet-actions');

for(var i = 0; i < buttons.length; i++){
    var buttonsChildren = buttons[i].children;
    
    for(var a = 0; a < buttonsChildren.length; a++) {
        if($parameters.IsOpen) {
           buttonsChildren[a].setAttribute('tabindex', "0");
        } else {
           buttonsChildren[a].setAttribute('tabindex', "-1");
        }
    }
}
```

`FocusTrap` / no `FocusTrap`:

```js
// Elements
var actionSheet = document.getElementById($parameters.WidgetId);
var cancelButton = document.getElementById($parameters.CancelButtonId);
var buttonWrapper = document.getElementById($parameters.Buttons);
var buttons = actionSheet.getElementsByTagName('BUTTON');
var firstButton = buttons[0];

var _focusableElems = 'a[href]:not([disabled]),[tabindex="0"], button:not([disabled]), textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]),input[type="submit"]:not([disabled]), select:not([disabled])';
var _focusableActionSheetElements = buttonWrapper.querySelectorAll(_focusableElems);
var _currentFocusedElementIndex = Array.from(_focusableActionSheetElements).findIndex(element => element.isEqualNode(document.activeElement));

// get event from eventListener
var e = $parameters.Event;

// Keycodes
var isTabPressed = (e.keyCode == "9");
var isShiftKey = e.shiftKey;
var isEsc = (e.keyCode == "27");
var isArrowDownPressed = e.key === "ArrowDown";
var isArrowUpPressed = e.key === "ArrowUp";


var setFocusTrap = function(){
    
    // Close on Esc
    if(isEsc) {
        $actions.OnCancelClick();
    }

    if(isTabPressed){
        // Focus trap to circle all buttons inside
        if(isShiftKey) {
            if(document.activeElement === firstButton) {
                cancelButton.focus();
                e.preventDefault();
            }
        } else if (document.activeElement === cancelButton){
            firstButton.focus();
            e.preventDefault();
        }
    }
    
    if(isArrowDownPressed || isArrowUpPressed){
        if (_focusableActionSheetElements.length === 0) {
        _currentFocusedElementIndex = undefined;
        } else if (isArrowDownPressed) {
            // If the _currentFocusedElementIndex is undefined or is the last one
            // Then move the focus to the first focusable element
            if (
                _currentFocusedElementIndex === undefined ||
                _currentFocusedElementIndex >= _focusableActionSheetElements.length - 1
            )
                _currentFocusedElementIndex = 0;
            // Otherwise, move the focus to the next focusable element
            else _currentFocusedElementIndex = _currentFocusedElementIndex + 1;
        }
        // When ArrowUp is pressed
        else if (isArrowUpPressed) {
            // If the _currentFocusedElementIndex is undefined or is the first one
            // Then move the focus to the last focusable element
            if (_currentFocusedElementIndex === undefined || _currentFocusedElementIndex === 0)
                _currentFocusedElementIndex = _focusableActionSheetElements.length - 1;
            // Otherwise, move the focus to the previous focusable element
            else _currentFocusedElementIndex = _currentFocusedElementIndex - 1;
        }

        // If the _currentFocusedElementIndex is undefined, focus on the balloon wrapper
        if (_currentFocusedElementIndex === undefined) {
            buttonWrapper.focus();
            // Otherwise, focus on the element corresponding ot the _currentFocusedElementIndex
        } else {
            _focusableActionSheetElements[_currentFocusedElementIndex].focus();
        }
    }
}();
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ActionSheet1","source":"IMobileBlock:ActionSheet","as":"$b"}
{"op":"set","target":"$b/IsOpen","prop":"Value","value":"<Boolean>"}
{"op":"create","parent":"$b/Button1","type":"IExpression","as":"$eButton1"}
{"op":"create","parent":"$b/Button2","type":"IExpression","as":"$eButton2"}
{"op":"create","parent":"$b/Button3","type":"IExpression","as":"$eButton3"}
{"op":"create","parent":"$b/Button4","type":"IExpression","as":"$eButton4"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClose` resolve o IEventHandler pelo nome do evento e `$b/OnClose/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"ActionSheet1_OnClose","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClose","prop":"Handler","value":"$h"}
```
