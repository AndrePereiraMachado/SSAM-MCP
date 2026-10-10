# DEPRECATED_NoUiSlider_11_0_3

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Libraries** | privado | 3 widgets internos

NoUiSlider library. Used to create RangeSliders.

Current version: 11.0.3
https://refreshless.com/nouislider/

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
/*! nouislider - 11.0.3 - 2018-01-21 14:04:07 */

(function (factory) {

    if ( typeof define === 'function' && define.amd ) {

        // AMD. Register as an anonymous module.
        define([], factory);

    } else if ( typeof exports === 'object' ) {

        // Node/CommonJS
        module.exports = factory();

    } else {

        // Browser globals
        window.noUiSlider = factory();
    }

}(function( ){

    'use strict';

    var VERSION = '11.0.3';


    function isValidFormatter ( entry ) {
        return typeof entry === 'object' && typeof entry.to === 'function' && typeof entry.from === 'function';
    }

    function removeElement ( el ) {
        el.parentElement.removeChild(el);
    }

    // Bindable version
    function preventDefault ( e ) {
        e.preventDefault();
    }

    // Removes duplicates from an array.
    function unique ( array ) {
        return array.filter(function(a){
            return !this[a] ? this[a] = true : false;
        }, {});
    }

    // Round a value to the closest 'to'.
    function closest ( value, to ) {
        return Math.round(value / to) * to;
    }

    // Current position of an element relative to the document.
    function offset ( elem, orientation ) {

        var rect = elem.getBoundingClientRect();
        var doc = elem.ownerDocument;
        var docElem = doc.documentElement;
        var pageOffset = getPageOffset(doc);

        // getBoundingClientRect contains left scroll in Chrome on Android.
        // I haven't found a feature detection that proves this. Worst case
        // scenario on mis-match: the 'tap' feature on horizontal sliders breaks.
        if ( /webkit.*Chrome.*Mobile/i.test(navigator.userAgent) ) {
            pageOffset.x = 0;
        }

        return orientation ? (rect.top + pageOffset.y - docElem.clientTop) : (rect.left + pageOffset.x - docElem.clientLeft);
    }

    // Checks whether a value is numerical.
    function isNumeric ( a ) {
        return typeof a === 'number' && !isNaN( a ) && isFinite( a );
    }

    // Sets a class and removes it after [duration] ms.
    function addClassFor ( element, className, duration ) {
        if (duration > 0) {
        addClass(element, className);
            setTimeout(function(){
                removeClass(element, className);
            }, duration);
        }
    }

    // Limits a value to 0 - 100
    function limit ( a ) {
        return Math.max(Math.min(a, 100), 0);
    }

    // Wraps a variable as an array, if it isn't one yet.
    // Note that an input array is returned by reference!
    function asArray ( a ) {
        return Array.isArray(a) ? a : [a];
    }

    // Counts decimals
    function countDecimals ( numStr ) {
        numStr = String(numStr);
        var pieces = numStr.split(".");
        return pieces.length > 1 ? pieces[1].length : 0;
    }

    // http://youmightnotneedjquery.com/#add_class
    function addClass ( el, className ) {
        if ( el.classList ) {
            el.classList.add(className);
        } else {
            el.className += ' ' + className;
        }
    }

    // http://youmightnotneedjquery.com/#remove_class
    function removeClass ( el, className ) {
        if ( el.classList ) {
            el.classList.remove(className);
        } else {
            el.className = el.className.replace(new RegExp('(^|\\b)' + className.split(' ').join('|') + '(\\b|$)', 'gi'), ' ');
        }
    }

    // https://plainjs.com/javascript/attributes/adding-removing-and-testing-for-classes-9/
    function hasClass ( el, className ) {
        return el.classList ? el.classList.contains(className) : new RegExp('\\b' + className + '\\b').test(el.className);
    }

    // https://developer.mozilla.org/en-US/docs/Web/API/Window/scrollY#Notes
    function getPageOffset ( doc ) {

        var supportPageOffset = window.pageXOffset !== undefined;
        var isCSS1Compat = ((doc.compatMode || "") === "CSS1Compat");
        var x = supportPageOffset ? window.pageXOffset : isCSS1Compat ? doc.documentElement.scrollLeft : doc.body.scrollLeft;
        var y = supportPageOffset ? window.pageYOffset : isCSS1Compat ? doc.documentElement.scrollTop : doc.body.scrollTop;

        return {
            x: x,
            y: y
        };
    }

    // we provide a function to compute constants instead
    // of accessing window.* as soon as the module needs it
    // so that we do not compute anything if not needed
    function getActions ( ) {

        // Determine the events to bind. IE11 implements pointerEvents without
        // a prefix, which breaks compatibility with the IE10 implementation.
        return window.navigator.pointerEnabled ? {
            start: 'pointerdown',
            move: 'pointermove',
            end: 'pointerup'
        } : window.navigator.msPointerEnabled ? {
            start: 'MSPointerDown',
            move: 'MSPointerMove',
            end: 'MSPointerUp'
        } : {
            start: 'mousedown touchstart',
            move: 'mousemove touchmove',
            end: 'mouseup touchend'
        };
    }

    // https://github.com/WICG/EventListenerOptions/blob/gh-pages/explainer.md
    // Issue #785
    function getSupportsPassive ( ) {

        var supportsPassive = false;

        try {

            var opts = Object.defineProperty({}, 'passive', {
                get: function() {
                    supportsPassive = true;
                }
            });

            window.addEventListener('test', null, opts);

        } catch (e) {}

        return supportsPassive;
    }

    function getSupportsTouchActionNone ( ) {
        return window.CSS && CSS.supports && CSS.supports('touch-action', 'none');
    }


// Value calculation

    // Determine the size of a sub-range in relation to a full range.
    function subRangeRatio ( pa, pb ) {
        return (100 / (pb - pa));
    }

    // (percentage) How many percent is this value of this range?
    function fromPercentage ( range, value ) {

/* ... truncado: 72028 chars a mais no JSON do catalogo */
```

## CSS

Classes: `.noUi-target`, `.noUi-base`, `.noUi-connects`, `.noUi-connect`, `.noUi-origin`, `.noUi-horizontal`, `.noUi-vertical`, `.noUi-handle`, `.noUi-state-tap`, `.noUi-state-drag`, `.noUi-draggable`, `.noUi-pips`, `.noUi-value`, `.noUi-value-sub`, `.noUi-marker`, `.noUi-pips-horizontal`, `.noUi-value-horizontal`, `.noUi-rtl`, `.noUi-marker-horizontal`, `.noUi-marker-sub`, `.noUi-pips-vertical`, `.noUi-value-vertical`, `.noUi-marker-vertical`, `.noUi-tooltip`

```css
/*! nouislider - 11.0.3 - 2018-01-21 14:04:07 */
/* Functional styling;
 * These styles are required for noUiSlider to function.
 * You don't need to change these rules to apply your design.
 */
.noUi-target,
.noUi-target * {
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
  -webkit-user-select: none;
  -ms-touch-action: none;
  touch-action: none;
  -ms-user-select: none;
  -moz-user-select: none;
  user-select: none;
  -moz-box-sizing: border-box;
  box-sizing: border-box;
}

.noUi-target {
  position: relative;
  direction: ltr;
}

.noUi-base,
.noUi-connects {
  width: 100%;
  height: 100%;
  position: relative;
  z-index: 1;
}

/* Wrapper for all connect elements. */
.noUi-connects {
  overflow: hidden;
  z-index: 0;
}

.noUi-connect,
.noUi-origin {
  will-change: transform;
  position: absolute;
  z-index: 1;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
  -webkit-transform-origin: 0 0;
  transform-origin: 0 0;
}

/* Offset direction */
html:not([dir="rtl"]) .noUi-horizontal .noUi-origin {
  left: auto;
  right: 0;
}

/* Give origins 0 height/width so they don't interfere with clicking the * connect elements. */
.noUi-vertical .noUi-origin {
  width: 0;
}

.noUi-horizontal .noUi-origin {
  height: 0;
}

.noUi-handle {
  position: absolute;
}

.noUi-state-tap .noUi-connect,
.noUi-state-tap .noUi-origin {
  -webkit-transition: transform 0.3s;
  transition: transform 0.3s;
}

.noUi-state-drag * {
  cursor: inherit !important;
}

/* Slider size and handle placement; */
html:not([dir="rtl"]) .noUi-horizontal .noUi-handle {
  left: auto;
}

/* Styling; * Giving the connect element a border radius causes issues with using transform: scale */

/* Handles and cursors; */
.noUi-draggable {
  cursor: ew-resize;
}

.noUi-vertical .noUi-draggable {
  cursor: ns-resize;
}

/* Handle stripes; */
.noUi-vertical .noUi-handle:before,
.noUi-vertical .noUi-handle:after {
  width: 14px;
  height: 1px;
  left: 6px;
  top: 14px;
}

.noUi-vertical .noUi-handle:after {
  top: 17px;
}

/* Disabled state; */
[disabled] .noUi-connect {
  background: #B8B8B8;
}

[disabled].noUi-target,
[disabled].noUi-handle,
[disabled] .noUi-handle {
  cursor: not-allowed;
}

/* Base; */
.noUi-pips,
.noUi-pips * {
  -moz-box-sizing: border-box;
  box-sizing: border-box;
}

.noUi-pips {
  position: absolute;
}

/* Values; */
.noUi-value {
  position: absolute;
  white-space: nowrap;
  text-align: center;
}

.noUi-value-sub {
  color: #ccc;
  font-size: 10px;
}

/* Markings; */
.noUi-marker {
  position: absolute;
}

/* Horizontal layout; */
.noUi-pips-horizontal {
  top: 100%;
  left: 0;
  width: 100%;
}

.noUi-value-horizontal {
  -webkit-transform: translate(-50%, 50%);
  transform: translate(-50%, 50%);
}

.noUi-rtl .noUi-value-horizontal {
  -webkit-transform: translate(50%, 50%);
  transform: translate(50%, 50%);
}

.noUi-marker-horizontal.noUi-marker {
  margin-left: -1px;
  width: 2px;
}

.noUi-marker-horizontal.noUi-marker-sub {
  height: 10px;
}

/* Vertical layout; */
.noUi-pips-vertical {
  height: 100%;
  top: 0;
  left: 100%;
}

.noUi-value-vertical {
  -webkit-transform: translate(0, -50%);
  transform: translate(0, -50%, 0);
}

.noUi-rtl .noUi-value-vertical {
  -webkit-transform: translate(0, 50%);
  transform: translate(0, 50%);
}

.noUi-marker-vertical.noUi-marker {
  width: 5px;
  height: 2px;
  margin-top: -1px;
}

.noUi-tooltip {
  display: block;
  position: absolute;
  border: 1px solid #D9D9D9;
  border-radius: 3px;
  background: #fff;
  color: #000;
  padding: 5px;
  text-align: center;
  white-space: nowrap;
}

.noUi-horizontal .noUi-tooltip {
  -webkit-transform: translate(-50%, 0);
  transform: translate(-50%, 0);
  left: 50%;
  bottom: 120%;
}

.noUi-vertical .noUi-tooltip {
  -webkit-transform: translate(0, -50%);
  transform: translate(0, -50%);
  top: 50%;
  right: 120%;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"DEPRECATED_NoUiSlider_11_0_31","source":"IWebBlock:DEPRECATED_NoUiSlider_11_0_3","as":"$b"}
```
