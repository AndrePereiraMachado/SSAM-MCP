# DropdownServerSide

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Advanced** | publico | 37 widgets internos

Dropdown block that allows you to manage large datasets in a more flexible and efficient way. The block has less out-of-the-box logic and is targeted for more advanced use cases.

Examples:
- Pagination / infinite scroll
- Search based on queries
- Custom dropdown balloon (with footer, buttons, title, etc.)

Check more about it in: https://success.outsystems.com/Documentation/11/Developing_an_Application/Design_UI/Patterns/Using_Mobile_and_Reactive_Patterns/Interaction/Dropdown_Server_Side

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| AllowMultipleSelection | Boolean | nao |  | Set to True to allow users to select more than one option. By default, False (the dropdown only allows one option to be selected). If AllowMultipleSelection is False, the dropdown will close automatically after the user picks an option. Otherwise (if AllowMultipleSelection is True), it will remain open. |
| IsDisabled | Boolean | nao | False | Set as True to disable the Dropdown. By default, False (the dropdown is active). |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **BalloonContent**: Add a List of DropdownServerSideItem(s) in order to add options into the Dropdown. (em `Dropdown/content/HideInPreview/Balloon/content/content`) | nasce com: List:ListOf_DropdownServerSideItems, If:IsEmpty (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **BalloonFooter**: Add the footer elements here. If empty, this placeholder will be hidden. (em `Dropdown/content/HideInPreview/Balloon/content/content`)
- **BalloonSearchInput**: Add an input text. If empty this placeholder will be hidden. (em `Dropdown/content/HideInPreview/Balloon/content/content/BalloonSearchWrapper/content`) | nasce com: Label, Input:SearchInput. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/BalloonSearchInput/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)
- **BalloonSearchInputIcon**: Add an icon. If empty, this placeholder will be hidden. (em `Dropdown/content/HideInPreview/Balloon/content/content/BalloonSearchWrapper/content`) | nasce com: Link:ClearSearchLink (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **SelectedValues**: Add an Expression to show the selected option(s) value. (em `Dropdown/content/SelectedValuesWrapper/content`) | nasce com: If:HasSelectedValues (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnToggle**(DropdownServerSideId: Text, IsOpen: Boolean): Event triggered each time the DropdownServerSide opens or closes.
- **Initialized**(DropdownServerSideId: Text): Event triggered after the DropdownServerSide instance is ready.

## Composicao interna

- Usa os blocos: DropdownServerSideItem
- Scripts exigidos: OutSystemsUI, FloatingUIDom
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnToggleHandler, OnDestroy, OnInitialize, OnReady, RegisterCallbacks, OnParametersChanged, InitializedHandler
- Chama actions do modulo: DropdownDestroy, LogEvent, DropdownCreate, GenerateUniqueId, DropdownInitialize, DropdownRegisterCallback, DropdownChangeTextProperty, DropdownChangeBooleanProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.DropdownAPI.Dispose`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.DropdownAPI.Create`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.DropdownAPI.Initialize`, `OutSystems.OSUI.Patterns.DropdownAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.DropdownAPI.ChangeProperty`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
$parameters.OnToggle = $actions.OnToggleHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DropdownServerSide1","source":"IMobileBlock:DropdownServerSide","empty":true,"as":"$b"}
{"op":"create","parent":"$b/BalloonFooter","type":"IExpression","as":"$eBalloonFooter"}
{"op":"set","target":"$b/BalloonSearchInput/#IInput","prop":"Variable","value":"<variavel local>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnToggle` resolve o IEventHandler pelo nome do evento e `$b/OnToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DropdownServerSide1_OnToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"DropdownServerSideId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsOpen","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnToggle","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnToggle/DropdownServerSideId","prop":"Value","value":"DropdownServerSideId"}
{"op":"set","target":"$b/OnToggle/IsOpen","prop":"Value","value":"IsOpen"}
```
