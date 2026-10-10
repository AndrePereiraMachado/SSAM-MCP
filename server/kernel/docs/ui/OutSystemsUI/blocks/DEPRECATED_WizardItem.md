# DEPRECATED_WizardItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 3 widgets internos

One step of a Wizard Block.

Add the Block inside the Content placeholder in the Wizard Block.

Used to split larger tasks into more manageable steps.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Status | Steps Identifier | sim |  | The UI of this step, it can be Active, Next or Past |

Valores possiveis (static entities):

- **Entities.Steps**: Next, Active, Past

## Placeholders

- **Content**: Drag your content to this placeholder. (em `content`)

## Eventos

- **OnClick**()

## Composicao interna

- Actions do bloco: TriggerClick

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_WizardItem1","source":"IMobileBlock:DEPRECATED_WizardItem","as":"$b"}
{"op":"set","target":"$b/Status","prop":"Value","value":"<Steps Identifier>"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_WizardItem1_OnClick","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClick","prop":"Handler","value":"$h"}
```
