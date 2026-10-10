# DEPRECATED_Carousel

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 16 widgets internos

A Carousel with multiple items in an horizontal slide. Elements inside the placeholder will be split in different items. For dynamic content, use a List directly inside the placeholder.

To use a Carousel with images on Firefox, the attribute "draggable=false" needs to be added to each image in order to allow the mouse events to grab the element and drag it.

The Carousel block is ideal to create horizontal slides in smaller screens.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Navigation | Boolean | nao | False | Arrows to navigate left and right. |
| Dots | Boolean | nao | True | Dots representing all items, which can be tapped to navigate directly to a given item. |
| Margin | Integer | nao | 0 | Distance between each Carousel item. |
| Padding | Integer | nao | 0 | Distance between the screen edges and the visible items on the screen. |
| Autoplay | Autoplay Identifier | nao | Entities.Autoplay.Disabled | Enable or disable the autoplay, and set autoplay's velocity. |
| Scale | Boolean | nao | False | Use the scale option for active carousel item. When dragging the active element, the scale begins to decrease and the next / previous element that becomes active increases. |
| Loop | Boolean | nao | False | Enable continuous slide of the Carousel even after it reaches the end. |
| Center | Boolean | nao | False | Display the active item centered horizontally. |
| InitialPosition | Integer | nao | 0 | Set the first element to show. |
| ItemsPhone | Integer | nao | 1 | Number of visible Carousel items at the same time on the screen, on Phone. |
| ItemsTablet | Integer | nao | 1 | Number of visible Carousel items at the same time on the screen, on Tablet. |
| ItemsDesktop | Integer | nao | 1 | Number of visible Carousel items at the same time on the screen, on Desktop. |

Valores possiveis (static entities):

- **Entities.Autoplay**: Fast, Disabled, Slow, Normal

## Placeholders

- **CarouselItems**: Add content to create Carousel Items. (em `carousel/content/content`) | nasce com: List (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnItemChange**(Index: Integer): Return active item's current position.

## Composicao interna

- Usa os blocos: TouchEvents, MouseEvents
- Scripts exigidos: DEPRECATED_Carousel
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: Init, OnParametersChanged, GestureMove, OnOrientationChange, OnReady, Update, SetEventsStatus, GoTo, OnDestroy, ChangeIsAnimatingStatus, GestureEnd, Previous, GestureStart, ClearInterval, SetInterval, Next, OnInitialize

## JavaScript

`Init` / no `InitCarousel`:

```js
var element = document.getElementById($parameters.WidgetId);
element = element.querySelector('.carousel-container-content');
var isRTL = $actions.IsRTL() === true;

// Add actions
element.next = function() { isRTL ? $actions.Previous() : $actions.Next() };
element.previous = function() { isRTL ? $actions.Next() : $actions.Previous() };
element.goto = function(i) { $actions.GoTo(i); };
element.updateCarousel = function() { $actions.Update(); };

```

`GestureMove` / no `TransformUi`:

```js
$parameters.CarouselObj.gestureMove($parameters.OffsetX);
$parameters.Evt.preventDefault();
```

`GestureMove` / no `AddNoTransitionClasses`:

```js
$parameters.CarouselObj.addNoTransitionClasses();
```

`OnOrientationChange` / no `OnOrientationChange`:

```js
$parameters.CarouselObj.onOrientationChange();
```

`OnReady` / no `CallingInit`:

```js
window.addEventListener('orientationchange', $actions.OnOrientationChange);
$parameters.CarouselObj = new newCarousel();

var previousArrow = document.getElementById($parameters.PreviousArrow);
var nextArrow = document.getElementById($parameters.NextArrow);

previousArrow.addEventListener('click', function(e){
    e.stopPropagation();
    e.preventDefault();
    $actions.Previous();
});

nextArrow.addEventListener('click', function(e){
    e.stopPropagation();
    e.preventDefault();
    $actions.Next();
});

var onKeyDownPress = function(e){
    //If enter or space use 
    if (e.keyCode == "32" || e.keyCode == "13") {
        if(e.currentTarget === nextArrow){
            $actions.Next();
        } else {
            $actions.Previous();
        }
        e.preventDefault();
        e.stopPropagation();
    }
};

previousArrow.addEventListener('keydown', onKeyDownPress);

nextArrow.addEventListener('keydown', onKeyDownPress);

var opts = {
    
    //OS parameters
    widgetId: $parameters.WidgetId,
    margin: $parameters.Margin,
    padding: $parameters.Padding,
    initialPosition: $parameters.InitialPosition,
    itemsPhone: $parameters.ItemsPhone,
    itemsTablet: $parameters.ItemsTablet,
    itemsDesktop: $parameters.ItemsDesktop,
    center: $parameters.Center,
    scale: $parameters.Scale,
    loop: $parameters.Loop,
    dots: $parameters.Dots,
    currentDevice: $parameters.currentDevice,
    isRTL: $parameters.IsRTL,
    
    //OS actions
    initAction: $actions.Init(),
    goToAction: $actions.GoTo,
    setEventsStatus: $actions.SetEventsStatus
};

$parameters.CarouselObj.init(opts);
```

`Update` / no `Update`:

```js
$parameters.CarouselObj.updateCarousel();
```

`GoTo` / no `GetMaxElements`:

```js
$parameters.MaxElements = $parameters.CarouselObj.getMaxElements();
```

`GoTo` / no `GoToLast`:

```js
$parameters.CarouselObj.goTo($parameters.Target);
```

`GoTo` / no `GoToTarget`:

```js
$parameters.CarouselObj.goTo($parameters.Target);
```

`OnDestroy` / no `RemoveListnerOnOrientation`:

```js
window.removeEventListener('orientationchange', $actions.OnOrientationChange);
$parameters.CarouselObj.destroy();
```

`GestureEnd` / no `PrepareElements`:

```js
$parameters.CarouselObj.removeNoTransitionClasses();
$parameters.ElementWidth = $parameters.CarouselObj.getNodeWidth();
```

`GestureEnd` / no `ChangeIsAnimatingStatus`:

```js
var TimeoutClear = setTimeout(function(){
    $actions.ChangeIsAnimatingStatus();
    clearTimeout(TimeoutClear);
},300);
```

`GestureEnd` / no `BackToMiddle`:

```js
$parameters.CarouselObj.backToMiddle();
```

`Previous` / no `Previous`:

```js
if($parameters.IsRTL) {
    $parameters.CarouselObj.next();
} else {
    $parameters.CarouselObj.previous();
}
```

`GestureStart` / no `RemoveNoTransition`:

```js
var el = document.getElementById($parameters.Id);
var carouselContent = el.querySelector(".carousel-container-content");

carouselContent.classList.remove("no-transition");
```

`GestureStart` / no `AddNoTransitionClasses`:

```js
$parameters.CarouselObj.addNoTransitionClasses();
```

`GestureStart` / no `CheckIfContainsClass`:

```js
var carouselSwipe = document.getElementById($parameters.CarouselId);

if(carouselSwipe.classList.contains('no-swipe')){
    $parameters.ContainsClass = true;
} else {
    $parameters.ContainsClass = false;
}
```

`ClearInterval` / no `ClearInterval`:

```js
clearInterval($parameters.AutoplayObj);
```

`SetInterval` / no `AutoplayLoop`:

```js
$parameters.AutoplayObj = setInterval(function(){
    if($parameters.IsRTL) {
        $actions.Previous();
    } else {
        $actions.Next();
    }
},$parameters.Autoplay);
```

`Next` / no `Next`:

```js
if($parameters.IsRTL) {
    $parameters.CarouselObj.previous();
} else {
    $parameters.CarouselObj.next();
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Carousel1","source":"IMobileBlock:DEPRECATED_Carousel","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnItemChange` resolve o IEventHandler pelo nome do evento e `$b/OnItemChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_Carousel1_OnItemChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Index","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnItemChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnItemChange/Index","prop":"Value","value":"Index"}
```
