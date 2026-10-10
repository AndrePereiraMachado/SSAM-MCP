# OutSystemsMaps 2.3.1: valores de configuracao (static entities)

## Entities.DirectionsProvider

Static entity with the available direction providers.

| Id |  |
|---|
| MapBox |  |
| OSRM |  |

## Entities.DrawingToolsEvent

Static entity with the available Drawing Tool events.

| Id |  |
|---|
| Initialized |  |

## Entities.DrawingToolsEventTriggered

Static entity with the available Drawing Tool events that can be triggered.

| Id |  |
|---|
| PolygonCreated |  |
| RectangleCreated |  |
| MarkerAdd |  |
| CircleCreated |  |
| PolylineCreated |  |

## Entities.DrawingToolsPosition

Set the drawing tools position within a Map.

| Id |  |
|---|
| Left_Bottom |  |
| Bottom_Left |  |
| Top_Center |  |
| Left_Top |  |
| Right_Top |  |
| Top_Right |  |
| Bottom_Right |  |
| Top_Left |  |
| Right_Center |  |
| Bottom_Center |  |
| Left_Center |  |
| Right_Bottom |  |

## Entities.DrawingToolType

Static entity with the available Drawing Tool types.

| Id |  |
|---|
| Circle |  |
| Polyline |  |
| Marker |  |
| Rectangle |  |
| Polygon |  |

## Entities.FileLayerEvent

Static entity with the available file layer events.

| Id |  |
|---|
| OnClick |  |

## Entities.LogType

Type of the log being recorded.

| Id | Label | Order |
|---|---|---|
| Warning | "Warning" | 1 |
| Debug | "Debug" | 4 |
| Performance | "Performance" | 3 |
| General | "General" | 2 |
| Error | "Error" | 0 |

## Entities.MapErrors

Static entity with the available Maps errors.

| Id | Code | Message |
|---|---|---|
| API_FailedLoadingPlugin | "MAPS-API-04002" | "There was a problem while loading the plugin" |
| CFG_InvalidTravelMode | "MAPS-CFG-04001" | "The Travel Mode is not recognized by the routing services" |
| GEN_InvalidChangePropertyMap | "MAPS-GEN-01001" | "The specified Map property is not supported: " |
| CFG_InvalidPolygonShapeLocations | "MAPS-CFG-05002" | "The Polygon needs at least 3 valid addresses/coordinates" |
| API_FailedRemoveMarkers | "MAPS-API-09004" | "An error occured while trying to remove all markers from the map" |
| LIB_FailedSetDirections | "MAPS-LIB-04001" | "Failed setting directions from the Map due to: " |
| GEN_InvalidChangePropertyHeatmapLayer | "MAPS-GEN-08001" | "The specified Heatmap Layer property is not supported: " |
| CFG_APIKeyAlreadySetStaticMap | "MAPS-CFG-02001" | "APIKey can only be set one time on the StaticMap" |
| API_FailedGettingShapeCenter | "MAPS-API-05003" | "It was not possible to get the shape center" |
| LIB_InvalidApiKeyMap | "MAPS-LIB-01001" | "The APIKey set on the Map is invalid for GoogleMaps API" |
| API_FailedUnsubscribeMarkerEvent | "MAPS-API-09006" | "It was not possible to remove event to the marker" |
| CFG_CantChangeParamsStaticMap | "MAPS-CFG-02002" | "Properties from StaticMaps can't be changed" |
| API_FailedCreatingShape | "MAPS-API-05006" | "It was not possible to add the shape to the map" |
| API_FailedGettingShapePath | "MAPS-API-05001" | "It was not possible to get the path from the Shape" |
| GEN_InvalidChangePropertyMapStyleId | "MAPS-GEN-06006" | "The 'MapStyleId' Map property cannot be changed after map initialization" |
| GEN_UnsupportedEventMap | "MAPS-GEN-01002" | "The specified Map event is not supported: " |
| CFG_LocalizationAlreadySetStaticMap | "MAPS-CFG-02003" | "Localization, Language and/or Region, can only be set one time on the StaticMap" |
| CFG_InvalidMapId | "MAPS-CFG-10005" | "The Map with the ID provided was not found or is invalid" |
| GEN_InvalidChangePropertyMarkerClusterer | "MAPS-GEN-09001" | "The specified MarkerClusterer property is not supported: " |
| CFG_InvalidDrawingToolsPosition | "MAPS-CFG-06001" | "The Drawing tools are placed in the wrong area." |
| LIB_FailedGeocodingMap | "MAPS-LIB-01002" | "Failed Geocoding the Map Location due to: " |
| API_FailedNoPluginDirections | "MAPS-API-04003" | "Please ensure to load a plugin before making Direction requests for Leaflet Maps. Use the LoadLeafletDirectionsPlugin client action." |
| API_FailedGettingCenterCoordinates | "MAPS-API-01001" | "It was not possible to get the center coordinates of the given map." |
| CFG_LocalizationAlreadySetMap | "MAPS-CFG-01003" | "Localization, Language and/or Region, can only be set one time on the Map" |
| LIB_FailedGeocodingMarker | "MAPS-LIB-03001" | "Failed Geocoding the Marker Position due to: " |
| GEN_InvalidChangePropertyShape | "MAPS-GEN-05001" | "The specified Shape property is not supported: " |
| API_FailedGettingCircleShape | "MAPS-API-05002" | "It was not possible to get the circle Shape" |
| CFG_InvalidCircleShapeCenter | "MAPS-CFG-05003" | "The Circle center needs to be a valid address/coordinates" |
| GEN_InvalidChangePropertyMarker | "MAPS-GEN-03001" | "The specified Marker property is not supported: " |
| API_FailedCreateMarker | "MAPS-API-09002" | "It was not possible to add the marker to the map" |
| GEN_UnsupportedEventMarker | "MAPS-GEN-03002" | "The specified Marker event is not supported: " |
| LIB_FailedGeocodingShapeLocations | "MAPS-LIB-05001" | "Failed Geocoding one or more locations of the Shape due to: " |
| CFG_APIKeyAlreadySetMap | "MAPS-CFG-01001" | "APIKey can only be set one time on the Map" |
| API_FailedContainsLocation | "MAPS-API-05005" | "It was not possible to get the shape and compare if the marker is inside" |
| GEN_ToolTypeAlreadyExists | "MAPS-GEN-06004" | "There is already a Tool on the DrawingTools registered on the specified Map under the same type: " |
| API_FailedRemoveMarker | "MAPS-API-09003" | "An error occured while trying to the marker from the map" |
| GEN_InvalidChangePropertyDrawingTools | "MAPS-GEN-06001" | "The specified Drawing Tools property is not supported: " |
| API_FailedRemoveDirections | "MAPS-API-03001" | "An error occurred while removing the Directions from the Map" |
| API_FailedGettingShapeRadius | "MAPS-API-05004" | "It was not possible to get the shape radius" |
| CFG_APIKeyDiffersFromPlacesToMaps | "MAPS-CFG-01002" | "The APIKey from Google Places and Google Maps must be equal." |
| API_PolylineUnsupported | "MAPS-GEN-01003" | "The action ContainsLocation can’t verify if a given marker is inside a Polyline shape. Please, change the ShapeWidgetId parameter to a Circle, Rectangle, or Polygon." |
| LIB_InvalidApiKeyStaticMap | "MAPS-LIB-02001" | "The APIKey set on the StaticMap is invalid for GoogleMaps API" |
| GEN_InvalidChangePropertyUseAdvancedMarkers | "MAPS-GEN-06005" | "The 'UseAdvancedMarkers' Map property cannot be changed after map initialization" |
| GEN_InvalidChangePropertyFileLayer | "MAPS-GEN-07001" | "The specified File Layer property is not supported: " |
| GEN_UnsupportedEventShape | "MAPS-GEN-05002" | "The specified Shape event is not supported: " |
| LIB_FailedGeocodingLeafletMarker | "MAPS-LIB-03002" | "Please provide a set of valid coordinates for the Marker Position." |
| LIB_FailedGeocodingLeafletMap | "MAPS-LIB-11001" | "Please provide a set of valid coordinates for the Map Center." |
| GEN_NoPluginDirectionsNeeded | "MAPS-GEN-04001" | "Google Maps' Directions API doesn't need a plugin to return the directions" |
| API_FailedSubscribeMarkerEvent | "MAPS-API-09005" | "It was not possible to add event to the marker" |
| CFG_InvalidRectangleShapeBounds | "MAPS-CFG-05004" | "The Rectangle needs to have 4 valid locations." |
| LIB_FailedGeocodingLeafletShapeLocations | "MAPS-LIB-05002" | "Please provide a set of valid coordinates for the Shape Locations." |
| GEN_InvalidChangePropertyTools | "MAPS-GEN-06002" | "The specified Tool property is not supported: " |
| CFG_InvalidPolylineShapeLocations | "MAPS-CFG-05001" | "The Polyline needs at least 2 valid addresses/coordinates" |
| GEN_UnsupportedEventDrawingTools | "MAPS-GEN-06003" | "The specified Drawing Tools event is not supported: " |

## Entities.MapEvent

Static entity with the available Map events.

| Id |  |
|---|
| OnError |  |
| Initialized |  |

## Entities.MapEventTriggered

Static entity with the available Map events that can be triggered.

| Id |  |
|---|
| DragEnd |  |
| DoubleClick |  |
| Click |  |
| RightClick |  |
| ZoomChanged |  |

## Entities.MapType

Static entity with the available Map types.

| Id |  |
|---|
| StaticMap |  |
| Map |  |

## Entities.MarkerEvent

Static entity with the available marker events.

| Id |  |
|---|
| OnClick |  |
| Initialized |  |

## Entities.MarkerEventTriggered

Static entity with the available marker events that can be triggered.

| Id |  |
|---|
| DragEnd |  |
| OnClick |  |
| DoubleClick |  |
| RightClick |  |

## Entities.MarkerType

Static entity with the available marker types.

| Id |  |
|---|
| Marker |  |
| MarkerPopup |  |

## Entities.PopupEvent

Static entity with the available popup marker events.

| Id |  |
|---|
| DoubleClick |  |
| OnMouseout |  |
| OnClick |  |
| RightClick |  |
| OnMouseover |  |

## Entities.Provider

Static entity with the available Map providers.

| Id |  |
|---|
| Leaflet |  |
| Google |  |

## Entities.SearchPlacesErrors

Static entity with the available search places errors.

| Id | Code | Message |
|---|---|---|
| GEN_UnsupportedEventSearchPlaces | "MAPS-GEN-10002" | "The specified SearchPlaces event is not supported: " |
| CFG_InvalidSearchPlacesSearchArea | "MAPS-CFG-10002" | "The SearchArea from SearchPlaces needs to have 4 valid locations." |
| CFG_APIKeyDiffersFromPlacesToMaps | "MAPS-CFG-01002" | "The APIKey from Google Places and Google Maps must be equal." |
| GEN_InvalidChangePropertySearchPlaces | "MAPS-GEN-10001" | "The specified SearchPlaces property is not supported: " |
| CFG_MaximumCountriesNumber | "MAPS-CFG-10003" | "The maximum number of countries you can use on a SearchPlace is 5." |
| CFG_APIKeyAlreadySetSearchPlaces | "MAPS-CFG-10001" | "APIKey can only be set one time on the Search Places" |
| LIB_InvalidApiKeySearchPlaces | "MAPS-LIB-10001" | "The APIKey set on the SearchPlaces is invalid for GoogleMaps API" |
| LIB_FailedGeocodingSearchAreaLocations | "MAPS-LIB-10002" | "Failed Geocoding one or more locations of the SearchArea from SearchPlaces due to: " |

## Entities.SearchPlacesEvent

Static entity with the available search places events.

| Id |  |
|---|
| OnPlaceSelect |  |
| Initialized |  |
| OnError |  |

## Entities.SearchTypes

Static entity with the available search types.

| Id |  |
|---|
| Establishments |  |
| Cities |  |
| Regions |  |
| Addresses |  |
| Geocodes |  |

## Entities.ShapeEvent

Static entity with the available shape events.

| Id |  |
|---|
| OnClick |  |

## Entities.ShapeEventTriggered

Static entity with the available shape events that can be triggered.

| Id |  |
|---|
| DragEnd |  |
| ShapeChanged |  |

## Entities.ShapeType

Static entity with the available shape types.

| Id |  |
|---|
| Polygon |  |
| Circle |  |
| Rectangle |  |
| Polyline |  |

## Entities.Style

Set the theme to be applied to the map.




Set the theme to be applied to the map.

| Id | Label | Order | Style | URLStyle | Is_Active |
|---|---|---|---|---|---|
| Dark | "Dark" | 4 | "[{'elementType':'geometry','stylers':[{'color':'#212121'}]},{'elementType':'labels.icon','stylers':[{'visibility':'off'}]},{'elementType':'labels.text.fill','stylers':[{'color':'#757575'}]},{'elementType':'labels.text.stroke','stylers':[{'color':'#212121'}]},{'featureType':'administrative','elementType':'geometry','stylers':[{'color':'#757575'}]},{'featureType':'administrative.country','elementType':'labels.text.fill','stylers':[{'color':'#9e9e9e'}]},{'featureType':'administrative.land_parcel','stylers':[{'visibility':'off'}]},{'featureType':'administrative.locality','elementType':'labels.text.fill','stylers':[{'color':'#bdbdbd'}]},{'featureType':'poi','elementType':'labels.text.fill','stylers':[{'color':'#757575'}]},{'featureType':'poi.park','elementType':'geometry','stylers':[{'color':'#181818'}]},{'featureType':'poi.park','elementType':'labels.text.fill','stylers':[{'color':'#616161'}]},{'featureType':'poi.park','elementType':'labels.text.stroke','stylers':[{'color':'#1b1b1b'}]},{'featureType':'road','elementType':'geometry.fill','stylers':[{'color':'#2c2c2c'}]},{'featureType':'road','elementType':'labels.text.fill','stylers':[{'color':'#8a8a8a'}]},{'featureType':'road.arterial','elementType':'geometry','stylers':[{'color':'#373737'}]},{'featureType':'road.highway','elementType':'geometry','stylers':[{'color':'#3c3c3c'}]},{'featureType':'road.highway.controlled_access','elementType':'geometry','stylers':[{'color':'#4e4e4e'}]},{'featureType':'road.local','elementType':'labels.text.fill','stylers':[{'color':'#616161'}]},{'featureType':'transit','elementType':'labels.text.fill','stylers':[{'color':'#757575'}]},{'featureType':'water','elementType':'geometry','stylers':[{'color':'#000000'}]},{'featureType':'water','elementType':'labels.text.fill','stylers':[{'color':'#3d3d3d'}]}]" | "&style=element:geometry%7Ccolor:0x212121&style=element:labels.icon%7Cvisibility:off&style=element:labels.text.fill%7Ccolor:0x757575&style=element:labels.text.stroke%7Ccolor:0x212121&style=feature:administrative%7Celement:geometry%7Ccolor:0x757575&style=feature:administrative.country%7Celement:labels.text.fill%7Ccolor:0x9e9e9e&style=feature:administrative.land_parcel%7Cvisibility:off&style=feature:administrative.locality%7Celement:labels.text.fill%7Ccolor:0xbdbdbd&style=feature:poi%7Celement:labels.text.fill%7Ccolor:0x757575&style=feature:poi.park%7Celement:geometry%7Ccolor:0x181818&style=feature:poi.park%7Celement:labels.text.fill%7Ccolor:0x616161&style=feature:poi.park%7Celement:labels.text.stroke%7Ccolor:0x1b1b1b&style=feature:road%7Celement:geometry.fill%7Ccolor:0x2c2c2c&style=feature:road%7Celement:labels.text.fill%7Ccolor:0x8a8a8a&style=feature:road.arterial%7Celement:geometry%7Ccolor:0x373737&style=feature:road.highway%7Celement:geometry%7Ccolor:0x3c3c3c&style=feature:road.highway.controlled_access%7Celement:geometry%7Ccolor:0x4e4e4e&style=feature:road.local%7Celement:labels.text.fill%7Ccolor:0x616161&style=feature:transit%7Celement:labels.text.fill%7Ccolor:0x757575&style=feature:water%7Celement:geometry%7Ccolor:0x000000&style=feature:water%7Celement:labels.text.fill%7Ccolor:0x3d3d3d" | True |
| Night | "Night" | 5 | "[{'elementType':'geometry','stylers':[{'color':'#242f3e'}]},{'elementType':'labels.text.fill','stylers':[{'color':'#746855'}]},{'elementType':'labels.text.stroke','stylers':[{'color':'#242f3e'}]},{'featureType':'administrative.locality','elementType':'labels.text.fill','stylers':[{'color':'#d59563'}]},{'featureType':'poi','elementType':'labels.text.fill','stylers':[{'color':'#d59563'}]},{'featureType':'poi.park','elementType':'geometry','stylers':[{'color':'#263c3f'}]},{'featureType':'poi.park','elementType':'labels.text.fill','stylers':[{'color':'#6b9a76'}]},{'featureType':'road','elementType':'geometry','stylers':[{'color':'#38414e'}]},{'featureType':'road','elementType':'geometry.stroke','stylers':[{'color':'#212a37'}]},{'featureType':'road','elementType':'labels.text.fill','stylers':[{'color':'#9ca5b3'}]},{'featureType':'road.highway','elementType':'geometry','stylers':[{'color':'#746855'}]},{'featureType':'road.highway','elementType':'geometry.stroke','stylers':[{'color':'#1f2835'}]},{'featureType':'road.highway','elementType':'labels.text.fill','stylers':[{'color':'#f3d19c'}]},{'featureType':'transit','elementType':'geometry','stylers':[{'color':'#2f3948'}]},{'featureType':'transit.station','elementType':'labels.text.fill','stylers':[{'color':'#d59563'}]},{'featureType':'water','elementType':'geometry','stylers':[{'color':'#17263c'}]},{'featureType':'water','elementType':'labels.text.fill','stylers':[{'color':'#515c6d'}]},{'featureType':'water','elementType':'labels.text.stroke','stylers':[{'color':'#17263c'}]}]" | "&style=element:geometry%7Ccolor:0x242f3e&style=element:labels.text.fill%7Ccolor:0x746855&style=element:labels.text.stroke%7Ccolor:0x242f3e&style=feature:administrative.locality%7Celement:labels.text.fill%7Ccolor:0xd59563&style=feature:poi%7Celement:labels.text.fill%7Ccolor:0xd59563&style=feature:poi.park%7Celement:geometry%7Ccolor:0x263c3f&style=feature:poi.park%7Celement:labels.text.fill%7Ccolor:0x6b9a76&style=feature:road%7Celement:geometry%7Ccolor:0x38414e&style=feature:road%7Celement:geometry.stroke%7Ccolor:0x212a37&style=feature:road%7Celement:labels.text.fill%7Ccolor:0x9ca5b3&style=feature:road.highway%7Celement:geometry%7Ccolor:0x746855&style=feature:road.highway%7Celement:geometry.stroke%7Ccolor:0x1f2835&style=feature:road.highway%7Celement:labels.text.fill%7Ccolor:0xf3d19c&style=feature:transit%7Celement:geometry%7Ccolor:0x2f3948&style=feature:transit.station%7Celement:labels.text.fill%7Ccolor:0xd59563&style=feature:water%7Celement:geometry%7Ccolor:0x17263c&style=feature:water%7Celement:labels.text.fill%7Ccolor:0x515c6d&style=feature:water%7Celement:labels.text.stroke%7Ccolor:0x17263c" | True |
| Silver | "Silver" | 2 | "[{'elementType':'geometry','stylers':[{'color':'#f5f5f5'}]},{'elementType':'labels.icon','stylers':[{'visibility':'off'}]},{'elementType':'labels.text.fill','stylers':[{'color':'#616161'}]},{'elementType':'labels.text.stroke','stylers':[{'color':'#f5f5f5'}]},{'featureType':'administrative.land_parcel','elementType':'labels.text.fill','stylers':[{'color':'#bdbdbd'}]},{'featureType':'poi','elementType':'geometry','stylers':[{'color':'#eeeeee'}]},{'featureType':'poi','elementType':'labels.text.fill','stylers':[{'color':'#757575'}]},{'featureType':'poi.park','elementType':'geometry','stylers':[{'color':'#e5e5e5'}]},{'featureType':'poi.park','elementType':'labels.text.fill','stylers':[{'color':'#9e9e9e'}]},{'featureType':'road','elementType':'geometry','stylers':[{'color':'#ffffff'}]},{'featureType':'road.arterial','elementType':'labels.text.fill','stylers':[{'color':'#757575'}]},{'featureType':'road.highway','elementType':'geometry','stylers':[{'color':'#dadada'}]},{'featureType':'road.highway','elementType':'labels.text.fill','stylers':[{'color':'#616161'}]},{'featureType':'road.local','elementType':'labels.text.fill','stylers':[{'color':'#9e9e9e'}]},{'featureType':'transit.line','elementType':'geometry','stylers':[{'color':'#e5e5e5'}]},{'featureType':'transit.station','elementType':'geometry','stylers':[{'color':'#eeeeee'}]},{'featureType':'water','elementType':'geometry','stylers':[{'color':'#c9c9c9'}]},{'featureType':'water','elementType':'labels.text.fill','stylers':[{'color':'#9e9e9e'}]}]" | "&style=element:geometry%7Ccolor:0xf5f5f5&style=element:labels.icon%7Cvisibility:off&style=element:labels.text.fill%7Ccolor:0x616161&style=element:labels.text.stroke%7Ccolor:0xf5f5f5&style=feature:administrative.land_parcel%7Celement:labels.text.fill%7Ccolor:0xbdbdbd&style=feature:poi%7Celement:geometry%7Ccolor:0xeeeeee&style=feature:poi%7Celement:labels.text.fill%7Ccolor:0x757575&style=feature:poi.park%7Celement:geometry%7Ccolor:0xe5e5e5&style=feature:poi.park%7Celement:labels.text.fill%7Ccolor:0x9e9e9e&style=feature:road%7Celement:geometry%7Ccolor:0xffffff&style=feature:road.arterial%7Celement:labels.text.fill%7Ccolor:0x757575&style=feature:road.highway%7Celement:geometry%7Ccolor:0xdadada&style=feature:road.highway%7Celement:labels.text.fill%7Ccolor:0x616161&style=feature:road.local%7Celement:labels.text.fill%7Ccolor:0x9e9e9e&style=feature:transit.line%7Celement:geometry%7Ccolor:0xe5e5e5&style=feature:transit.station%7Celement:geometry%7Ccolor:0xeeeeee&style=feature:water%7Celement:geometry%7Ccolor:0xc9c9c9&style=feature:water%7Celement:labels.text.fill%7Ccolor:0x9e9e9e" | True |
| Standard | "Standard" | 1 | "" | "" | True |
| Aubergine | "Aubergine" | 6 | "[{'elementType':'geometry','stylers':[{'color':'#1d2c4d'}]},{'elementType':'labels.text.fill','stylers':[{'color':'#8ec3b9'}]},{'elementType':'labels.text.stroke','stylers':[{'color':'#1a3646'}]},{'featureType':'administrative.country','elementType':'geometry.stroke','stylers':[{'color':'#4b6878'}]},{'featureType':'administrative.land_parcel','elementType':'labels.text.fill','stylers':[{'color':'#64779e'}]},{'featureType':'administrative.province','elementType':'geometry.stroke','stylers':[{'color':'#4b6878'}]},{'featureType':'landscape.man_made','elementType':'geometry.stroke','stylers':[{'color':'#334e87'}]},{'featureType':'landscape.natural','elementType':'geometry','stylers':[{'color':'#023e58'}]},{'featureType':'poi','elementType':'geometry','stylers':[{'color':'#283d6a'}]},{'featureType':'poi','elementType':'labels.text.fill','stylers':[{'color':'#6f9ba5'}]},{'featureType':'poi','elementType':'labels.text.stroke','stylers':[{'color':'#1d2c4d'}]},{'featureType':'poi.park','elementType':'geometry.fill','stylers':[{'color':'#023e58'}]},{'featureType':'poi.park','elementType':'labels.text.fill','stylers':[{'color':'#3C7680'}]},{'featureType':'road','elementType':'geometry','stylers':[{'color':'#304a7d'}]},{'featureType':'road','elementType':'labels.text.fill','stylers':[{'color':'#98a5be'}]},{'featureType':'road','elementType':'labels.text.stroke','stylers':[{'color':'#1d2c4d'}]},{'featureType':'road.highway','elementType':'geometry','stylers':[{'color':'#2c6675'}]},{'featureType':'road.highway','elementType':'geometry.stroke','stylers':[{'color':'#255763'}]},{'featureType':'road.highway','elementType':'labels.text.fill','stylers':[{'color':'#b0d5ce'}]},{'featureType':'road.highway','elementType':'labels.text.stroke','stylers':[{'color':'#023e58'}]},{'featureType':'transit','elementType':'labels.text.fill','stylers':[{'color':'#98a5be'}]},{'featureType':'transit','elementType':'labels.text.stroke','stylers':[{'color':'#1d2c4d'}]},{'featureType':'transit.line','elementType':'geometry.fill','stylers':[{'color':'#283d6a'}]},{'featureType':'transit.station','elementType':'geometry','stylers':[{'color':'#3a4762'}]},{'featureType':'water','elementType':'geometry','stylers':[{'color':'#0e1626'}]},{'featureType':'water','elementType':'labels.text.fill','stylers':[{'color':'#4e6d70'}]}]" | "&style=element:geometry%7Ccolor:0x1d2c4d&style=element:labels.text.fill%7Ccolor:0x8ec3b9&style=element:labels.text.stroke%7Ccolor:0x1a3646&style=feature:administrative.country%7Celement:geometry.stroke%7Ccolor:0x4b6878&style=feature:administrative.land_parcel%7Celement:labels.text.fill%7Ccolor:0x64779e&style=feature:administrative.province%7Celement:geometry.stroke%7Ccolor:0x4b6878&style=feature:landscape.man_made%7Celement:geometry.stroke%7Ccolor:0x334e87&style=feature:landscape.natural%7Celement:geometry%7Ccolor:0x023e58&style=feature:poi%7Celement:geometry%7Ccolor:0x283d6a&style=feature:poi%7Celement:labels.text.fill%7Ccolor:0x6f9ba5&style=feature:poi%7Celement:labels.text.stroke%7Ccolor:0x1d2c4d&style=feature:poi.park%7Celement:geometry.fill%7Ccolor:0x023e58&style=feature:poi.park%7Celement:labels.text.fill%7Ccolor:0x3C7680&style=feature:road%7Celement:geometry%7Ccolor:0x304a7d&style=feature:road%7Celement:labels.text.fill%7Ccolor:0x98a5be&style=feature:road%7Celement:labels.text.stroke%7Ccolor:0x1d2c4d&style=feature:road.highway%7Celement:geometry%7Ccolor:0x2c6675&style=feature:road.highway%7Celement:geometry.stroke%7Ccolor:0x255763&style=feature:road.highway%7Celement:labels.text.fill%7Ccolor:0xb0d5ce&style=feature:road.highway%7Celement:labels.text.stroke%7Ccolor:0x023e58&style=feature:transit%7Celement:labels.text.fill%7Ccolor:0x98a5be&style=feature:transit%7Celement:labels.text.stroke%7Ccolor:0x1d2c4d&style=feature:transit.line%7Celement:geometry.fill%7Ccolor:0x283d6a&style=feature:transit.station%7Celement:geometry%7Ccolor:0x3a4762&style=feature:water%7Celement:geometry%7Ccolor:0x0e1626&style=feature:water%7Celement:labels.text.fill%7Ccolor:0x4e6d70" | True |
| Retro | "Retro" | 3 | "[{'elementType':'geometry','stylers':[{'color':'#ebe3cd'}]},{'elementType':'labels.text.fill','stylers':[{'color':'#523735'}]},{'elementType':'labels.text.stroke','stylers':[{'color':'#f5f1e6'}]},{'featureType':'administrative','elementType':'geometry.stroke','stylers':[{'color':'#c9b2a6'}]},{'featureType':'administrative.land_parcel','elementType':'geometry.stroke','stylers':[{'color':'#dcd2be'}]},{'featureType':'administrative.land_parcel','elementType':'labels.text.fill','stylers':[{'color':'#ae9e90'}]},{'featureType':'landscape.natural','elementType':'geometry','stylers':[{'color':'#dfd2ae'}]},{'featureType':'poi','elementType':'geometry','stylers':[{'color':'#dfd2ae'}]},{'featureType':'poi','elementType':'labels.text.fill','stylers':[{'color':'#93817c'}]},{'featureType':'poi.park','elementType':'geometry.fill','stylers':[{'color':'#a5b076'}]},{'featureType':'poi.park','elementType':'labels.text.fill','stylers':[{'color':'#447530'}]},{'featureType':'road','elementType':'geometry','stylers':[{'color':'#f5f1e6'}]},{'featureType':'road.arterial','elementType':'geometry','stylers':[{'color':'#fdfcf8'}]},{'featureType':'road.highway','elementType':'geometry','stylers':[{'color':'#f8c967'}]},{'featureType':'road.highway','elementType':'geometry.stroke','stylers':[{'color':'#e9bc62'}]},{'featureType':'road.highway.controlled_access','elementType':'geometry','stylers':[{'color':'#e98d58'}]},{'featureType':'road.highway.controlled_access','elementType':'geometry.stroke','stylers':[{'color':'#db8555'}]},{'featureType':'road.local','elementType':'labels.text.fill','stylers':[{'color':'#806b63'}]},{'featureType':'transit.line','elementType':'geometry','stylers':[{'color':'#dfd2ae'}]},{'featureType':'transit.line','elementType':'labels.text.fill','stylers':[{'color':'#8f7d77'}]},{'featureType':'transit.line','elementType':'labels.text.stroke','stylers':[{'color':'#ebe3cd'}]},{'featureType':'transit.station','elementType':'geometry','stylers':[{'color':'#dfd2ae'}]},{'featureType':'water','elementType':'geometry.fill','stylers':[{'color':'#b9d3c2'}]},{'featureType':'water','elementType':'labels.text.fill','stylers':[{'color':'#92998d'}]}]" | "&style=element:geometry%7Ccolor:0xebe3cd&style=element:labels.text.fill%7Ccolor:0x523735&style=element:labels.text.stroke%7Ccolor:0xf5f1e6&style=feature:administrative%7Celement:geometry.stroke%7Ccolor:0xc9b2a6&style=feature:administrative.land_parcel%7Celement:geometry.stroke%7Ccolor:0xdcd2be&style=feature:administrative.land_parcel%7Celement:labels.text.fill%7Ccolor:0xae9e90&style=feature:landscape.natural%7Celement:geometry%7Ccolor:0xdfd2ae&style=feature:poi%7Celement:geometry%7Ccolor:0xdfd2ae&style=feature:poi%7Celement:labels.text.fill%7Ccolor:0x93817c&style=feature:poi.park%7Celement:geometry.fill%7Ccolor:0xa5b076&style=feature:poi.park%7Celement:labels.text.fill%7Ccolor:0x447530&style=feature:road%7Celement:geometry%7Ccolor:0xf5f1e6&style=feature:road.arterial%7Celement:geometry%7Ccolor:0xfdfcf8&style=feature:road.highway%7Celement:geometry%7Ccolor:0xf8c967&style=feature:road.highway%7Celement:geometry.stroke%7Ccolor:0xe9bc62&style=feature:road.highway.controlled_access%7Celement:geometry%7Ccolor:0xe98d58&style=feature:road.highway.controlled_access%7Celement:geometry.stroke%7Ccolor:0xdb8555&style=feature:road.local%7Celement:labels.text.fill%7Ccolor:0x806b63&style=feature:transit.line%7Celement:geometry%7Ccolor:0xdfd2ae&style=feature:transit.line%7Celement:labels.text.fill%7Ccolor:0x8f7d77&style=feature:transit.line%7Celement:labels.text.stroke%7Ccolor:0xebe3cd&style=feature:transit.station%7Celement:geometry%7Ccolor:0xdfd2ae&style=feature:water%7Celement:geometry.fill%7Ccolor:0xb9d3c2&style=feature:water%7Celement:labels.text.fill%7Ccolor:0x92998d" | True |

## Entities.TravelMode

Static entity with the available travel modes for directions.

| Id |  |
|---|
| TRANSIT |  |
| WALKING |  |
| DRIVING |  |
| BICYCLING |  |

## Entities.Type

Set the travel mode to be viewed on the map.


Set the map type to be applied.

| Id | MapType | Label | Order | Is_Active |
|---|---|---|---|---|
| Terrain | "terrain" | "terrain" | 4 | True |
| Hybrid | "hybrid" | "hybrid" | 3 | True |
| Roadmap | "roadmap" | "roadmap" | 1 | True |
| Satellite | "satellite" | "satellite" | 2 | True |

## Entities.Verbosity

Level of logs to be written or read.

| Id | Label | Order |
|---|---|---|
| Warning | "Warning" | 2 |
| Verbose | "Verbose" | 4 |
| NoLogging | "No Logging" | 0 |
| Log | "Log" | 3 |
| Error | "Error" | 1 |

## Entities.Zoom

Set the level of zoom to be added to the map.

| Id | Label | Zoom |
|---|---|---|
| Zoom13 | "Zoom 13" | 13 |
| Zoom17 | "Zoom 17" | 17 |
| Zoom14 | "Zoom 14" | 14 |
| Zoom15_Streets | "Zoom 15 (Streets)" | 15 |
| Zoom19 | "Zoom 19" | 19 |
| Auto | "Auto" | 0 |
| Zoom9 | "Zoom 9" | 9 |
| Zoom3 | "Zoom 3" | 3 |
| Zoom1_World | "Zoom 1 (World)" | 1 |
| Zoom8 | "Zoom 8" | 8 |
| Zoom12 | "Zoom 12" | 12 |
| Zoom4 | "Zoom 4" | 4 |
| Zoom5_Continent | "Zoom 5 (Continent)" | 5 |
| Zoom2 | "Zoom 2" | 2 |
| Zoom6 | "Zoom 6" | 6 |
| Zoom10_City | "Zoom 10 (City)" | 10 |
| Zoom20_Buildings | "Zoom 20 (Buildings)" | 20 |
| Zoom16 | "Zoom 16" | 16 |
| Zoom11 | "Zoom 11" | 11 |
| Zoom7 | "Zoom 7" | 7 |
| Zoom18 | "Zoom 18" | 18 |

# Structures

## Author

Holds information about the author in the context of the File Layers.

- Email: Email - Email address of the author.
- Name: Text - Name of the author.
- Uri: Text - Uir address.

## Bounds

Structure that helps defining the bounds of the Rectangle shape.

- North: Text - The rectangle's North bound. Works with addresses and coordinates (latitude and longitude).
Example: "34.56,45.65" or "34.56" or "55 Thomson Pl 2nd floor, Boston, MA 02210, United States"
- South: Text - The rectangle's South bound. Works with addresses and coordinates (latitude and longitude).
Example: "34.56,45.65" or "34.56" or "55 Thomson Pl 2nd floor, Boston, MA 02210, United States"
- West: Text - The rectangle's West bound. Works with addresses and coordinates (latitude and longitude).
Example: "34.56,45.65" or "45.65 or "55 Thomson Pl 2nd floor, Boston, MA 02210, United States"
- East: Text - The rectangle's East bound. Works with addresses and coordinates (latitude and longitude).
Example: "34.56,45.65" or "45.65 or "55 Thomson Pl 2nd floor, Boston, MA 02210, United States"

## CircleShape

Structure that helps defining the shape of the Circle (contains the center coordinates and radius).

- Center: Coordinates - Coordinates of the Circle's center.
- Radius: Decimal - Radius of the Circle in meters.

## Coordinates

Coordinates indicate the Latitude and Longitude and will be filled in this parameter.

- Lat: Decimal - The Latitude will be filled in this parameter.
- Lng: Decimal - The Longitude will be filled in this parameter.

## DEPRECATED_Internal_HeatmapLayer_Configs

Structure to handle internal configurations associated with the Heatmap Layer.

- Internal_to_provider_heatmapLayer_configs: DEPRECATED_Internal_to_provider_heatmapLayer_confi
- UniqueId: Text

## DEPRECATED_Internal_to_provider_heatmapLayer_confi

Set additional parameters to customize the file layer behavior and functionality.

- points: Points List
- maxIntensity: Decimal = False - Set if when clicking on the layer, popups should be displayed. By default, false.
- opacity: Decimal = False - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.
- radius: Integer = False - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.
- dissipateOnZoom: Boolean = True - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.
- gradient: Text List - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.

## DEPRECATED_OptionalHeatmapLayerConfigs

DEPRECATED

- MaxIntensity: Decimal - The maximum intensity of the heatmap.
- Opacity: Decimal = 0.6 - The opacity of the heatmap, expressed as a number between 0 and 1. By default 0.6.
- Radius: Integer = 3 - The radius of influence for each data point, in pixels.
- DissipateOnZoom: Boolean = True - Specifies whether heatmaps dissipate on zoom or not. By default, true.
- Gradient: Text List - The color gradient of the heatmap, specified as an array of CSS color strings.

## DirectionLegs

Legs from Direction (when direction contains waypoints, each leg is one step from a point to the next)

- Origin: Coordinates - Coordinates from the origin location.
- Destination: Coordinates - Coordinates from the destination location.
- Distance: Integer - Distance to travel.
- Duration: Integer - Route duration

## DirectionOptions

Structure to handle direction options.

- Origin: Text [obrigatorio] - Defines the location of the origin. Works with addresses and coordinates (latitude and longitude).

Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”
- Destination: Text [obrigatorio] - Defines the location of the destination. Works with addresses and coordinates (latitude and longitude).

Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”
- TravelMode: TravelMode Identifier [obrigatorio] - Defines the mode of transportation. By default, Driving.
Travel Modes available:
- Driving (directions using the road network)
- Bicycling (directions via bicycle paths & preferred streets)
- Transit (directions via public transit routes)
- Walking (directions via pedestrian paths & sidewalks)
- Waypoints: Text List - List of locations on the map that the route must go through. Requests using more than 10 waypoints, or waypoint optimization, may be billed at a higher rate.
Please, be sure to check how your provider bills such requests.
- OptimizeWaypoints: Boolean = False - Set to true to rearrange the waypoints and calculate the optimized route.
- Exclude: ExcludeCriteria

## ErrorMessage

Error message from actions from the Map. Contains a code and a message explaining the error.

- Code: Text - Code that indicates the error.
- Message: Text - Message explaining the error.

## ExcludeCriteria

Structure to handle the exclusion criteria for directions.

- AvoidTolls: Boolean = False - Set to true to set a direction avoiding tolls.
- AvoidHighways: Boolean = False - Set to true to set a direction avoiding highways.
- AvoidFerries: Boolean = False - Set to true to set a direction avoiding ferries.

## FeatureData

Holds information about the feature data in the context of File Layers.

- Id: Text - Identifier of the feature.
- Name: Text - Name of the feature.
- Author: Author - Holds information about the author in the context of the File Layers.
- Description: Text - Description of the feature.
- InfoWindowHtml: Text - Information Window in HTML
- Snippet: Text - Snippet associated with the feature.

## Fill

Set additional parameters to customize the shape’s fill.

- Color: Text = "#000000" - Set the HEX color of the shape. The default color is “#000000” (black).
- Opacity: Decimal = 1 - Set a value (between 0.0 and 1.0) to define the opacity of the shape. The default opacity is 1.

## GradientColor

Structure that represents the color of a given gradient.
Possible to use the color in RGBA OR hexadecimal formats.

- Red: Text - Value of the red color. Value between 0 and 255.
- Green: Text - Value of the green color. Value between 0 and 255.
- Blue: Text - Value of the blue color. Value between 0 and 255.
- Alpha: Text - Value of the transparency. Value between 0 and 255. 0 means fully transparent, 255 opac.
- Hexadecimal: Text - Color defined in hexadecimal format (e.g. #08519cff).

## IconSize

Structure that helps defining the marker icon size.

- Width: Integer - Icon width.
- Height: Integer - Icon height.

## Internal__Marker_Configs

Structure to handle internal configurations associated with the Markers.

- Internal_to_provider_marker_configs: Internal_to_provider_marker_configs
- UniqueId: Text

## Internal_Configs

Structure to handle internal configurations for the Map.

- ExtendedClass: Text - Attribute to me mapped to the provider configurations.
- Height: Text - Attribute to me mapped to the provider configurations.
- Internal_to_provider_configs: Internal_to_provider_configs - Attribute to me mapped to the provider configurations.
- StaticMapURL: Text - Attribute to me mapped to the provider configurations.
- UniqueId: Text - Attribute to me mapped to the provider configurations.

## Internal_DrawCircle_Configs

Structure to handle internal configurations associated with the Drawing Tools.

- Internal_to_provider_tools_configs: Internal_to_provider_drawFilledShape_configs
- UniqueId: Text

## Internal_DrawCircle_Shape

Structure that helps defining the shape of the Circle drawed (contains the location and radius), that is returned by the OnDrawingChange event.

- Location: Text - Coordinates of the Circle's center.
- Radius: Decimal - Radius of the Circle in meters.

## Internal_DrawingTools_Configs

Structure to handle internal configurations associated with the Drawing Tools.

- Internal_to_provider_drawingTools_configs: Internal_to_provider_drawingTools_configs
- UniqueId: Text

## Internal_DrawMarker_Configs

Structure to handle internal configurations associated with the Drawing Tools.

- Internal_to_provider_tools_configs: Internal_to_provider_drawMarker_configs
- UniqueId: Text

## Internal_DrawPolygon_Configs

Structure to handle internal configurations associated with the Drawing Tools.

- Internal_to_provider_tools_configs: Internal_to_provider_drawFilledShape_configs
- UniqueId: Text

## Internal_DrawPolyline_Configs

Structure to handle internal configurations associated with the Drawing Tools.

- Internal_to_provider_tools_configs: Internal_to_provider_drawNotFilledShape_configs
- UniqueId: Text

## Internal_DrawRectangle_Configs

Structure to handle internal configurations associated with the Drawing Tools.

- Internal_to_provider_tools_configs: Internal_to_provider_drawFilledShape_configs
- UniqueId: Text

## Internal_FileLayer_Configs

Structure to handle internal configurations associated with the File Layers.

- Internal_to_provider_fileLayer_configs: Internal_to_provider_fileLayer_configs
- UniqueId: Text

## Internal_HeatmapLayer_Configs

Structure to handle internal configurations associated with the Heatmap Layer.

- Internal_to_provider_heatmapLayer_configs: Internal_to_provider_heatmapLayer_configs
- UniqueId: Text

## Internal_SearchPlaces_Configs

Structure to handle internal configurations associated with search places.

- Internal_to_provider_configs: Internal_to_provider_searchPlaces_configs
- UniqueId: Text

## Internal_Shape_Configs

Structure to handle internal configurations associated with Shapes.

- Internal_to_provider_shape_configs: Internal_to_provider_shape_configs
- UniqueId: Text

## Internal_to_provider_configs

Structure to handle internal configurations associated with the Map's provider.

- advancedFormat: Text - Attribute to me mapped to the provider configurations.
- apiKey: Text [obrigatorio] - Attribute to me mapped to the provider configurations.
- autoZoomOnShapes: Boolean = False - Attribute to me mapped to the provider configurations.
- center: Text - Attribute to me mapped to the provider configurations.
- height: Text [obrigatorio] - Attribute to me mapped to the provider configurations.
- offset: Offset [obrigatorio] - Attribute to me mapped to the provider configurations.
- showTraffic: Boolean [obrigatorio] - Attribute to me mapped to the provider configurations.
- staticMap: Boolean [obrigatorio] - Attribute to me mapped to the provider configurations.
- style: Style Identifier [obrigatorio] - Attribute to me mapped to the provider configurations.
- type: Type Identifier [obrigatorio] - Attribute to me mapped to the provider configurations.
- zoom: Zoom Identifier [obrigatorio] - Attribute to me mapped to the provider configurations.
- markerClusterer: Private_MarkerClusterer - Attribute to me mapped to the provider configurations.
- respectUserPosition: Boolean = False - Attribute to me mapped to the provider configurations.
- respectUserZoom: Boolean = False - Attribute to me mapped to the provider configurations.
- localization: Localization - Attribute to me mapped to the provider configurations.
- useAdvancedMarkers: Boolean - Attribute to me mapped to the provider configurations.
- mapStyleId: Text - Attribute to me mapped to the provider configurations.

## Internal_to_provider_drawFilledShape_configs

Structure to handle internal configurations associated with the Drawing Tools.

- allowDrag: Boolean = False
- allowEdit: Boolean = False
- strokeColor: Text [obrigatorio] = "#000000"
- strokeOpacity: Decimal [obrigatorio] = 1
- strokeWeight: Integer [obrigatorio] = 2
- fillColor: Text [obrigatorio] = "#000000"
- fillOpacity: Decimal [obrigatorio] = 1

## Internal_to_provider_drawingTools_configs

Structure to handle internal configurations associated with the Drawing Tools.

- position: DrawingToolsPosition Identifier = Entities.DrawingToolsPosition.Top_Center

## Internal_to_provider_drawMarker_configs

Structure to handle internal configurations associated with the Drawing Tools.

- allowDrag: Boolean = False
- iconUrl: Text

## Internal_to_provider_drawNotFilledShape_configs

Structure to handle internal configurations associated with the Drawing Tools.

- allowDrag: Boolean = False
- allowEdit: Boolean = False
- strokeColor: Text [obrigatorio] = "#000000"
- strokeOpacity: Decimal [obrigatorio] = 1
- strokeWeight: Integer [obrigatorio] = 2

## Internal_to_provider_fileLayer_configs

Set additional parameters to customize the file layer behavior and functionality.

- layerUrl: Text
- suppressPopups: Boolean - Set if when clicking on the layer, popups should be displayed. By default, false.
- preserveViewport: Boolean - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.

## Internal_to_provider_heatmapLayer_configs

Set additional parameters to customize the file layer behavior and functionality.

- points: Points List
- minIntensity: Decimal = False - Set if when clicking on the layer, popups should be displayed. By default, false.
- maxIntensity: Decimal = False - Set if when clicking on the layer, popups should be displayed. By default, false.
- opacity: Decimal = False - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.
- radius: Integer = False - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.
- gradient: GradientColor List - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.

## Internal_to_provider_marker_configs

Structure to handle internal configurations associated with the Markers at the provider level.

- location: Text
- iconUrl: Text [obrigatorio]
- title: Text [obrigatorio]
- label: Text [obrigatorio]
- allowDrag: Boolean [obrigatorio]
- iconWidth: Text [obrigatorio]
- iconHeight: Text [obrigatorio]

## Internal_to_provider_searchPlaces_configs

Structure to handle internal configurations associated with search places.

- apiKey: Text [obrigatorio]
- countries: Text List
- searchArea: SearchArea
- searchType: SearchTypes Identifier
- localization: Localization

## Internal_to_provider_shape_configs

Structure to handle internal configurations associated with Shapes at the provider level.

- locations: Text
- center: Text
- bounds: Text
- radius: Integer
- allowDrag: Boolean [obrigatorio]
- allowEdit: Boolean [obrigatorio]
- strokeColor: Text [obrigatorio] = "#000000"
- strokeOpacity: Decimal [obrigatorio] = 1
- strokeWeight: Integer [obrigatorio] = 2
- fillColor: Text [obrigatorio] = "#000000"
- fillOpacity: Decimal [obrigatorio] = 1

## Localization

Customize your map for a specific country or region.

- Language: Text - Change the default language settings.
- Region: Text - Specify a region code, which alters the map's behavior based on a given country or territory.

## Marker

Use the Marker parameter to set a location on the map. By default, the Marker uses the google maps defaults marker but can by displayed custom images and you can change it using the present parameters.

For more information, please visit https://developers.google.com/maps/documentation/javascript/markers

- Location: Text = "42.3517926,-71.0467845" - Defines the marker position on the map. Works with addresses and coordinates (latitude and longitude).

Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”
- IconURL: Text - Set the icon image to be applied to each marker. By default, the Marker uses the Google Maps defaults marker.
- AdvancedFormat: Text - Allow for more options beyond what's provided through the input parameters on the marker.

"
{
    icon: {
        url:icons[iconCounter],
        scaledSize: new google.maps.Size(70, 70)
        }
    }
"

For more information, please visit https://developers.google.com/maps/documentation/javascript/reference/marker#MarkerOptions and https://developers.google.com/maps/documentation/javascript/reference/marker#Icon

## MarkerClusterer

Allows you to aggregate markers of close proximity into gropus and to simplify the display of markers on the map.

- Active: Boolean = False - Set whether the map markers are clustered. By default, false.
- MaxZoom: Zoom Identifier - The maximum zoom level at which clustering is enabled. By default clustering is to be enabled at all zoom levels ‘Auto’.
- ZoomOnClick: Boolean = True - Set whether to zoom the map when a cluster marker is clicked. By default, true.
- MinClusterSize: Integer = 2 - Set the minimum number of markers needed in a cluster before the markers are hidden and a cluster marker appears. By default, 2.

## Offset

Expand the options to set the OffsetX(vertical) and OffsetY(horizontal) in pixels, to apply on map. This will apply based on defined Location.

- OffsetX: Integer = 0 - Set the horizontal offset in pixels to be applied.
- OffsetY: Integer = 0 - Set the vertical offset in pixels to be applied.

## OptionalCircleConfigs

Set additional parameters to customize the circle’s behavior and functionality.

- AllowDrag: Boolean = False - Allows users to drag the circle. By default, circles are not draggable.
- AllowEdit: Boolean = False - Allows users to edit the circle. By default, circles are not editable.
- Stroke: Stroke - Set additional parameters to customize the shape’s stroke.
- Fill: Fill - Set additional parameters to customize the shape’s fill.

## OptionalFileLayerConfigs

Set additional parameters to customize the file layer behavior and functionality.

- SuppressPopups: Boolean = False - Set if when clicking on the layer, popups should be displayed. By default, false.
- PreserveViewport: Boolean = False - Set if the map should be adjusted to the bounds of the content when showing the layer. By default, the map will automatically adjust to show all layer’s contents.

## OptionalHeatmapLayerConfigs

Set additional parameters to customize the file layer behavior and functionality.

- MaxIntensity: Decimal - The maximum intensity of the heatmap.
- MinIntensity: Decimal - The minimum intensity of the heatmap.
- Opacity: Decimal = 0.6 - The opacity of the heatmap, expressed as a number between 0 and 1. By default 0.6.
- Radius: Integer = 3 - The radius of influence for each data point, in pixels.
- GradientColors: GradientColor List - The color gradient of the heatmap, specified as an array of CSS colors.

## OptionalLeafletMapConfigs

Set additional parameters to customize map’s behavior and functionality.

- AutoZoomOnShapes: Boolean = False - If True, the auto zoom feature adjusts to fit all shapes and markers displayed on the map.
If False (default), the auto zoom accommodates only the markers.
This functionality is only applicable Zoom = Entities.Zoom.Auto.

Note: For Leaflet, this property can’t be changed dynamically.
- Offset: Offset - Expand the options to set the OffsetX(vertical) and OffsetY(horizontal) in pixels, to apply on map. This will apply based on defined Location.
- RespectUserPosition: Boolean = False - Defines whether changes made by the user to the map center position should be preserved when the map is refreshed or when new elements are added or removed.

Default: False – the map center is automatically adjusted to fit all elements (e.g. markers, shapes).
- RespectUserZoom: Boolean = False - Defines if the changes made on the zoom by the user, should be respected when new elements are added or removed from the map. Default: false - zoom will be automatically adjusted to fit all elements in the map (e.g. markers, shapes, etc).
- Zoom: Zoom Identifier = Entities.Zoom.Auto - Sets the Zoom level to apply on map, between 1 (World) and 20 (Buildings). The following list shows the approximate level of detail you can expect to see at each zoom level:
- Auto: Fit to all markers present on Map
- Zoom1: World
- Zoom5: Continent
- Zoom10: City
- Zoom15: Streets
- Zoom20: Buildings

For more information, visit https://developers.google.com/maps/documentation/javascript/overview#zoom-levels

## OptionalMapConfigs

Set additional parameters to customize map’s behavior and functionality.

- AutoZoomOnShapes: Boolean = False - If True, the auto zoom feature adjusts to fit all shapes and markers displayed on the map.
If False (default), the auto zoom accommodates only the markers.
This functionality is only applicable Zoom = Entities.Zoom.Auto.
- Localization: Localization - Customize your map for a specific country or region.
This setting will not change in runtime.
- MapStyleId: Text - Sets the map id of the style designed in the https://console.cloud.google.com/google/maps-apis/studio/styles/. This parameter is only used when the property 'OptionalMapsConfigs.UseAdvancedMarkers' is set to true (default).
When using this parameter, map styles are controlled via the Google Cloud Console.
Please see documentation at https://developers.google.com/maps/documentation/javascript/styling#cloud_tooling

📝 This parameter cannot be set or changed after a map is instantiated.
Please see documentation at https://developers.google.com/maps/documentation/javascript/reference/map#MapElement.mapId
- MarkerClusterer: MarkerClusterer - Allows you to aggregate markers of close proximity into gropus and to simplify the display of markers on the map.
- Offset: Offset - Expand the options to set the OffsetX(vertical) and OffsetY(horizontal) in pixels, to apply on map. This will apply based on defined Location.
- RespectUserPosition: Boolean = False - Defines whether changes made by the user to the map center position should be preserved when the map is refreshed or when new elements are added or removed.

Default: False – the map center is automatically adjusted to fit all elements (e.g. markers, shapes).
- RespectUserZoom: Boolean = False - Defines if the changes made on the zoom by the user, should be respected when new elements are added or removed from the map. Default: false - zoom will be automatically adjusted to fit all elements in the map (e.g. markers, shapes, etc).
- ShowTraffic: Boolean = False - Enable to show the traffic mode on the map.
- Type: Type Identifier = Entities.Type.Roadmap - Set the map type to roadmap, satellite, hybrid or terrain, provided by Google Maps. 

For more information, visit https://developers.google.com/maps/documentation/javascript/maptypes.
- UseAdvancedMarkers: Boolean = True - If set to True (default), the new google.maps.marker.AdvancedMarkerElement is enabled for all markers displayed on the map. If set to False, the deprecated google.maps.Marker (since Google Maps v3.56) is enabled for all markers displayed on the map. This functionality is only applicable if the Google Maps version is 3.56 or higher.

📝 This parameter cannot be set or changed after a map is instantiated.
- Zoom: Zoom Identifier = Entities.Zoom.Auto - Sets the Zoom level to apply on map, between 1 (World) and 20 (Buildings). The following list shows the approximate level of detail you can expect to see at each zoom level:
- Auto: Fit to all markers present on Map
- Zoom1: World
- Zoom5: Continent
- Zoom10: City
- Zoom15: Streets
- Zoom20: Buildings

For more information, visit https://developers.google.com/maps/documentation/javascript/overview#zoom-levels
- DEPRECATED_AdvancedFormat: Text - Allow for more options beyond what's provided through the input parameters.

To be compliant with Content Security Policy (CSP) requirements, the usage of eval() function will be discontinued. 
Consequently, this parameter will be impacted and may not function as expected.
It's important to note that this change will only affect those who need to ensure compliance with CSP guidelines.

Additionally, as an alternative we recommend the usage of Maps API to extend the product.

Example:
In order to hide the zoom controls from the Map we used:
  "{
      'zoomControl': true
   }"

Now, replace it by a javascript call in the Map Initialize event:

  OutSystems.Maps.MapAPI.MapManager.GetMapById($parameters.MapId).provider.setOptions({'zoomControl':false});
  //$parameters.MapId is the identifier of the Map block
- DEPRECATED_Style: Style Identifier = Entities.Style.Standard - If the property 'OptionalMapsConfigs.UseAdvancedMarkers' is set to false, set the theme type based on themes provided by Google Maps. Please note, that any style applied won't be visible with the Satellite type selected.
For more information, visit https://developers.google.com/maps/documentation/javascript/styling.
—
Note: This parameter is deprecated when the property 'OptionalMapsConfigs.UseAdvancedMarkers' is set to true (default). In this case, please use 'OptionalMapsConfigs.MapStyleId' to set the ID of the style designed in the https://console.cloud.google.com/google/maps-apis/studio/styles/.

## OptionalMarkerConfigs

Set additional parameters to customize the marker’s behavior and functionality.

- IconURL: Text - Set the icon image to be applied to the marker. By default, markers use the Google Maps default marker.
- IconSize: IconSize - Set the marker icon size.
- Title: Text - Set the tooltip text that is shown when hovering the marker. By default, markers don’t have titles.
- Label: Text - Set the label text that is shown on top of the marker icon. By default, markers don’t have labels.
- AllowDrag: Boolean - Set the dragging property of the Marker. By default, markers are not draggable.

## OptionalPolygonConfigs

Set additional parameters to customize the polygon’s behavior and functionality.

- AllowDrag: Boolean = False - Allows users to drag the polygon. By default, polygons are not draggable.
- AllowEdit: Boolean = False - Allows users to edit the polygon. By default, polygons are not editable.
- Stroke: Stroke - Set additional parameters to customize the shape’s stroke.
- Fill: Fill - Set additional parameters to customize the shape’s fill.

## OptionalPolylineConfigs

Set additional parameters to customize the polyline's behavior and functionality.

- AllowDrag: Boolean = False - Allows users to drag the polyline. By default, polylines are not draggable.
- AllowEdit: Boolean = False - Allows users to edit the polyline. By default, polylines are not editable.
- Stroke: Stroke - Set additional parameters to customize the shape’s stroke.

## OptionalPopupMarkerConfigs

Set additional parameters to customize the popup marker’s behavior and functionality.

- IconURL: Text - Set the icon image to be applied to the marker. By default, markers use the Google Maps default marker.
- IconSize: IconSize - Set the marker icon size.
- Title: Text - Set the tooltip text that is shown when hovering the marker. By default, markers don’t have titles.
- Label: Text - Set the label text that is shown on top of the marker icon. By default, markers don’t have labels.
- AllowDrag: Boolean - Set the dragging property of the Marker. By default, markers are not draggable.

## OptionalRectangleConfigs

Set additional parameters to customize the rectangle’s behavior and functionality.

- AllowDrag: Boolean = False - Allows users to drag the polygon. By default, polygons are not draggable.
- AllowEdit: Boolean = False - Allows users to edit the polygon. By default, polygons are not editable.
- Stroke: Stroke - Set additional parameters to customize the shape’s stroke.
- Fill: Fill - Set additional parameters to customize the shape’s fill.

## OptionalSearchPlacesConfigs

Set additional parameters to customize search behavior and functionality.

- Countries: Text List - Restricts the search to specific countries. You can define up to 5 countries. Countries must be set to a two-letter, ISO 3166-1 Alpha-2 compatible country code. (Examples: "pt", "br")
- Localization: Localization - Customize your map for a specific country or region.
This setting will not change in runtime.
- SearchArea: SearchArea - Area where to return results (north, south, east, and west). If the bounds are defined, the results returned must be within that area.
- SearchType: SearchTypes Identifier - Type of suggestions that appear. By default, the list of places has all the place types (addresses, cities, establishments, geocodes, and regions).

## OptionalShapeConfigs

Structure to handle optional configurations associated with Shapes.

- AllowDrag: Boolean = False
- AllowEdit: Boolean = False
- Stroke: Stroke
- Fill: Fill

## OptionalStaticMapConfigs

Set additional parameters to customize static map's behavior and functionality.

- Zoom: Zoom Identifier = Entities.Zoom.Auto - Sets the Zoom level to apply on map, between 1 (World) and 20 (Buildings). The following list shows the approximate level of detail you can expect to see at each zoom level:
- Auto: Fit to all markers present on Map
- Zoom1: World
- Zoom5: Continent
- Zoom10: City
- Zoom15: Streets
- Zoom20: Buildings

For more information, visit https://developers.google.com/maps/documentation/javascript/overview#zoom-levels
- Type: Type Identifier = Entities.Type.Roadmap - Set the map type to roadmap, satellite, hybrid or terrain, provided by Google Maps. 

For more information, visit https://developers.google.com/maps/documentation/javascript/maptypes.
- Localization: Localization - Customize your map for a specific country or region.
This setting will not change in runtime.

## Points

List of heatmap data points.

- Lat: Decimal [obrigatorio] - Latitude value of the heatmap point.
- Lng: Decimal [obrigatorio] - Longitude value of the heatmap point.
- Weight: Decimal = 1.0 - The weighting value of the data point. By default, 1.0.

## Private_MarkerClusterer

Allows you to aggregate markers of close proximity into gropus and to simplify the display of markers on the map.

- Active: Boolean = False - Set whether the map markers are clustered. By default, false.
- MaxZoom: Zoom Identifier - The maximum zoom level at which clustering is enabled. By default clustering is to be enabled at all zoom levels ‘Auto’.
- ZoomOnClick: Boolean = True - Set whether to zoom the map when a cluster marker is clicked. By default, true.
- MinClusterSize: Integer = 2 - Set the minimum number of markers needed in a cluster before the markers are hidden and a cluster marker appears. By default, 2.

## ReturnMessage

Returning error message from actions such as SetDirections or RemoveRedirections.

- IsSuccess: Boolean
- Code: Text
- Message: Text

## SearchArea

Area where to return results (north, south, east, and west). If the bounds are defined, the results returned must be within that area.

- North: Text [obrigatorio] - The search area's North bound. Works with addresses and coordinates (latitude and longitude).
Example: "34.56,45.65" or "34.56" or "55 Thomson Pl 2nd floor, Boston, MA 02210, United States"
- South: Text [obrigatorio] - The search area's South bound. Works with addresses and coordinates (latitude and longitude).
Example: "34.56,45.65" or "34.56" or "55 Thomson Pl 2nd floor, Boston, MA 02210, United States"
- West: Text [obrigatorio] - The search area's West bound. Works with addresses and coordinates (latitude and longitude).
Example: "34.56,45.65" or "45.65 or "55 Thomson Pl 2nd floor, Boston, MA 02210, United States"
- East: Text [obrigatorio] - The search area's East bound. Works with addresses and coordinates (latitude and longitude).
Example: "34.56,45.65" or "45.65 or "55 Thomson Pl 2nd floor, Boston, MA 02210, United States"

## StaticMarker

Use the StaticMarker parameter to set a location on the map. By default, the Marker uses the google maps defaults marker but can by displayed custom images and you can change it using the present parameters.

For more information, please visit https://developers.google.com/maps/documentation/javascript/markers

- Location: Text = "42.3517926,-71.0467845" - Defines the marker position on the map. Works with addresses and coordinates (latitude and longitude).

Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”
- IconURL: Text - Set the icon image to be applied to each marker. By default, the Marker uses the Google Maps defaults marker.

Notes:
- Icon images may be in PNG, JPEG or GIF formats, though PNG is recommended.
- Icons may be up to 4096 pixels maximum size (64x64 for square images).
- The icon image URL needs to be absolute.
- Google uses cache on the custom icon images.

For more information, please visit https://developers.google.com/maps/documentation/maps-static/start#CustomIcons
- DEPRECATED_AdvancedFormat: Text - Allow for more options beyond what's provided through the input parameters on the marker.

To be compliant with Content Security Policy (CSP) requirements, the usage of eval() function will be discontinued. Consequently, this parameter will be impacted and may not function as expected.
It's important to note that this change will only affect those who need to ensure compliance with CSP guidelines.

## Stroke

Set additional parameters to customize the shape’s stroke.

- Color: Text = "#000000" - Set the HEX color of the shape stroke. The default color is “#000000” (black).
- Opacity: Decimal = 1 - Set a value (between 0.0 and 1.0) to define the opacity of the shape line. The default opacity is 1.
- Weight: Integer = 2 - Set the weight of the shape stroke in pixels.

