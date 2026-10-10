# ClosestPolyfill

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Private** | privado | 0 widgets internos

Used to provide closest() compability with the Internet Explorer browsers.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
/*https://github.com/idmadj/element-closest-polyfill*/
if (typeof Element !== "undefined") {
    if (!Element.prototype.matches) {
        Element.prototype.matches = Element.prototype.msMatchesSelector || Element.prototype.webkitMatchesSelector;
    }

    if (!Element.prototype.closest) {
        Element.prototype.closest = function (s) {
            var el = this;

            do {
                if (el.matches(s)) return el;
                el = el.parentElement || el.parentNode;
            } while (el !== null && el.nodeType === 1);
            
            return null;
        };
    }
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ClosestPolyfill1","source":"IWebBlock:ClosestPolyfill","as":"$b"}
```
