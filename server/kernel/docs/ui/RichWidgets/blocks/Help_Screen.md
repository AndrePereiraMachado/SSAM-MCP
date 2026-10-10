# Help_Screen

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 10 widgets internos

Displays a "Need Help" label and a ? icon that when hovered show the help message for a screen.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| HtmlOrHelpText | Text | sim |  | The help text to be shown. Rendered as an unescaped expression allowing you to use HTML tags in your text. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Widget_Tooltip

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Help_Screen1","source":"IWebBlock:Help_Screen","as":"$b"}
{"op":"set","target":"$b/HtmlOrHelpText","prop":"Value","value":"<Text>"}
```
