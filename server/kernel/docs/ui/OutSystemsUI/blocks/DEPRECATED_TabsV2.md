# DEPRECATED_TabsV2

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 30 widgets internos

Set of Tabs with placeholders for Title and Content.

Fill in the headers and respective content areas of the tabs to be displayed. Empty tabs will not be rendered.

Used to display large sets of information which can be split into different areas, whilst always remaining a click away.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartingTab | Integer | nao | 0 | Index of the Current Active Tab. |
| IsJustified | Boolean | nao |  | When set to true the Items are evenly distributed in the space available. |
| IsVertical | Boolean | nao | False | If set to True, the header will be displayed side by side to the content. |
| IsRight | Boolean | nao | False | When set to true, aligns the Tabs Header items to right.  This will only go into effect if the Orientation parameter is set to Vertical. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Header**: Drag TabsHeaderItem blocks to this placeholder. (em `tabs/content`) | nasce com: WebBlockInstance:DEPRECATED_TabsHeaderItem, WebBlockInstance:DEPRECATED_TabsHeaderItem, WebBlockInstance:DEPRECATED_TabsHeaderItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Content**: Drag TabsContentItem blocks to this placeholder. (em `tabs/content/tabscontent/content`) | nasce com: WebBlockInstance:DEPRECATED_TabsContentItem, WebBlockInstance:DEPRECATED_TabsContentItem, WebBlockInstance:DEPRECATED_TabsContentItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnTabChange**(ActiveTab: Integer): Triggered when switching tabs

## Composicao interna

- Usa os blocos: DEPRECATED_TabsHeaderItem, DEPRECATED_TabsContentItem, TouchEvents
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> SetTabs; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: SetRTLObserver, OnReady, RemoveTransition, UpdateUI, AddOverlay, OnInitialize, TabsOnClick, ChangeTab, OnDestroy, RemoveActive, GestureMove, SetTabs, GestureEnd, OnOrientationChange, GestureStart
- Chama actions do modulo: AddRTLObserver, RemoveRTLObserver (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OSFramework.OSUI.Event.DOMEvents.Observers.GlobalObserverManager.Instance.addHandler`, `OSFramework.OSUI.Event.DOMEvents.Observers.ObserverEvent.RTL`, `OSFramework.OSUI.Event.DOMEvents.Observers.GlobalObserverManager.Instance.removeHandler`

`SetRTLObserver` / no `SetActionAsObj`:

```js
$parameters.Action = $actions.SetTabs;
```

`OnReady` / no `Init`:

```js
window.addEventListener('orientationchange', $actions.OnOrientationChange);
var tab = document.getElementById($parameters.Id);
var list = tab.querySelector('.tabs-header .list');

var init = function() {

    var headerTabs = tab.querySelector(".tabs-header");
    var contentTabs = tab.querySelector(".tabs-content");
    var tabsWithSectionGroup = tab.querySelector('.tabs-content .section-group.is--sticky');
    var tabNumber = 0;
    
    //Check if Tabs contains SectionGroup inside TabsContent
    if(tabsWithSectionGroup){
        tab.classList.add('tabs-section-group');
    }
    
    //Check the tabs wrapper has the context content of the actual tab
    var tabsHeaderItems = Array.prototype.filter.call(tab.querySelectorAll('.tabs-header-tab'), function (el) {
        return el.closest('.tabs') === tab;
    });
    
    var tabsContentItems = Array.prototype.filter.call(tab.querySelectorAll('.tabs-content-tab'), function (el) {
        return el.closest('.tabs') === tab;
    });
    
        
    for(var i = 0; i < tabsHeaderItems.length; i++) {
        
        tabNumber = i;
        
        tabsHeaderItems[i].setAttribute('data-tab', tabNumber);

         // Sets the role presentation to the Tab's header wrapper
        tabsHeaderItems[i].parentElement.setAttribute('role', 'presentation');
        
        if(tabsContentItems[i] !== undefined) {
           tabsContentItems[i].setAttribute('data-tab', tabNumber);
           tabsContentItems[i].setAttribute('aria-labelledby', tabsHeaderItems[i].getAttribute('id'));
           tabsHeaderItems[i].setAttribute('aria-controls', tabsContentItems[i].getAttribute('id'));             
        }
        
        tabsHeaderItems[i].addEventListener('click', function(e) {
             $actions.TabsOnClick(parseFloat(e.currentTarget.dataset.tab));
        });


    }    
    
    // add the event for the keydown
    headerTabs.addEventListener('keydown', onTabsKeypress);                                
                                                           
    
    // Set startingTab of the closest tabs wrapper
    var startingHeader = Array.prototype.filter.call(headerTabs.querySelectorAll("[data-tab = '" + $parameters.ActiveTab + "']"), function(el) {
        return el.closest('.tabs') === tab;
    });
    var staringContent = Array.prototype.filter.call(contentTabs.querySelectorAll("[data-tab = '" + $parameters.ActiveTab + "']"), function(el) {
        return el.closest('.tabs') === tab;
    });
    
    if(startingHeader[0] !== undefined) {
        startingHeader[0].classList.add('active');
        startingHeader[0].setAttribute('aria-selected', 'true');
        startingHeader[0].setAttribute("tabindex", "0");
    }
    
    if(staringContent[0] !== undefined) {
        staringContent[0].classList.add('open');
        staringContent[0].setAttribute("tabindex", "0");
    }
    
    //Global Action
    var element = document.getElementById($parameters.Id).parentElement;
    element.changeTab = function(i) { $actions.TabsOnClick(i); };
    
    var isRTL = document.querySelector('.is-rtl');
    
    if(isRTL) {
        $parameters.IsRTL = true;
    }
    
    if(!$parameters.IsWebApp) {
        addOverlay();
    }

    function addOverlay() {
        //Add Overlay
        var tabHeaderWidth = tab.querySelector(".tabs-header");
        var tabheaders = tab.querySelectorAll(".tabs-header-tab");
        var tabOverlay = element.querySelector(".tabs-overlay");
        var tabWidth = 0;
        
        if(tabOverlay) {
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
    }
    
    // keyborad navigation
    function onTabsKeypress(e) {
        var nextTabItem = document.activeElement; // set active as default
        var tabsHeaderItems = headerTabs.children;
        tabsHeaderItems = [].slice.call(tabsHeaderItems);
        var items = tabsHeaderItems.length;

        if(tab.classList.contains('tabs-horizontal')) {
            // Arrow Right
            if(e.keyCode == "39") {
                nextTabItem = document.activeElement.parentElement.nextElementSibling;
                if(!nextTabItem) {
                    nextTabItem = tabsHeaderItems[0];
                    nextTabItem.children[0].focus();
                    nextTabItem.children[0].click();
                }
                else {
                    nextTabItem.children[0].focus();
                    nextTabItem.children[0].click();
                }
            }
            // Arrow Left
            if(e.keyCode == "37") {
                nextTabItem = document.activeElement.parentElement.previousElementSibling;
                if(!nextTabItem) {
                    nextTabItem = tabsHeaderItems[items - 1];
                    nextTabItem.children[0].focus();
                    nextTabItem.children[0].click();
                }
                else {
                    nextTabItem.children[0].focus();
                    nextTabItem.children[0].click();
                }
            }
        }
        
        if(tab.classList.contains('tabs-vertical')) {
            // Arrow Down - Act as Right
            if(e.keyCode == "40") {
           
/* ... truncado: 1904 chars a mais no JSON do catalogo */
```

`RemoveTransition` / no `RemoveNoTransition`:

```js
var el = document.getElementById($parameters.Id);
var tabsContent = el.querySelector(".tabs-content-wrapper");

if(tabsContent.classList.contains('no-transition')) {
    tabsContent.classList.remove("no-transition");
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

`TabsOnClick` / no `CheckTabsContent`:

```js
var tab = document.getElementById($parameters.TabsId);
var contentTabs = tab.querySelector(".tabs-content");
var tabsInsidePopup = document.body.querySelector('.popup-dialog .popup-content .tabs');

//Check the tabs wrapper has the context content of the actual tab
var newTabContent = Array.prototype.filter.call(contentTabs.querySelectorAll("[data-tab = '" + $parameters.TabNumber + "']"), function(el) {
    return el.closest('.tabs') === tab;
});

if(newTabContent[0]) {
    $parameters.HasContentTab = true;
}  

// Check if tabs are inside a popup
if(tabsInsidePopup) {
    $parameters.TabsInsidePopup = true;
} else {
    $parameters.TabsInsidePopup = false;
}

```

`TabsOnClick` / no `RemoveHeaderClass`:

```js
var tab = document.getElementById($parameters.TabsId);
var headerTabs = tab.querySelector(".tabs-header");

var tabHeader = headerTabs.querySelector("[data-tab = '" + $parameters.ActiveTab + "']");

tabHeader.classList.remove('active');





```

`TabsOnClick` / no `AddHeaderClass`:

```js
var tab = document.getElementById($parameters.TabsId);
var headerTabs = tab.querySelector(".tabs-header");

//Check the tabs wrapper has the context content of the actual tab
var newTabHeader = Array.prototype.filter.call(headerTabs.querySelectorAll("[data-tab = '" + $parameters.TabNumber + "']"), function(el) {
    return el.closest('.tabs') === tab;
});

newTabHeader[0].classList.add('active');

```

`ChangeTab` / no `changeTab`:

```js
var tab = document.getElementById($parameters.id);
var headerTabs = tab.querySelector(".tabs-header");
var contentTabs = tab.querySelector(".tabs-content");

//Check the tabs wrapper has the context content of the actual tab
var newTabHeader = Array.prototype.filter.call(headerTabs.querySelectorAll("[data-tab = '" + $parameters.ActiveTab + "']"), function(el) {
    return el.closest('.tabs') === tab;
});

var newTabContent = Array.prototype.filter.call(contentTabs.querySelectorAll("[data-tab = '" + $parameters.ActiveTab + "']"), function(el) {
    return el.closest('.tabs') === tab;
});

newTabHeader[0].classList.add('active');
newTabHeader[0].setAttribute("tabindex", "0");
newTabHeader[0].setAttribute("aria-selected", "true");

if(newTabContent) {
    newTabContent[0].classList.add('open');
    newTabContent[0].setAttribute("tabindex", "0");
}
```

`OnDestroy` / no `Destroy`:

```js
window.removeEventListener('orientationchange', $actions.OnOrientationChange);
```

`RemoveActive` / no `RemoveActive`:

```js
var tab = document.getElementById($parameters.Id);
var headerTabs = tab.querySelector(".tabs-header");
var contentTabs = tab.querySelector(".tabs-content");

var tabHeader = Array.prototype.filter.call(headerTabs.querySelectorAll("[data-tab = '" + $parameters.activeTab + "']"), function(el) {
    return el.closest('.tabs') === tab;
});

var tabContent = Array.prototype.filter.call(contentTabs.querySelectorAll("[data-tab = '" + $parameters.activeTab + "']"), function(el) {
    return el.closest('.tabs') === tab;
});

if(tabHeader[0]){
    tabHeader[0].classList.remove('active');
    tabHeader[0].setAttribute("tabindex", "-1");
    tabHeader[0].setAttribute("aria-selected", "false");
}

if(tabContent[0]){
    tabContent[0].classList.remove('open');
    tabContent[0].setAttribute("tabindex", "-1");
}
```

`GestureMove` / no `RemoveNoTransition`:

```js
var el = document.getElementById($parameters.Id);
var tabsContent = el.querySelector(".tabs-content-wrapper");

tabsContent.classList.remove("no-transition");
```

`GestureMove` / no `PreventDefaultWDirection`:

```js
$parameters.Evt.preventDefault();

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

`GestureMove` / no `UpdateUI`:

```js
requestAnimationFrame($actions.UpdateUI);
```

`SetTabs` / no `SetTabs`:

```js
var obj = document.getElementById($parameters.id);

if(obj){
    var isLayoutNative = document.querySelector('.layout-native');
    var isNativeDesktop = document.querySelector('.desktop .layout-native');

    var moveheadertabs = obj.querySelector(".tabs-header");
    var tabheaders = obj.querySelectorAll(".tabs-header-tab");
    var tabsInsidePopup = document.body.querySelector('.popup-dialog .popup-content .tabs');
    var element = tabheaders[$parameters.ActiveTab];
    var threshold = 40;
    var elementMargin;
    var isRTL;

    function setRightTab() {
        var el = obj.querySelector(".tabs-content-wrapper");
        var width = -(($parameters.ActiveTab) * el.offsetWidth);
        
        if(isRTL) {
            width = ($parameters.ActiveTab) * el.offsetWidth;
        }
        
        if(!$parameters.IsWebApp && !tabsInsidePopup) {
        
            if($parameters.ActiveTab === 0 && $parameters.StartingTab === 0) {
                el.removeAttribute("style");
            } else {
                el.style.webkitTransform =  "translateX(" + width + "px) translateZ(0)";
                el.style.transform =  "translateX(" + width + "px) translateZ(0)";
            }
            
        }
        
        if(tabsInsidePopup){
            element = document.querySelector(".popup-dialog .tabs-header-tab.active");
        }

        if(!$parameters.IsVertical){
            
            var boundingRight = Math.round(tabheaders[$parameters.ActiveTab].getBoundingClientRect().right);
            var screenBoundingWidthRight = moveheadertabs.offsetWidth - elementMargin;
            var boundingLeft = Math.round(tabheaders[$parameters.ActiveTab].getBoundingClientRect().left);
            var layoutsReactiveNative = document.querySelector('.layout.layout-top .main') || document.querySelector('.layout.layout-side:not(.layout-native) .main') || document.querySelector('.layout.layout-side.layout-native .main') ;
            var oldLayouts = document.querySelector('.layout');
            var layoutBoundings = 0;
            var tabsScroll;
            var scroollBehavior = "smooth";
            var waitingTime = 100;
            
            if(layoutsReactiveNative) {
                layoutBoundings = layoutsReactiveNative.getBoundingClientRect().left;
            } else if(oldLayouts) {
                layoutBoundings = oldLayouts.offsetWidth - oldLayouts.querySelector('.main-content').offsetWidth;
            }
            
            elementMargin = threshold + layoutBoundings + parseInt(window.getComputedStyle(element).getPropertyValue('margin-left')) + parseInt(window.getComputedStyle(element).getPropertyValue('margin-right'));
            
            if($parameters.IsFirstTimeLoad){
                scroollBehavior = "auto";
                $actions.RemoveTransition();
            }
            
            if($parameters.IsRTL){
                tabsScroll = (element.offsetLeft - ((moveheadertabs.offsetWidth/2) - (element.offsetWidth/2))) * -1;
            } else {
                tabsScroll = element.offsetLeft - ((moveheadertabs.offsetWidth/2) - (element.offsetWidth/2));
            }
            
            if(!(boundingRight < screenBoundingWidthRight && boundingLeft > elementMargin)) {
                moveheadertabs.scrollTo({
                top: 0,
                left: tabsScroll,
                behavior: scroollBehavior
                });
            }
            
        }
        
    }

    function setUnderLine() {
        var activeTab = obj.querySelector(".tabs-header-tab.active");
        
        if(activeTab){
            isRTL = document.querySelector('.is-rtl');
            var activeWidth = activeTab.offsetWidth;
            var position = 0;
            
            for(var i = 0; i < tabheaders.length; i++) {
                if(!tabheaders[i].classList.contains("active")) {
                position = position + tabheaders[i].offsetWidth;
                } else {
                    break;
                }
            }

            if(isRTL) {
                position = -position;
            }

            setRightTab();    
        }
    }

    setUnderLine();
}
```

`GestureEnd` / no `CalculateMiddleLeft`:

```js
$parameters.MiddleX = (($parameters.TabsWidth * $parameters.ActiveTab) + $parameters.TabsWidth)-(1*$parameters.TabsWidth/2)

```

`GestureEnd` / no `CalculateMiddleRight`:

```js
$parameters.MiddleX = ($parameters.TabsWidth * $parameters.ActiveTab)-(1*$parameters.TabsWidth/2);

```

`GestureStart` / no `CleanAnimationClasses`:

```js
var tabsNumber = 0;
var el = document.getElementById($parameters.Id);
var tabsChildren = el.querySelector(".tabs-header").children;
var tabsContent = el.querySelector(".tabs-content-wrapper");
var isRTL = document.querySelector('.is-rtl');
var tabsHeaderList = el.querySelector(".tabs-header .list.list-group");

if(tabsHeaderList) {
    tabsChildren = el.querySelector(".tabs-header .list.list-group").children
}

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

`GestureStart` / no `CheckTabsInsidePopup`:

```js
var tabsInsidePopup = document.body.querySelector('.popup-dialog .popup-content .tabs');

if(tabsInsidePopup) {
    $parameters.TabsInsidePopup = true;
} else {
    $parameters.TabsInsidePopup = false;
}

```

`GestureStart` / no `RemoveNoTransition`:

```js
var el = document.getElementById($parameters.Id);
var tabsContent = el.querySelector(".tabs-content-wrapper");

tabsContent.classList.remove("no-transition");
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_TabsV21","source":"IMobileBlock:DEPRECATED_TabsV2","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnTabChange` resolve o IEventHandler pelo nome do evento e `$b/OnTabChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_TabsV21_OnTabChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ActiveTab","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnTabChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnTabChange/ActiveTab","prop":"Value","value":"ActiveTab"}
```
