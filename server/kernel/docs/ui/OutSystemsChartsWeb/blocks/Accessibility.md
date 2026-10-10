# Accessibility

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **ChartLibrariesJS** | privado | 0 widgets internos

Highcharts JS v11.4.1 (2024-04-04) - Accessibility module.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
!/**
 * Highcharts JS v11.4.1 (2024-04-04)
 *
 * Accessibility module
 *
 * (c) 2010-2024 Highsoft AS
 * Author: Oystein Moseng
 *
 * License: www.highcharts.com/license
 */function(e){"object"==typeof module&&module.exports?(e.default=e,module.exports=e):"function"==typeof define&&define.amd?define("highcharts/modules/accessibility",["highcharts"],function(t){return e(t),e.Highcharts=t,e}):e("undefined"!=typeof Highcharts?Highcharts:void 0)}(function(e){"use strict";var t=e?e._modules:{};function i(e,t,i,s){e.hasOwnProperty(t)||(e[t]=s.apply(null,i),"function"==typeof CustomEvent&&window.dispatchEvent(new CustomEvent("HighchartsModuleLoaded",{detail:{path:t,module:e[t]}})))}i(t,"Accessibility/Utils/HTMLUtilities.js",[t["Core/Globals.js"],t["Core/Utilities.js"]],function(e,t){let{doc:i,win:s}=e,{css:n}=t,o=s.EventTarget&&new s.EventTarget||"none";function r(e){if("function"==typeof s.MouseEvent)return new s.MouseEvent(e.type,e);if(i.createEvent){let t=i.createEvent("MouseEvent");if(t.initMouseEvent)return t.initMouseEvent(e.type,e.bubbles,e.cancelable,e.view||s,e.detail,e.screenX,e.screenY,e.clientX,e.clientY,e.ctrlKey,e.altKey,e.shiftKey,e.metaKey,e.button,e.relatedTarget),t}return a(e.type)}function a(e,t,n){let r=t||{x:0,y:0};if("function"==typeof s.MouseEvent)return new s.MouseEvent(e,{bubbles:!0,cancelable:!0,composed:!0,button:0,buttons:1,relatedTarget:n||o,view:s,detail:"click"===e?1:0,screenX:r.x,screenY:r.y,clientX:r.x,clientY:r.y});if(i.createEvent){let t=i.createEvent("MouseEvent");if(t.initMouseEvent)return t.initMouseEvent(e,!0,!0,s,"click"===e?1:0,r.x,r.y,r.x,r.y,!1,!1,!1,!1,0,null),t}return{type:e}}return{addClass:function(e,t){e.classList?e.classList.add(t):0>e.className.indexOf(t)&&(e.className+=" "+t)},cloneMouseEvent:r,cloneTouchEvent:function(e){let t=e=>{let t=[];for(let i=0;i<e.length;++i){let s=e.item(i);s&&t.push(s)}return t};if("function"==typeof s.TouchEvent){let i=new s.TouchEvent(e.type,{touches:t(e.touches),targetTouches:t(e.targetTouches),changedTouches:t(e.changedTouches),ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,metaKey:e.metaKey,bubbles:e.bubbles,cancelable:e.cancelable,composed:e.composed,detail:e.detail,view:e.view});return e.defaultPrevented&&i.preventDefault(),i}let i=r(e);return i.touches=e.touches,i.changedTouches=e.changedTouches,i.targetTouches=e.targetTouches,i},escapeStringForHTML:function(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#x27;").replace(/\//g,"&#x2F;")},getElement:function(e){return i.getElementById(e)},getFakeMouseEvent:a,getHeadingTagNameForElement:function(e){let t=e=>"h"+Math.min(6,parseInt(e.slice(1),10)+1),i=e=>/H[1-6]/.test(e),s=e=>{let t=e;for(;t=t.previousSibling;){let e=t.tagName||"";if(i(e))return e}return""},n=e=>{let o=s(e);if(o)return t(o);let r=e.parentElement;if(!r)return"p";let a=r.tagName;return i(a)?t(a):n(r)};return n(e)},removeChildNodes:function(e){for(;e.lastChild;)e.removeChild(e.lastChild)},removeClass:function(e,t){e.classList?e.classList.remove(t):e.className=e.className.replace(RegExp(t,"g"),"")},removeElement:function(e){e&&e.parentNode&&e.parentNode.removeChild(e)},reverseChildNodes:function(e){let t=e.childNodes.length;for(;t--;)e.appendChild(e.childNodes[t])},simulatedEventTarget:o,stripHTMLTagsFromString:function(e,t=!1){return"string"==typeof e?t?e.replace(/<\/?[^>]+(>|$)/g,""):e.replace(/<\/?(?!\s)[^>]+(>|$)/g,""):e},visuallyHideElement:function(e){n(e,{position:"absolute",width:"1px",height:"1px",overflow:"hidden",whiteSpace:"nowrap",clip:"rect(1px, 1px, 1px, 1px)",marginTop:"-3px","-ms-filter":"progid:DXImageTransform.Microsoft.Alpha(Opacity=1)",filter:"alpha(opacity=1)",opacity:.01})}}}),i(t,"Accessibility/A11yI18n.js",[t["Core/Templating.js"],t["Core/Utilities.js"]],function(e,t){var i;let{format:s}=e,{getNestedProperty:n,pick:o}=t;return function(e){function t(e,t,i){let r=(e,t)=>{let i=e.slice(t||0),s=i.indexOf("{"),n=i.indexOf("}");if(s>-1&&n>s)return{statement:i.substring(s+1,n),begin:t+s+1,end:t+n}},a=[],l,h,c=0;do l=r(e,c),(h=e.substring(c,l&&l.begin-1)).length&&a.push({value:h,type:"constant"}),l&&a.push({value:l.statement,type:"statement"}),c=l?l.end+1:c+1;while(l);return a.forEach(e=>{"statement"===e.type&&(e.value=function(e,t){let i,s;let r=e.indexOf("#each("),a=e.indexOf("#plural("),l=e.indexOf("["),h=e.indexOf("]");if(r>-1){let o=e.slice(r).indexOf(")")+r,a=e.substring(0,r),l=e.substring(o+1),h=e.substring(r+6,o).split(","),c=Number(h[1]),d;if(s="",i=n(h[0],t)){d=(c=isNaN(c)?i.length:c)<0?i.length+c:Math.min(c,i.length);for(let e=0;e<d;++e)s+=a+i[e]+l}return s.length?s:""}if(a>-1){var c;let i=e.slice(a).indexOf(")")+a,r=e.substring(a+8,i).split(",");switch(Number(n(r[0],t))){case 0:s=o(r[4],r[1]);break;case 1:s=o(r[2],r[1]);break;case 2:s=o(r[3],r[1]);break;default:s=r[1]}return s?(c=s).trim&&c.trim()||c.replace(/^\s+|\s+$/g,""):""}if(l>-1){let s;let o=e.substring(0,l),r=Number(e.substring(l+1,h));return i=n(o,t),!isNaN(r)&&i&&(r<0?void 0===(s=i[i.length+r])&&(s=i[0]):void 0===(s=i[r])&&(s=i[i.length-1])),void 0!==s?s:""}return"{"+e+"}"}(e.value,t))}),s(a.reduce((e,t)=>e+t.value,""),t,i)}function i(e,i){let s=e.split("."),n=this.options.lang,o=0;for(;o<s.length;++o)n=n&&n[s[o]];return"string"==typeof n?t(n,i,this):""}e.compose=function(e){let t=e.prototype;t.langFormat||(t.langFormat=i)},e.i18nFormat=t}(i||(i={})),i}),i(t,"Accessibility/Utils/ChartUtilities.js",[t["Core/Globals.js"],t["Accessibility/Utils/HTMLUtilities.js"],t["Core/Utilities.js"]],function(e,t,i){let{doc:s}=e,{stripHTMLTagsFromString:n}=t,{defined:o,find:r,fireEvent:a}=i;function l(e){if(e.points&&e.points.length){let t=r(e.points,e=>!!e.graphic);return t&&t.graphic&&t.graphic.element}}function h(e){let t=l(e);return t&&t.parentNode||e.graph&&e.graph.element||e.group&&e.group.element}return{fireEventOnWrappedOrUnwrappedElement:function e(t,i){let n=i.type,o=t.hcEvents;s.createEvent&&(t.dispatchEvent||t.fireEvent)?t.dispatchEvent?t.disp
/* ... truncado: 133180 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Accessibility1","source":"IWebBlock:Accessibility","as":"$b"}
```
