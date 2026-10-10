# StackedCards

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 14 widgets internos

Stacked cards with multiple items. For dynamic content, use a List directly inside the content placeholder.

The content to show when swipe left, right and top is dynamic and must be set by the user.

Ideal for creating a message board or display multiple images.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StackedOptions | StackedCardsPosition Identifier | nao | Entities.StackedCardsPosition.Bottom | Change stacked cards view from bottom, top or none. |
| Rotate | Boolean | nao | True | Activate the elements' rotation for each move on stacked cards. |
| Items | Integer | nao | 5 | Number of visible elements when the stacked options are bottom or top. |
| ElementsMargin | Integer | nao | 5 | Define the distance of each element when the stacked options are bottom or top. |
| UseOverlays | Boolean | nao | True | Enable or disable the overlays for swipe elements. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.StackedCardsPosition**: Bottom, Top, None

## Placeholders

- **Content**: Add content to create stacked cards Items. (em `stackedcards/content`) | nasce com: List (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **OverlayTop**: Add your icon, image or text to be shown for swipe top action. (em `stackedcards/content`)
- **OverlayRight**: Add your icon, image or text to be shown for swipe right action. (em `stackedcards/content`)
- **OverlayLeft**: Add your icon, image or text to be shown for swipe left action. (em `stackedcards/content`)

## Eventos

- **OnRightSwipe**(CurrentPosition: Integer): Triggered when swipe right.
- **OnItemChange**(CurrentPosition: Integer): Return active card's position.
- **OnLeftSwipe**(CurrentPosition: Integer): Triggered when swipe left.
- **OnTopSwipe**(CurrentPosition: Integer): Triggered when swipe top.

## Composicao interna

- Usa os blocos: TouchEvents, MouseEvents
- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnSwipeLeft, UpdateLastActive_A11S, SetZindex, CountElements, ResetOverlays, OnActionLeft, ResetOverlayRight, SetActiveHidden, OnReady, CurrentElement, OnListRemoveUpdate, GestureStart, OnActionRight, OnSwipeTop, BackToMiddle, GestureMove, Init, RemoveNoTransition, OnActionTop, UpdateUi, OnSwipeRight, TransformUi, GestureEnd, ResetOverlayLeft

## JavaScript

`UpdateLastActive_A11S` / no `UpdateLastActive_A11S`:

```js
requestAnimationFrame(function(){
    $parameters.ListElNodesObj[$parameters.CurrentPosition].setAttribute('aria-hidden', true);
    $parameters.ListElNodesObj[$parameters.CurrentPosition].style.opacity = 0;
});


```

`SetZindex` / no `SetZindex`:

```js
if($parameters.ListElNodesObj[$parameters.CurrentPosition]){
    $parameters.ListElNodesObj[$parameters.CurrentPosition].style.zIndex = $parameters.Zindex;
}



```

`CountElements` / no `CountElements`:

```js
$parameters.MaxElements = $parameters.ListElNodesObj.length;
```

`ResetOverlays` / no `ResetOverlays`:

```js
setTimeout(function(){
    
    var elTrans;
    
    if($parameters.StackedOptions === "Top"){
        
        elTrans = $parameters.ElementsMargin * ($parameters.Items - 1);
    
    } else if($parameters.StackedOptions === "Bottom" || $parameters.StackedOptions === "None"){
        
        elTrans = 0;
        
    }
    
    if(!$parameters.IsFirstTime){
        
        $parameters.LeftObj.classList.add('no-transition');
        $parameters.RightObj.classList.add('no-transition');
        $parameters.TopObj.classList.add('no-transition');
        
    }
    requestAnimationFrame(function(){
        $parameters.LeftObj.style.transform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.LeftObj.style.webkitTransform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.LeftObj.style.opacity = '0';
        
        $parameters.RightObj.style.transform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.RightObj.style.webkitTransform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.RightObj.style.opacity = '0';
        
        $parameters.TopObj.style.transform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.TopObj.style.webkitTransform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.TopObj.style.opacity = '0';
    });
    
},300);


```

`OnActionLeft` / no `OnActionLeft`:

```js
if($parameters.UseOverlays) {
    $parameters.LeftObj.classList.remove('no-transition');
    $parameters.TopObj.classList.remove('no-transition');
    $parameters.LeftObj.style.zIndex = '8';
}

setTimeout(function() {
    $actions.OnSwipeLeft();
    $actions.ResetOverlayLeft();
},300);
```

`ResetOverlayRight` / no `ResetOverlayRight`:

```js
setTimeout(function(){
    
    var elTrans;
    
    if($parameters.StackedOptions === "Top"){
        
        elTrans = $parameters.ElementsMargin * ($parameters.Items - 1);
    
    } else if($parameters.StackedOptions === "Bottom" || $parameters.StackedOptions === "None"){
        
        elTrans = 0;
    
    }
    
    if(!$parameters.IsFirstTime){
        
        $parameters.RightObj.classList.add('no-transition');
        $parameters.TopObj.classList.add('no-transition');
        
    }
    
    requestAnimationFrame(function(){
        
        $parameters.RightObj.style.transform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.RightObj.style.webkitTransform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.RightObj.style.opacity = '0';
        
        $parameters.TopObj.style.transform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.TopObj.style.webkitTransform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.TopObj.style.opacity = '0';
    
    });
    
},300);


```

`SetActiveHidden` / no `SetActiveHiddenElement`:

```js
$parameters.ListElNodesObj[$parameters.CurrentPosition - 1].classList.remove('stackedcards-active');
$parameters.ListElNodesObj[$parameters.CurrentPosition - 1].classList.add('stackedcards-hidden');
$parameters.ListElNodesObj[$parameters.CurrentPosition - 1].setAttribute('aria-hidden', true);
$parameters.ListElNodesObj[$parameters.CurrentPosition].classList.add('stackedcards-active');
$parameters.ListElNodesObj[$parameters.CurrentPosition].setAttribute('aria-hidden', false);
```

`OnReady` / no `WaitListRender`:

```js
var obj = document.getElementById($parameters.WidgetId);
var listEl = obj.querySelector('.stackedcards-container .list');
var timeoutVar;
var listElNodes;

var waitListRender = function() {
    if(!listEl.classList.contains("list-loading")) {
        listElNodes = listEl.childNodes;
        $actions.Init(listElNodes);
    } else {
        timeoutVar = setTimeout(waitListRender, 100);
    }
};

    if(!listEl) {
        listEl = obj.querySelector('.stackedcards-container');
        listElNodes = listEl.childNodes;
        $actions.Init(listElNodes);
    } else {
        waitListRender();
    }

```

`CurrentElement` / no `GetCurrentElement`:

```js
$parameters.CurElObj = $parameters.ListElNodesObj[$parameters.CurrentPosition];
```

`GestureStart` / no `PrepareElements`:

```js
if($parameters.ListElNodesObj[$parameters.CurrentPosition]){
    $parameters.ListElNodesObj[$parameters.CurrentPosition].classList.add('no-transition');
    $actions.SetZindex(6);
    
    if($parameters.UseOverlays){
        $parameters.LeftObj.classList.add('no-transition');
        $parameters.RightObj.classList.add('no-transition');
        $parameters.TopObj.classList.add('no-transition');
    }
    
    if(($parameters.CurrentPosition + 1) < $parameters.MaxElements){
        $parameters.ListElNodesObj[$parameters.CurrentPosition + 1].style.opacity = '1';
    }
    
    $parameters.GetElementHeight = $parameters.ListElNodesObj[$parameters.CurrentPosition].offsetHeight / 3;
}
```

`OnActionRight` / no `OnActionRight`:

```js
if($parameters.UseOverlays) {
    $parameters.RightObj.classList.remove('no-transition');
    $parameters.TopObj.classList.remove('no-transition');
    $parameters.RightObj.style.zIndex = '8';
}
setTimeout(function(){
    $actions.OnSwipeRight();
    $actions.ResetOverlayRight();
},300);
```

`BackToMiddle` / no `RemoveOpacity`:

```js
//roll back the opacity of second element
if(($parameters.CurrentPosition + 1) < $parameters.MaxElements){
    $parameters.ListElNodesObj[$parameters.CurrentPosition + 1].style.opacity = '.8';
}
```

`GestureMove` / no `SetZindexObjs`:

```js
$parameters.LeftObj.style.zIndex = 8;
$parameters.RightObj.style.zIndex = 8;
$parameters.TopObj.style.zIndex = 7;
```

`GestureMove` / no `PreventDefaultWDirection`:

```js
$parameters.Evt.preventDefault();

```

`Init` / no `GetObjectsAndActions`:

```js
var obj = document.getElementById($parameters.WidgetId);
$parameters.StackedCardsObj = obj.querySelector('.stackedcards-container');

// Add actions

$parameters.StackedCardsObj.swipeLeft = function() { $actions.OnSwipeLeft(); };
$parameters.StackedCardsObj.swipeRight = function() { $actions.OnSwipeRight(); };
$parameters.StackedCardsObj.swipeTop = function() { $actions.OnSwipeTop(); };
$parameters.StackedCardsObj.updateUi = function() { $actions.OnListRemoveUpdate(); };
$parameters.StackedCardsObj.resetOverlays = function() { $actions.ResetOverlays(); };
$parameters.StackedCardsObj.leftAction = function() { $actions.OnActionLeft(); };
$parameters.StackedCardsObj.rightAction = function() { $actions.OnActionRight(); };
$parameters.StackedCardsObj.topAction = function() { $actions.OnActionTop(); };

// Get Objects
$parameters.LeftObj = obj.querySelector('.stackedcards-overlay.left');
$parameters.RightObj = obj.querySelector('.stackedcards-overlay.right');
$parameters.TopObj = obj.querySelector('.stackedcards-overlay.top');
$parameters.MessageObj = obj.querySelector('.stackedcards-message');

```

`Init` / no `GetElNodesWidth`:

```js
$parameters.ListElNodesWidth = $parameters.StackedCardsObj.offsetWidth;
$parameters.CurElObj = $parameters.ListElNodesObj[0];





```

`Init` / no `PrepareElements`:

```js
var addMargin = $parameters.ElementsMargin * ($parameters.Items -1) + 'px';

var elTrans;
var element = document.getElementById($parameters.WidgetId);
var arrowLeft = 37;
var arrowRight = 39;
var arrowUp = 38;

// Set accessibility role to list elements
for(var i = 0; i < $parameters.MaxElements; i++){
    $parameters.ListElNodesObj[i].setAttribute('role','listitem');
    $parameters.ListElNodesObj[i].setAttribute('aria-hidden', true); 
}

if($parameters.StackedOptions === "Top"){
    
    for(i = $parameters.Items; i < $parameters.MaxElements; i++){
        $parameters.ListElNodesObj[i].classList.add('stackedcards-top', 'stackedcards--animatable', 'stackedcards-origin-top');
    }
    
    elTrans = $parameters.ElementsMargin * 4;
    
    $parameters.StackedCardsObj.style.marginBottom = addMargin;
    
} else if($parameters.StackedOptions === "Bottom"){
    
    
    for(i = $parameters.Items; i < $parameters.MaxElements; i++){
        $parameters.ListElNodesObj[i].classList.add('stackedcards-bottom', 'stackedcards--animatable', 'stackedcards-origin-bottom');
    }
    
    elTrans = 0;
    
    $parameters.StackedCardsObj.style.marginBottom = addMargin;
    
} else if ($parameters.StackedOptions === "None"){
    
    for(i = $parameters.Items; i < $parameters.MaxElements; i++){
        $parameters.ListElNodesObj[i].classList.add('stackedcards-none', 'stackedcards--animatable');
    }
    
    elTrans = 0;

}
    
for(i = $parameters.Items; i < $parameters.MaxElements; i++){
    $parameters.ListElNodesObj[i].style.zIndex = 0;
    $parameters.ListElNodesObj[i].style.opacity = 0;
    $parameters.ListElNodesObj[i].style.webkitTransform ='scale(' + (1 - ($parameters.Items * 0.04)) +') translateX(0) translateY(' + elTrans + 'px) translateZ(0)';
    $parameters.ListElNodesObj[i].style.transform ='scale(' + (1 - ($parameters.Items * 0.04)) +') translateX(0) translateY(' + elTrans + 'px) translateZ(0)';
    $parameters.ListElNodesObj[i].ariaLabel = i + 1 + ' of ' + $parameters.MaxElements
}

if($parameters.ListElNodesObj[$parameters.CurrentPosition]){
    $parameters.ListElNodesObj[$parameters.CurrentPosition].classList.add('stackedcards-active');
    $parameters.ListElNodesObj[$parameters.CurrentPosition].setAttribute('aria-hidden', false)
}

if($parameters.UseOverlays){
    $parameters.LeftObj.style.transform = 'translateX(0px) translateY(' + elTrans + 'px) translateZ(0px) rotate(0deg)';
    $parameters.LeftObj.style.webkitTransform = 'translateX(0px) translateY(' + elTrans + 'px) translateZ(0px) rotate(0deg)';
    
    $parameters.RightObj.style.transform = 'translateX(0px) translateY(' + elTrans + 'px) translateZ(0px) rotate(0deg)';
    $parameters.RightObj.style.webkitTransform = 'translateX(0px) translateY(' + elTrans + 'px) translateZ(0px) rotate(0deg)';
    
    $parameters.TopObj.style.transform = 'translateX(0px) translateY(' + elTrans + 'px) translateZ(0px) rotate(0deg)';
    $parameters.TopObj.style.webkitTransform = 'translateX(0px) translateY(' + elTrans + 'px) translateZ(0px) rotate(0deg)';
    
} else {
    $parameters.LeftObj.className = '';
    $parameters.RightObj.className = '';
    $parameters.TopObj.className = '';
    
    $parameters.LeftObj.classList.add('stackedcards-overlay-hidden');
    $parameters.RightObj.classList.add('stackedcards-overlay-hidden');
    $parameters.TopObj.classList.add('stackedcards-overlay-hidden');
}

//Remove class init
setTimeout(function() {
    element.classList.remove('init');
},150);

// Add keypress events
var onKeydownPress = function(e){
    
    switch(true) {
        case (e.keyCode === arrowLeft):
            $actions.OnActionLeft();
            break;
        case (e.keyCode === arrowRight):
            $actions.OnActionRight();
            break;
        case (e.keyCode === arrowUp):
            $actions.OnActionTop();
            break;
    }
    
};

element.addEventListener('keydown', onKeydownPress);






```

`RemoveNoTransition` / no `PrepareElements`:

```js
if($parameters.ListElNodesObj[$parameters.CurrentPosition]){
    
    if($parameters.UseOverlays) {
        $parameters.LeftObj.classList.remove('no-transition');
        $parameters.RightObj.classList.remove('no-transition');
        $parameters.TopObj.classList.remove('no-transition');
    }
    
    $parameters.ListElNodesObj[$parameters.CurrentPosition].classList.remove('no-transition');
    $parameters.ListElNodesObj[$parameters.CurrentPosition].style.zIndex = 6;
}

```

`OnActionTop` / no `OnActionTop`:

```js
if($parameters.UseOverlays) {

    $parameters.LeftObj.classList.remove('no-transition');
    $parameters.RightObj.classList.remove('no-transition');
    $parameters.TopObj.classList.remove('no-transition');
    $parameters.TopObj.style.zIndex = '8';
}

setTimeout(function(){
    $actions.OnSwipeTop();
    $actions.ResetOverlays();
},300);
```

`UpdateUi` / no `UpdateUi`:

```js
requestAnimationFrame(function(){
    
    var elTrans = 0;
    var elZindex = 5;
    var elScale = 1;
    var elOpac = 1;
    var elTransTop = $parameters.Items;
    var elTransInc = $parameters.ElementsMargin;
    
    for(var i = $parameters.CurrentPosition; i < ($parameters.CurrentPosition + $parameters.Items); i++){
        if($parameters.ListElNodesObj[i]){
            if(i === $parameters.CurrentPosition){
                 $parameters.ListElNodesObj[i].setAttribute('aria-hidden', false);
            }
            if($parameters.StackedOptions === "Top"){
                
                $parameters.ListElNodesObj[i].classList.add('stackedcards-top', 'stackedcards--animatable', 'stackedcards-origin-top');
                
                if($parameters.UseOverlays){
                    $parameters.LeftObj.classList.add('stackedcards-origin-top');
                    $parameters.RightObj.classList.add('stackedcards-origin-top');
                    $parameters.TopObj.classList.add('stackedcards-origin-top'); 
                }
                
                elTrans = elTransInc * elTransTop;
                elTransTop--;
                
            } else if($parameters.StackedOptions === "Bottom"){
                $parameters.ListElNodesObj[i].classList.add('stackedcards-bottom', 'stackedcards--animatable', 'stackedcards-origin-bottom');
                
                if($parameters.UseOverlays){
                    $parameters.LeftObj.classList.add('stackedcards-origin-bottom');
                    $parameters.RightObj.classList.add('stackedcards-origin-bottom');
                    $parameters.TopObj.classList.add('stackedcards-origin-bottom');
                }
                
                elTrans = elTrans + elTransInc;
                
            } else {
                
                $parameters.ListElNodesObj[i].classList.add('stackedcards-none', 'stackedcards--animatable');
                elTrans = elTrans + elTransInc;
                
            }
           
            $parameters.ListElNodesObj[i].style.transform ='scale(' + elScale + ') translateX(0) translateY(' + (elTrans - elTransInc) + 'px) translateZ(0)';
            $parameters.ListElNodesObj[i].style.webkitTransform ='scale(' + elScale + ') translateX(0) translateY(' + (elTrans - elTransInc) + 'px) translateZ(0)';
            $parameters.ListElNodesObj[i].style.opacity = elOpac;
            $parameters.ListElNodesObj[i].style.zIndex = elZindex;
            
            elScale = elScale - 0.04;
            elOpac = elOpac - (1 / $parameters.Items);
            elZindex--;
        }
    }
    
});


```

`TransformUi` / no `TransformUi`:

```js
requestAnimationFrame(function(){  
    
    var element = $parameters.ElementObj;
    
    var elTrans;

    var rotateElement;
    
    // Function to generate rotate value 
    function RotateRegulator(value) {
       if(value/10 > 15) {
           return 15;
       }
       else if(value/10 < -15) {
           return -15;
       }
       return value/10;
    }
    
    if($parameters.Rotate){
        rotateElement = RotateRegulator($parameters.MoveX);
    } else {
        rotateElement = 0;
    }
    
    if($parameters.StackedOptions === "Top"){
        elTrans = $parameters.ElementsMargin * ($parameters.Items - 1);
        if(element){     
            element.style.webkitTransform = "translateX(" + $parameters.MoveX + "px) translateY(" + ($parameters.MoveY + elTrans) + "px) translateZ(0) rotate(" + rotateElement + "deg)";
            element.style.transform = "translateX(" + $parameters.MoveX + "px) translateY(" + ($parameters.MoveY + elTrans) + "px) translateZ(0) rotate(" + rotateElement + "deg)";
            element.style.opacity = $parameters.Opacity;

            if($parameters.Opacity === 0){
                element.setAttribute('aria-hidden', true)
            } else {
                element.setAttribute('aria-hidden', false)
            }
        }
    } else if($parameters.StackedOptions === "Bottom" || $parameters.StackedOptions === "None"){
        
        if(element){
            element.style.webkitTransform = "translateX(" + $parameters.MoveX + "px) translateY(" + ($parameters.MoveY) + "px) translateZ(0) rotate(" + rotateElement + "deg)";
            element.style.transform = "translateX(" + $parameters.MoveX + "px) translateY(" + ($parameters.MoveY) + "px) translateZ(0) rotate(" + rotateElement + "deg)";
            element.style.opacity = $parameters.Opacity;

            if($parameters.Opacity === 0){
                element.setAttribute('aria-hidden', true)
            } else {
                element.setAttribute('aria-hidden', false)
            }
        }
    
    }
});



```

`GestureEnd` / no `RemoveZindexObj`:

```js
// This is a fix to use with some existing patterns on e.g.: FlipContent
var stackedEle = document.getElementById($parameters.WidgetId);

if(stackedEle) {
    var element = document.getElementById($parameters.WidgetId).querySelector('.stackedcards-container .flip-content')
    
    if(element) {
        $parameters.LeftObj.style.zIndex = null;
        $parameters.RightObj.style.zIndex = null;
        $parameters.TopObj.style.zIndex = null;
    }
}
```

`ResetOverlayLeft` / no `ResetOverlayLeft`:

```js
setTimeout(function(){
    
    var elTrans;
    
    if($parameters.StackedOptions === "Top"){
        
        elTrans = $parameters.ElementsMargin * ($parameters.Items - 1);
    
    } else if($parameters.StackedOptions === "Bottom" || $parameters.StackedOptions === "None"){
        
        elTrans = 0;
    
    }
    
    if(!$parameters.IsFirstTime){
        
        $parameters.LeftObj.classList.add('no-transition');
        $parameters.TopObj.classList.add('no-transition');
        
    }
    
    requestAnimationFrame(function(){
        
        $parameters.LeftObj.style.transform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.LeftObj.style.webkitTransform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.LeftObj.style.opacity = '0';
        
        $parameters.TopObj.style.transform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.TopObj.style.webkitTransform = "translateX(0) translateY(" + elTrans + "px) translateZ(0)";
        $parameters.TopObj.style.opacity = '0';
    
    });
    
},300);

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"StackedCards1","source":"IMobileBlock:StackedCards","empty":true,"as":"$b"}
{"op":"create","parent":"$b/OverlayTop","type":"IExpression","as":"$eOverlayTop"}
{"op":"create","parent":"$b/OverlayRight","type":"IExpression","as":"$eOverlayRight"}
{"op":"create","parent":"$b/OverlayLeft","type":"IExpression","as":"$eOverlayLeft"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnRightSwipe` resolve o IEventHandler pelo nome do evento e `$b/OnRightSwipe/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"StackedCards1_OnRightSwipe","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"CurrentPosition","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnRightSwipe","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnRightSwipe/CurrentPosition","prop":"Value","value":"CurrentPosition"}
```
