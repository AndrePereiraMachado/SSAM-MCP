# LayoutSimple

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Layouts** | publico | 5 widgets internos

A custom simple Layout with a single placeholder for content.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |
| DeviceConfiguration | DeviceConfiguration | nao |  | Configuration to change the default values that set when the application will be seen as phone, tablet or desktop. |
| AccessibilityConfiguration | AccessibilityConfiguration | nao |  | Configuration to change the default values for the options to reset tabindex values and to add a visible outline to focused elements. |

## Placeholders

- **Content**: Drag your content to this placeholder.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: LayoutWidgets

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutSimple1","source":"IWebBlock:LayoutSimple","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
