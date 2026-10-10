# Carousel

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 23 widgets internos

Displays multiple items in a horizontal slide. Ideal for creating horizontal slides in smaller screens. For dynamic content, place a List directly inside the placeholder. Elements inside the placeholder represent different items.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Navigation | CarouselNavigation Identifier | nao | Entities.CarouselNavigation.Both | Set the type of navigation of the carousel. Available options:  - Arrows: show arrows on the sides - Dots: show dots under the carousel slides - Both: show arrows and dots on the carousel - None: no navigation controls are shown |
| Height | Text | nao | "auto" | Set a custom height for the carousel. The parameter accepts any CSS format, except percentage (library constraint). By default, 'auto'. |
| ItemsPerSlide | CarouselItems | nao |  | Set the number of items shown per slide according to the device.   - Desktop: Set the number of items that are shown simultaneously in desktop. By default, 1 item in all devices. - Tablet: Set the number of items that are shown simultaneously in tablet. By default, 1 item in all devices. - Phone: Set the number of items that are shown simultaneously in phone. By default, 1 item in all devices. |
| OptionalConfigs | CarouselOptionalConfigs | nao |  | Set additional parameters to customize Carousel behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.CarouselNavigation**: None, Both, Arrows, Dots

## Placeholders

- **CarouselItems** (em `content/content/Togglepreview`) | nasce com: List (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnSlideMoved**(CarouselId: Text, ItemIndex: Integer): Event triggered after the Carousel slides move.
- **Initialized**(CarouselId: Text): Event triggered after the Carousel is initialized.

## Composicao interna

- Scripts exigidos: Splide, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnRender, OnSlideMovedHandler, OnReady, OnInitialize, RegisterCallbacks, InitializeHandler, OnParametersChanged
- Chama actions do modulo: CarouselDestroy, CarouselUpdateOnRender, CarouselInitialize, LogEvent, GenerateUniqueId, CarouselCreate, CarouselRegisterCallback, CarouselChangeIntegerProp, CarouselChangeBooleanProperty, CarouselChangeTextProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.CarouselAPI.Dispose`, `OutSystems.OSUI.Patterns.CarouselAPI.UpdateOnRender`, `OutSystems.OSUI.Patterns.CarouselAPI.Initialize`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.CarouselAPI.Create`, `OutSystems.OSUI.Patterns.CarouselAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.CarouselAPI.ChangeProperty`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnSlideMovedObj = $actions.OnSlideMovedHandler;

$parameters.OnCarouselInitializedObj = $actions.InitializeHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Carousel1","source":"IMobileBlock:Carousel","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnSlideMoved` resolve o IEventHandler pelo nome do evento e `$b/OnSlideMoved/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Carousel1_OnSlideMoved","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"CarouselId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ItemIndex","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnSlideMoved","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnSlideMoved/CarouselId","prop":"Value","value":"CarouselId"}
{"op":"set","target":"$b/OnSlideMoved/ItemIndex","prop":"Value","value":"ItemIndex"}
```
