# ProgressBar

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 4 widgets internos

You can use the ProgressBar to display the current progress in a bar.
When the update frequency is high (e.g., 2 or more updates per second), the default animation speed may appear sluggish. To address this, adjust the animation speed by modifying the following CSS variables: --progress-initial-speed and --progress-speed.

To override the default animation settings, use the following CSS:

.override-speed .osui-progress-bar {
    --progress-speed: 0.1s;         /* default: 0.35s */
    --progress-initial-speed: 0.2s; /* default: 0.5s  */
}

This customization ensures that the ProgressBar remains smooth and responsive, even at high update rates.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Progress | Integer | sim |  | Progress percentage. Usually a number (integer) between 0 and 100. You can also use functions and local variables. |
| ProgressColor | Color Identifier | nao | Entities.Color.Primary | The color that fills the bar, as progress goes up. By default, the progress color is the primary color you chose when creating the app.  To use an RGB color, use: TextToIdentifier(“rgb(0,0,0)“) To use an HEX color, use: TextToIdentifier(“#000000”) |
| TrailColor | Color Identifier | nao | Entities.Color.Neutral4 | The color of the empty part of the bar. By default,  the trail color is Neutral 4 (#DEE2E6).   To use an RGB color, use: TextToIdentifier(“rgb(0,0,0)“) To use an HEX color, use: TextToIdentifier(“#000000”) |
| Thickness | Integer | nao | 12 | Sets the height of the ProgressBar, in pixels. By default, the thickness is "12". |
| OptionalConfigs | ProgressBarOptionalConfigs | nao |  | Sets additional parameters to customize the ProgressBar behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS. Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Color**: Pink, Blue, Neutral0, Neutral4, Violet, Neutral2, Neutral5, Green, Indigo, Neutral3, Grape, Lime, Neutral8, Neutral9, Secondary, Primary, Neutral7, Neutral6, Yellow, Cyan, Orange, Neutral10, Neutral1, Red, Teal, Transparent

## Placeholders

- **Content** (em `ProgressBar/content/ProgressContainer/content`)

## Eventos

- **Initialized**(ProgressBarId: Text): Event triggered after the ProgressBar instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, OnInitialize, OnDestroy, OnReady, RegisterCallbacks, InitializedHandler
- Chama actions do modulo: ProgressChangeTextProperty, ProgressChangeIntegerProperty, GenerateUniqueId, ProgressBarCreate, LogEvent, ProgressDestroy, ProgressInitialize, ProgressRegisterCallback (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.ProgressAPI.ChangeProperty`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.ProgressAPI.Create`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.ProgressAPI.Dispose`, `OutSystems.OSUI.Patterns.ProgressAPI.Initialize`, `OutSystems.OSUI.Patterns.ProgressAPI.RegisterCallback`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ProgressBar1","source":"IMobileBlock:ProgressBar","as":"$b"}
{"op":"set","target":"$b/Progress","prop":"Value","value":"<Integer>"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"ProgressBar1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ProgressBarId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/ProgressBarId","prop":"Value","value":"ProgressBarId"}
```
