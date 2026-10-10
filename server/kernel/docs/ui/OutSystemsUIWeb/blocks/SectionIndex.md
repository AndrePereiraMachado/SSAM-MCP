# SectionIndex

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 14 widgets internos

Use the Section Index to organize a screen's content, enabling quick navigation within a page.

Just drag the pattern, and it will create a link to every section you have on the page. 

Use the parameter isFixed to define if it will stick on scroll and the TopPosition to change the distance to top. 

Set IsSmooth to true to enable animated scroll.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsSmooth | Boolean | nao | False | If IsSmooth is true, the navigation to destination will animate. If set to false, it will navigate instantly. |
| IsFixed | Boolean | nao | True | If Fixed is true, SectionIndex will allways be in the same position within the screen.  If set to false, it scrolls with the page content. |
| TopPosition | Integer | nao |  | Set the top position when the SectionIndex is fixed. Just insert the number, the pixels unit will be added automatically. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var SectionIndex = function() { 
    // Objects
    var sectionIndex;
    var anchorlinks;
    var anchorTarget;
    var titleContent;
    var isSmooth;
    var unsupportedBrowsers;
    var targetId;
    var headerHeight;
    var checkIE;
    var topValue;
    var getHeight;
    var getPadding;
    var header = document.querySelector('.header');

    var start = function(IsSmoothParam, topPositionParam) {
        sectionIndex = document.querySelector('.section-index');
        anchorlinks = sectionIndex.getElementsByTagName('a');
        anchorTarget = document.querySelectorAll('.section-anchor');

        if(header) {
            headerHeight = header.offsetHeight;    
        } else {
            headerHeight = 0;    
        }

        isSmooth = (IsSmoothParam === 'True');
        topValue = parseFloat(topPositionParam);
        checkIE = document.body.classList.contains('ie11');
        unsupportedBrowsers = document.body.classList.contains('ie11') || document.body.classList.contains('edge') || document.body.classList.contains('safari');
        
        // Check for browsers that don't support ScrollIntoView to call Polyfill
        if(isSmooth && unsupportedBrowsers){
            callPolyfill();
            checkIEBrowser();
        }

        // Create links for each section
        createElements();
        
        // Set classes and event listeners
        prepareElements();
    }

    var createElements = function() {
        // Add link for each section
        for (var i=0; i < anchorTarget.length; i++){
            // Get section-index wrapper to be able to navigate throught his whole html structure
            var parentAnchor = anchorTarget[i].parentElement;

            // Get content from section-title text
            elemText = parentAnchor.querySelector('.section-title').textContent;
            // Remove white spaces
            removeSpace = elemText.split(" ");
            // Get first word (to prevent error when title is composed from one than one)
            titleContent = removeSpace.shift();
            
            // Create links inside section-index, for each section
            sectionIndex.innerHTML += "<a role='menuitem' tabindex='0' name=section-" + titleContent + "-"+ [i] +">"+ elemText +"</a>";

            // Create ID for each section-anchor
            anchorTarget[i].id= "section-"+ titleContent +"-"+ [i];

            // Create name attribute for each section-anchor (to enable navigation through url)
            anchorTarget[i].setAttribute('name', "section-"+ titleContent +"-"+[i]);

            var contentPadding = 40;
            // get header height plus content padding
            var offset = headerHeight + contentPadding;
            
            // Define position of targeted anchor
            anchorTarget[i].style.position = "absolute";
            anchorTarget[i].style.top = "-" + offset + "px";
            anchorTarget[i].style.left = "0";
        }
    }

    var prepareElements = function() {   
        anchorlinks[0].classList.add('is--active');    
        for(var i=0; i < anchorlinks.length; i++) {
            // Add css class to each anchor on section-index
            anchorlinks[i].classList.add('section-index-item');
            
            // Adds event listeners
            anchorlinks[i].addEventListener('click', onSectionIndexClick);
            anchorlinks[i].addEventListener('keydown', onSectionIndexKeypress);
       
            window.addEventListener('scroll', function() {
                activeOnScroll(anchorlinks);
            });
        }
    }
    
    // If IE browser get values and call function to calculate
    var checkIEBrowser = function() {
        getHeight = parseFloat(window.getComputedStyle(document.querySelector('.header')).getPropertyValue('height'));
        getPadding = parseFloat(window.getComputedStyle(document.querySelector('.main-content')).getPropertyValue('padding-top'));
        
        //Verify if DOM are rendered
        if(checkIE && !isNaN(getHeight)) {
            setTopPositionValue(getHeight, getPadding);
        } else {
            setTimeout(function(){ 
                checkIEBrowser();
            }, 0);
        }
    }    
    
    // If IE browser calculate values and set inline top style
    var setTopPositionValue = function(getHeight, getPadding) {
        sectionIndex.style.top = (getHeight + getPadding + topValue) + 'px';
    }

    var toggleActive = function(el) {
        // Get all anchors with is--active class and remove it
        var elems = document.querySelectorAll(".is--active");
        for(var i= 0; i < elems.length; i++){
            elems[i].classList.remove("is--active");
        };

        // Add is--active class to active anchor
        el.className = "section-index-item is--active";
    }
    
    var activeOnScroll = function(el) {
        // Get window height
        var windowHeight = window.innerHeight;
        // Get last link on section-index
        var lastItem = sectionIndex.querySelector('a:last-child');
            
        for(var i = 0; i < el.length; i++){
            // Get anchor based on link name attribute
            var elemAtrr = el[i].getAttribute('name');
            var elem = document.getElementById(elemAtrr);
            // Get anchor current position
            if(elem) {
                var elemPosition = elem.getBoundingClientRect();
                var elemPositionTop = elemPosition.top + windowHeight;
            }
            
            // Add is--active class on scroll, based on position
            if((windowHeight + headerHeight) > elemPositionTop) {
                toggleActive(el[i]);
            } else if(getDocHeight() === (getScrollPos()[1] + windowHeight)){ // if on bottom of page, set last link to active
                toggleActive(lastItem);
            }
         }
    }
    
    var addSmoothScroll = function(el) {
        // Get name attribute from targeted element
        var name = el.getAttribute('
/* ... truncado: 15634 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"SectionIndex1","source":"IWebBlock:SectionIndex","as":"$b"}
```
