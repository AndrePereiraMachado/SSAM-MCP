# Notification

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 14 widgets internos

Use this block to add a notification. By default, it will be displayed on top of the screen. It's ideal to create a native looking notification message.
Drag to the screen, add the notification content, and bind the variable to control the visibility of the message.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartsOpen | Boolean | nao | False | Set the initial state of the Notification. If "True", the notification starts open. Use one of the following actions to change the value afterward: - NotificationOpen - NotificationClose |
| Width | Text | nao | "370px" | Set the Notification width. Accepts any kind of unit (px, %, vw). Default is "370px". In case, the value defined is bigger than the screen size, the notification width will be 100%. |
| Position | Position Identifier | nao | Entities.Position.Top | Set the position where the notification appears on the screen.   The predefined options are: -Bottom -BottomLeft -BottomRight -Center -Left -Right -Top -TopLeft -TopRight  Examples: Entities.Position.Right - The notification is displayed on the right side of the screen. Entities.Position.Bottom - The notification is displayed on the bottom of the screen. |
| OptionalConfigs | NotificationOptionalConfigs | nao |  | Set additional parameters to customize the notification behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your app using CSS. Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI.  You can also use the classes available on the OutSystems UI. For more information, go to the OutSystems UI Cheatsheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Position**: Right, TopRight, BottomLeft, Left, TopLeft, Center, BottomRight, Top, Bottom

## Placeholders

- **Content**: Add content to this placeholder.

## Eventos

- **Initialized**(NotificationId: Text): Event triggered when the Notification instance is ready.
- **OnToggle**(IsOpen: Boolean): Triggered when the Notification is toggled.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: RegisterCallback, OnParametersChanged, InitializedHandler, OnToggleHandler, OnReady, OnInitialize, OnDestroy
- Chama actions do modulo: NotificationRegisterCallback, NotificationChangeTextProperty, NotificationChangeBooleanProperty, NotificationChangeIntegerProperty, LogEvent, NotificationInitialize, NotificationCreate, GenerateUniqueId, NotificationDestroy (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.NotificationAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.NotificationAPI.ChangeProperty`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.NotificationAPI.Initialize`, `OutSystems.OSUI.Patterns.NotificationAPI.Create`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.NotificationAPI.Dispose`

`RegisterCallback` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
$parameters.OnToggle = $actions.OnToggleHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Notification1","source":"IMobileBlock:Notification","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Notification1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"NotificationId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/NotificationId","prop":"Value","value":"NotificationId"}
```
