# LayoutMenuTop

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Layouts** | publico | 6 widgets internos

Custom layout with a menu on top.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |
| DeviceConfiguration | DeviceConfiguration | nao |  | Configuration to change the default values that set when the application will be seen as phone, tablet or desktop. |
| AccessibilityConfiguration | AccessibilityConfiguration | nao |  | Configuration to change the default values for the options to reset tabindex values and to add a visible outline to focused elements. |

## Placeholders

- **Header**: Drag your content to this placeholder.
- **Content**: Drag your content to this placeholder.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: LayoutWidgets

## JavaScript

JavaScript do bloco:

```js
document.addEventListener("DOMContentLoaded", function(event) {

    // detect IE11 and IE10
    var isIE = document.body.classList.contains("ie11") || document.body.classList.contains("ie10");
    
    // get total header size to space the main content
    var headerGutter = document.querySelector(".header").offsetHeight;
    
    if(!isIE) {
        var headerContent = document.querySelector(".header-content");        
        
        if(headerContent) {
            var headerContentSize = headerContent.offsetHeight;
            
            if(headerContentSize > 0) {            
                document.querySelector(".main").style.setProperty('--header-gutter', headerGutter + "px");
            }
        }    
    }
    
    // get the MenuIcon and Menu DOM elements    
    var menuIcon = document.querySelector(".menu-icon");
    var menu = document.querySelector(".Application_Menu");

    // add the event listeners if both elements exist
    if(menu !== null && menuIcon !== null) {
        // open the menu
        menuIcon.addEventListener("click", function() {
            menu.classList.add("is--visible");
        });
        
        // close the menu
        menu.addEventListener('click', function(e) {
            // close the menu if the click is on the overlay
            if(e.target === menu) {
                menu.classList.remove('is--visible');
            }
        });
    }
});
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutMenuTop1","source":"IWebBlock:LayoutMenuTop","as":"$b"}
{"op":"create","parent":"$b/Header","type":"IExpressionWidget","as":"$eHeader"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
