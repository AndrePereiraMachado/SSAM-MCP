# JavaScript_ContentDebug

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **Utils** | privado | 17 widgets internos

For debug purposes: Replace Javascript_Content with Javascript_ContentDebug to show a Debug link and enable runtime changes in the generated Javascript.
WARNING: This block increases view state size *A LOT*!

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Content | Text | sim |  |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScript_Content
- Actions do bloco: ToggleDebug, Update

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"JavaScript_ContentDebug1","source":"IWebBlock:JavaScript_ContentDebug","as":"$b"}
{"op":"set","target":"$b/Content","prop":"Value","value":"<Text>"}
```
