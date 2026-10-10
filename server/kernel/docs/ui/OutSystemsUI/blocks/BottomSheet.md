# BottomSheet

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 10 widgets internos

Use this block to add a container that slides up from the bottom of the screen to reveal more content. This pattern is primarily used in Mobile apps. 
Note: The Bottom Sheet pattern was exclusively designed to be used on mobile since it’s primarily used there. Its usage in web apps is not supported.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Shape | Shape Identifier | nao | Entities.Shape.SoftRounded | Set the BottomSheet shape. The predefined options are: - SoftRounded - Rounded - Sharp  Examples: Entities.Shape.Rounded - the inherit style will be rounded.  By default, 16px (Entities.Shape.SoftRounded). |
| ShowHandler | Boolean | nao | True | Set to True to show a handler on top of the BottomSheet. Set to False, otherwise. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Shape**: SoftRounded, Sharp, Rounded

## Placeholders

- **Content** (em `TogglePreview/BottomSheet/content`)
- **TopBar** (em `TogglePreview/BottomSheet/content/Header/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(BottomSheetId: Text): Event triggered after the BottomSheet instance is ready.
- **OnToggle**(BottomSheetId: Text, IsOpen: Boolean): Event triggered when the BottomSheet is opened or closed.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnReady, OnParametersChanged, OnToggleHandler, RegisterCallback, InitializedHandler, OnDestroy
- Chama actions do modulo: BottomSheetCreate, GenerateUniqueId, BottomSheetInitialize, BottomSheetChangeTextProperty, BottomSheetChangeBooleanProperty, BottomSheetRegisterCallback, BottomSheetDestroy (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.BottomSheetAPI.Create`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.BottomSheetAPI.Initialize`, `OutSystems.OSUI.Patterns.BottomSheetAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.BottomSheetAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.BottomSheetAPI.Dispose`

`RegisterCallback` / no `GetCallbackHandler`:

```js
$parameters.OnInitializedHandler = $actions.InitializedHandler;
$parameters.OnToggleHandler = $actions.OnToggleHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"BottomSheet1","source":"IMobileBlock:BottomSheet","empty":true,"as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"BottomSheet1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"BottomSheetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/BottomSheetId","prop":"Value","value":"BottomSheetId"}
```
