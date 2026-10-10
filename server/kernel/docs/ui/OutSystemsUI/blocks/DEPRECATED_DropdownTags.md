# DEPRECATED_DropdownTags

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 11 widgets internos

Enhanced Dropdown block, with search functionality and multiple tags selection.

Drag the block to your screen and set the ItemList parameter structure with your list. Use the SelectedItemsList parameter to define a pre-selected list of items.

Use the OnChange event to assign the current list selected to your local variable.

For advanced scenarios, use the AdvancedFormat parameter. To check the options available, read the official documentation: 
https://github.com/jshjohnson/Choices

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ItemList | DropdownItem List | sim |  | List of items to show in dropdown. |
| SelectedItemsList | DropdownItem List | nao |  | Use this parameter to set  pre-selected items. |
| IsRemoveItems | Boolean | nao | True | Set to False to disable the option for removing items. |
| IsDisabled | Boolean | nao | False | Set as True to disable the DropdownSearch. |
| SearchPrompt | Text | nao | "Search" | Text to display on the search prompt/ placeholder. |
| NoResultsText | Text | nao | "No results found" | Text to display when there are no results. |
| AdvancedFormat | Text | nao | "{}" | Allow for more options beyond what it's provided through the inputs.  Example:  "{ ""searchEnabled"": false }"  For more information visit:  https://github.com/jshjohnson/Choices  You can also use fuse.js options to change the search configurations. As an example, for a more stricted search, you can use:  "{ fuseOptions: {           threshold: 0.2,           matchAllTokens: true,           tokenize: true              }}  }"  For search configurations visit: https://fusejs.io/ |
| ExtendedClass | Text | nao | "" | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

- **OnChange**(CurrentList: DropdownItem List) [obrigatorio]: Triggered on value changed.

## Composicao interna

- Usa os blocos: Card, Tag
- Scripts exigidos: DEPRECATED_Choices
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> Init; OnDestroy -> OnDestroy
- Actions do bloco: Init, SerializeData, SetRTLObserver, OnInitialize, OnParametersChanged, GetCurrentList, OnChangeListener, OnDestroy
- Chama actions do modulo: IsRTL, ListIndexOf, ListAppend, AddRTLObserver, RemoveRTLObserver (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.GetIsRTL`, `OSFramework.OSUI.Event.DOMEvents.Observers.GlobalObserverManager.Instance.addHandler`, `OSFramework.OSUI.Event.DOMEvents.Observers.ObserverEvent.RTL`, `OSFramework.OSUI.Event.DOMEvents.Observers.GlobalObserverManager.Instance.removeHandler`

`Init` / no `Init`:

```js
var choices;
var listItemsList;
var selectedList;
var listItemsListParam = JSON.parse($parameters.ListItemsList);
var elementId = document.getElementById($parameters.WidgetId);
var str = String($parameters.AdvancedFormat);
var isRTL = $parameters.IsRTL;
var selected = $parameters.SelectedList.length > 0 ? JSON.parse($parameters.SelectedList) : $parameters.SelectedPosition;


function Sanitize(value) {
    if (typeof value === 'string') {
        if (value !== undefined && value !== null && value !== '') {
            return value.replace(/</g, '‹').replace(/>/g, '›');
        }
    }
    return value;
}


// Main function to init choices
var init = function(){
    
    // Map list keys to 'value' and 'label', as expected by the library
    listItemsList = listItemsListParam.map(function (obj) {
        var Value = Object.keys(obj)[0];
        var Label = Object.keys(obj)[1];
        return {value: Sanitize(obj.Value), label: Sanitize(obj.Text)};
    });
    
    if(selected !== -1) {
        if(selected !== $parameters.SelectedPosition) {
            for(var i = 0; i < selected.length; i++){
                if(selected[i] !== "-1") {
                    listItemsList[selected[i]].selected = true;
                }  
            }
        } else {
            listItemsList[$parameters.SelectedPosition].selected = true;
        }
    }

    // Set options
    var options = {
        choices: listItemsList,
        removeItemButton: $parameters.IsRemoveItems,
        itemSelectText: "",
        placeholderValue: $parameters.EmptyValue,
        noResultsText: $parameters.noResultsText,
        classNames: {containerOuter: 'choices ' + $parameters.ExtendedClass},
        fuseOptions: {
            includeMatches: true,
            threshold: 0.2,
            location: 0,
            distance: 100,
            maxPatternLength: 32,
            minMatchCharLength: 1
        }
    };
    
    if(str.length > 0) {
        var json = JSON.stringify(eval('(' + str + ')'));  
        options = mergeJSON(options, JSON.parse(json));
    }
    
    choices = new Choices(elementId, options);
    $parameters.ChoicesObj = choices;
    
    // Add title do inputs
    choices.input.element.setAttribute('title', $parameters.EmptyValue);
    elementId.setAttribute('title', "Select Item");
    
    // Set Disabled status
    if($parameters.IsDisabled) {
        choices.disable();
    } else if(!$parameters.IsDisabled && $parameters.IsUpdate) {
        choices.enable();
    }
    
    // Set rtl attributes
    // Set rtl attributes
    if(isRTL) {
        choices.direction = 'rtl';
        choices.containerOuter.element.setAttribute('dir', 'rtl');
        choices.choiceList.element.setAttribute('dir', 'rtl');
    } else {
        choices.direction = 'ltr';
        choices.containerOuter.element.setAttribute('dir', 'ltr');
        choices.choiceList.element.setAttribute('dir', 'ltr');
    }

    // Creates div around search input
    createEl('.choices__input--cloned', 'div', 'search--wrapper');
    
    $parameters.ChoicesObj.passedElement.element.addEventListener('change', $actions.GetCurrentList);

};

var getCurrentList = function(){
    hasEvent = true;
    var currentValue = $parameters.ChoicesObj.getValue();
    
    // Map selected keys to 'Value' and 'tEXT', as expected by OS DropdownItem Structure 
    selectedList = currentValue.map(function (obj) {
        var value = Object.keys(obj)[0];
        var label = Object.keys(obj)[1];
        return {Value: Sanitize(obj.value), Text: Sanitize(obj.label)};
    });

    $actions.OnChangeListener(JSON.stringify(selectedList));
};

// Recursive Function for closest()
var closestFn = function(element, classToSearch) {
    if(element && element.classList.contains(classToSearch)) {
        return element;
    } else if(!element || element && element.classList.contains('layout')) {
        return false;
    } else {
        return closestFn(element.parentElement, classToSearch);
    }
};

var isEmpty = function(str) {
    return (!str || 0 === str.length);
};

// Function to create div around search input (necessary for css search icon)
var createEl = function(query, tag, className, innerHTML) {
   var queryList = document.querySelectorAll(query);
   
   for(var i = 0; i < queryList.length; i++) {
        var elem = queryList[i];
        var wrapper = document.createElement(tag);
        if(!isEmpty(innerHTML)) { 
            wrapper.innerHTML = innerHTML; 
        }
        
        if(!closestFn(elem, className)){
            elem.parentElement.insertBefore(wrapper, elem);
            wrapper.appendChild(elem);
            wrapper.classList.add(className);
            
        }
   }
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
}

// Call init
init();
```

`SetRTLObserver` / no `SetActionAsObj`:

```js
$parameters.Action = $actions.OnParametersChanged;
```

`OnParametersChanged` / no `CheckObjectStatus`:

```js
$parameters.ObjectIsDefined = $parameters.Object !== null;
```

`GetCurrentList` / no `GetCurrentList`:

```js
var currentValue = $parameters.ChoicesObj.getValue();

// Map selected keys to 'Value' and 'tEXT', as expected by OS DropdownItem Structure 
var selectedList = currentValue.map(function (obj) {
    var value = Object.keys(obj)[0];
    var label = Object.keys(obj)[1];
    return {Value: obj.value, Text: obj.label};
});

$actions.OnChangeListener(JSON.stringify(selectedList));

```

`OnDestroy` / no `OnDestroy`:

```js
var elementId = document.getElementById($parameters.ElementId);
$parameters.ChoicesObj.destroy();

if(elementId) {
    elementId.options.length = 0;
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_DropdownTags1","source":"IMobileBlock:DEPRECATED_DropdownTags","as":"$b"}
{"op":"set","target":"$b/ItemList","prop":"Value","value":"<DropdownItem List>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnChange` resolve o IEventHandler pelo nome do evento e `$b/OnChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_DropdownTags1_OnChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"CurrentList","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"DropdownItem List"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnChange/CurrentList","prop":"Value","value":"CurrentList"}
```
