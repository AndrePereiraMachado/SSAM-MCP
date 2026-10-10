# Gallery

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Structure** | publico | 7 widgets internos

Creates a Gallery list, with full control over the number of items per line.

Used when you want to list out items in a gallery view and define the number of items per device.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ItemsDesktop | Integer | nao | 5 | Number of Items per line on Desktop.  Default Value: 5 |
| ItemsTablet | Integer | nao | 3 | Number of Items per line on Tablet.  Default Value: 3 |
| ItemsPhone | Integer | nao | 1 | Number of Items per line on Phone.  Default Value: 1 |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **ListRecords**: Drag your records here. You can also drag a ListRecord to get items dynamically.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var Gallery = function() {  
    var widgetElementId;
    var nritemsDesktop;
    var nritemsTablet;
    var nrItemsPhone;
    
    var galleryEl;
    var listEl;
    var galleryItems;
    var columnWidth;
    var divider;
    var gutter;
    var margin;
    var rtime;
    var timeout = false;
    var delta = 200;

    function initGallery(widgetId, itemsDesktop, itemsTablet, itemsPhone) {        
           
        // get device define column width
        var body = document.querySelector("body");
        isDesktop = body.classList.contains("desktop");
        isTablet = body.classList.contains("tablet");
        isPhone = body.classList.contains("phone");
        
        widgetElementId = widgetId;
        nritemsDesktop = itemsDesktop;
        nritemsTablet = itemsTablet;
        nrItemsPhone = itemsPhone;
        
        if(isDesktop) {
            divider = itemsDesktop;
        } else if(isTablet) {
            divider = itemsTablet;
        } else if(isPhone) {
            divider = itemsPhone;
        }

        //gutter = GutterSize;
        gutter = 20;
        
        // 1.96078431372549 gutter measure in Platform Grid
        margin = 1.96;
        columnWidth = (100 - (gutter ? (divider -1) * margin : 0)) / divider;

        // define the gallery element
        galleryEl = document.getElementById(widgetId);

        // define list element
        if(galleryEl.children[0].classList.contains("ListRecords")) {
            listEl = galleryEl.children[0];
            galleryItems = listEl;
        } else {
            galleryItems = galleryEl;
        }
        
        galleryItems.classList.add("gallery-content");
        galleryItems.classList.add("is--hidden");
        
        // resize gallery items
        resizeElements(galleryItems);
        
        galleryItems.classList.remove("is--hidden");
        galleryItems.classList.add("is--visible");
    }

    var resizeElements = function(el) {
        el.classList.remove("is--visible");
        el.classList.add("is--hidden");
        
        var isRTL = document.querySelector(".is-rtl");
        
        for(var i=0; i < el.children.length; i++) {
            var element = el.children[i];
            
            element.classList.add("gallery-item");
            
            // remove margins
            if(isRTL) {
                element.style.removeProperty('margin-right');
            } else {
                element.style.removeProperty('margin-left');
            }
            element.style.removeProperty('margin-left');
            element.style.removeProperty('margin-top');

            // set width to all elements
            element.style.width = columnWidth + "%";

            // set left margin to all except first in row
            if(i%divider !== 0 && gutter) {
                if(isRTL) {
                    element.style.marginRight = margin + "%";   
                } else {
                    element.style.marginLeft = margin + "%";   
                }
            }

            // set margin top to all expect first row
            if(i >= divider && gutter) {
                element.style.marginTop = margin + "%";    
            }
            
        }        
    }

    function resizeend() {
        if (new Date() - rtime < delta) {
            setTimeout(resizeend, delta);
        } else {
            timeout = false;                
            initGallery(widgetElementId, nritemsDesktop, nritemsTablet, nrItemsPhone);
        } 
    }

    window.addEventListener("resize", function() {                
        rtime = new Date();
        if (timeout === false) {
            timeout = true;
            setTimeout(resizeend, delta);
        }        
    }, false);
    
    return {
        init: function(widgetId, ItemsDesktop, ItemsTablet, ItemsPhone) {
            initGallery(widgetId, ItemsDesktop, ItemsTablet, ItemsPhone);
        }
    }
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Gallery1","source":"IWebBlock:Gallery","as":"$b"}
{"op":"create","parent":"$b/ListRecords","type":"IExpressionWidget","as":"$eListRecords"}
```
