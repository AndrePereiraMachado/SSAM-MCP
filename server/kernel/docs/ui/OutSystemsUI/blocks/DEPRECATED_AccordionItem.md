# DEPRECATED_AccordionItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 6 widgets internos

An area that can be expanded or collapsed. You can change the default state of the Block using the IsExpanded input.

Can also be used within the Accordion Pattern, placed inside the Content placeholder. Drag into the Accordion Block as many items as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsExpanded | Boolean | nao | False | Initial state of the Block, the default value is False |
| UsePadding | Boolean | nao | True | When true, content has padding |
| IsDisabled | Boolean | nao | False | Doesn't allow the Accordion Item to be clickable. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Title**: Section Title (em `SectionItem/content/TitleWrapper/content`)
- **Content**: Add content to this placeholder (em `SectionItem/content/ContentWrapper/content`)

## Eventos

- **OnToggle**(IsExpanded: Boolean): Triggered when the section is expanded or collaped

## Composicao interna

- Ciclo de vida: OnParametersChanged -> OnReady; OnReady -> OnReady
- Actions do bloco: Collapse, Expand, OnUpdate, SetAriaAttributes, OnClick, OnReady

## JavaScript

`Collapse` / no `Collapse`:

```js

var currentAccordionItem = document.getElementById($parameters.WidgetId);

var currentAccordionItemContent = currentAccordionItem.querySelector('.section-expandable-content');

currentAccordionItemContent.removeAttribute('style');

// Gets initial height value
var expandedHeight = currentAccordionItemContent.getBoundingClientRect().height;

// Toggle is--closed/is--open class from current accordion item
currentAccordionItem.classList.add('is--closed');
currentAccordionItem.classList.remove('is--open');

// Removes expanded class and adds the collapsed class to obtain the collapsed height value
currentAccordionItemContent.classList.remove('is--expanded');
currentAccordionItemContent.classList.add('is--collapsed');

var collapsedHeight = currentAccordionItemContent.getBoundingClientRect().height;

currentAccordionItemContent.style.height = expandedHeight + 'px';

// Removes collapsed class and adds the expanded class to animate
currentAccordionItemContent.classList.add('is--expanded');
currentAccordionItemContent.classList.remove('is--collapsed');

// This setTimeout (0ms) will ensure that the DOM received the height 0 before actually starts the transition
var waitDomIterateTimeout = setTimeout(function() {
    
    // Adds is--animating class to current accordion item content to obtain the final height value
    currentAccordionItemContent.classList.add('is--animating');
    
    // Removes is--expanded class from current accordion item content
    currentAccordionItemContent.classList.remove('is--expanded');
    
    currentAccordionItemContent.style.height = collapsedHeight + 'px';
    
    // Adds event listener to transition end
    currentAccordionItemContent.addEventListener('transitionend', transitionEndHandler);
    
    // Adds is--collapsed class to current accordion item content
    currentAccordionItemContent.classList.add('is--collapsed');
    
    // Clear timeout
    clearTimeout(waitDomIterateTimeout);
}, 100);

var transitionEndHandler = function() {
    var currentElement = currentAccordionItemContent;
    var currentElementHeader = currentAccordionItem.querySelector('.section-expandable-title');
    
    if(currentElement) {
        // Removes is--animating class
        currentElement.classList.remove('is--animating');
        
        // Remove height and pointer events inline style
        currentElement.style.height = '';
        currentElementHeader.style.pointerEvents = '';
        
        // Verify if the currentElement has inline-styles and remove attribute if are empty
        if(currentElement.style.cssText.length === 0) {
            currentElement.removeAttribute('style');
        }
        
        if($parameters.IsKeypress) {
            // Add focus for Accessibility
            currentElementHeader.focus();
        }
        
        // Set visibility through ARIA states - Accessibility
        $actions.SetAriaAttributes(false, $parameters.WidgetId);
        
        // Removes transitionend event listener
        currentElement.removeEventListener('transitionend', transitionEndHandler, false);   
    }
};


```

`Expand` / no `Expand`:

```js
var currentAccordionItem = document.getElementById($parameters.WidgetId);

var currentAccordionItemContent = currentAccordionItem.querySelector('.section-expandable-content');
var currentAccordionItemHeader = currentAccordionItem.querySelector('.section-expandable-title');

// Gets initial height value
var collapsedHeight = currentAccordionItemContent.getBoundingClientRect().height;

// Toggle is--closed/is--open class from current accordion item
currentAccordionItem.classList.remove('is--closed');
currentAccordionItem.classList.add('is--open');

// Prevents multiple clicks on Accordion when it's animating
currentAccordionItemHeader.style.pointerEvents = 'none';

// Toggle is--collapsed/is--expanded class from current accordion item
currentAccordionItemContent.classList.remove('is--collapsed');
currentAccordionItemContent.classList.add('is--expanded');

currentAccordionItemContent.removeAttribute('style');

// Gets final height value
var expandedHeight = currentAccordionItemContent.getBoundingClientRect().height;

// Removes is--expanded class from current accordion item content to animate
currentAccordionItemContent.classList.remove('is--expanded');

currentAccordionItemContent.style.height = collapsedHeight + 'px';

// This setTimeout (0ms) will ensure that the DOM received the height 0 before actually starts the transition
var waitDomIterateTimeout = setTimeout(function() {
    
    // Adds is--animating class to current accordion item content to obtain the final height value
    currentAccordionItemContent.classList.add('is--animating');
    
    currentAccordionItemContent.style.height = expandedHeight + 'px';
    
    // Adds event listener to transition end
    currentAccordionItemContent.addEventListener('transitionend', transitionEndHandler);
    
    // Adds is--expanded class to current accordion item content
    currentAccordionItemContent.classList.add('is--expanded');
    
    // Clear timeout
    clearTimeout(waitDomIterateTimeout);
}, 100);

var transitionEndHandler = function() {
    var currentElement = currentAccordionItemContent;
    var currentElementHeader = currentAccordionItemHeader;
    
    if(currentElement) {
        // Removes is--animating class
        currentElement.classList.remove('is--animating');
        
        // Remove height and pointer events inline style
        currentElement.style.height = '';
        currentElementHeader.style.pointerEvents = '';
        
        // Verify if the currentElement has inline-styles and remove attribute if are empty
        if(currentElement.style.cssText.length === 0) {
            currentElement.removeAttribute('style');
        }
        
        if($parameters.IsKeypress) {
            // Add focus for Accessibility
            currentElement.focus();
        }
        
        // Set visibility through ARIA states - Accessibility
        $actions.SetAriaAttributes(true, $parameters.WidgetId);
        
        // Removes transitionend event listener
        currentElement.removeEventListener('transitionend', transitionEndHandler, false);   
    }
};
```

`SetAriaAttributes` / no `SetAttributes`:

```js
var currentAccordionItem = document.getElementById($parameters.ElementId);

// Set visibility through ARIA states - Accessibility
var setAriaExpanded = function(currentAccordionItem, status, ariaHidden) {
    if(currentAccordionItem) {
        currentAccordionItem.setAttribute('aria-expanded', status);
        currentAccordionItem.querySelector('.section-expandable-title').setAttribute('aria-expanded', status);
        currentAccordionItem.querySelector('.section-expandable-content').setAttribute('aria-hidden', ariaHidden);   
    }
};

if($parameters.IsExpand) {
    setAriaExpanded(currentAccordionItem, 'true', 'false');
} else {
    setAriaExpanded(currentAccordionItem, 'false', 'true');
}
```

`OnClick` / no `CloseAll`:

```js
var accordion = $parameters.AccordionObj;
var accordionItems = accordion.querySelectorAll(':scope > div > .section-expandable');
var thisElem = document.getElementById($parameters.WidgetId);

var isClosed = function(currentAccordionItem) {
    if(currentAccordionItem.classList.contains('is--closed')) {
        return true;
    }
    
    return false;
};

var currAccordionItem = thisElem;

for(var i = 0; i < accordionItems.length; i++) {
    var accordionItem = accordionItems[i];
    if(accordionItem !== currAccordionItem && !isClosed(accordionItem)) {
        accordionItem.CollapseItem();
    }
}






```

`OnClick` / no `ToggleClass`:

```js
var currentAccordionItem = document.getElementById($parameters.WidgetId);
var currentAccordionItemContent = currentAccordionItem.querySelector('.section-expandable-content');

// Toggle is--closed/is--open class from current accordion item
if($parameters.IsExpanded) {
    currentAccordionItem.classList.add('is--closed');
    currentAccordionItem.classList.remove('is--open');
    $parameters.IsOpen = false;
} else {
    currentAccordionItem.classList.add('is--open');
    currentAccordionItem.classList.remove('is--closed');
    $parameters.IsOpen = true;
}



```

`OnClick` / no `UpdateAttribute`:

```js
var accordionItem  = document.getElementById($parameters.WidgetId);

accordionItem.setAttribute('data-expanded', $parameters.IsExpanded);


```

`OnReady` / no `Init`:

```js
var sectionItem = document.getElementById($parameters.Id);
var sectionTitle = document.getElementById($parameters.TitleId);
var sectionContent = document.getElementById($parameters.ContentId);
var contentPlaceholder = document.getElementById($parameters.ContentPlaceholderId);
var accordion;
var isExpanded;
$parameters.HasContent = contentPlaceholder.innerHTML !== "";

accordion = sectionItem.closest('.accordion');

// If accordion selector with closest returns null, change to work with parent nodes
if(accordion === null){
    accordion = sectionItem.parentNode.parentNode;
}

var multipleItemsData = accordion.getAttribute('data-multiple-items');

// Check if is inside Accordion
if(accordion.classList.contains('accordion')) {
    $parameters.HasWrapper = true;
} 

// Check if MultipleItems is False
if(multipleItemsData === 'True') {
    $parameters.IsMultipleItems = true;
}

// Add classes if expanded set as true. Doing here, instead of using Platform If on div, to avoid conflict with FLIP animation
if($parameters.IsParameterChange) {
    if($parameters.IsExpanded) {
        $actions.Expand(false);
    } else {
        $actions.Collapse(false);
    }
} else if($parameters.IsExpanded) {
    sectionContent.classList.remove('is--collapsed');
    sectionContent.classList.add('is--expanded');
}


var onKeyDownPress = function(e){
    isExpanded = sectionTitle.getAttribute('aria-expanded');

    //If esc, Close AccordionItem
    if(isExpanded === "true" && e.keyCode == "27") {
        $actions.OnClick($parameters.Id, true);
        e.preventDefault();
        e.stopPropagation();
    }
    
    //If enter or space use the onAccordionClick to validate
    if (e.keyCode == "32" || e.keyCode == "13") {
        $actions.OnClick($parameters.Id, true);
        e.preventDefault();
        e.stopPropagation();
    }
};

if($parameters.HasContent) {
    sectionTitle.addEventListener('keydown', onKeyDownPress);
}

$parameters.AccordionObj = accordion;
```

`OnReady` / no `SetGlobalActions`:

```js
var element = document.getElementById($parameters.WidgetId);

// Add actions
element.CollapseItem = function() { 
    $actions.Collapse();
};

element.ExpandItem = function() { 
    $actions.Expand();
};

element.updateAccordion = function(i) { 
    $actions.OnUpdate(i);
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_AccordionItem1","source":"IMobileBlock:DEPRECATED_AccordionItem","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnToggle` resolve o IEventHandler pelo nome do evento e `$b/OnToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_AccordionItem1_OnToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsExpanded","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnToggle","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnToggle/IsExpanded","prop":"Value","value":"IsExpanded"}
```
