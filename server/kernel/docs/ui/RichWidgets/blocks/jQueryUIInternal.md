# jQueryUIInternal

RichWidgets  | Traditional | UI flow **jQueryUI** | privado | 6 widgets internos

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
(function(jQuery) {
/*! jQuery UI
* https://github.com/jquery/jquery-ui
* Includes: jquery.ui.core.js 
* Copyright (c) 2012 AUTHORS.txt; Licensed MIT, GPL */
(function(a,b){function c(b,c){var e=b.nodeName.toLowerCase();if("area"===e){var f=b.parentNode,g=f.name,h;return!b.href||!g||f.nodeName.toLowerCase()!=="map"?!1:(h=a("img[usemap=#"+g+"]")[0],!!h&&d(h))}return(/input|select|textarea|button|object/.test(e)?!b.disabled:"a"==e?b.href||c:c)&&d(b)}function d(b){return!a(b).parents().andSelf().filter(function(){return a.curCSS(this,"visibility")==="hidden"||a.expr.filters.hidden(this)}).length}a.ui=a.ui||{};if(a.ui.version)return;a.extend(a.ui,{version:"osjs-1.0.0",keyCode:{ALT:18,BACKSPACE:8,CAPS_LOCK:20,COMMA:188,COMMAND:91,COMMAND_LEFT:91,COMMAND_RIGHT:93,CONTROL:17,DELETE:46,DOWN:40,END:35,ENTER:13,ESCAPE:27,HOME:36,INSERT:45,LEFT:37,MENU:93,NUMPAD_ADD:107,NUMPAD_DECIMAL:110,NUMPAD_DIVIDE:111,NUMPAD_ENTER:108,NUMPAD_MULTIPLY:106,NUMPAD_SUBTRACT:109,PAGE_DOWN:34,PAGE_UP:33,PERIOD:190,RIGHT:39,SHIFT:16,SPACE:32,TAB:9,UP:38,WINDOWS:91}}),a.fn.extend({propAttr:a.fn.prop||a.fn.attr,_focus:a.fn.focus,focus:function(b,c){return typeof b=="number"?this.each(function(){var d=this;setTimeout(function(){a(d).focus(),c&&c.call(d)},b)}):this._focus.apply(this,arguments)},scrollParent:function(){var b;return a.browser.msie&&/(static|relative)/.test(this.css("position"))||/absolute/.test(this.css("position"))?b=this.parents().filter(function(){return/(relative|absolute|fixed)/.test(a.curCSS(this,"position",1))&&/(auto|scroll)/.test(a.curCSS(this,"overflow",1)+a.curCSS(this,"overflow-y",1)+a.curCSS(this,"overflow-x",1))}).eq(0):b=this.parents().filter(function(){return/(auto|scroll)/.test(a.curCSS(this,"overflow",1)+a.curCSS(this,"overflow-y",1)+a.curCSS(this,"overflow-x",1))}).eq(0),/fixed/.test(this.css("position"))||!b.length?a(document):b},zIndex:function(c){if(c!==b)return this.css("zIndex",c);if(this.length){var d=a(this[0]),e,f;while(d.length&&d[0]!==document){e=d.css("position");if(e==="absolute"||e==="relative"||e==="fixed"){f=parseInt(d.css("zIndex"),10);if(!isNaN(f)&&f!==0)return f}d=d.parent()}}return 0},disableSelection:function(){return this.bind((a.support.selectstart?"selectstart":"mousedown")+".os-internal-ui-disableSelection",function(a){a.preventDefault()})},enableSelection:function(){return this.unbind(".os-internal-ui-disableSelection")}}),a("<a>").outerWidth(1).jquery||a.each(["Width","Height"],function(c,d){function h(b,c,d,f){return a.each(e,function(){c-=parseFloat(a.curCSS(b,"padding"+this,!0))||0,d&&(c-=parseFloat(a.curCSS(b,"border"+this+"Width",!0))||0),f&&(c-=parseFloat(a.curCSS(b,"margin"+this,!0))||0)}),c}var e=d==="Width"?["Left","Right"]:["Top","Bottom"],f=d.toLowerCase(),g={innerWidth:a.fn.innerWidth,innerHeight:a.fn.innerHeight,outerWidth:a.fn.outerWidth,outerHeight:a.fn.outerHeight};a.fn["inner"+d]=function(c){return c===b?g["inner"+d].call(this):this.each(function(){a(this).css(f,h(this,c)+"px")})},a.fn["outer"+d]=function(b,c){return typeof b!="number"?g["outer"+d].call(this,b):this.each(function(){a(this).css(f,h(this,b,!0,c)+"px")})}}),a.extend(a.expr[":"],{data:a.expr.createPseudo?a.expr.createPseudo(function(b){return function(c){return!!a.data(c,b)}}):function(b,c,d){return!!a.data(b,d[3])},focusable:function(b){return c(b,!isNaN(a.attr(b,"tabindex")))},tabbable:function(b){var d=a.attr(b,"tabindex"),e=isNaN(d);return(e||d>=0)&&c(b,!e)}}),a(function(){var b=document.body,c=b.appendChild(c=document.createElement("div"));c.offsetHeight,a.extend(c.style,{minHeight:"100px",height:"auto",padding:0,borderWidth:0}),a.support.minHeight=c.offsetHeight===100,a.support.selectstart="onselectstart"in c,b.removeChild(c).style.display="none"}),a.curCSS||(a.curCSS=a.css),a.extend(a.ui,{plugin:{add:function(b,c,d){var e=a.ui[b].prototype;for(var f in d)e.plugins[f]=e.plugins[f]||[],e.plugins[f].push([c,d[f]])},call:function(a,b,c){var d=a.plugins[b];if(!d||!a.element[0].parentNode)return;for(var e=0;e<d.length;e++)a.options[d[e][0]]&&d[e][1].apply(a.element,c)}},contains:function(a,b){return document.compareDocumentPosition?a.compareDocumentPosition(b)&16:a!==b&&a.contains(b)},hasScroll:function(b,c){if(a(b).css("overflow")==="hidden")return!1;var d=c&&c==="left"?"scrollLeft":"scrollTop",e=!1;return b[d]>0?!0:(b[d]=1,e=b[d]>0,b[d]=0,e)},isOverAxis:function(a,b,c){return a>b&&a<b+c},isOver:function(b,c,d,e,f,g){return a.ui.isOverAxis(b,d,f)&&a.ui.isOverAxis(c,e,g)}})})(jQuery);;
/*! jQuery UI
* https://github.com/jquery/jquery-ui
* Includes: jquery.ui.widget.js
* Copyright (c) 2012 AUTHORS.txt; Licensed MIT, GPL */
(function(a,b){if(a.cleanData){var c=a.cleanData;a.cleanData=function(b){for(var d=0,e;(e=b[d])!=null;d++)try{a(e).triggerHandler("remove")}catch(f){}c(b)}}else{var d=a.fn.remove;a.fn.remove=function(b,c){return this.each(function(){return c||(!b||a.filter(b,[this]).length)&&a("*",this).add([this]).each(function(){try{a(this).triggerHandler("remove")}catch(b){}}),d.call(a(this),b,c)})}}a.widget=function(b,c,d){var e=b.split(".")[0],f;b=b.split(".")[1],f=e+"-"+b,d||(d=c,c=a.Widget),a.expr[":"][f]=function(c){return!!a.data(c,b)},a[e]=a[e]||{},a[e][b]=function(a,b){arguments.length&&this._createWidget(a,b)};var g=new c;g.options=a.extend(!0,{},g.options),a[e][b].prototype=a.extend(!0,g,{namespace:e,widgetName:b,widgetEventPrefix:a[e][b].prototype.widgetEventPrefix||b,widgetBaseClass:f},d),a.widget.bridge(b,a[e][b])},a.widget.bridge=function(c,d){a.fn[c]=function(e){var f=typeof e=="string",g=Array.prototype.slice.call(arguments,1),h=this;return e=!f&&g.length?a.extend.apply(null,[!0,e].concat(g)):e,f&&e.charAt(0)==="_"?h:(f?this.each(function(){var d=a.data(this,c),f=d&&a.isFunction(d[e])?d[e].apply(d,g):d;if(f!==d&&f!==b)return h=f,!1}):this.each(function(){var b=a.data(this,c);b?b.option(e||{})._init():a.data(this,c,new d(e,this))}),h)}},a.Widget=function(a,b){arguments.length&&this._createWidget(a,b)},a.Widget.prototype={widgetName:"widget",widgetEventPrefix:"",o
/* ... truncado: 65120 chars a mais no JSON do catalogo */
```

## CSS

Classes: `.os-internal-ui-widget-overlay`, `.os-internal-ui-dialog`, `.os-internal-PopupCallOut`, `.os-internal-Popup`, `.os-internal-ui-dialog-titlebar`, `.png`, `.Microsoft`, `.AlphaImageLoader`, `.os-internal-ui-draggable`, `.os-internal-ui-dialog-titlebar-close-hover`, `.os-internal-ui-dialog-titlebar-close`, `.os-internal-ui-dialog-titlebar-close-no-title`, `.os-internal-ui-dialog-title`, `.os-internal-ui-dialog-content`, `.os-internal-ui-dialog-buttonpane`, `.os-internal-ui-resizable-n`, `.os-internal-ui-resizable-s`, `.os-internal-ui-resizable-e`, `.os-internal-ui-resizable-w`, `.os-internal-ui-resizable-se`, `.os-internal-ui-resizable-sw`, `.os-internal-ui-resizable-nw`, `.os-internal-ui-resizable-ne`

```css
.os-internal-ui-widget-overlay {
   position: fixed;
   *position: absolute; /* IE6 */
   top: 0;
   left: 0;
   background-color: black;
   filter: alpha(opacity=30); 
   -moz-opacity: 0.3; 
   opacity: 0.3;
}

.os-internal-ui-dialog {
   position: absolute;
}

div.os-internal-PopupCallOut{
   position: absolute;
   display: none;
   z-index: 4001;
}

div.os-internal-Popup .os-internal-ui-dialog,
div.os-internal-Popup.os-internal-ui-dialog {
    background-color: white;
    border:1px solid #666666;
}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-dialog-titlebar,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-titlebar {
    border-bottom: 0px solid #d8d2aa;
    background: #1E5AA3 url(/RichWidgets/img/Bar_Gradient.png) repeat-x top;
    _background:#1E5AA3;  /* IE6 */
    _filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src='/RichWidgets/img/Bar_Gradient.png', sizingMethod='scale');  /* IE6 */
    padding: 0px;
    height: 28px;
}

div.os-internal-Popup .os-internal-ui-dialog.os-internal-ui-draggable .os-internal-ui-dialog-titlebar,
div.os-internal-Popup.os-internal-ui-dialog.os-internal-ui-draggable .os-internal-ui-dialog-titlebar {
    cursor: move;
}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-dialog-titlebar-close-hover,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-titlebar-close-hover,
div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-dialog-titlebar-close,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-titlebar-close {
    width: 16px;
    height: 16px;
    background: url(/RichWidgets/img/Popup_titlebar_close.png) no-repeat;
    position:absolute;
    top: 6px;
    right: 7px;
}

div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-titlebar-close-no-title {
    width: 48px;
    height: 48px;
    background: url(/RichWidgets/img/Popup_Editor_No_Title_Close.png) no-repeat;
    _background:none;
    _filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src='/RichWidgets/img/Popup_Editor_No_Title_Close.png', sizingMethod='scale');  /* IE6 */
    position:absolute;
    top: -24px;
    right: -24px;
}

div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-titlebar-close-no-title:hover {
    background: url(/RichWidgets/img/Popup_Editor_No_Title_Close_Hover.png) no-repeat;
    _background:none;
    _filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src='/RichWidgets/img/Popup_Editor_No_Title_Close_Hover.png', sizingMethod='scale');  /* IE6 */
}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-dialog-titlebar-close span,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-titlebar-close span {
    display: none;
}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-dialog-title,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-title {
    margin-left: 5px;
    color: white;
    font-weight: bold;
    position: relative;
    top: 7px;
    left: 4px;
}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-dialog-content,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-content {
    margin: 0px;
}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-dialog-buttonpane,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-buttonpane {
    position: absolute;
    bottom: 8px;
    right: 12px;
    width: 100%;
    text-align: right;
}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-dialog-buttonpane button,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-dialog-buttonpane button {
    margin: 6px;
}

/* Dialog handle styles */
div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-resizable-n,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-resizable-n { cursor: n-resize; height: 2px; width: 100%; top: 0px; left: 0px;}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-resizable-s,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-resizable-s { cursor: s-resize; height: 8px; width: 100%; bottom: 0px; left: 0px;}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-resizable-e,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-resizable-e { cursor: e-resize; width: 7px; right: 0px; top: 0px; height: 100%;}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-resizable-w,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-resizable-w { cursor: w-resize; width: 7px; left: 0px; top: 0px; height: 100%;}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-resizable-se,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-resizable-se { cursor: se-resize; width: 9px; height: 9px; right: 0px; bottom: 0px;}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-resizable-sw,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-resizable-sw { cursor: sw-resize; width: 9px; height: 9px; left: 0px; bottom: 0px;}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-resizable-nw,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-resizable-nw { cursor: nw-resize; width: 9px; height: 29px; left: 0px; top: 0px;}

div.os-internal-Popup .os-internal-ui-dialog .os-internal-ui-resizable-ne,
div.os-internal-Popup.os-internal-ui-dialog .os-internal-ui-resizable-ne { cursor: ne-resize; width: 9px; height: 29px; right: 0px; top: 0px;}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"jQueryUIInternal1","source":"IWebBlock:jQueryUIInternal","as":"$b"}
```
