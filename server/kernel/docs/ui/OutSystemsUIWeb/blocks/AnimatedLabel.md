# AnimatedLabel

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 12 widgets internos

Input fields with labels that animate when users focus the input.

Drag an input and label to the respective placeholders. You may use the IsInline parameter to define if it has input style.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsInline | Boolean | nao | True | If set as false, the input style in the block as default (white background). |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Label**: Drag the Label widget to this placeholder. (em `AnimatedLabelWrapper`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Input**: Drag the Input widget to this placeholder. (em `AnimatedLabelWrapper`) | nasce com: Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Input/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var newAnimatedLabel = function() {
    // Objects
    var input;
    var animatedLabel;
    
    var start = function(inputId, animatedLabelId) {
        // Gets objects
        input = document.querySelector('#' + inputId + ' input');
        animatedLabel = document.getElementById(animatedLabelId);
        
        var maxTime = 3000;
        var count = 0;
        var isFirefox = typeof InstallTrigger !== 'undefined';
        var isChrome = document.body.classList.contains('chrome');

        if(input !== null && animatedLabel) {
            // Adds event listeners
            input.addEventListener('focus', setAsActive);
            input.addEventListener('blur', setAsInative);
            
            input.addEventListener('animationstart', onAnimationStart, false);
            
            // Verify if input has values and set active
            if(input.value.length !== 0 && !input.classList.contains("active")) {
                animatedLabel.classList.add('active');
            }
            
            // Exception for Chrome, due to it's inconsistent behavior with auto-fill
            if(isChrome) {
                setTimeout(function() {
                  // If the input has pseudo-selector :-webkit-autofill add class .auto-filled to the input
                  var autofilled = matches(input, ":-webkit-autofill") ? animatedLabel.classList.add('auto-filled') : false;
                }, 0);
                
                // if it has class .auto-filled, removes class .active
                var checkAutoFilled = setInterval(function(){ 
                    if(animatedLabel.classList.contains('auto-filled') && input.value.length === 0) {
                        animatedLabel.classList.remove('active');
                        clearInterval(checkAutoFilled);
                    }
                }, 10);
            }
            
            // Used to for when selecting cached info from browser (not needed in Chrome)
            if(!isChrome) {
                input.addEventListener('input', function(){
                    if(input.value.length !== 0){
                        animatedLabel.classList.add('active');
                    }
                });
            }
            
            if(isFirefox) {
                var autoFill = setInterval(function() { 
                    if(input.value.length !== 0 && !input.classList.contains("active")) {
                        animatedLabel.classList.add('active');
                        clearInterval(autoFill);
                    };
                    
                    count = count + 10;
                    
                    if(count >= maxTime) {
                        clearInterval(autoFill);
                    }
                }, 10);
            } 
        }
    };
    
    var setAsActive = function() {
        // Adds active class
        if(animatedLabel && !animatedLabel.classList.contains('active')) {
            animatedLabel.classList.add('active');
        }
    };
    
    var setAsInative = function() {
        // Removes active class if it doesnt have a value
        if(input.value.length <= 0 && animatedLabel && animatedLabel.classList.contains('active')) {
            animatedLabel.classList.remove('active');
        }
    };
    
    var onAnimationStart = function() {
        animatedLabel.classList.add('active');
    };
    
    var matches = function(el, selector) {
      // Returns if element has class  
      return (el.matches || el.matchesSelector || el.msMatchesSelector || el.mozMatchesSelector || el.webkitMatchesSelector || el.oMatchesSelector).call(el, selector);
    };
    
    return {
        init: function(inputId, animatedLabelId) {
            start(inputId, animatedLabelId);
        }
    };
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"AnimatedLabel1","source":"IWebBlock:AnimatedLabel","empty":true,"as":"$b"}
{"op":"set","target":"$b/Input/#IInput","prop":"Variable","value":"<variavel local>"}
```
