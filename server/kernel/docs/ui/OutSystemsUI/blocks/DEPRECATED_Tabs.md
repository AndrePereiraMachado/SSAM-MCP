# DEPRECATED_Tabs

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 21 widgets internos

Set of Tabs with placeholders for Title and Content.

Fill in the headers and respective content areas of the tabs to be displayed. Empty tabs will not be rendered.

Used to display large sets of information which can be split into different areas, whilst always remaining a click away.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartingTab | Integer | nao | 0 | Index of the Current Active Tab. |

## Placeholders

- **Tab1** (em `tabs/content/content`)
- **Tab2** (em `tabs/content/content`)
- **Tab3** (em `tabs/content/content`)
- **Tab4** (em `tabs/content/content`)
- **Tab5** (em `tabs/content/content`)
- **TabContent1** (em `tabs/content/tabscontent/content/content/TabContentTab/content`)
- **TabContent2** (em `tabs/content/tabscontent/content/content/TabContentTab2/content`)
- **TabContent3** (em `tabs/content/tabscontent/content/content/TabContentTab3/content`)
- **TabContent4** (em `tabs/content/tabscontent/content/content/TabContentTab4/content`)
- **TabContent5** (em `tabs/content/tabscontent/content/content/TabContentTab5/content`)

## Eventos

- **OnTabChange**(ActiveTab: Integer): Triggered when switching tabs

## Composicao interna

- Usa os blocos: TouchEvents
- Ciclo de vida: OnInitialize -> OnInitialize; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnReady, UpdateUI, AddOverlay, GestureMove, TabsOnClick, GestureEnd, OnOrientationChange, GestureStart, OnDestroy

## JavaScript

`OnReady` / no `setUnderline`:

```js
window.addEventListener('orientationchange', $actions.OnOrientationChange);
var obj = document.getElementById($parameters.Id); 

//Global Action
var element = document.getElementById($parameters.Id).parentElement;
element.changeTab = function(i) { $actions.TabsOnClick(i); };

    var isRTL = document.querySelector('.is-rtl');
    
    if(isRTL) {
        $parameters.IsRTL = true;
    }
    
    setUnderLine(); 
    setRightTab();

function setRightTab() {
    var el = obj.querySelector(".tabs-content-wrapper");
    var width = -(($parameters.ActiveTab) * el.offsetWidth);
    
    if($parameters.IsRTL) {
        width = (($parameters.ActiveTab) * el.offsetWidth);
    }
    
    el.style.transform =  "translateX(" + width + "px) translateZ(0)";
    el.style.webkitTransform =  "translateX(" + width + "px) translateZ(0)";
    
    addOverlay();
}

function setUnderLine() {
    var activeWidth = obj.querySelector(".tabs-header-tab.active").offsetWidth;
    var activeTab = obj.querySelector(".tabs-header-tab.active");
    var tabheaders = obj.querySelectorAll(".tabs-header-tab");
    var tabheadercontent = obj.querySelector(".tabs-header-content");
    var position = 0;
    
    for(var i = 0; i < tabheaders.length; i++) {
        tabheaders[i].style.transform =  "translateX(0) translateZ(0)";
        
        if(!tabheaders[i].classList.contains("active")) {
           position = position + tabheaders[i].offsetWidth;
        } else {
            break;
        }
    }
}

function addOverlay() {
    //Add Overlay
    var tabHeaderWidth = obj.querySelector(".tabs-header");
    var tabheaders = obj.querySelectorAll(".tabs-header-tab");
    var tabOverlay = element.querySelector(".tabs-overlay");
    var tabWidth = 0;
    
    for(i = 0; i < tabheaders.length; i++) {
        
        tabWidth = tabWidth + tabheaders[i].offsetWidth;
        if(tabWidth > (tabHeaderWidth.offsetWidth + 10)) {
            if(tabOverlay.classList.contains("placeholder-empty")){
                tabOverlay.classList.remove("placeholder-empty");
            }
            
            if($parameters.IsRTL) {
                tabOverlay.classList.add("left");
            } else {
                tabOverlay.classList.add("right");
                
            }
            break;
        } else {
            if(!tabOverlay.classList.contains("placeholder-empty")){
                tabOverlay.classList.add("placeholder-empty");
            }
        }
    }
}

```

`UpdateUI` / no `MoveMenu`:

```js
var el = document.getElementById($parameters.Id).querySelector(".tabs-content-wrapper");

el.style.transform =  "translateX(" + $parameters.OffsetX + "px)";
el.style.webkitTransform =  "translateX(" + $parameters.OffsetX + "px)";

requestAnimationFrame($actions.UpdateUI);
```

`AddOverlay` / no `AddOverlay`:

```js
var isRTL = document.querySelector('.is-rtl'); 
var element = document.getElementById($parameters.Id).parentElement;
var tabOverlay = element.querySelector(".tabs-overlay");
var countTabs = element.querySelectorAll(".tabs-header-tab").length -1;
var tabsElement = element.querySelectorAll(".tabs-header-tab");
var countEmptyTabs = element.querySelectorAll(".tabs-header-tab.placeholder-empty");
var isEmpty = 0;

for(i = 0; i < tabsElement.length; i++) {
    
    if(countEmptyTabs[i].childNodes.length === 0) {
       isEmpty = isEmpty + 1;
    }
}
    
setTimeout(function() {
    if($parameters.ActiveTab == (countTabs - isEmpty)) {
        if(isRTL) {
            
            if(tabOverlay.classList.contains("left")){
                tabOverlay.classList.remove("left");
            }
            
        } else {
            
            if(tabOverlay.classList.contains("right")){
                tabOverlay.classList.remove("right");
            }
            
        }
    } else {
        if(isRTL){
            
            if(!tabOverlay.classList.contains("left")){
                tabOverlay.classList.add("left");
            }
            
        } else {
            
            if(!tabOverlay.classList.contains("right")){
                tabOverlay.classList.add("right");
            }
            
        }
    }
}, 0)
```

`GestureMove` / no `UpdateUI`:

```js
requestAnimationFrame($actions.UpdateUI);
```

`GestureMove` / no `RemoveNoTransition`:

```js
var el = document.getElementById($parameters.Id);
var tabsContent = el.querySelector(".tabs-content-wrapper");

tabsContent.classList.remove("no-transition");
```

`GestureMove` / no `CalculateInterval`:

```js
if($parameters.FirstTime) {
    if($parameters.IsRTL) {
    $parameters.interval = (-($parameters.X - $parameters.LastX))/($parameters.TabsNumber * $parameters.TabsWidth);
    } else {
        $parameters.interval = (($parameters.X - $parameters.LastX))/($parameters.TabsNumber * $parameters.TabsWidth);
    }
} else {
    $parameters.interval = $parameters.X - $parameters.LastX;
}

```

`GestureMove` / no `PreventDefaultWDirection`:

```js
$parameters.Evt.preventDefault();

```

`TabsOnClick` / no `SetTabs`:

```js
var obj = document.getElementById($parameters.id);
var moveheadertabs = obj.querySelector(".tabs-header");
var tabheaders = obj.querySelectorAll(".tabs-header-tab");
var scrolltoleftelements = 0;
var allTabsWidth = 0;

function setRightTab() {
    var el = obj.querySelector(".tabs-content-wrapper");
    var width = -(($parameters.ActiveTab) * el.offsetWidth);

    if($parameters.IsRTL) {
        width = ($parameters.ActiveTab) * el.offsetWidth;
    }
          
    el.style.webkitTransform =  "translateX(" + width + "px) translateZ(0)";
    el.style.transform =  "translateX(" + width + "px) translateZ(0)";
}

function setUnderLine() {
    var activeWidth = obj.querySelector(".tabs-header-tab.active").offsetWidth;
    var activeTab = obj.querySelector(".tabs-header-tab.active");
    var position = 0;
    
    for(var i = 0; i < tabheaders.length; i++) {
        if(!tabheaders[i].classList.contains("active")) {
           position = position + tabheaders[i].offsetWidth;
        } else {
            break;
        }
    }

    if($parameters.IsRTL) {
        position = -position;
    }
    
    boundingRight = Math.round(tabheaders[$parameters.ActiveTab].getBoundingClientRect().right);
    screenBoundingWidthRight = moveheadertabs.offsetWidth - 40;
    boundingLeft = Math.round(tabheaders[$parameters.ActiveTab].getBoundingClientRect().left);
    screenBoundingWidthLeft = 40;
    
    if(boundingRight < screenBoundingWidthRight && boundingLeft > 40){
        //do nothing
    } else {
        if($parameters.IsRTL) {
            doRightScroll();
        } else {
            doScroll();
        }
    }
}

function doScroll() {
    
    var tabscount = $parameters.ActiveTab;
    
    for(i = 0; i < tabscount; i++) {
        scrolltoleftelements = scrolltoleftelements + tabheaders[i].offsetWidth;
    }
    
    setTimeout(function(){
        moveheadertabs.scrollLeft = (scrolltoleftelements - ((moveheadertabs.offsetWidth - (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));
    },10);
}

function doRightScroll() {
    
    var tabscount = $parameters.ActiveTab;
    
    if(document.body.classList.contains('android')){
        
        for(i = 0; i < tabscount; i++) {
            scrolltoleftelements = scrolltoleftelements + tabheaders[i].offsetWidth;
        }
        
        for(i = 0; i < tabheaders.length; i++) {
            allTabsWidth = allTabsWidth + tabheaders[i].offsetWidth;
        }
        
        setTimeout(function(){
            
            moveheadertabs.scrollLeft = (allTabsWidth - scrolltoleftelements - ((moveheadertabs.offsetWidth + (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));
            
        },10);
        
    } else {
        
        for(i = 0; i < tabscount; i++) {
            scrolltoleftelements = scrolltoleftelements - tabheaders[i].offsetWidth;
        }
        
        setTimeout(function(){
            
            moveheadertabs.scrollLeft =  (scrolltoleftelements + ((moveheadertabs.offsetWidth - (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));
            //moveheadertabs.scrollLeft = moveheadertabs.offsetWidth - scrolltoleftelements;
            //moveheadertabs.scrollLeft = (scrolltoleftelements + ((moveheadertabs.offsetWidth + (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2)) - (tabheaders[$parameters.ActiveTab].getBoundingClientRect().right - tabheaders[$parameters.ActiveTab].getBoundingClientRect().left);
        
        },10);
        
    }
    
}


setTimeout(function() { 
    setUnderLine(); 
    setRightTab();
}, 10);
```

`GestureEnd` / no `CalculateMiddleLeft`:

```js
$parameters.MiddleX = (($parameters.TabsWidth * $parameters.ActiveTab) + $parameters.TabsWidth)-(1*$parameters.TabsWidth/2)

```

`GestureEnd` / no `SetLeftTabAndHeader`:

```js
var width = -($parameters.ActiveTab * $parameters.TabsWidth);
var obj = document.getElementById($parameters.id);

var el = obj.querySelector('.tabs-content-wrapper');
var moveheadertabs = obj.querySelector('.tabs-header');
var tabheaders = obj.querySelectorAll('.tabs-header-tab');
var scrolltoleftelements = 0;
var allTabsWidth = 0;

if($parameters.IsRTL) {
    width = ($parameters.ActiveTab * $parameters.TabsWidth);
}

el.style.transform =  "translateX(" + width + "px) translateZ(0)";
el.style.webkitTransform =  "translateX(" + width + "px) translateZ(0)";

setTimeout(function() {
    var activeWidth = obj.querySelector('.tabs-header-tab.active').offsetWidth;
    var tabheaders = obj.querySelectorAll('.tabs-header-tab');
    var moveheadertabs = obj.querySelector('.tabs-header');
    var position = 0;
    
    for(var i = 0; i < tabheaders.length; i++) {
        if(!tabheaders[i].classList.contains("active")) {
           position = position + tabheaders[i].offsetWidth;
        } else {
            break;
        }
    }
    
    if($parameters.IsRTL) {
        position = -position;
    }
    
    boundingRight = Math.round(tabheaders[$parameters.ActiveTab].getBoundingClientRect().right);
    screenBoundingWidthRight = moveheadertabs.offsetWidth - 40;
    boundingLeft = Math.round(tabheaders[$parameters.ActiveTab].getBoundingClientRect().left);
    screenBoundingWidthLeft = 40;
    
    if(boundingRight < screenBoundingWidthRight && boundingLeft > 40){
        //do nothing
    } else {
        if($parameters.IsRTL) {
            doRightScroll();
        } else {
            doScroll();
        }
    }
    
}, 0)

function doScroll() {
    
    var tabscount = $parameters.ActiveTab;
    
    for(i = 0; i < tabscount; i++) {
        scrolltoleftelements = scrolltoleftelements + tabheaders[i].offsetWidth;
    }
    
    setTimeout(function(){
        moveheadertabs.scrollLeft = (scrolltoleftelements - ((moveheadertabs.offsetWidth - (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));
    },10);
}

function doRightScroll() {
    
    var tabscount = $parameters.ActiveTab;
    
    if(document.body.classList.contains('android')){
        
        for(i = 0; i < tabscount; i++) {
            scrolltoleftelements = scrolltoleftelements + tabheaders[i].offsetWidth;
        }
        
        for(i = 0; i < tabheaders.length; i++) {
            allTabsWidth = allTabsWidth + tabheaders[i].offsetWidth;
        }
        
        setTimeout(function(){
            
            moveheadertabs.scrollLeft = (allTabsWidth - scrolltoleftelements - ((moveheadertabs.offsetWidth + (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));
            
        },10);
        
    } else {
        
        for(i = 0; i < tabscount; i++) {
            scrolltoleftelements = scrolltoleftelements - tabheaders[i].offsetWidth;
        }
        
        setTimeout(function(){
            
            moveheadertabs.scrollLeft =  (scrolltoleftelements + ((moveheadertabs.offsetWidth - (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));

        },10);
        
    }
    
}

el.classList.remove('no-transition');
```

`GestureEnd` / no `RemoveNoTransition2`:

```js
var obj = document.getElementById($parameters.id);
var el = obj.querySelector('.tabs-content-wrapper');

el.classList.remove("no-transition");
```

`GestureEnd` / no `SetRightTabAndHeader`:

```js
var width = -(($parameters.ActiveTab) * $parameters.TabsWidth);
var obj = document.getElementById($parameters.id);

var el = obj.querySelector(".tabs-content-wrapper");
var moveheadertabs = obj.querySelector(".tabs-header");
var tabheaders = obj.querySelectorAll(".tabs-header-tab");
var scrolltoleftelements = 0;
var allTabsWidth = 0;

if($parameters.IsRTL) {
    width = (($parameters.ActiveTab) * $parameters.TabsWidth);
}

el.style.transform =  "translateX(" + width + "px) translateZ(0)";
el.style.webkitTransform =  "translateX(" + width + "px) translateZ(0)";    


setTimeout(function() {
    var activeWidth = obj.querySelector('.tabs-header-tab.active').offsetWidth;
    var tabheaders = obj.querySelectorAll('.tabs-header-tab');
    var moveheadertabs = obj.querySelector('.tabs-header');
    var position = 0;
    
    for(var i = 0; i < tabheaders.length; i++) {
        if(!tabheaders[i].classList.contains("active")) {
           position = position + tabheaders[i].offsetWidth;
        } else {
            break;
        }
    }    
    
    if($parameters.IsRTL) {
        position = -position;
    }
    
    boundingRight = Math.round(tabheaders[$parameters.ActiveTab].getBoundingClientRect().right);
    screenBoundingWidthRight = moveheadertabs.offsetWidth - 40;
    boundingLeft = Math.round(tabheaders[$parameters.ActiveTab].getBoundingClientRect().left);
    screenBoundingWidthLeft = 40;
    
    if(boundingRight < screenBoundingWidthRight && boundingLeft > 40){
        //do nothing
    } else {
        if($parameters.IsRTL) {
            doRightScroll();
        } else {
            doScroll();
        }
    }
}, 0)

function doScroll() {
    
    var tabscount = $parameters.ActiveTab;
    
    for(i = 0; i < tabscount; i++) {
        scrolltoleftelements = scrolltoleftelements + tabheaders[i].offsetWidth;
    }
    
    setTimeout(function(){
        moveheadertabs.scrollLeft = (scrolltoleftelements - ((moveheadertabs.offsetWidth - (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));
    },10);
}

function doRightScroll() {
    
    var tabscount = $parameters.ActiveTab;
    
    if(document.body.classList.contains('android')){
        
        for(i = 0; i < tabscount; i++) {
            scrolltoleftelements = scrolltoleftelements + tabheaders[i].offsetWidth;
        }
        
        for(i = 0; i < tabheaders.length; i++) {
            allTabsWidth = allTabsWidth + tabheaders[i].offsetWidth;
        }
        
        setTimeout(function(){
            
            moveheadertabs.scrollLeft = (allTabsWidth - scrolltoleftelements - ((moveheadertabs.offsetWidth + (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));
            
        },10);
        
    } else {
        
        for(i = 0; i < tabscount; i++) {
            scrolltoleftelements = scrolltoleftelements - tabheaders[i].offsetWidth;
        }
        
        setTimeout(function(){
            
            moveheadertabs.scrollLeft =  (scrolltoleftelements + ((moveheadertabs.offsetWidth - (tabheaders[$parameters.ActiveTab].offsetWidth)) / 2));

        },10);
        
    }
    
}

el.classList.remove("no-transition");
```

`GestureEnd` / no `CalculateMiddleRight`:

```js
$parameters.MiddleX = ($parameters.TabsWidth * $parameters.ActiveTab)-(1*$parameters.TabsWidth/2);

```

`GestureEnd` / no `RemoveNoTransition`:

```js
var el = document.getElementById($parameters.Id);
var tabsContent = el.querySelector(".tabs-content-wrapper");

tabsContent.classList.remove("no-transition");
```

`OnOrientationChange` / no `onOrientationChange`:

```js
setTimeout(function() {
    setUnderLine();
    setRightTab();
}, 300);

var obj = document.getElementById($parameters.Id);

function setRightTab() {
    var el = obj.querySelector(".tabs-content-wrapper");
    var width = -(($parameters.ActiveTab) * el.offsetWidth);
    
    if($parameters.IsRTL) {
        width = (($parameters.ActiveTab) * el.offsetWidth);
    }
    
    el.style.transform =  "translateX(" + width + "px) translateZ(0)";
    el.style.webkitTransform =  "translateX(" + width + "px) translateZ(0)";
}

function setUnderLine() {
    var activeWidth = obj.querySelector(".tabs-header-tab.active").offsetWidth;
    var activeTab = obj.querySelector(".tabs-header-tab.active");
    var tabheaders = obj.querySelectorAll(".tabs-header-tab");
    var moveheadertabs = obj.querySelector('.tabs-header');
    var position = 0;
    
    for(var i = 0; i < tabheaders.length; i++) {
        if(!tabheaders[i].classList.contains("active")) {
           position = position + tabheaders[i].offsetWidth;
        } else {
            break;
        }
    }
    
    if($parameters.IsRTL) {
        position = -position;
        moveheadertabs.scrollLeft = ((moveheadertabs.offsetWidth - tabheaders[$parameters.ActiveTab].offsetWidth) /2) * (($parameters.TabsNumber - $parameters.ActiveTab) - 2);
    } else {
        moveheadertabs.scrollLeft = ((moveheadertabs.offsetWidth - tabheaders[$parameters.ActiveTab].offsetWidth) /2) * ($parameters.ActiveTab - 1);
    }

}

```

`GestureStart` / no `CleanAnimationClasses`:

```js
var tabsNumber = 0;
var el = document.getElementById($parameters.Id);
var tabsChildren = el.querySelector(".tabs-header").children;
var tabsContent = el.querySelector(".tabs-content-wrapper");
var isRTL = document.querySelector('.is-rtl');

for(var i=0; i < tabsChildren.length; i++) {
    if(tabsChildren[i].innerHTML !== "") {
        tabsNumber++;
    }
}
        
$parameters.Width = el.offsetWidth;
$parameters.TabsNumber = tabsNumber;

if(isRTL) {
    $parameters.IsRTL = true;
}

tabsContent.classList.add("no-transition");
```

`GestureStart` / no `CheckIfContainsClass`:

```js
var tabSwipe = document.getElementById($parameters.TabId);

if(tabSwipe.classList.contains('no-swipe')){
    $parameters.ContainsClass = true;
} else {
    $parameters.ContainsClass = false;
}
```

`GestureStart` / no `RemoveNoTransition`:

```js
var el = document.getElementById($parameters.Id);
var tabsContent = el.querySelector(".tabs-content-wrapper");

tabsContent.classList.remove("no-transition");
```

`OnDestroy` / no `Destroy`:

```js
window.removeEventListener('orientationchange', $actions.OnOrientationChange);
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Tabs1","source":"IMobileBlock:DEPRECATED_Tabs","as":"$b"}
{"op":"create","parent":"$b/Tab1","type":"IExpression","as":"$eTab1"}
{"op":"create","parent":"$b/Tab2","type":"IExpression","as":"$eTab2"}
{"op":"create","parent":"$b/Tab3","type":"IExpression","as":"$eTab3"}
{"op":"create","parent":"$b/Tab4","type":"IExpression","as":"$eTab4"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnTabChange` resolve o IEventHandler pelo nome do evento e `$b/OnTabChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_Tabs1_OnTabChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ActiveTab","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnTabChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnTabChange/ActiveTab","prop":"Value","value":"ActiveTab"}
```
