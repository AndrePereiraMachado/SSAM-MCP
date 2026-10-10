# LoadOnVisible

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Responsive** | publico | 12 widgets internos

Use the viewport position to late-load content.

## Inputs

Nenhum.

## Placeholders

- **Content**: Drag your content to this placeholder. (em `CanShowContent`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode
- Actions do bloco: Loadcontent
- Chama actions do modulo: Feedback_Message (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
var LoadOnVisible = function() {
    // Objects
    var loadOnVisible;
    var loadOnVisibleButton;
    var viewPortSize = 0;
    var elemPositionTop = 0;
    
    
    var start = function(widgetIdParam) {
        loadOnVisible = document.getElementById(widgetIdParam);
        
        if(loadOnVisible) {
            loadOnVisibleButton = loadOnVisible.querySelector('.load-on-visible-button');
            // If element is can be loaded, load it. Otherwise, add a scroll event listener
            if(canElementBeLoaded()) {
                loadElementContent(); 
            } else {
                window.addEventListener('scroll', scrollEventHandler);
            }
        }
    };

    // Loads the final content
    var loadElementContent = function() {
        // Verify if the container and the button exist
        if(loadOnVisible && loadOnVisibleButton) {
            loadOnVisibleButton.click();
        }
    };

    // On scroll, if the element is able to be loaded, load it and remove the scroll event listener 
    var scrollEventHandler = function() {
        if(canElementBeLoaded()) {
            loadElementContent();
            window.removeEventListener('scroll', scrollEventHandler, false);
        }
    };

    // Validate if the element is almost in range of the viewport, and if so, it can be loaded in order to be ready when it reached the viewport.
    // A threshold of 300px is used to validate if the element is indeed in range of the viewport.
    // This value (300px) was found after research to be the best to use on this situation.
    var canElementBeLoaded = function() {
        viewPortSize = window.innerHeight;
        elemPositionTop = loadOnVisible.getBoundingClientRect().top;
        
        if((elemPositionTop - viewPortSize) < 300) {
            return true;
        }
        
        return false;
    }

    return {
        init: function(widgetIdParam) {
            start(widgetIdParam);
        }
    }
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LoadOnVisible1","source":"IWebBlock:LoadOnVisible","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
