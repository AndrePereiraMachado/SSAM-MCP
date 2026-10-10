# LayoutEmail

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Email** | publico | 63 widgets internos

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| PreviewLine | Text | nao |  |  |

## Placeholders

- **Logo**: Drag your logo image to this placeholder.
- **Source**: Set some details of who sent the email.
- **Heading**: Fill this placeholder with a heading of your Email.
- **MainContent**: Fill this placeholder with the body of your Email.
- **Action**: Drag button or link to this placeholder.
- **Notes**: Fill this placeholder with your notes. (em `Content/Row1`)
- **Unsubscribe**: Use this placeholder to give the option to unsubscribe your email list. (em `Content/Row2`)
- **Address**: Fill this placeholder with your address or your contact details. (em `Content/Row3`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: EmailSection, Email3Rows

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LayoutEmail1","source":"IWebBlock:LayoutEmail","as":"$b"}
{"op":"create","parent":"$b/Logo","type":"IExpressionWidget","as":"$eLogo"}
{"op":"create","parent":"$b/Source","type":"IExpressionWidget","as":"$eSource"}
{"op":"create","parent":"$b/Heading","type":"IExpressionWidget","as":"$eHeading"}
{"op":"create","parent":"$b/MainContent","type":"IExpressionWidget","as":"$eMainContent"}
```
