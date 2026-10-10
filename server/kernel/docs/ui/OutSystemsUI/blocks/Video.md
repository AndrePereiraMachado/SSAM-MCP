# Video

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 1 widgets internos

Drag the pattern to the screen to add video content without the need for a third-party plug-in.
Note: The URL must be a direct video file, not a website like Vimeo or YouTube since those servers provide their own embed code.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| URL | Text | sim |  | Set the URL of the video file, preferably mp4 or webm format. |
| Controls | Boolean | nao | True | Set to True to sow the video controls. Set False to disable the video controls. In case of mobile, the controls will always be enable. By default, the controls are shown (True).  Default: True |
| Width | Text | nao |  | Set the width (in pixel or percentage) of the video. By default, the original video width is detected. |
| Height | Text | nao |  | Set the height (in pixel or percentage) of the video. By default, the original video height is detected. |
| Captions | VideoCaptions List | nao |  | List of the caption tracks (language, source file and label) that will be available for the video. By default, the video has no captions. |
| OptionalConfigs | VideoOptionalConfigs | nao |  | Set additional parameters to customize the Video behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  Blank - No custom styles are added (default value).  "myclass" - Adds the myclass style to the UI styles being applied.  "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

- **StateChanged**(VideoId: Text, VideoState: VideoState Identifier): Returns the reproduction state of the video. The different states of the video are: 
- Unstarted: if the video did not start being played.
- Playing: if the video is being played.
- Paused: if the video is currently paused.
- Ended: if the video is ended.
- **Initialized**(VideoId: Text): Event triggered after the Video instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: RegisterCallback, OnDestroy, OnInitialize, OnParametersChanged, OnReady, InitializedHandler, StateChangedHandler
- Chama actions do modulo: VideoRegisterCallback, VideoDestroy, LogEvent, GenerateUniqueId, VideoCreate, VideoChangeTextProperty, VideoChangeBooleanProperty, VideoInitialize (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.VideoAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.VideoAPI.Dispose`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.VideoAPI.Create`, `OutSystems.OSUI.Patterns.VideoAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.VideoAPI.Initialize`

`RegisterCallback` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
$parameters.OnStateChanged = $actions.StateChangedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Video1","source":"IMobileBlock:Video","as":"$b"}
{"op":"set","target":"$b/URL","prop":"Value","value":"<Text>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/StateChanged` resolve o IEventHandler pelo nome do evento e `$b/StateChanged/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Video1_StateChanged","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"VideoId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"VideoState","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"VideoState Identifier"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/StateChanged","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/StateChanged/VideoId","prop":"Value","value":"VideoId"}
{"op":"set","target":"$b/StateChanged/VideoState","prop":"Value","value":"VideoState"}
```
