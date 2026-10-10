# OutSystemsMaps 2.3.1 (ReactiveLibrary)

Gerado em 2026-09-04T09:44:37 de `OutSystemsMaps.oml` pelo `anvil ui-catalog`. Nao editar a mao: regenerar quando a versao do ambiente mudar.

32 blocos (24 publicos), 27 static entities de configuracao, 17 actions publicas, 10 scripts, 0 temas.

## Como instanciar um bloco com os verbos

O modulo alvo precisa referenciar a biblioteca (`references`). Um bloco entra na tela como block instance:

```json
{"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IMobileBlockInstanceWidget","name":"Accordion1","source":"IMobileBlock:Accordion","empty":true,"as":"$acc"}
// source = SourceBlock na criacao; empty = apaga o conteudo de exemplo dos placeholders (nasce ao definir o SourceBlock)
{"op":"set","target":"$acc/MultipleItems","prop":"Value","value":"True"}          // input -> IArgument.Value
{"op":"create","parent":"$acc/Content","type":"IContainer","name":"Inner"}      // placeholder por nome
```

Widgets nativos do Reactive/Mobile: IContainer, IExpression, IInput, IButton, ILink, IList, IListItem, ITableRecords, IDropdown, ICheckbox, ISwitch, IIcon, IImage, IForm (plugin NRWidgets). Leia a pagina do bloco antes de usar: placeholders esperam filhos especificos e eventos obrigatorios precisam de handler (secao 'Como ligar um evento' da pagina).

## Drawing_Tools (6)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [DrawCircle](blocks/DrawCircle.md) | sim | Drag this block inside the DrawingTools placeholder to allow users to draw circles on the map. | 4 |  | OnDrawingChange |
| [Drawing_Tools](blocks/Drawing_Tools.md) | sim | Drag-and-drop this block inside the map Addons placeholder to allow users to draw on the map. | 1 | DrawingTools_Placeholder |  |
| [DrawMarker](blocks/DrawMarker.md) | sim | Drag this block inside the DrawingTools placeholder to allow users to add markers to the map. | 2 |  | OnDrawingChange |
| [DrawPolygon](blocks/DrawPolygon.md) | sim | Drag this block inside the DrawingTools placeholder to allow users to add polygons to the map. | 4 |  | OnDrawingChange |
| [DrawPolyline](blocks/DrawPolyline.md) | sim | Drag this block inside the DrawingTools placeholder to allow users to add polylines to the map. | 3 |  | OnDrawingChange |
| [DrawRectangle](blocks/DrawRectangle.md) | sim | Drag this block inside the DrawingTools placeholder to allow users to add rectangles to the map. | 4 |  | OnDrawingChange |

## FileLayer (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [FileLayer](blocks/FileLayer.md) | sim | The File Layer block allows you to display KML or GeoRSS layers on a map. | 2 |  | OnClick |

## HeatmapLayer (2)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [DEPRECATED_HeatmapLayer](blocks/DEPRECATED_HeatmapLayer.md) | sim | DEPRECATED due to Google Maps upcomming decommission: https://developers.google.com/maps/deprecations#heatmap-layer-js-deprecation;  📝 The Heatmap Layer is ... | 2 |  |  |
| [HeatmapLayer](blocks/HeatmapLayer.md) | sim | The Heatmap Layer block allows to visualize spatial distribution of data on maps. | 2 |  |  |

## Licenses (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Licenses](blocks/Licenses.md) | sim | Contains the OutSystemsMaps licenses. | 0 |  |  |

## Map_Events (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [MapEvent](blocks/MapEvent.md) | sim | This block enables to listen to events of a given map. | 1 |  | Action |

## Maps (3)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [LeafletMap](blocks/LeafletMap.md) | sim | Displays an interactive map on your Reactive Web and Native Mobile apps using Leaflet, an open-source JavaScript library for interactive maps. | 3 | Events_Placeholder, AddOns_Placeholder | OnError, Map_Initialized |
| [Map](blocks/Map.md) | sim | Displays an interactive map on your Reactive Web and Native Mobile apps using the Google Maps API. | 4 | Events_Placeholder, AddOns_Placeholder, LicenseWarning | OnError, Map_Initialized |
| [StaticMap](blocks/StaticMap.md) | sim | Displays non-interactive map on your Reactive Web and Native Mobile apps using the Google Maps API. | 5 | LicenseInformation | OnError |

## Marker (3)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Layout_MarkerPopup](blocks/Layout_MarkerPopup.md) | sim | Popup layout that can be used together with the MarkerPopup inside the Map Block. | 0 | Image, Header, Description, Link |  |
| [Marker](blocks/Marker.md) | sim | Adds a location to OutSystems Maps Map block. | 2 | MarkerEvents | OnClick |
| [MarkerPopup](blocks/MarkerPopup.md) | sim | Adds a location and a popup to OutSystems Maps Map block. | 2 | Popup, MarkerEvents | OnClick |

## Marker_Events (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [MarkerEvent](blocks/MarkerEvent.md) | sim | This block enables to listen to events of a given Marker on a Map. | 1 |  | Action |

## SearchPlaces (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [SearchPlaces](blocks/SearchPlaces.md) | sim | The Search Places block is based on Google’s Places Autocomplete, a Google service that returns place suggestions based on a textual search. | 2 |  | OnPlaceSelect, OnError |

## Shape_Events (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [ShapeEvent](blocks/ShapeEvent.md) | sim | This block enables to listen to events of a given Shape on a Map. | 1 |  | Action |

## Shapes (5)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Circle](blocks/Circle.md) | sim | Adds a Circle shape to the Map block. | 3 | ShapeEvents | OnClick |
| [Generic](blocks/Generic.md) | nao | Helper to add a shape to OutSystems Maps Map block. | 7 |  | OnClick |
| [Polygon](blocks/Polygon.md) | sim | Adds a Polygon shape to the Map block. | 2 | ShapeEvents | OnClick |
| [Polyline](blocks/Polyline.md) | sim | Adds a Polyline shape to the Map block. | 2 | ShapeEvents | OnClick |
| [Rectangle](blocks/Rectangle.md) | sim | Adds a Rectangle shape to the Map block. | 5 | ShapeEvents | OnClick |

## Styles (7)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [ImagesCSS](blocks/ImagesCSS.md) | nao | Block that contains the CSS variables defining images in base64 to be used on the Map's stylesheet. | 0 |  |  |
| [LeafletCSS](blocks/LeafletCSS.md) | nao | Leaflet v1.9.4 Date: 18.05.2023 Github: https://github.com/Leaflet/Leaflet NPM: https://www.npmjs.com/package/leaflet Website: https://leafletjs.com | 0 |  |  |
| [LeafletDrawCSS](blocks/LeafletDrawCSS.md) | nao | Leaflet.draw v1.0.4 Date: 24.10.2018 Github: https://github.com/Leaflet/Leaflet.draw NPM: https://www.npmjs.com/package/leaflet-draw | 0 |  |  |
| [LeafletRoutingCSS](blocks/LeafletRoutingCSS.md) | nao | LeafletRoutingMachine v3.2.12  Date: 21.11.2018 Github: https://github.com/perliedman/leaflet-routing-machine NPM: https://www.npmjs.com/package/leaflet-rout... | 0 |  |  |
| [MapCSS](blocks/MapCSS.md) | nao | Block with the CSS needed for Maps in designtime. | 0 |  |  |
| [PlacesCSS](blocks/PlacesCSS.md) | nao | Block with the CSS needed for places in designtime. | 0 |  |  |
| [TerraDrawToolbarCSS](blocks/TerraDrawToolbarCSS.md) | nao | Custom CSS made to build the DrawingTools toolbar and tools, when the TerraDraw provider is used. | 0 |  |  |

Veja tambem: [config-values.md](config-values.md) (static entities), [actions.md](actions.md) (actions publicas), [themes.md](themes.md) (tokens CSS).
