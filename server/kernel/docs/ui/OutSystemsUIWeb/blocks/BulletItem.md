# BulletItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 1 widgets internos

Break up blocks of text into tidy chunks so the reader can skim through information, using BulletItems.

## Inputs

Nenhum.

## Placeholders

- **Content**: Fill this placeholder with your text. If left empty it will not be displayed.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"BulletItem1","source":"IWebBlock:BulletItem","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
