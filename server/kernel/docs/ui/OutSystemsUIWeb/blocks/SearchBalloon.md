# SearchBalloon

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 22 widgets internos

Pattern of Search combined with an input Widget and the Balloon Pattern, in which you will be able to make a display of results inside a ballon.

Drag an Input Widget inside the placeholder to use as a search input and a list into Answers Placeholder to show in a Balloon.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |
| AdvancedFormat | Text | nao | "{hideOnClick: false, animation: ""fade"", arrow: false}" | Allow for more options for the display of answers beyond what it's provided through the input parameters.  Example:  "{animation: perspective}"  For more information visit:  https://atomiks.github.io/tippyjs/ |

## Placeholders

- **Icon**: Drag the Icon widget to this placeholder. (em `SearchBallonWrapper/Search`) | nasce com: WebBlockInstance:Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Input**: Drag the Input widget to this placeholder. (em `SearchBallonWrapper/Search`) | nasce com: Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Input/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)
- **Actions**: Drag your actions (a button or a link) to this placeholder. (em `SearchBallonWrapper/Search`)
- **Answers**: Drag a list of your items. (em `SearchBallonWrapper/Balloon/Content`) | nasce com: ListRecords:ListRecords1 (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnShow**(): Event triggered once the answers are shown.
- **OnHide**(): Event triggered once the answers are hidden.

## Composicao interna

- Usa os blocos: Balloon, Icon, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
/* Manually triggers the balloon according to the value of the search */
var SearchBalloon = function() {
    
    // Initial variables
    var input;
    var balloon;
    var searchFocus;
    var hasListeners = false;
    
    var openBalloon = function(searchFocus) {
        searchFocus._tippy.show();
    };
    
    var closeBalloon = function(searchFocus) {
        searchFocus._tippy.hide();
    };
    
    var addEventListeners = function() {
        if(input) {
            var isActive = searchFocus.classList.contains('tippy-active');
            hasListeners = true;
            
            input.addEventListener('focus', function() {
                if(input.value.length > 0 && !isActive) {
                    openBalloon(searchFocus);
                }
            });
            
            input.addEventListener('input', function() {
                if(input.value.length > 0 && !isActive) {
                    openBalloon(searchFocus);
                } else if(input.value.length === 0) {
                    closeBalloon(searchFocus);
                }
            });
            
            input.addEventListener('blur', function() {
                if(isActive) {
                    closeBalloon(searchFocus);
                }
            });
        }
    };
    
    // Starts the Balloon
    var start = function(widgetId, balloonId, search) {
        // Sets objects and variables
        input = document.querySelector('#' + widgetId + ' input');
        balloon = document.querySelector('#' + balloonId);
        searchFocus = document.querySelector('#' + search);
        
        if(!hasListeners) {
            // Add event listeners
            addEventListeners();
        }
        
        // Disables auto complete
        if(input) {
            input.setAttribute('autocomplete', 'off');
        }
    };
    
    return {
        init: function(widgetId, balloonId, search) {
            start(widgetId, balloonId, search);
            osAjaxBackend.BindAfterAjaxRequest(function() {
                start(widgetId, balloonId, search);
            });
        }
    };
}

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"SearchBalloon1","source":"IWebBlock:SearchBalloon","empty":true,"as":"$b"}
{"op":"set","target":"$b/Input/#IInput","prop":"Variable","value":"<variavel local>"}
{"op":"create","parent":"$b/Actions","type":"IExpressionWidget","as":"$eActions"}
```
