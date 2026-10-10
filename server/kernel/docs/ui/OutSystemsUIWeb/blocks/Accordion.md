# Accordion

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 17 widgets internos

Arrange the content by having vertically stacked tabs that expand when clicked. This is an effective way to display additional information.

Add the Accordion Web Block on your Web Screen and as many AccordionItems as you need inside the Accordion.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MultipleItems | Boolean | nao | False | Allows multiple Accordion Items to be opened having the effect of Section Expandables. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag AccordionItem blocks to this placeholder. | nasce com: WebBlockInstance:AccordionItem, WebBlockInstance:AccordionItem, WebBlockInstance:AccordionItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: AccordionItem, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var newAccordion = function() { 
    // Objects
    var accordion;
    var accordionItems;
    var currAccordionItem;
    var currAccordionItemContent;
    var transitioningElement;
    var activeIndex = false;
    var multipleItems;

    var start = function(widgetIdParam, multipleItemsParam) {
        // Fills objects
        accordion = document.getElementById(widgetIdParam);
        multipleItems = multipleItemsParam;
        
        // Get the accordion-items inside the scope only, but only the ones open and without having items without an accordion as a parent element
        checkAccordionElements = accordion.querySelectorAll(':scope .accordion-item.is--open:not(:scope .accordion-item .accordion-item)'); 
        
        if(accordion) {
            if(multipleItems === "false"){
                for(i = 0; i < checkAccordionElements.length; i++) {
                    if(i !== 0) {
                        checkAccordionElements[i].classList.remove('is--open');
                        checkAccordionElements[i].classList.add('is--closed');
                        // get the accordion-item-content inside the scope only
                        checkAccordionElements[i].querySelector(':scope >  .accordion-item-content').classList.remove('is--expanded'); 
                        checkAccordionElements[i].querySelector(':scope > .accordion-item-content').classList.add('is--collapsed');
                    }
                }
            }
            
            // Get the accordion-items inside the scope and without having items without an accordion as a parent element
            accordionItems = accordion.querySelectorAll(':scope .accordion-item:not(:scope .accordion-item .accordion-item)');

            if(accordion.getAttribute('data-active-item') > -1) {
                activeIndex = accordion.getAttribute('data-active-item');
            }
            
            // Adds event listener for each accordion item
            for(var i = 0; i < accordionItems.length; i++) {
                prepareElements(accordionItems[i]);
            }
        }
    };
    
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
    
    var isClosed = function(currentAccordionItem) {
        if(currentAccordionItem.classList.contains('is--closed')) {
            return true;
        }
        
        return false;
    };
    
    var isDisabled = function(currentAccordionItem) {
        if(currentAccordionItem.classList.contains('is--disabled')) {
            return true;
        }
        
        return false;
    };
    
    // Set visibility through ARIA states - Accessibility
    var setAriaExpanded = function(currentAccordionItem, status, ariaHidden) {
        currentAccordionItem.setAttribute('aria-expanded', status);
        currentAccordionItem.querySelector('.accordion-item-header').setAttribute('aria-expanded', status);
        currentAccordionItem.querySelector('.accordion-item-content').setAttribute('aria-hidden', ariaHidden);
    };
    
    var prepareElements = function(accordionItem) {
        if(accordionItem) {
            
            var accordionItemContent = accordionItem.querySelector('.accordion-item-content');
            var accordionItemHeader = accordionItem.querySelector('.accordion-item-header');
            
            // Adds event listener
            accordionItemHeader.addEventListener('click', onAccordionClick);
            accordionItemHeader.addEventListener('keydown', onAccordionKeypress);
            
            // Checks if it is the active item
            if(activeIndex && activeIndex < accordionItems.length && accordionItem === accordionItems[activeIndex]) {
                removeClass(accordionItem, 'is--closed');
                addClass(accordionItem, 'is--open');
                removeClass(accordionItemContent, 'is--collapsed');
                addClass(accordionItemContent, 'is--expanded');
                setAriaExpanded(accordionItem, 'true', 'false');
            }
        }
    };
    
    var getCurrentHeight = function(currentAccordionItem) {
        var currentAccordionItemContent = currentAccordionItem.querySelector('.accordion-item-content');
        
        // Returns the accordion item content height
        if(currentAccordionItemContent) {
            return currentAccordionItemContent.getBoundingClientRect().height;
        }
        
        return false;
    };
    
    // Set keyboard interaction - Accessibility
    var onAccordionKeypress = function(e) {
        currAccordionItem = this;
        
        if(currAccordionItem) {
            currAccordionItem = currAccordionItem.parentElement
            
            if(isDisabled(currAccordionItem)) {
                if (e.keyCode == "32" || e.keyCode == "13")
                    e.preventDefault();
                return false;
            } else {
                
                if(!isClosed(currAccordionItem))
                {
                    //If esc, Close AccordionItem
                    if (e.keyCode == "27") {
                        collapse(currAccordionItem);
                        setAriaExpanded(currAccordionItem, 'false', 'true');
                    }
                }
                //If enter or space use the onAccordionClick to validate
                if (e.keyCode == "32" || e.keyCode == "13") {
                    // Checks if the current accordion item is closed - collapsed
                    if(isClosed(currAccordionItem)) {
                        expand(currAccordionItem);
                        setAriaExpanded(currAccordionItem, 'true'
/* ... truncado: 7318 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Accordion1","source":"IWebBlock:Accordion","empty":true,"as":"$b"}
```
