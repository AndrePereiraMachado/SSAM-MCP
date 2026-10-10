# NotifyWidget

RichWidgets  | Traditional | UI flow **Private** | privado | 6 widgets internos

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| javascriptVariableName | Text | sim |  |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Actions do bloco: FakeOnNotify
- Chama actions do modulo: Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"NotifyWidget1","source":"IWebBlock:NotifyWidget","as":"$b"}
{"op":"set","target":"$b/javascriptVariableName","prop":"Value","value":"<Text>"}
```
