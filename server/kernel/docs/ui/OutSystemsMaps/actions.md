# OutSystemsMaps 2.3.1: actions publicas

## AddMarker (ClientAction)

Add a marker to a given map.

- in MapWidgetId: Text [obrigatorio] - Identifier of the map block, to where the marker should be added.
- in Position: Text [obrigatorio] - Defines the marker position on the map. 

GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”.
Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”.
- in OptionalConfigs: OptionalMarkerConfigs - Set additional parameters to customize the marker’s behavior and functionality.
- out MarkerId: Text - Id of the created Marker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## ContainsLocation (ClientAction)

Checks if a given point is inside a shape (circle, polygon or rectangle) or a coordinates list. 
Please, fill in only one of the two properties: ShapeWidgetId or CoordinatesList. 
In case, the two properties are filled, only the ShapeWidgetId will be considered.

- in MapId: Text [obrigatorio] - Identifier of the map block.
- in PointCoordinates: Coordinates [obrigatorio] - Defines the point latitude and longitude coordinates.
- in ShapeWidgetId: Text - Identifier of the Shape block. Optionally, you can fill the CoordinatesList property. 
In case the two are filled, only the ShapeWidgetId will be considered.
- in CoordinatesList: Coordinates List - List of shape coordinates (latitude + longitude). The last coordinate will be automatically connected with the first one (it's not necessary to repeat it). Optionally, you can fill the ShapeWidgetId property. 
In case the two are filled, only the ShapeWidgetId will be considered.
- out IsInsideShape: Boolean - Returns True if the point is inside the shape. False, otherwise.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Error message from actions from the Map. Contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## GetCircleShape (ClientAction)

Returns a set of properties from the Circle shape based on its WidgetId.

- in CircleWidgetId: Text [obrigatorio] - Identifier of the Circle block.
- out CircleShape: CircleShape - Get information regarding the Circle Shape. For instance, get the radius or the center of the circle.

## GetMapCenter (ClientAction)

Returns the coordinates (latitude and longitude) of the center of a given map.

- in MapId: Text [obrigatorio] - Identifier of the map block.
- out Coordinates: Coordinates - Coordinates (latitude and longitude) of the map’s center.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## GetShapePath (ClientAction)

Returns a Shape path based on the WidgetId of the shape.
Doesn't work for shapes like the Circle.

- in ShapeWidgetId: Text [obrigatorio] - Identifier of the Shape block.
- out CoordinatesList: Coordinates List - Shape path in coordinates

## GetTotalDistanceFromDirection (ClientAction)

Gets the total distance from the directions that are being shown on a given Map Block.

Note: 
To use this functionality, enable the Google Maps’ Directions API. For detailed instructions on how to do it, refer to https://outsystemsui.outsystems.com/OutSystemsMapsSample/.

- in MapId: Text [obrigatorio] - Identifier of the map block.
- out Distance: Integer - Total Distance from Direction (sum in meters of all the distances from all legs)

## GetTotalDurationFromDirection (ClientAction)

Gets the total duration from the directions that are being shown on a given Map Block.

Note: 
To use this functionality, enable the Google Maps’ Directions API. For detailed instructions on how to do it, refer to https://outsystemsui.outsystems.com/OutSystemsMapsSample/.

- in MapId: Text [obrigatorio] - Identifier of the map block.
- out Duration: Integer - Total Duration from Direction (sum in seconds of all the durations from all legs)

## LoadLeafletDirectionsPlugin (ClientAction)

Leaflet Map uses the Leaflet Routing Machine library in order to get directions. Before using the SetDirections, GetTotalDistanceFromDirection or GetTotalDurationFromDirection you will need to load a plugin into the map. The plugin will be responsible for converting your request into queries for the correspondent routing services.

- in MapId: Text [obrigatorio] - Identifier of the map block.
- in Provider: DirectionsProvider Identifier [obrigatorio] - Name of the provider that serves the routing mechanisms.
(Note: OSRM is free/demo service)
- in APIKey: Text - Depending on the provider, some services might require an API Key.
- in PluginURL: Text - For alternative Leaflet routing provider, add the provider URL.

You can add a script containing the Plugin code and then use its Runtime URL here.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Error message from actions from the Map. Contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode, RequireScript

## RemoveAllMarkers (ClientAction)

Removes all markers of a given map.

- in MapWidgetId: Text [obrigatorio] - Identifier of the map block, from where the all markers should be removed.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## RemoveDirections (ClientAction)

Removes the directions shown on a given Map Block.

Note: 
To use this functionality, enable the Google Maps’ Directions API. For detailed instructions on how to do it, refer to https://outsystemsui.outsystems.com/OutSystemsMapsSample/.

- in MapId: Text [obrigatorio] - Identifier of the Map Block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Error message from actions from the Map. Contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## RemoveMarker (ClientAction)

Removes a marker of a given map.

- in MarkerId: Text [obrigatorio] - Identifier of the marker to be removed.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## RemoveMarkerFromCluster (ClientAction)

Removes a map marker with a given position from a cluster.

- in MapId: Text [obrigatorio] - Identifier of the map block.
- in MarkerPosition: Text [obrigatorio] - Defines the location of the marker. Works with addresses.
and coordinates (latitude and longitude).

Example: "34.56.45.65" or "55 Thomson Pl 2nd floor. Boston.
MA 02210. United States"
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.

## SetDirections (ClientAction)

Adds directions from an origin to a destination on a given map. This feature is supported by both Google Maps and Leaflet providers.

To use this functionality, follow the instructions below based on the provider you have chosen:

For Google Maps:
1. Ensure you have a valid API key for Google Maps. If you haven't obtained one yet, please refer to Google's documentation on how to create an API key: Google Maps API Documentation (https://developers.google.com/maps/documentation/javascript/get-api-key).
2. Enable the Google Maps Directions API for your API key. This will allow you to use the "Set Directions" action within the OutSystems Maps component. 
For detailed instructions on how to enable the Directions API, visit Google Maps Directions API Documentation (https://developers.google.com/maps/documentation/directions/).

For Leaflet:
1. No API key is required when using the Leaflet provider. You can directly utilize the "Set Directions" action without any additional configuration.

Please note that using this feature will require an active internet connection as the directions are fetched dynamically from the respective map service.

- in MapId: Text [obrigatorio] - Identifier of the map block.
- in Origin: Text [obrigatorio] - Defines the location of the origin. 

GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”.
Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”.
- in Destination: Text [obrigatorio] - Defines the location of the destination.

GMaps - Works with addresses and coordinates (lat and long). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”.
Leaflet - Works with coordinates (lat and long) only. Example: “34.56,45.65”.
- in TravelMode: TravelMode Identifier [obrigatorio] - Defines the mode of transportation. By default, Driving.
Travel Modes available:
- Driving (directions using the road network)
- Bicycling (directions via bicycle paths & preferred streets)
- Walking (directions via pedestrian paths & sidewalks)
- Transit (directions via public transit routes) (May not work for all Leaflet routing providers)
- in Waypoints: Text List - List of locations on the map that the route must go through.

GMaps - Works with addresses and coordinates (lat and long). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”.
Requests using more than 10 waypoints, or waypoint optimization, may be billed at a higher rate.
Please, be sure to check how your provider bills such requests.

Leaflet - Works with coordinates (lat and long) only. Example: “34.56,45.65”.
- in OptimizeWaypoints: Boolean = False - Set to true to rearrange the waypoints and calculate the optimized route.

Only available for GMaps.
- in AvoidTolls: Boolean = False - Set to true to set a direction avoiding tolls.

(Note: May not work for all Leaflet routing providers)
- in AvoidHighways: Boolean = False - Set to true to set a direction avoiding highways.

(Note: May not work for all Leaflet routing providers)
- in AvoidFerries: Boolean = False - Set to true to set a direction avoiding ferries.

(Note: May not work for all Leaflet routing providers)
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Error message from actions from the Map. Contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## SubscribeMarkerEvent (ClientAction)

This action enables to subscribe to events of a given Marker on a Map. 
Pass the marker id, event to subscribe, and finally the action handler (see X on how to do it).
The list of events that you can listen to include: click, doubleClick, dragEnd and rightClick.

- in MarkerId: Text [obrigatorio] - Id of the Marker to subscribe the event.
- in MarkerEventTriggeredId: MarkerEventTriggered Identifier [obrigatorio] - Define the name of the event to be added to the Marker element.
- in Callback: Object [obrigatorio] - Function or action to be executed when the event occurs.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## UnsubscribeMarkerEvent (ClientAction)

This action enables to unsubscribe to events of a given Marker on a Map. 
Pass the marker id, event to subscribe, and finally the action handler (see X on how to do it).

- in MarkerId: Text [obrigatorio] - Id of the Marker to unsubscribe the event.
- in MarkerEventTriggeredId: MarkerEventTriggered Identifier [obrigatorio] - Define the name of the event to be added to the Marker element.
- in Callback: Object [obrigatorio] - Function or action to be executed when the event occurs.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: GetMapErrorByErrorCode

## GetGoogleMapsServerKey (ServerAction, function)

Returns the Google Maps API key setup for this component.

- out Key: Text - Google Maps Key.

## GetGoogleMapsVersion (ServerAction)

Returns the Google Maps API version, as defined in the site property GoogleMapsVersion.

- out GoogleMapsApiVersion: Text - Google Maps API version as defined in the site.GoogleMapsVersion

