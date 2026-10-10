# Drawing_Tools

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Drawing_Tools** | publico | 7 widgets internos

Drag-and-drop this block inside the map Addons placeholder to allow users to draw on the map. 
You can customize it by dragging draw modes blocks inside it: draw polygons, polylines, circles, markers, and rectangles.

Note: 
To use this functionality, enable the Google Maps’ Drawing API. For detailed instructions on how to do it, refer to https://outsystemsui.outsystems.com/OutSystemsMapsSample/.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Position | DrawingToolsPosition Identifier | nao | Entities.DrawingToolsPosition.Top_Center | The position of the drawing tools on the map. By default, the input parameter is TOP_CENTER. When using Google Maps, the default position is TOP_CENTER.  When using Leaflet, it is TOP_LEFT.  Note: Leaflet only supports the following positions: - TOP_LEFT - TOP_RIGHT - BOTTOM_LEFT - BOTTOM_RIGHT |

Valores possiveis (static entities):

- **Entities.DrawingToolsPosition**: Left_Bottom, Bottom_Left, Top_Center, Left_Top, Right_Top, Top_Right, Bottom_Right, Top_Left, Right_Center, Bottom_Center, Left_Center, Right_Bottom

## Placeholders

- **DrawingTools_Placeholder**: Drag and drop draw modes blocks here (DrawPolygon, DrawPolyline, DrawCircle, DrawMarker, and DrawRectangle). (em `content/content`) | nasce com: WebBlockInstance:DrawPolygon, WebBlockInstance:DrawPolyline (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: DrawPolygon, DrawPolyline
- Scripts exigidos: terradraw, terradrawgooglemapsadapter
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnParametersChanged, OnReady, OnDestroy
- Chama actions do modulo: GenerateUniqueId, LogEvent, ChangeDrawingToolsPosition, CreateDrawingTools, RemoveDrawingTools (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Drawing_Tools1","source":"IMobileBlock:Drawing_Tools","empty":true,"as":"$b"}
```
