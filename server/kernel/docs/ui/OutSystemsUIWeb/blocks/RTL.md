# RTL

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Private** | privado | 6 widgets internos

Script used to add the is-rtl class.

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
document.addEventListener("DOMContentLoaded", function() {
    document.querySelector('body').classList.add('is-rtl');    
});
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"RTL1","source":"IWebBlock:RTL","as":"$b"}
```
