# LayoutLoginSplit

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Layouts** | publico | 38 widgets internos

A custom page Layout for the login screen that divides the page in 2 columns. 

On the login page, select the object tree and use the LayoutLogin instead of the current page Layout, then, add the input widgets to the correct placeholders. OutSystems UI Themes already have the login page using the new LayoutLogin by default.

Use the BackgroundImage placeholder to set a background-image if you need, and drag any content you need in the Content placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DeviceConfiguration | DeviceConfiguration | nao |  | Configuration to change the default values that set when the application will be seen as phone, tablet or desktop. |
| AccessibilityConfiguration | AccessibilityConfiguration | nao |  | Configuration to change the default values for the options to reset tabindex values and to add a visible outline to focused elements. |

## Placeholders

- **Login**: Drag your login related content to this placeholder. | nasce com: WebBlockInstance:Columns2 (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: LayoutWidgets, Columns2, LoginForm, AnimatedLabel, AlignCenter

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutLoginSplit1","source":"IWebBlock:LayoutLoginSplit","empty":true,"as":"$b"}
```
