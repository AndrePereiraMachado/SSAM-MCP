# DropdownTags

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 10 widgets internos

Enhanced Dropdown block, with search functionality and multiple tags selection.
By default, Dropdowns open as popups in mobile apps (responsive and native).

Drag the block to your screen and set the OptionsList parameter structure with your list. Use the SelectedOptions parameter to set a list with a pre-selected item.

Use: 
- The OnChanged event to assign the current list of selected values to your local variable.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| OptionsList | DropdownOption List | sim |  | List of options to show in dropdown. |
| StartingSelection | DropdownOption List | nao |  | List of options that will appear pre-selected in the DropdownTags. |
| Prompt | Text | nao | "Select..." | Text to display when there are no items selected and to serve as an empty value. |
| OptionalConfigs | DropdownTagsOptionalConfigs | nao |  | Extra configurations. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

- **Initialized**(DropdownTagsId: Text): Event triggered after the DropdownTags instance is ready.
- **OnChanged**(DropdownTagsId: Text, SelectedOptionList: DropdownOption List) [obrigatorio]: Event triggered each time an option is selected.

## Composicao interna

- Scripts exigidos: Virtualselect, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnParametersChanged, InitializedHandler, OnReady, RegisterCallbacks, OnSelectHandler, OnInitialize
- Chama actions do modulo: DropdownDestroy, DropdownChangeTextProperty, DropdownChangeBooleanProperty, LogEvent, DropdownInitialize, DropdownRegisterCallback, GenerateUniqueId, DropdownCreate (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.DropdownAPI.Dispose`, `OutSystems.OSUI.Patterns.DropdownAPI.ChangeProperty`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.DropdownAPI.Initialize`, `OutSystems.OSUI.Patterns.DropdownAPI.RegisterCallback`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.DropdownAPI.Create`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
$parameters.OnSelected = $actions.OnSelectHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DropdownTags1","source":"IMobileBlock:DropdownTags","as":"$b"}
{"op":"set","target":"$b/OptionsList","prop":"Value","value":"<DropdownOption List>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DropdownTags1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"DropdownTagsId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/DropdownTagsId","prop":"Value","value":"DropdownTagsId"}
```
