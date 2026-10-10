# Email3Rows

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Email** | publico | 17 widgets internos

A layout for emails with 3 rows to provide a simple interface and a light email structure.

Create a new email screen in a separate flow with an empty theme, then, drag this pattern to the email screen and fill in the placeholders.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Align | Text | nao | "center" | Text align position, "left" or "center". |
| Color | Text | nao | "#343a40" | Text color in hex format. Example: #fff is white #000 is black #aa2000 is a dark red Text color in hex format. Example: #fff is white #000 is black #aa2000 is a dark red Text color in hex format. Example: #fff is white #000 is black #aa2000 is a dark red |

## Placeholders

- **Row1**: Drag your content to this placeholder.
- **Row2**: Drag your content to this placeholder.
- **Row3**: Drag your content to this placeholder.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Email3Rows1","source":"IWebBlock:Email3Rows","as":"$b"}
{"op":"create","parent":"$b/Row1","type":"IExpressionWidget","as":"$eRow1"}
{"op":"create","parent":"$b/Row2","type":"IExpressionWidget","as":"$eRow2"}
{"op":"create","parent":"$b/Row3","type":"IExpressionWidget","as":"$eRow3"}
```
