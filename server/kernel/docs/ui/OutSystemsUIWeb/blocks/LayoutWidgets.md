# LayoutWidgets

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Layouts** | publico | 17 widgets internos

The must have widgets in every OutSystems UI layout, it contains essential pieces like feedback messages, device detection, internet explorer compatibility and  RTL scripts.

Make sure to have this Web Block inside your page layout. This is done by default in all OutSystems UI Framework templates.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DeviceConfiguration | DeviceConfiguration | nao |  | Configuration to change the default values that set when the application will be seen as phone, tablet or desktop. |
| AccessibilityConfiguration | AccessibilityConfiguration | nao |  |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: ServiceStudioPreview, ClosestPolyfill, DeviceDetection, CSSVarsPonyfill, JSON5_2_1_0, Feedback_AjaxWait, Feedback_Message, Icon, RTL
- Chama actions do modulo: RunJavaScript, ResetTabIndex, ShowFocus, AccessibilityMetaTags (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
document.addEventListener("DOMContentLoaded", function() {
    
    var body = document.body;
    var isMobile = body.classList.contains('phone') || (body.classList.contains('tablet') && body.classList.contains('portrait'))
    
    // function to add default responsive behaviot for Table widget
    var TableResponsive = function() {
        var table, tableWrapper;
        
        var start = function() {
            table = document.querySelectorAll('.TableRecords');
            
            for(var i = 0; i < table.length; i++){
                if(table[i].classList.contains('no-responsive') || table[i].classList.contains('translatedToResponsive')){
                    continue;
                }
                    
                tableWrapper = document.querySelector('.table-records-responsive');
                // Check if it's not inside ResponsiveTable pattern
                if(tableWrapper && !tableWrapper.contains(table[i]) || !tableWrapper ){
                    prepareElements(table[i]);
                } 
            }
        };
             
        var prepareElements = function(table) {
            
            // Verify if the table was already rebuilt to responsive
            if(table.classList.contains('translatedToResponsive'))
                return;
        
            var label = [];

            tableLabels = table.querySelectorAll('thead th');
            tableRow = table.querySelectorAll('tbody tr');
            tableTd = table.querySelectorAll('td');
            
            // Get Labels
            for(i = 0; i < tableLabels.length; i++) {
                label.push(getTextContentExceptScript(tableLabels[i]));
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
            
            // Add validation class to prevent multiple header builds
            table.classList.add('translatedToResponsive');
        };
        
        // get textContent function, that ignores script tags
        var getTextContentExceptScript = function(element) {
            var text = [];
            for (var i= 0, n= element.childNodes.length; i<n; i++) {
                var child= element.childNodes[i];
                if (child.nodeType===1 && child.tagName.toLowerCase()!=='script')
                    text.push(getTextContentExceptScript(child));
                else if (child.nodeType===3)
                    text.push(child.data);
            }
            return text.join('');
        }
        
        return {
            init: function() {
                start();
            }
        };
    };
            
    var tableResponsive = new TableResponsive();
    
    // If it opens first time as mobile, init
    if(isMobile) {
        tableResponsive.init();
        osAjaxBackend.BindAfterAjaxRequest(function(){
            tableResponsive.init();
        });
    } else { // else prpare observer to init when resizing to mobile
        var targetNode = body;
        // Options for the observer (which mutations to observe)
        var config = { attributes: true, attributeFilter: ["class"] };
        
        var observer = new MutationObserver(function(mutations) {
          mutations.forEach(function(mutation) {
                if(mutation.target.classList.contains('phone') || (mutation.target.classList.contains('tablet') && mutation.target.classList.contains('portrait'))) {
                    tableResponsive.init();
                };                
            });   
        });
        
        // Start observing the target node for configured mutations
        observer.observe(targetNode, config);
    }

});
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutWidgets1","source":"IWebBlock:LayoutWidgets","as":"$b"}
```
