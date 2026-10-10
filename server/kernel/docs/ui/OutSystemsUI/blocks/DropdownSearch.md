# DropdownSearch

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 8 widgets internos

Enhanced DropdownSearch block, with search functionality.
By default, Dropdowns open as popups in mobile apps (responsive and native).

Drag the block to your screen and set the OptionsList parameter structure with your list. Use the SelectedOptions parameter to set a list with a pre-selected item.

Use: 
- The OnChanged event to assign the current list of selected values to your local variable.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| OptionsList | DropdownOption List | sim |  | List of options to show in dropdown. |
| StartingSelection | DropdownOption List | nao |  | List of options that will appear pre-selected in the DropdownSearch. |
| Prompt | Text | nao | "Select..." | Text to display when there are no items selected and to serve as an empty value. |
| OptionalConfigs | DropdownOptionalConfigs | nao |  | Extra configurations. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

- **OnChanged**(DropdownSearchId: Text, SelectedOptionList: DropdownOption List) [obrigatorio]: Event triggered each time an option is selected.
- **Initialized**(DropdownSearchId: Text): Event triggered after the DropdownSearch instance is ready.

## Composicao interna

- Scripts exigidos: Virtualselect, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, InitializedHandler, OnDestroy, RegisterCallbacks, OnInitialize, OnSelectHandler, OnParametersChanged
- Chama actions do modulo: DropdownInitialize, LogEvent, DropdownDestroy, DropdownRegisterCallback, GenerateUniqueId, DropdownCreate, DropdownChangeTextProperty, DropdownChangeBooleanProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.DropdownAPI.Initialize`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.DropdownAPI.Dispose`, `OutSystems.OSUI.Patterns.DropdownAPI.RegisterCallback`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.DropdownAPI.Create`, `OutSystems.OSUI.Patterns.DropdownAPI.ChangeProperty`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
$parameters.OnSelected = $actions.OnSelectHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DropdownSearch1","source":"IMobileBlock:DropdownSearch","as":"$b"}
{"op":"set","target":"$b/OptionsList","prop":"Value","value":"<DropdownOption List>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnChanged` resolve o IEventHandler pelo nome do evento e `$b/OnChanged/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DropdownSearch1_OnChanged","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"DropdownSearchId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SelectedOptionList","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"DropdownOption List"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnChanged","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnChanged/DropdownSearchId","prop":"Value","value":"DropdownSearchId"}
{"op":"set","target":"$b/OnChanged/SelectedOptionList","prop":"Value","value":"SelectedOptionList"}
```
