# DEPRECATED_DropdownSearch

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 8 widgets internos

Enhanced Dropdown block, with search functionality.

Drag the block to your screen and set the ItemList parameter structure with your list. Use the SelectedItem parameter to define a pre-selected item.

Use the OnSelect event to assign the current value selected to your local variable.

For advanced scenarios, use the AdvancedFormat parameter. To check the options available, read the official documentation: 
https://github.com/jshjohnson/Choices

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ItemList | DropdownItem List | sim |  | List of items to show in dropdown. |
| SelectedItem | DropdownItem | nao |  | Use this parameter to set a pre-selected item. |
| IsDisabled | Boolean | nao | False | Set as True to disable the DropdownSearch. |
| EmptyText | Text | nao | "Select an item" | Text to display when there are no items selected and to serve as an empty value. |
| SearchPrompt | Text | nao | "Search" | Text to display on the search prompt/ placeholder. |
| NoResultsText | Text | nao | "No results found" | Text to display when there are no results. |
| AdvancedFormat | Text | nao | "{}" | Allow for more options beyond what it's provided through the inputs.  Example:  "{ ""searchEnabled"": false }"  For more information visit:  https://github.com/jshjohnson/Choices  You can also use fuse.js options to change the search configurations. As an example, for a more stricted search, you can use:  "{ fuseOptions: {           threshold: 0.2,           matchAllTokens: true,           tokenize: true              }}  }"  For search configurations visit: https://fusejs.io/ |
| ExtendedClass | Text | nao | "" | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

- **OnSelect**(SelectedItem: DropdownItem) [obrigatorio]: Triggered on item select.

## Composicao interna

- Scripts exigidos: DEPRECATED_Choices
- Ciclo de vida: OnParametersChanged -> OnParametersChanged; OnReady -> Init; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnChangeListener, OnParametersChanged, OnShowDropdown, SetRTLObserver, Init, OnHideDropdown, GetValueOnSelect
- Chama actions do modulo: RemoveRTLObserver, AddRTLObserver, IsRTL, ListIndexOf (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OSFramework.OSUI.Event.DOMEvents.Observers.GlobalObserverManager.Instance.removeHandler`, `OSFramework.OSUI.Event.DOMEvents.Observers.ObserverEvent.RTL`, `OSFramework.OSUI.Event.DOMEvents.Observers.GlobalObserverManager.Instance.addHandler`, `OutSystems.OSUI.Utils.GetIsRTL`

`OnDestroy` / no `OnDestroy`:

```js
$parameters.ChoicesObj.destroy();
```

`OnParametersChanged` / no `CheckObjectStatus`:

```js
$parameters.ObjectIsDefined = $parameters.Object !== null;
```

`SetRTLObserver` / no `SetActionAsObj`:

```js
$parameters.Action = $actions.OnParametersChanged;
```

`Init` / no `Init`:

```js
var str = String($parameters.AdvancedFormat);
var paramList = JSON.parse($parameters.ItemList);
var elementId = document.getElementById($parameters.WidgetId);
var isRTL = $parameters.IsRTL;
var isDisabled = $parameters.IsDisabled;
var showEmptySelected = true;
var choices;
var itemList = [];

function Sanitize(value) {
    if (typeof value === 'string') {
        if (value !== undefined && value !== null && value !== '') {
            return value.replace(/</g, '‹').replace(/>/g, '›');
        }
    }
    return value;
}

// Map paramList to a new one, as the library only supports 'value' and 'label'. 
// We'll also sanitize both labels and values to reduce XSS vulnerabilities
for(var i = 0; i < paramList.length; i++) {
    itemList.push({value:Sanitize(paramList[i].Value), label: Sanitize(paramList[i].Text)});
}

// Function to set the options and parameters and init the Choices
var init = function(){
    
    // Validate if SelectedItem is set
    if($parameters.SelectedPosition >= 0) {
        itemList[$parameters.SelectedPosition].selected = true;
        showEmptySelected = false;
    } 
    
    // Set default options 
    var options = {
        choices: itemList,
        itemSelectText: "",
        noResultsText: $parameters.noResultsText,
        searchPlaceholderValue: $parameters.searchPlaceholderValue,
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

    // Create choices
    choices = new Choices(elementId, options);
    
    // Add placeholder only if not using selectedItem and EmptyValue isn't empty
    if($parameters.EmptyValue !== "") {
        choices.setChoices([{value: $parameters.NullValue, label: $parameters.EmptyValue, selected: showEmptySelected, disabled: false, placeholder: true}], 'value', 'label', false);
    }
    
    // Assign choices object to output, to be able to destroy it OnDestroy
    $parameters.ChoicesObj = choices;
    
    // Creates div around search input
    createEl('.choices__input--cloned', 'div', 'search--wrapper');
    
    // Add title do inputs
    choices.input.element.setAttribute('title', $parameters.searchPlaceholderValue);
    elementId.setAttribute('title', "Select options");
    
    // Set Disabled status
    if(isDisabled) {
        choices.disable();
    } else {
        choices.enable();
    }
    
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
    
    // Add change listener on opening Dropdown, to pass set IsSelecting to true
    choices.passedElement.element.addEventListener('showDropdown', function(event){
        $actions.OnShowDropdown();
    });
    
    // Add change listener on closing Dropdown, to pass set IsSelecting to false
    choices.passedElement.element.addEventListener('hideDropdown', function(event){
        $actions.OnHideDropdown();
    });
    
    // Add change listener on input, to pass currentValue to event
    choices.passedElement.element.addEventListener('choice', $actions.GetValueOnSelect);
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

// Function to create div around search input (necessary for css search icon)
var createEl = function(query, tag, className) {
   var queryList = document.querySelectorAll(query);
   
   for(var i = 0; i < queryList.length; i++) {
        var elem = queryList[i];
        var wrapper = document.createElement(tag);

        if(!closestFn(elem, className)){
            elem.parentElement.insertBefore(wrapper, elem);
            wrapper.appendChild(elem);
            wrapper.classList.add(className);
        }
   }
};

// AdvancedFormat
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

`GetValueOnSelect` / no `GetValueOnSelect`:

```js
// Check if is Placeholder to pass Null Values
var isPlaceholder = $parameters.Event.detail.choice.placeholder;
var currentValue = isPlaceholder ? $parameters.NullValue : $parameters.Event.detail.choice.value;
var currentLabel = isPlaceholder ? $parameters.NullText : $parameters.Event.detail.choice.label;

$actions.OnChangeListener(currentValue, currentLabel);
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_DropdownSearch1","source":"IMobileBlock:DEPRECATED_DropdownSearch","as":"$b"}
{"op":"set","target":"$b/ItemList","prop":"Value","value":"<DropdownItem List>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnSelect` resolve o IEventHandler pelo nome do evento e `$b/OnSelect/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_DropdownSearch1_OnSelect","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SelectedItem","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"DropdownItem"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnSelect","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnSelect/SelectedItem","prop":"Value","value":"SelectedItem"}
```
