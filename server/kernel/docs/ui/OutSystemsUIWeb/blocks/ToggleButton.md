# ToggleButton

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 9 widgets internos

A mobile friendly pattern to switch between two states.

After placing the Web Block on your Web Screen, drag a checkbox inside the placeholder and the pattern will automatically use it.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **CheckBox**: Drag the check box widget to this placeholder. (em `ToggleButtonWrapper`) | nasce com: CheckBox (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var ToggleButton = function() {
    
    var start = function(widgetID) {
        var toggleButtonElem;
        
        toggleButtonElem = document.querySelector('#'+ widgetID + ' .toggle-button');   
        checkboxAttribute = toggleButtonElem.querySelector('.checkbox');
        
        if(!checkboxAttribute.hasAttribute('disabled')) {
            toggleButtonElem.addEventListener('click', function(e){
                var activeElem = e.currentTarget;

                if (activeElem.classList.contains('toggle-button-checked')) {
                    activeElem.classList.remove('toggle-button-checked');           
                } else {        
                    activeElem.classList.add('toggle-button-checked');         
                }            
            });
        } else {
            toggleButtonElem.classList.add('toggle-button-disabled');
        };
        
        if(checkboxAttribute.hasAttribute('checked')) {
            toggleButtonElem.classList.add('toggle-button-checked'); 
        };
                 
    };
    
    return {
        init: function(widgetID) {
            start(widgetID);
        }
    };
    
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ToggleButton1","source":"IWebBlock:ToggleButton","empty":true,"as":"$b"}
```
