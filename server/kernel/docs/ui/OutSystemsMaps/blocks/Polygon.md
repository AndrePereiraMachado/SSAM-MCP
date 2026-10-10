# Polygon

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Shapes** | publico | 8 widgets internos

Adds a Polygon shape to the Map block. Drag inside the map AddOns placeholder. 
The polygon only appears once three or more locations are set.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Locations | Text List | sim |  | List of points that define the polygon. The polygon only appears once three or more locations are set.   GMaps - Works with addresses and coordinates (lat and lng). Leaflet - Works with coordinates (lat and lng) only. |
| OptionalConfigs | OptionalPolygonConfigs | nao |  | Set additional parameters to customize the polygon’s behavior and functionality. |

## Placeholders

- **ShapeEvents** (em `content`)

## Eventos

- **OnClick**(MapWidgetId: Text, ShapeId: Text): Shape event that will be fired when the user clicks on the marker.

## Composicao interna

- Usa os blocos: Generic
- Ciclo de vida: OnInitialize -> OnInitialize
- Actions do bloco: OnInitialize
- Chama actions do modulo: GenerateUniqueId (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Polygon1","source":"IMobileBlock:Polygon","as":"$b"}
{"op":"set","target":"$b/Locations","prop":"Value","value":"<Text List>"}
{"op":"create","parent":"$b/ShapeEvents","type":"IExpression","as":"$eShapeEvents"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Polygon1_OnClick","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ShapeId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClick","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnClick/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/OnClick/ShapeId","prop":"Value","value":"ShapeId"}
```
