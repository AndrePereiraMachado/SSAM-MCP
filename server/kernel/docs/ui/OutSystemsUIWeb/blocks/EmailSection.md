# EmailSection

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Email** | publico | 6 widgets internos

A section for the email screen that allows to create a custom structure.

Create a new email screen in a separate flow with an empty theme, then, drag this pattern to the email screen to build your email.

## Inputs

Nenhum.

## Placeholders

- **Content**: Drag your content to this placeholder.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"EmailSection1","source":"IWebBlock:EmailSection","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
