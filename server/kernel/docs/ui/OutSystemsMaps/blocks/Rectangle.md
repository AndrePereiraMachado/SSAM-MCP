# Rectangle

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Shapes** | publico | 8 widgets internos

Adds a Rectangle shape to the Map block. Set the rectangle by defining its bounds (North, South, East, West). Drag inside the map AddOns placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| North | Text | sim |  | The rectangle's North bound.   GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”. Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”. |
| South | Text | sim |  | The rectangle's South bound.  GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”. Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”. |
| East | Text | sim |  | The rectangle's East bound.   GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”. Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”. |
| West | Text | sim |  | The rectangle's West  bound.   GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”. Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”. |
| OptionalConfigs | OptionalRectangleConfigs | nao |  | Set additional parameters to customize the rectangle’s behavior and functionality. |

## Placeholders

- **ShapeEvents** (em `content`)

## Eventos

- **OnClick**(MapWidgetId: Text, ShapeId: Text): Shape event that will be fired when the user clicks on the marker.

## Composicao interna

- Usa os blocos: Generic
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged
- Actions do bloco: OnInitialize, OnParametersChanged
- Chama actions do modulo: GenerateUniqueId, ChangeShapeBounds, LogEvent (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Rectangle1","source":"IMobileBlock:Rectangle","as":"$b"}
{"op":"set","target":"$b/North","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/South","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/East","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/West","prop":"Value","value":"<Text>"}
{"op":"create","parent":"$b/ShapeEvents","type":"IExpression","as":"$eShapeEvents"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Rectangle1_OnClick","as":"$h"}
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
