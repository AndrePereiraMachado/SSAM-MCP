# NavigationBar

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 14 widgets internos

Navigation pattern with vertically stacked links that can be displayed with different hierarchy levels. Uses the NavigationBarItem and NavigationBarSubItem to create the necessary structure.

Drag as many NavigationBarItems as you need. In a similar way, if you need another level, just drag NavigationBarSubItems to the NavigationBarItem content placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsFixed | Boolean | nao | True | If Fixed is true, NavigationBar will allways be in the same position within the screen.  If set to false, it scrolls with the page content. |
| TopPosition | Integer | nao |  | Set the top position when the NavigationBar is fixed. Just insert the number, the pixels unit will be added automatically. |
| MultipleItems | Boolean | nao | True | Allows multiple NavigationBarItems to be opened having the effect of Accordion. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag NavigationBarItem blocks to this placeholder. | nasce com: WebBlockInstance:NavigationBarItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: NavigationBarItem, NavigationBarSubItem, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var NavigationBar = function() { 
    // Objects
    var navBar;
    var navBarItems;
    var currNavBarItem;
    var activeIndex = false;
    var multipleItems;
    var subitems;
    var topValue;
    var getHeight; 
    var getPadding; 
    
    var start = function(widgetIdParam, multipleItemsParam, topPositionParam) {
        // Fills objects
        navBar = document.getElementById(widgetIdParam);
        multipleItems = (multipleItemsParam === 'True');
        topValue = parseFloat(topPositionParam); 
        checkNavBarElements = navBar.querySelectorAll('.navigation-bar-item.is--open');
        
        // Set multipleItems parameter
        if(navBar) {
            if(multipleItems === false){
                for(i = 0; i < checkNavBarElements.length; i++) {
                    if(i !== 0) {
                        var currNavBarItemIndex = navBar.querySelectorAll('.navigation-bar-item')[i];
                        var currNavBarContentIndex = navBar.querySelectorAll('.navigation-bar-item-content')[i];
                        
                        // Toggles interaction classes on each navBarItem & navBarContent
                        currNavBarItemIndex.classList.remove('is--open');
                        currNavBarItemIndex.classList.add('is--closed');
                        currNavBarContentIndex.classList.remove('is--expanded');
                        currNavBarContentIndex.classList.add('is--collapsed');
                    }
                    
                }
            }
            
            // Set data-active-item to activeIndex
            navBarItems = navBar.querySelectorAll('.navigation-bar-item');
            if(navBar.getAttribute('data-active-item') > -1) {
                activeIndex = navBar.getAttribute('data-active-item');
            }
            
            // Adds event listener for each navBar item
            for(var i = 0; i < navBarItems.length; i++) {
                prepareElements(navBarItems[i]);
            }
        }
        
        // Get all SubItems
        subitems = document.querySelectorAll('.navigation-bar-item-subitem');
        
        // Add is--active class to navBarItem when SubItem is also active
        for(var i = 0; i < subitems.length; i++) {
            if(subitems[i].classList.contains('is--active')){
                // Get the navBarSubItem parent navNarItem
                var subItemParent =  subitems[i].parentElement.parentElement;
                // Set the navBarItem parent element to active
                subItemParent.classList.add('is--active');
            };
        }
        checkBrowser();
    };
    
    // Get values and call function to calculate
    var checkBrowser = function() {
        if(document.querySelector('.phone')) {
            return;
        }

        getHeight = 0;
        getPadding = 0;
        var headerSelector = document.querySelector('.header');
        var mainContentSelector = document.querySelector('.main-content');

        if(headerSelector) {
            getHeight = parseFloat(window.getComputedStyle(headerSelector).getPropertyValue('height'));
        }

        if(mainContentSelector) {
            getPadding = parseFloat(window.getComputedStyle(mainContentSelector).getPropertyValue('padding-top'));
        }

        // Verify if DOM is rendered
        if(!isNaN(getHeight)) {
            setTopPositionValue(getHeight, getPadding);
        } else {
            setTimeout(function(){ 
                checkBrowser();
            }, 0);
        }
    };  
    
    // If IE browser calculate values and set inline top style
    var setTopPositionValue = function(getHeight, getPadding) {
        navBar.style.top = (getHeight + getPadding + topValue) + 'px';
    }
    
    var addClass = function(element, elClass) {
        if(element && !element.classList.contains(elClass)) {
            element.classList.add(elClass);
            return true;
        }
        
        return false;
    };    
    
    var removeClass = function(element, elClass) {
        if(element && element.classList.contains(elClass)) {
            element.classList.remove(elClass);
            return true;
        }
        
        return false;
    };
    
    var isClosed = function(currentNavBarItem) {
        if(currentNavBarItem.classList.contains('is--closed')) {
            return true;
        }
        
        return false;
    };
    
    // Set visibility through ARIA states - Accessibility
    var setAriaExpanded = function(currentNavBarItem, status, ariaHidden) {
        currentNavBarItem.setAttribute('aria-expanded', status);
        currentNavBarItem.querySelector('.navigation-bar-item-title').setAttribute('aria-expanded', status);
        currentNavBarItem.querySelector('.navigation-bar-item-content').setAttribute('aria-hidden', ariaHidden);
    };
    
    var prepareElements = function(navBarItem) {
        if(navBarItem) {
            
            var navBarItemContent = navBarItem.querySelector('.navigation-bar-item-content');
            var navBarItemTitle = navBarItem.querySelector('.navigation-bar-item-title');
            
            // Adds event listener
            navBarItemTitle.addEventListener('click', onNavigationBarClick);
            navBarItemTitle.addEventListener('keydown', onNavigationBarKeypress);
            
            // Checks if it is the active item
            if(activeIndex && activeIndex < navBarItems.length && navBarItem === navBarItems[activeIndex]) {
                removeClass(navBarItem, 'is--closed');
                addClass(navBarItem, 'is--open');
                removeClass(navBarItemContent, 'is--collapsed');
                addClass(navBarItemContent, 'is--expanded');
                setAriaExpanded(navBarItem, 'true', 'false');
            }

            // Remove tabIndex
            if(navBarItem.querySelector(".navigation-bar-item-title > a")){
                navBarItem.querySelector(".navigation-bar-item-title").removeAttrib
/* ... truncado: 8094 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"NavigationBar1","source":"IWebBlock:NavigationBar","empty":true,"as":"$b"}
```
