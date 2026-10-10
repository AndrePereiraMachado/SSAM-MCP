# HighCharts

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **ChartLibrariesJS** | privado | 0 widgets internos

Highcharts JS v11.4.1 (2024-04-04)

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
if (typeof Highcharts == 'undefined') {
    if (typeof outsystems == 'undefined') { // only valid in the editor
        outsystems = {}; 
        outsystems.internal ={}; 
        outsystems.internal.$ = $;
    }
!/**
 * Highcharts JS v11.4.1 (2024-04-04)
 *
 * (c) 2009-2024 Torstein Honsi
 *
 * License: www.highcharts.com/license
 */function(t,e){"object"==typeof module&&module.exports?(e.default=e,module.exports=t&&t.document?e(t):e):"function"==typeof define&&define.amd?define("highcharts/highcharts",function(){return e(t)}):(t.Highcharts&&t.Highcharts.error(16,!0),t.Highcharts=e(t))}("undefined"!=typeof window?window:this,function(t){"use strict";var e={};function i(e,i,s,r){e.hasOwnProperty(i)||(e[i]=r.apply(null,s),"function"==typeof CustomEvent&&t.dispatchEvent(new CustomEvent("HighchartsModuleLoaded",{detail:{path:i,module:e[i]}})))}return i(e,"Core/Globals.js",[],function(){var e,i;return(i=e||(e={})).SVG_NS="http://www.w3.org/2000/svg",i.product="Highcharts",i.version="11.4.1",i.win=void 0!==t?t:{},i.doc=i.win.document,i.svg=i.doc&&i.doc.createElementNS&&!!i.doc.createElementNS(i.SVG_NS,"svg").createSVGRect,i.userAgent=i.win.navigator&&i.win.navigator.userAgent||"",i.isChrome=-1!==i.userAgent.indexOf("Chrome"),i.isFirefox=-1!==i.userAgent.indexOf("Firefox"),i.isMS=/(edge|msie|trident)/i.test(i.userAgent)&&!i.win.opera,i.isSafari=!i.isChrome&&-1!==i.userAgent.indexOf("Safari"),i.isTouchDevice=/(Mobile|Android|Windows Phone)/.test(i.userAgent),i.isWebKit=-1!==i.userAgent.indexOf("AppleWebKit"),i.deg2rad=2*Math.PI/360,i.hasBidiBug=i.isFirefox&&4>parseInt(i.userAgent.split("Firefox/")[1],10),i.marginNames=["plotTop","marginRight","marginBottom","plotLeft"],i.noop=function(){},i.supportsPassiveEvents=function(){let t=!1;if(!i.isMS){let e=Object.defineProperty({},"passive",{get:function(){t=!0}});i.win.addEventListener&&i.win.removeEventListener&&(i.win.addEventListener("testPassive",i.noop,e),i.win.removeEventListener("testPassive",i.noop,e))}return t}(),i.charts=[],i.composed=[],i.dateFormats={},i.seriesTypes={},i.symbolSizes={},i.chartCount=0,e}),i(e,"Core/Utilities.js",[e["Core/Globals.js"]],function(t){let e;let{charts:i,doc:s,win:r}=t;function o(e,i,s,a){let n=i?"Highcharts error":"Highcharts warning";32===e&&(e=`${n}: Deprecated member`);let h=p(e),l=h?`${n} #${e}: www.highcharts.com/errors/${e}/`:e.toString();if(void 0!==a){let t="";h&&(l+="?"),k(a,function(e,i){t+=`
 - ${i}: ${e}`,h&&(l+=encodeURI(i)+"="+encodeURI(e))}),l+=t}M(t,"displayError",{chart:s,code:e,message:l,params:a},function(){if(i)throw Error(l);r.console&&-1===o.messages.indexOf(l)&&console.warn(l)}),o.messages.push(l)}function a(t,e){return parseInt(t,e||10)}function n(t){return"string"==typeof t}function h(t){let e=Object.prototype.toString.call(t);return"[object Array]"===e||"[object Array Iterator]"===e}function l(t,e){return!!t&&"object"==typeof t&&(!e||!h(t))}function d(t){return l(t)&&"number"==typeof t.nodeType}function c(t){let e=t&&t.constructor;return!!(l(t,!0)&&!d(t)&&e&&e.name&&"Object"!==e.name)}function p(t){return"number"==typeof t&&!isNaN(t)&&t<1/0&&t>-1/0}function u(t){return null!=t}function g(t,e,i){let s;let r=n(e)&&!u(i),o=(e,i)=>{u(e)?t.setAttribute(i,e):r?(s=t.getAttribute(i))||"class"!==i||(s=t.getAttribute(i+"Name")):t.removeAttribute(i)};return n(e)?o(i,e):k(e,o),s}function f(t){return h(t)?t:[t]}function m(t,e){let i;for(i in t||(t={}),e)t[i]=e[i];return t}function x(){let t=arguments,e=t.length;for(let i=0;i<e;i++){let e=t[i];if(null!=e)return e}}function y(t,e){m(t.style,e)}function b(t){return Math.pow(10,Math.floor(Math.log(t)/Math.LN10))}function v(t,e){return t>1e14?t:parseFloat(t.toPrecision(e||14))}(o||(o={})).messages=[],Math.easeInOutSine=function(t){return -.5*(Math.cos(Math.PI*t)-1)};let S=Array.prototype.find?function(t,e){return t.find(e)}:function(t,e){let i;let s=t.length;for(i=0;i<s;i++)if(e(t[i],i))return t[i]};function k(t,e,i){for(let s in t)Object.hasOwnProperty.call(t,s)&&e.call(i||t[s],t[s],s,t)}function C(t,e,i){function s(e,i){let s=t.removeEventListener;s&&s.call(t,e,i,!1)}function r(i){let r,o;t.nodeName&&(e?(r={})[e]=!0:r=i,k(r,function(t,e){if(i[e])for(o=i[e].length;o--;)s(e,i[e][o].fn)}))}let o="function"==typeof t&&t.prototype||t;if(Object.hasOwnProperty.call(o,"hcEvents")){let t=o.hcEvents;if(e){let o=t[e]||[];i?(t[e]=o.filter(function(t){return i!==t.fn}),s(e,i)):(r(t),t[e]=[])}else r(t),delete o.hcEvents}}function M(e,i,r,o){if(r=r||{},s.createEvent&&(e.dispatchEvent||e.fireEvent&&e!==t)){let t=s.createEvent("Events");t.initEvent(i,!0,!0),r=m(t,r),e.dispatchEvent?e.dispatchEvent(r):e.fireEvent(i,r)}else if(e.hcEvents){r.target||m(r,{preventDefault:function(){r.defaultPrevented=!0},target:e,type:i});let t=[],s=e,o=!1;for(;s.hcEvents;)Object.hasOwnProperty.call(s,"hcEvents")&&s.hcEvents[i]&&(t.length&&(o=!0),t.unshift.apply(t,s.hcEvents[i])),s=Object.getPrototypeOf(s);o&&t.sort((t,e)=>t.order-e.order),t.forEach(t=>{!1===t.fn.call(e,r)&&r.preventDefault()})}o&&!r.defaultPrevented&&o.call(e,r)}k({map:"map",each:"forEach",grep:"filter",reduce:"reduce",some:"some"},function(e,i){t[i]=function(t){return o(32,!1,void 0,{[`Highcharts.${i}`]:`use Array.${e}`}),Array.prototype[e].apply(t,[].slice.call(arguments,1))}});let w=function(){let t=Math.random().toString(36).substring(2,9)+"-",i=0;return function(){return"highcharts-"+(e?"":t)+i++}}();return r.jQuery&&(r.jQuery.fn.highcharts=function(){let e=[].slice.call(arguments);if(this[0])return e[0]?(new t[n(e[0])?e.shift():"Chart"](this[0],e[0],e[1]),this):i[g(this[0],"data-highcharts-chart")]}),{addEvent:function(e,i,s,r={}){let o="function"==typeof e&&e.prototype||e;Object.hasOwnProperty.call(o,"hcEvents")||(o.hcEvents={});let a=o.hcEvents;t.Point&&e instanceof t.Point&&e.series&&e.series.chart&&(e.series.chart.runTrackerClick=!0);let n=e.addEventListener;n&&n.call(e,i,s,!!t.supportsPassiveEvents&&{passive:void 0===r.passive?-1!==i.indexOf("touch"):r.passive,capture:!1}),a[i]||(a[i]=[]);let h={fn:s,order:"num
/* ... truncado: 271910 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"HighCharts1","source":"IWebBlock:HighCharts","as":"$b"}
```
