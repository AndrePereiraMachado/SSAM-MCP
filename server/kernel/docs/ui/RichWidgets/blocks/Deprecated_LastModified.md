# Deprecated_LastModified

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 2 widgets internos

DEPRECATED: Consider creating a similar webblock in a different eSpace. Shows the user who modified the record and when.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| UserId | User Identifier | sim |  | The 'Id' of the User. |
| DateTime | Date Time | sim |  | The date and time of the last modification. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Deprecated_LastModified1","source":"IWebBlock:Deprecated_LastModified","as":"$b"}
{"op":"set","target":"$b/UserId","prop":"Value","value":"<User Identifier>"}
{"op":"set","target":"$b/DateTime","prop":"Value","value":"<Date Time>"}
```
