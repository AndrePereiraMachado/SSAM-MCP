# DEPRECATED_MasterDetail

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Adaptive** | publico | 21 widgets internos

Similar to the Split Screen, but receives an item list for the left panel.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ItemList | DEPRECATED_MasterDetailItem List | sim |  |  |

## Placeholders

- **Content**: Drag your content to this placeholder. (em `MasterDetailWrapper/content/content`)

## Eventos

- **DetailClose**()
- **ItemSelected**(Id: Long Integer) [obrigatorio]

## Composicao interna

- Usa os blocos: ListItemContent
- Scripts exigidos: DEPRECATED_MasterDetail
- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnDetailClose, OnItemSelect, OnReady

## JavaScript

`OnDetailClose` / no `CloseRightContent`:

```js
$parameters.SplitScreenObj.close();
```

`OnItemSelect` / no `Open`:

```js
$parameters.SplitScreenObj.open();
```

`OnReady` / no `Init`:

```js
$parameters.SplitScreenObj = new SplitScreen();

var isPhone = $actions.IsPhone().IsPhone;

$parameters.SplitScreenObj.init($parameters.Id,isPhone);

// IOS fix
$actions.MoveElement($parameters.WidgetId, ".active-screen .screen");
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_MasterDetail1","source":"IMobileBlock:DEPRECATED_MasterDetail","as":"$b"}
{"op":"set","target":"$b/ItemList","prop":"Value","value":"<DEPRECATED_MasterDetailItem List>"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/DetailClose` resolve o IEventHandler pelo nome do evento e `$b/DetailClose/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_MasterDetail1_DetailClose","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/DetailClose","prop":"Handler","value":"$h"}
```
