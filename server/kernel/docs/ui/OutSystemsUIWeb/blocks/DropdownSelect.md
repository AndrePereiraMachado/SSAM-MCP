# DropdownSelect

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 8 widgets internos

Enhanced Combo/ List box usable in forms.

If you bind it to a Combo Box widget, it will work as an selectable Dropdown. 
If you bind it to a List Box, works as an multi select, creating removable tags.

Drag the pattern next to a Combo/ List Box and bind the two in the WidgetId parameter or using the ExtendedClass parameter.

For advanced scenarios, use the AdvancedFormat parameter. To know how to use this, read the official documentation: 
https://github.com/jshjohnson/Choices

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| WidgetId | Text | sim |  | Element Name (Combo Box and List Box) that will trigger the element to be visible. |
| NoResultsText | Text | nao | "No results found" | Text to display when there are no results. |
| SearchEnabled | Boolean | nao | True | If set to false, removes the search functionality.  Doesn't work with ListBox. |
| SearchResultsLimit | Long Integer | nao | 10 | Limit number of results shown. |
| AdvancedFormat | Text | nao | "{}" | Allow for more options beyond what it's provided through the inputs.  Example:  "{ ""searchEnabled"": false }"  For more information visit:  https://github.com/jshjohnson/Choices |
| ExtendedClass | Text | nao |  | Set a class. You can then use it to bind all other ComboBox/ListBox in your screen. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode, Choices_v3_0_3

## JavaScript

JavaScript do bloco:

```js
var newDropdownSelect = function() {
    
    // Objects
    var elementId;
    var elementClass;
    var extendedOptions;
    var choices;
    var options;
    
    var start = function(widgetId, classParam, optionsParam, advancedFormat) {
        elementId = document.getElementById(widgetId);
        
        if(classParam.length > 0) {
            elementClass = classParam;
        }
          
        extendedOptions = advancedFormat;
        options = {
            noResultsText: optionsParam.noResultsText,
            searchResultLimit: optionsParam.searchResultLimit,
            searchEnabled: optionsParam.searchEnabled,
            shouldSort: false,
            callbackOnInit: onInit,
        };
        
        if(extendedOptions.length > 0) {
            var advancedObj = eval('(' + extendedOptions + ')');
            options = mergeJSON(options, advancedObj);
        }
        
        if(elementId) {
            choices = new Choices('#' + widgetId, options);
        };
        
        // AdvancedFormat function
        function mergeJSON(target, add) {
            function isObject(obj) {
                if (typeof obj == 'object') {
                    for (var key in obj) {
                        if (obj.hasOwnProperty(key)) {
                            return true; // search for first object prop
                        }
                    }
                }
                return false;
            }
            for (var key in add) {
                if (add.hasOwnProperty(key)) {
                    if (target[key] && isObject(target[key]) && isObject(add[key])) {
                        mergeJSON(target[key], add[key]);
                    } else {
                        target[key] = add[key];
                    }
                }
            }
            return target;
        };
        
        // Recursive Function for closest() in IE
        var closestFn = function(element, classToSearch) {
            if(element && element.classList.contains(classToSearch)) {
                return element;
            } else if(!element || element && element.classList.contains('layout')) {
                return false;
            } else {
                return closestFn(element.parentElement, classToSearch);
            }
        };
        
        function isEmpty(str) {
            return (!str || 0 === str.length);
        }
        
       // Function to create div around search input (necessary for css search icon)
       var createEl = function(query, tag, className, innerHTML) {
           var queryList = document.querySelectorAll(query);
           
           for(var i = 0; i < queryList.length; i++) {
                var elem = queryList[i];
                var wrapper = document.createElement(tag);
                if(!isEmpty(innerHTML)) { 
                    wrapper.innerHTML = innerHTML 
                }
                
                if(!closestFn(elem, className)){
                    elem.parentElement.insertBefore(wrapper, elem);
                    wrapper.appendChild(elem);
                    wrapper.classList.add(className);
                    
                }
           }
        };
        
        // Creates div around search input
        createEl('.choices__input--cloned', 'div', 'search--wrapper', '');
        
        // Add title do input
        if(choices) {
            choices.input.setAttribute('title', "Search");
        }

        // Get all elements with class .choices
        var choicesClass = document.querySelectorAll('.choices');
        var choicesListClass = document.querySelectorAll('.choices__list');
        
        // Check for rtl and set correct attribute on every element
        if(document.body.classList.contains('is-rtl')) {
            for(var i = 0; i < choicesClass.length; i++) {
                choicesClass[i].setAttribute('dir', 'rtl');
            }
            for(var i = 0; i < choicesListClass.length; i++) {
                choicesListClass[i].setAttribute('dir', 'rtl');
            }
        };
        
        // Verify if select has the attribute disabled        
        var choicesSelect = document.querySelectorAll('.choices');
        
        if(choicesSelect) {
            for(var i = 0; i < choicesSelect.length; i++) {
                var choicesDisabled = choicesSelect[i].querySelector('select');
                
                if(choicesDisabled.hasAttribute('disabled')) {
                    choicesSelect[i].classList.add('choices-disabled');
                };       
            };
        };

        /*
         * Fix issue with DropdownSelect not displaying correctly and the options not being selectable when inside EditableTable.
         *
         * The issues only occur when the dropdown is opened, so we use the showDropdown and the hideDropdown events to add and remove the classes that fix the issues.
         */
        var isFirefox = document.body.classList.contains('firefox');
        var editableTables = document.querySelectorAll(".EditableTable")
        var isInsideEditableTable = false;

        for (var i = 0; i < editableTables.length; i++){
            if(editableTables[i].contains(choices.passedElement)) isInsideEditableTable = true;
        }

        // Add the event listeners if in Firefox and the dropdown is inside a EditableTable
        if(isFirefox && isInsideEditableTable){
            choices.passedElement.addEventListener(
              'showDropdown',
              function(event) {
                editableTable = event.currentTarget.closest(".EditableTable.OnEdit"); // get the EditableTable element
                editableTable.classList.add("transform-none"); // add the class to the EditableTable element
                rowControlGroup = document.querySelector(".RowControlGroup"); // get the RowControlGroup element
                rowControlGroup.classList.add("visibility-hidden"); // add the class to the RowControlGroup element
              },
        
/* ... truncado: 2392 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"DropdownSelect1","source":"IWebBlock:DropdownSelect","as":"$b"}
{"op":"set","target":"$b/WidgetId","prop":"Value","value":"<Text>"}
```
