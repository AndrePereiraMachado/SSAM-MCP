# Submenu

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 11 widgets internos

Menu item able to hold additional links inside the Submenu Items placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Menu**: Menu item (em `Submenu/content/SubMenuHeader/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Items**: Submenu items (em `Submenu/content`) | nasce com: Link (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(SubmenuId: Text): Event triggered after the Submenu is ready.
- **OnToggle**(SubmenuId: Text, IsOpened: Boolean): Event triggered each time a Submenu opens or closes.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, InitializedHandler, OnDestroy, OnToggleHandler, OnParametersChanged, RegisterCallbacks, OnRender, OnInitialize
- Chama actions do modulo: LogEvent, SubmenuInitialize, SubmenuDestroy, SubmenuChangeTextProperty, SubmenuRegisterCallback, SubmenuOnRender, GenerateUniqueId, SubmenuCreate (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.SubmenuAPI.Initialize`, `OutSystems.OSUI.Patterns.SubmenuAPI.Dispose`, `OutSystems.OSUI.Patterns.SubmenuAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.SubmenuAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.SubmenuAPI.UpdateOnRender`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.SubmenuAPI.Create`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnInitialize = $actions.InitializedHandler;
$parameters.OnToggle = $actions.OnToggleHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Submenu1","source":"IMobileBlock:Submenu","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Submenu1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SubmenuId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/SubmenuId","prop":"Value","value":"SubmenuId"}
```
