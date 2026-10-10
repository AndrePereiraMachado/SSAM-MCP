# Carousel

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 15 widgets internos

A Carousel with responsive behavior that can display multiple images or other items in any device and highly customizable.

Items on the first level after the placeholder will be separated in different items. You can have multiple containers with text and images and each container will be a carousel item. The placeholder can also have a list item providing dynamic content. You can set up how many items to be shown for each device and turn on autoplay on a slow, medium or fast pace.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Margin | Integer | nao | 16 | Distance between each Carousel item. |
| Padding | Integer | nao | 0 | Distance between the screen edges and the visible items on the screen. |
| Pagination | Boolean | nao | True | If true, sets the dots representing all items, which can be tapped to navigate directly to a given item. |
| Navigation | Boolean | nao | True | If true, arrows to navigate left and right. |
| Autoplay | Boolean | nao | False | If true, it enables the autoplay. |
| Rewind | Boolean | nao | False | Have a Rewind effect when the Carousel reaches the end and Loop is enabled. The default behaviour is to show the first item without rewinding through the remaining. |
| Loop | Boolean | nao | False | If true it enables continuous slide of the Carousel even after it reaches the end. |
| InitialPosition | Integer | nao | 0 | Set the first element to show. |
| ItemsDesktop | Integer | nao | 1 | Number of items to be displayed at the same time while on desktop. |
| ItemsTablet | Integer | nao | 1 | Number of items to be displayed at the same time while on tablet. |
| ItemsPhone | Integer | nao | 1 | Number of items to be displayed at the same time while on phone. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |
| AdvancedFormat | Text | nao |  | Allows for more options that the ones given in the input parameters.  Example: "{     axis: 'vertical',     mouseDrag: false }"  For more information visit:  https://github.com/ganlanyuan/tiny-slider |

## Placeholders

- **Items**: Drag images or containers to create carousel items. (em `CarouselWrapper`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Icon, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
/* Carousel JS */

var newCarousel = function() { 
    // Objects
    var carouselWidget;
    var carouselContainer;
    var carouselContainerNavigation;
    var carouselNavigation;
    var carouselDots;
    var carouselMargin;
    var carouselPadding;
    var carouselAutoplay;
    var carouselLoop;
    var carouselRewind;
    var carouselInitialPosition;
    var carouselDesktopItems;
    var carouselTabletItems;
    var carouselPhoneItems;
    var carouselAdvancedFormat;
    var carouselWithLists;
    var carouselElements;
    var getCarouselElements;
    var wrapper;
    var element;
    
    var carousel;
    
    var wrapCarouselElements = function(widgetIdParam, widgetContainerParam, widgetNavigationParam, navigationParam, dotsParam, marginParam, paddingParam, autoplayParam, loopParam, rewindParam, initialpositionParam, itemsdesktopParam, itemstabletParam, itemsphoneParam, advancedformatParam) {
        
        carouselWidget = widgetIdParam;
        carouselContainer = widgetContainerParam;
        carouselContainerNavigation = widgetNavigationParam;
        carouselNavigation = navigationParam;
        carouselDots = dotsParam;
        carouselMargin = marginParam;
        carouselPadding = paddingParam;
        carouselAutoplay = autoplayParam;
        carouselLoop = loopParam;
        carouselRewind = rewindParam;
        carouselInitialPosition = initialpositionParam;
        carouselDesktopItems = itemsdesktopParam;
        carouselTabletItems = itemstabletParam;
        carouselPhoneItems = itemsphoneParam;
        carouselAdvancedFormat = advancedformatParam;
        
        // Verify if carousel has list records
        carouselWithLists = document.getElementById(carouselWidget).querySelector('.carousel-items span.ListRecords');
        
        if(carouselWithLists){
            carouselElements = carouselWithLists;
        } else {
            carouselElements = document.getElementById(carouselWidget).querySelector('.carousel-items');
        }
        
        // create div around carousel element to add specific classes and make calculations
        for (i = 0; i < carouselElements.childNodes.length; i++) {
            
            element = carouselElements.childNodes[i];            
            wrapper = document.createElement('div');
            
            element.parentNode.insertBefore(wrapper, element);
            
            wrapper.appendChild(element);
        }
        
        // init carousel
        start(carouselWidget, carouselContainer, carouselContainerNavigation, carouselNavigation, carouselDots, carouselMargin, carouselPadding, carouselAutoplay, carouselLoop, carouselRewind, carouselInitialPosition, carouselDesktopItems, carouselTabletItems, carouselPhoneItems, carouselAdvancedFormat);
        
    };

    var start = function(carouselWidget, carouselContainer, carouselContainerNavigation, carouselNavigation, carouselDots, carouselMargin, carouselPadding, carouselAutoplay, carouselLoop, carouselRewind, carouselInitialPosition, carouselDesktopItems, carouselTabletItems, carouselPhoneItems, carouselAdvancedFormat) {
        
        var options = {
            container: carouselElements,
            controls: (carouselNavigation === 'true'),
            controlsContainer: document.getElementById(carouselContainerNavigation),
            nav: (carouselDots === 'true'),
            gutter: Number(carouselMargin),
            edgePadding: Number(carouselPadding),
            loop: (carouselLoop === 'true'),
            rewind: (carouselRewind === 'true'),
            autoHeight: true,
            autoplay: (carouselAutoplay === 'true'),
            autoplayButtonOutput: false,
            startIndex: Number(carouselInitialPosition),
            responsive: {
              0: {
                items: Number(carouselPhoneItems)
              },
              421: {
                items: Number(carouselTabletItems)
              },
              1025: {
                items: Number(carouselDesktopItems)
              }
            },
            slideBy: "page",
            touch: true,
            mouseDrag: true,
            swipeAngle: false
        };
        
        // Created so that we can keep how many real items exist when using Loop: true 
        var initialItems = Array.prototype.slice.call(carouselElements.children);
        
        // Prepare the options considering the advancedFormat        
        if(carouselAdvancedFormat.length > 0) {
            advancedFormat = eval('(' + carouselAdvancedFormat + ')');
            options = mergeJSON(options, advancedFormat);
        }
        
        carousel = tns(options);
        setPublicActions();

        // bind function to event - accessibility hack
        carousel.events.on('indexChanged', indexChange);
         
        // Move arrows to right content div
        document.getElementById(carouselWidget).querySelector('.tns-ovh').appendChild(document.getElementById(carouselWidget).querySelector('.carousel-navigation'));
        
        // make the options accessible
        document.getElementById(carouselWidget)._opts = options;
        document.getElementById(carouselWidget)._opts.initialItems = initialItems;
        
        // verifiry if carousel has edgePadding and add a class
        if(carouselPadding === '0') {
            document.getElementById(carouselContainerNavigation).classList.add('carousel-padding-none');
        }
        
        document.getElementById(carouselWidget).classList.remove('is--hidden');
        
    };
    
    function setPublicActions() { 
        var widget = document.getElementById(carouselWidget);
        
        widget.goTo = function(index) {
            carousel.goTo(index);
        }
        
        widget.next = function() {
            var list = widget._opts.initialItems;
            var nrItems = list.length;
            var currentIndex = list.indexOf(widget.querySelector('.tns-slide-active'));
            
            if(currentInde
/* ... truncado: 97153 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Carousel1","source":"IWebBlock:Carousel","as":"$b"}
{"op":"create","parent":"$b/Items","type":"IExpressionWidget","as":"$eItems"}
```
