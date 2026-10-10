# SearchPlaces

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **SearchPlaces** | publico | 14 widgets internos

The Search Places block is based on Google’s Places Autocomplete, a Google service that returns place suggestions based on a textual search. 

Search Places instantiates a web-component made available by the provider (Google), having at the moment - v3.61, limited UI customization capabilities. 
You can customize the list of suggestions by type (for example, addresses, cities, and regions), area (north, south, east and west), and countries. 

Note: 
To use this functionality, enable the Google Maps’ Places API (New) - read more in https://developers.google.com/maps/documentation/places/web-service/op-overview.

For detailed instructions on how to do it, refer to https://outsystemsui.outsystems.com/OutSystemsMapsSample/.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| APIKey | Text | nao |  | Enter a Google Maps API key to use the autocomplete feature correctly. If no API Key is provided, the functionality is not available at runtime. There are 2 ways of setting the API key: - In the input parameter API key (in service studio or from a persistent storage) - In the site property GoogleMapsServerKey in module OutSystemsLocations  To use this feature, your API key must have Places API activated in the console. Keep in mind that if you have a block from OutSystemsMaps and a block from OutSystemsLocations, the API key must be the same or else an error will be returned.  You can get an API key for Google Places here: https://developers.google.com/maps/documentation/javascript/get-api-key |
| OptionalConfigs | OptionalSearchPlacesConfigs | nao |  | Set additional parameters to customize search behavior and functionality. |

## Placeholders

Nenhum.

## Eventos

- **OnPlaceSelect**(SearchPlacesId: Text, Name: Text, Coordinates: Coordinates, Address: Text): Event triggered when a place is selected by the user.
- **OnError**(ErrorMessage: Text): Event triggered when an error occurs in window.

## Composicao interna

- Usa os blocos: PlacesCSS
- Scripts exigidos: OutSystemsMaps
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, OnReady, SearchPlacesOnError_Callback, SearchPlacesOnPlaceSelect_Callback, InitializeProviderSearchPlaces, OnInitialize, OnDestroy, SubscribeEvents, ObtainMapAPIVersion_OnAfterFetch, SetApiKey, ObtainMapKey_OnAfterFetch
- Chama actions do modulo: GetGoogleMapsVersion, GetGoogleMapsServerKey, ChangeSearchPlacesCountries, ChangeSearchPlacesSearchType, ChangeSearchPlacesApiKey, LogEvent, ChangeSearchPlacesSearchArea, ChangeSearchPlacesLocalization, GetSearchPlacesErrorByErrorCode, InitSearchPlaces, GenerateUniqueId, CreateSearchPlaces, RemoveSearchPlaces, SearchPlacesEventSubscribe, SetProviderVersion (contratos em [actions.md](../actions.md))

## JavaScript

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.SearchPlacesOnError_Callback = $actions.SearchPlacesOnError_Callback;

$parameters.SearchPlacesOnPlaceSelect_Callback = $actions.SearchPlacesOnPlaceSelect_Callback;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"SearchPlaces1","source":"IMobileBlock:SearchPlaces","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnPlaceSelect` resolve o IEventHandler pelo nome do evento e `$b/OnPlaceSelect/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"SearchPlaces1_OnPlaceSelect","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SearchPlacesId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Name","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Coordinates","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Coordinates"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Address","as":"$p4"}
{"op":"set","target":"$p4","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnPlaceSelect","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnPlaceSelect/SearchPlacesId","prop":"Value","value":"SearchPlacesId"}
{"op":"set","target":"$b/OnPlaceSelect/Name","prop":"Value","value":"Name"}
{"op":"set","target":"$b/OnPlaceSelect/Coordinates","prop":"Value","value":"Coordinates"}
{"op":"set","target":"$b/OnPlaceSelect/Address","prop":"Value","value":"Address"}
```
