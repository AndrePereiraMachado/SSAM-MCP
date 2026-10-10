# Dropdown

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 14 widgets internos

Button which triggers a dropdown of links.

Fill in the label of the dropdown button and add the required links on the DropdownList placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Prompt**: Drag text to this placeholder. (em `ButtonDropdownWrapper`)
- **DropdownList**: Drag the list of your links to this placeholder. (em `ButtonDropdownWrapper`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Icon, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
/* Closes the dropdown when the user clicks outside of dropdown */
var Dropdown = function() {
    var body;
    var dropdown;
    var dropdownButton;
    var dropDownListItems;
    
    var start = function(widgetId) {
        // Gets objects
        body = document.querySelector('body');
        dropdown = document.getElementById(widgetId);
        dropdownButton = dropdown.querySelector('.dropdown-header');
        dropdownList = dropdown.querySelector('.dropdown-content-list');

        // change the tabindex values to -1
        dropDownListItems = dropdownList.querySelectorAll('[tabindex]');
        dropDownListItems = [].slice.call(dropDownListItems);
        setTabIndexValue('-1');

        if(dropdownButton.querySelector("input")) {
            dropdownButton.querySelector("input").setAttribute('tabindex', '-1');
        }
        
        // Add event listeners
        body.addEventListener('click', screenClickHandler);
        dropdownButton.addEventListener('keydown', onDropdownKeypress);
        dropdownButton.addEventListener('click', onDropdownClick);
    };
    
    var isChildrenOf = function(element, parent) {
        // Checks if element is children of parent
        if(element && element.parentElement && element.parentElement === parent) {
            return element.parentElement;
        } else if( !element || element && element.parentElement && element.parentElement.classList.contains('page')) {
            return false;
        } else {
            return isChildrenOf(element.parentElement, parent);
        }
    };

    var setTabIndexValue = function (value) {
        dropDownListItems.forEach(function(item) {
            item.setAttribute('tabindex', value);
        });
    }
    
    var onDropdownClick = function() {
        toggleDropdown();
    };
    
    var onDropdownKeypress = function(e) {
        e.stopPropagation();
        
        if (e.keyCode == "13") {
            toggleDropdown();
        } else if(e.keyCode == "27" && dropdown.classList.contains('is--visible')) {
            dropdown.classList.remove('is--visible');
            dropdown.classList.add('is--hidden');
            dropdownButton.setAttribute('aria-expanded','false');
            dropdownList.setAttribute('aria-hidden','true');

            setTabIndexValue('-1');
        } else if(e.keyCode == "32" && dropdown.classList.contains('is--hidden')) {
            dropdown.classList.remove('is--hidden');
            dropdown.classList.add('is--visible');
            dropdownButton.setAttribute('aria-expanded','true');
            dropdownList.setAttribute('aria-hidden','false');

            setTabIndexValue('0');
        }
    };
    
    var toggleDropdown = function() {
        if(dropdown.classList.contains('is--visible')){
            dropdown.classList.remove('is--visible');
            dropdown.classList.add('is--hidden');
            dropdownButton.setAttribute('aria-expanded','false');
            dropdownList.setAttribute('aria-hidden','true');

            setTabIndexValue('-1');
        } else {
            dropdown.classList.remove('is--hidden');
            dropdown.classList.add('is--visible');
            dropdownButton.setAttribute('aria-expanded','true');
            dropdownList.setAttribute('aria-hidden','false');

            setTabIndexValue('0');
        }
    }
    
    var screenClickHandler = function(e) {
        // Closes dropdown if target doesn't have the current dropdown element as a parent
        if(dropdown.classList.contains('is--visible') && !isChildrenOf(e.target, dropdown)) {
            onDropdownClick();
        }
    };
    
    return {
        init: function(widgetId) {
            start(widgetId);        
        }
    };
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Dropdown1","source":"IWebBlock:Dropdown","as":"$b"}
{"op":"create","parent":"$b/Prompt","type":"IExpressionWidget","as":"$ePrompt"}
{"op":"create","parent":"$b/DropdownList","type":"IExpressionWidget","as":"$eDropdownList"}
```
