# LightBoxImage

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 13 widgets internos

Block with only one placeholder for image. It’s possible use local images or External URL, using the ImageURL parameter on the block. To be able to open items, the Utilities\Lightbox Block needs to be placed somewhere on the screen.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Title | Text | nao |  | Title of the image to be displayed |
| Group | Text | nao |  | Images of the same group will be displayed in a gallery |
| ImageURL | Text | nao |  | URL for an image that can be a replacement for the Image Placeholder image. |
| ImageZoom | Decimal | nao | 2 | The zoom value is used to define the size of the image that will open in full screen based on the thumbnail size.   Note: try to use images with the same ratio to avoid rendering problems:       - thumbnail with 100x100 and zoom 2 will open with 200x200       - thumbnail with 500x500 and zoom 0.5 will open with 250x250 |

## Placeholders

- **Thumbnail**: Drag an image element (em `LightboxItem/openLightBoxImage`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: LightBox

## JavaScript

JavaScript do bloco:

```js
 /**************************************************************
* Outsystems SILK Mobile
*
* Last Update:  2017-12-19 by bmo
**************************************************************/

function onImageClick(elementId, e) {
    var lightboxItem = document.getElementById(elementId) || elementId;
    var lightbox = new Lightbox();
    lightbox.openPhoto(lightboxItem, e);
}

function Lightbox() {
    var gallery;
    
    var parseThumbnailElements = function(el) {
        var linkEl = el,
            figureEl,
            size,
            group,
            groupElements,
            item,
            items = [];
            
        linkEl = el.querySelector("a");
        group = linkEl.getAttribute('data-group');

        if(group !== "") {

            groupElements = document.querySelectorAll("[data-group='" + group + "']");

            for(var i = 0; i < groupElements.length; i++) {
                linkEl = groupElements[i];
                figureEl = linkEl.parentNode;
                captionEl = figureEl.querySelector("figcaption");

                size = linkEl.getAttribute('data-size').split('x');
    
                // create slide object
                item = {
                    src: linkEl.getAttribute('href'),
                    w: parseInt(size[0], 10),
                    h: parseInt(size[1], 10)
                };

                if(captionEl.children.length >= 1) {                    
                    item.title = captionEl.innerHTML;
                }

                if(linkEl.children.length > 0) {
                    item.msrc = linkEl.children[0].children[0].getAttribute('src');
                }

                item.el = figureEl;
                items.push(item);
          }
        } else {       
            figureEl = linkEl.parentNode;
            captionEl = figureEl.querySelector("figcaption");

            size = linkEl.getAttribute('data-size').split('x');

            // create slide object
            item = {
                src: linkEl.getAttribute('href'),
                w: parseInt(size[0], 10),
                h: parseInt(size[1], 10)
            };

            if(captionEl.children.length >= 1) {                    
                item.title = captionEl.innerHTML;
            }

            if(linkEl.children.length > 0) {
                item.msrc = linkEl.children[0].children[0].getAttribute('src');
            }

            item.el = figureEl;
            items.push(item);
        }      

        return items;
    };

    var closest = function closest(el, fn) {
        return el && ( fn(el) ? el : closest(el.parentNode, fn) );
    };

    var onThumbnailsClick = function(e) {
        
        var lightboxitems = document.querySelectorAll(".lightbox-item");
        
        for(var i = 0; i< lightboxitems.length; i++) {
            
            // read thumbnail data
            var thumbnail = lightboxitems[i].querySelector(".lightbox-content-thumbnail img");
            
            if(thumbnail !== null) {
                var width = thumbnail.naturalWidth;
                var height = thumbnail.naturalHeight;
                var link = lightboxitems[i].querySelector("a");
                var zoom = link.getAttribute("data-zoom");
                var hasImage = link.getAttribute("href") !== "";
                
                // write image data
                link.setAttribute("data-size", width*zoom + "x" + height*zoom);
                
                if(!hasImage) {
                    link.href = thumbnail.src;
                }
                
            
            }
            
        }
        
        e = e || window.event;
        e.preventDefault ? e.preventDefault() : e.returnValue = false;

        var eTarget = e.target || e.srcElement;

        var clickedListItem = closest(eTarget, function(el) {
            return (el.tagName && el.tagName.toUpperCase() === 'FIGURE');
        });

        if(!clickedListItem) {
            return;
        }

        var clickedGallery = clickedListItem.parentNode,
            linkEl = clickedGallery.querySelector("a"),
            groupName = linkEl.getAttribute('data-group'),
            groupElements,
            nodeIndex = 0,
            index = 0;

        if(groupName !== "") {
          groupElements = document.querySelectorAll("[data-group='" + groupName + "']");
          for (i = 0; i < groupElements.length; i++) {
            if(groupElements[i] === linkEl) {
                index = nodeIndex;
                break;
            }
            nodeIndex++;
          }
        }      

        if(index >= 0) {          
            openPhotoSwipe( index, clickedGallery );
        }
        return false;
    };   

    var openPhotoSwipe = function(index, galleryElement, disableAnimation, fromURL) {
        var pswpElement = document.querySelectorAll('.pswp')[0],
            options,
            items;

        items = parseThumbnailElements(galleryElement);

        options = {

            galleryUID: galleryElement.getAttribute('data-pswp-uid'),            
            shareEl: false,
            fullscreenEl: true,
            index: index,

            getThumbBoundsFn: function(index) {               
                var thumbnail = items[index].el.getElementsByTagName('img')[0],
                    pageYScroll = window.pageYOffset || document.documentElement.scrollTop,
                    rect = thumbnail.getBoundingClientRect();
                return {x:rect.left, y:rect.top + pageYScroll, w:rect.width};
            }

        };        

        gallery = new PhotoSwipe( pswpElement, PhotoSwipeUI_Default, items, options);
        gallery.init();
    };
    
    return { 

        openPhoto: function(itemId, e) {
            
            item = document.getElementById(itemId);
            
            onThumbnailsClick(e);
        }
    };
}

/*! PhotoSwipe - v4.1.2 - 2017-04-05
* http://photoswipe.com
* Copyright (c) 2017 Dmitry Semenov; */
(func
/* ... truncado: 149898 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LightBoxImage1","source":"IWebBlock:LightBoxImage","as":"$b"}
{"op":"create","parent":"$b/Thumbnail","type":"IExpressionWidget","as":"$eThumbnail"}
```
