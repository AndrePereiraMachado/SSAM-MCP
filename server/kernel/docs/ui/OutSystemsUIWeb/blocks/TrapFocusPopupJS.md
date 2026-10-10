# TrapFocusPopupJS

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Private** | privado | 0 widgets internos

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Chama actions do modulo: RunJavaScript (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
function trapFocusPopup() {
    var element = document;
    var focusableClose = window.parent.document.querySelector('a.os-internal-ui-dialog-titlebar-close, a.os-internal-ui-dialog-titlebar-close-no-title');
    var focusableEls = element.querySelectorAll('a[href]:not([disabled]), button:not([disabled]), textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]),input[type="submit"]:not([disabled]), select:not([disabled])');
        firstFocusableEl = focusableEls[0];  
        lastFocusableEl = focusableEls[focusableEls.length - 1];
        KEYCODE_TAB = 9;
        KEYCODE_ESCAPE = 27;
    
    if(focusableClose) {
        focusableClose.setAttribute('tabindex', "0");
    }
    
    document.addEventListener('keydown', function(e) {
        var isTabPressed = (e.key === 'Tab' || e.keyCode === KEYCODE_TAB);
        var isEscapedPressed = (e.key === 'Escape' || e.keyCode === KEYCODE_ESCAPE);
        
        if(!isTabPressed && !isEscapedPressed) {
            return;
        }
        
        if (isEscapedPressed && focusableClose) /* Escape */ {
            focusableClose.click();
            e.preventDefault();
        } 
        
        if ( e.shiftKey ) /* shift + tab */ {
            if (document.activeElement === firstFocusableEl && focusableClose) {
                focusableClose.focus();
                e.preventDefault();
            }
        } else if (document.activeElement === lastFocusableEl && focusableClose) {
            focusableClose.focus();
            e.preventDefault();
        } 
    });
    
    firstFocusableEl.focus();
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"TrapFocusPopupJS1","source":"IWebBlock:TrapFocusPopupJS","as":"$b"}
```
