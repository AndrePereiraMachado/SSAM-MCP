# LayoutPopup

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Layouts** | publico | 9 widgets internos

The Layout for the RichWidgets Popup Editor.

On the popup page, select the object tree and use the LayoutPopup instead of the current Layout, then, add your content inside the layout.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DeviceConfiguration | DeviceConfiguration | nao |  | Configuration to change the default values that set when the application will be seen as phone, tablet or desktop. |
| AccessibilityConfiguration | AccessibilityConfiguration | nao |  | Configuration to change the default values for the options to reset tabindex values and to add a visible outline to focused elements. |

## Placeholders

- **MainContent**: Drag your content to this placeholder.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: LayoutWidgets, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var trapFocusPopup = function() {
    var element = document;

     var start = function() {
        var popElem = document.querySelector('.os-internal-ui-dialog');
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
    
    return {
        init: function() {
            start();
        }
    }
}
```

## CSS

Classes: `.MainPopup`

```css
html > body {
    min-height: 300px;
    min-width: 400px;
}

.MainPopup {
    -servicestudio-width: 100%;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutPopup1","source":"IWebBlock:LayoutPopup","as":"$b"}
{"op":"create","parent":"$b/MainContent","type":"IExpressionWidget","as":"$eMainContent"}
```
