# CSSVarsPonyfill

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Private** | privado | 6 widgets internos

Used to provide compability in the CSS with the Internet Explorer browsers.

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
/*!
 * css-vars-ponyfill
 * v1.9.0
 * https://github.com/jhildenbiddle/css-vars-ponyfill
 * (c) 2018 John Hildenbiddle <http://hildenbiddle.com>
 * MIT license
 */
(function(global, factory) {
    typeof exports === "object" && typeof module !== "undefined" ? module.exports = factory() : typeof define === "function" && define.amd ? define(factory) : global.cssVars = factory();
})(this, function() {
    "use strict";
    /*!
     * get-css-data
     * v1.3.2
     * https://github.com/jhildenbiddle/get-css-data
     * (c) 2018 John Hildenbiddle <http://hildenbiddle.com>
     * MIT license
     */    function getUrls(urls) {
        var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
        var settings = {
            mimeType: options.mimeType || null,
            onBeforeSend: options.onBeforeSend || Function.prototype,
            onSuccess: options.onSuccess || Function.prototype,
            onError: options.onError || Function.prototype,
            onComplete: options.onComplete || Function.prototype
        };
        var urlArray = Array.isArray(urls) ? urls : [ urls ];
        var urlQueue = Array.apply(null, Array(urlArray.length)).map(function(x) {
            return null;
        });
        function onError(xhr, urlIndex) {
            settings.onError(xhr, urlArray[urlIndex], urlIndex);
        }
        function onSuccess(responseText, urlIndex) {
            var returnVal = settings.onSuccess(responseText, urlArray[urlIndex], urlIndex);
            responseText = returnVal === false ? "" : returnVal || responseText;
            urlQueue[urlIndex] = responseText;
            if (urlQueue.indexOf(null) === -1) {
                settings.onComplete(urlQueue);
            }
        }
        urlArray.forEach(function(url, i) {
            var parser = document.createElement("a");
            parser.setAttribute("href", url);
            parser.href = parser.href;
            var isCrossDomain = parser.host.replace(":" + parser.port, "") !== location.host;
            var isSameProtocol = parser.protocol === location.protocol;
            if (isCrossDomain && typeof XDomainRequest !== "undefined") {
                if (isSameProtocol) {
                    var xdr = new XDomainRequest();
                    xdr.open("GET", url);
                    xdr.timeout = 0;
                    xdr.onprogress = Function.prototype;
                    xdr.ontimeout = Function.prototype;
                    xdr.onload = function() {
                        onSuccess(xdr.responseText, i);
                    };
                    xdr.onerror = function(err) {
                        onError(xdr, i);
                    };
                    setTimeout(function() {
                        xdr.send();
                    }, 0);
                } else {
                    console.log("Internet Explorer 9 Cross-Origin (CORS) requests must use the same protocol");
                    onError(null, i);
                }
            } else {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url);
                if (settings.mimeType && xhr.overrideMimeType) {
                    xhr.overrideMimeType(settings.mimeType);
                }
                settings.onBeforeSend(xhr, url, i);
                xhr.onreadystatechange = function() {
                    if (xhr.readyState === 4) {
                        if (xhr.status === 200) {
                            onSuccess(xhr.responseText, i);
                        } else {
                            onError(xhr, i);
                        }
                    }
                };
                xhr.send();
            }
        });
    }
    /**
     * Gets CSS data from <style> and <link> nodes (including @imports), then
     * returns data in order processed by DOM. Allows specifying nodes to
     * include/exclude and filtering CSS data using RegEx.
     *
     * @preserve
     * @param {object}   [options] The options object
     * @param {string}   [options.include] CSS selector matching <link> and <style>
     *                   nodes to include
     * @param {string}   [options.exclude] CSS selector matching <link> and <style>
     *                   nodes to exclude
     * @param {object}   [options.filter] Regular expression used to filter node CSS
     *                   data. Each block of CSS data is tested against the filter,
     *                   and only matching data is included.
     * @param {function} [options.onBeforeSend] Callback before XHR is sent. Passes
     *                   1) the XHR object, 2) source node reference, and 3) the
     *                   source URL as arguments.
     * @param {function} [options.onSuccess] Callback on each CSS node read. Passes
     *                   1) CSS text, 2) source node reference, and 3) the source
     *                   URL as arguments.
     * @param {function} [options.onError] Callback on each error. Passes 1) the XHR
     *                   object for inspection, 2) soure node reference, and 3) the
     *                   source URL that failed (either a <link> href or an @import)
     *                   as arguments
     * @param {function} [options.onComplete] Callback after all nodes have been
     *                   processed. Passes 1) concatenated CSS text, 2) an array of
     *                   CSS text in DOM order, and 3) an array of nodes in DOM
     *                   order as arguments.
     *
     * @example
     *
     *   getCssData({
     *     include: 'style,link[rel="stylesheet"]', // default
     *     exclude: '[href="skip.css"]',
     *     filter : /red/,
     *     onBeforeSend(xhr, node, url) {
     *       // ...
     *     }
     *     onSuccess(cssText, node, url) {
     *       // ...
     *     }
     *     onError(xhr, node, url) {
     *       // ...
     *     },
     *     onComplete(cssText, cssArray) {
     *       // ...
     *     },
     *   }
/* ... truncado: 45929 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"CSSVarsPonyfill1","source":"IWebBlock:CSSVarsPonyfill","as":"$b"}
```
