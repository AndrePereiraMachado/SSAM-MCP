# ResponsiveTableRecords

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Responsive** | publico | 7 widgets internos

Makes table rows expandable or make table rows horizontally scrollable in phone and tablet portrait.

Add this Web Block to the screen and place a table records in the placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ResponsiveBehavior | ResponsiveTableRecords Identifier | sim |  | TableRecords responsive behavior. |

Valores possiveis (static entities):

- **Entities.ResponsiveTableRecords**: ExpandableRows, ScrollabeRows

## Placeholders

- **Content**: Drag your Records to this placeholder.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var ResponsiveTables = function() {
    var table;
    
    var start = function(widgetId) {
        table = document.getElementById(widgetId);
    
        var expandableRow = document.querySelector('.table-records-responsive.expandable-row');

        if(expandableRow) {
            var expandTableRecords = table.querySelectorAll('.table-records-responsive.expandable-row td:first-child');

            // Function to get all labels's textcontent, and insert them on a new created div 
            prepareElements();

            // Loop through every row on table
            for(i = 0; i < expandTableRecords.length; i++) {
                // Add eventListeners
                addEventListeners(expandTableRecords[i]);
                // Set initial Aria Attributes
                setAriaAttributes(expandTableRecords[i]);
                expandTableRecords[i].setAttribute("tabindex", "0");
            }
        }
    };

    var prepareElements = function() {
        
        var label = [];

        tableLabels = table.querySelectorAll('thead th');
        tableRow = table.querySelectorAll('tbody tr');
        tableTd = table.querySelectorAll('td');
        
        // Get Labels
        for(i = 0; i < tableLabels.length; i++) {
            label.push(tableLabels[i].textContent);
        }
        
        // Verification to account for tables with Show Header set as False
        if(label.length > 0) {
            // Create TableRecords_Label on each td
            for(i = 0; i < tableRow.length; i++) {
                for(i = 0; i < tableTd.length; i++) {          
                    // Create div to receive each tableLabel on mobile      
                    var labelElem = document.createElement('div'); 
                    
                    // Make label index equal to necessary td's available
                    var labelFullArray = label.concat(labelFullArray);
                    
                    // Remove "trash" text when using List_SortColumn from RichWidget.
                    var labelFinal = labelFullArray[i].split(/lnkSort[\s\S]*/);
                    
                    // Insert label text on labelElem (div) 
                    labelElem.innerHTML += labelFinal[0];

                    // Insert the labelElem div, with the necessary CSS class, and set it as first-child of each td
                    labelElem.classList.add('TableRecords_Label');
                    tableTd[i].insertAdjacentElement('afterbegin', labelElem);    
                }
            }     
        }
    };
    
    var addEventListeners = function(elem) {
        // Adds event listeners
        elem.addEventListener('click', onResponsiveTableClick);
        elem.addEventListener('keydown', onResponsiveTableKeydown);
    }

    var onResponsiveTableClick = function() {
        this.parentNode.classList.toggle('TableRecords_ExpandedRow');
        setAriaAttributes(this);
    }

    var onResponsiveTableKeydown = function(e) {
        // If pressed space(32) or enter (13)
        if (e.keyCode == "32" || e.keyCode == "13") {
            this.parentNode.classList.toggle('TableRecords_ExpandedRow'); 
        }

        setAriaAttributes(this);
        e.preventDefault();
        e.stopPropagation();
    }

    // Set visibility through ARIA states - Accessibility
    var setAriaAttributes = function(elem) {
        if(elem.parentNode.classList.contains('TableRecords_ExpandedRow')) {
            elem.parentNode.setAttribute("aria-expanded", "true");
        } else {
            elem.parentNode.setAttribute("aria-expanded", "false");
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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ResponsiveTableRecords1","source":"IWebBlock:ResponsiveTableRecords","as":"$b"}
{"op":"set","target":"$b/ResponsiveBehavior","prop":"Value","value":"<ResponsiveTableRecords Identifier>"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
