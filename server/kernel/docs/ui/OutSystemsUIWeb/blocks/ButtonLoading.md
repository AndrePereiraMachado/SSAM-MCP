# ButtonLoading

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Utilities** | publico | 12 widgets internos

Button with loading state when is clicked.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsLoading | Boolean | sim |  | When true, the button shows the loading state. |
| ShowLoadingAndLabel | Boolean | nao | False | If true, the loading spinner will appear side by side with the label. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Button**: Drag a Button or a link to this placeholder | nasce com: Link (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var ButtonLoading = function() {
    
    // Objects
    var elemId;
    var IsLoading;
    var button;
    
    var start = function(widgetId, isLoading) {
        
        elemId = document.getElementById(widgetId);
        button = elemId.querySelector('.btn');
        IsLoading = (isLoading === 'True');

        button.addEventListener('keydown', onButtonKeypress);
        
    };
    
    var onButtonKeypress = function(e){
    
        if((e.keyCode == "13" || e.keyCode == "32") && IsLoading) {
          e.preventDefault();
        } else {
            button.removeEventListener('keydown', onButtonKeypress); 
            return true;
        }

    };

    return {
        init: function(widgetId, isLoading) {
            start(widgetId, isLoading);
        }
    };
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ButtonLoading1","source":"IWebBlock:ButtonLoading","empty":true,"as":"$b"}
{"op":"set","target":"$b/IsLoading","prop":"Value","value":"<Boolean>"}
```
