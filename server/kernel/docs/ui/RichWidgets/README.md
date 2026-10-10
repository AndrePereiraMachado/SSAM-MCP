# RichWidgets  (WebResponsive)

Gerado em 2026-09-04T09:44:34 de `RichWidgets.oml` pelo `anvil ui-catalog`. Nao editar a mao: regenerar quando a versao do ambiente mudar.

55 blocos (41 publicos), 6 static entities de configuracao, 32 actions publicas, 0 scripts, 23 temas.

## Como instanciar um bloco com os verbos

O modulo alvo precisa referenciar a biblioteca (`references`). Um bloco entra na tela como block instance:

```json
{"op":"create","parent":"IWebFlow:MainFlow","type":"IWebScreen","name":"Minha","as":"$scr"}   // nasce com o layout do tema e placeholders Title/MainContent/...
{"op":"create","parent":"$scr/#IWebBlockInstanceWidget/MainContent","type":"IWebBlockInstanceWidget","name":"Card1","source":"IWebBlock:Card","empty":true,"as":"$card"}
// source = SourceBlock na criacao; empty = apaga o conteudo de exemplo dos placeholders
{"op":"set","target":"$card/ExtendedClass","prop":"Value","value":"\"padding-m\""}   // input -> IArgument.Value (expressao)
{"op":"create","parent":"$card/Content","type":"IExpressionWidget","as":"$e"}   // placeholder por nome; widgets Web usam o sufixo Widget
{"op":"set","target":"$e","prop":"Value","value":"\"Ola\""}
```

Widgets nativos do Traditional: IContainerWidget, IExpressionWidget, IInputWidget, IButtonWidget, ILinkWidget, ITableRecordsWidget, IListRecordsWidget, IIfWidget, IEditRecordWidget, IComboBoxWidget, ICheckBoxWidget (namespace OutSystems.Model.UI.Web.Widgets). Leia a pagina do bloco antes de usar: placeholders esperam filhos especificos.

## jQueryUI (6)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Deprecated_jQueryCurvycorners](blocks/Deprecated_jQueryCurvycorners.md) | nao |  | 0 |  |  |
| [jQueryComponents](blocks/jQueryComponents.md) | nao |  | 0 |  |  |
| [jQueryCookie](blocks/jQueryCookie.md) | nao |  | 0 |  |  |
| [jQueryUICompatibility](blocks/jQueryUICompatibility.md) | nao |  | 0 |  |  |
| [jQueryUIInternal](blocks/jQueryUIInternal.md) | nao |  | 0 |  |  |
| [jQueryUILoader](blocks/jQueryUILoader.md) | nao |  | 0 |  |  |

## Layouts (2)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Layout_Chicago](blocks/Layout_Chicago.md) | sim |  | 0 | Header, Menu, Title, Actions, MainContent, Footer |  |
| [Layout_London](blocks/Layout_London.md) | sim |  | 0 | Header, Menu, MainContent, Title, Actions, Footer |  |

## LayoutsOther (2)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Layout_Email](blocks/Layout_Email.md) | sim |  | 0 | Title, MainContent |  |
| [Layout_Popup](blocks/Layout_Popup.md) | sim |  | 0 | MainContent |  |

## LayoutsSmartphone (3)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [LayoutSmartphone_Chicago](blocks/LayoutSmartphone_Chicago.md) | sim | Default layout for Chicago Smartphone | 0 | Title, MainContent, Footer, Menu, Header |  |
| [LayoutSmartphone_Detroit](blocks/LayoutSmartphone_Detroit.md) | sim |  | 0 | MainContent, Footer, Menu, Title |  |
| [LayoutSmartphone_London](blocks/LayoutSmartphone_London.md) | sim | Layout for London Smartphone | 0 | Footer, Menu, Header, Title, MainContent |  |

## Private (6)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [AllowAddToIOSHome](blocks/AllowAddToIOSHome.md) | nao |  | 0 |  |  |
| [jQueryUI](blocks/jQueryUI.md) | nao | This block is to maintain compatibility with eSpaces compiled before 8.0 (only includes jQueryUICompatibility.css). | 0 |  |  |
| [LoadingMessage](blocks/LoadingMessage.md) | nao |  | 0 |  |  |
| [NotifyWidget](blocks/NotifyWidget.md) | nao |  | 1 |  |  |
| [RichWidgetsjQueryUI](blocks/RichWidgetsjQueryUI.md) | nao | This block contains the jQueryUI that is used by some wigets in the RichWidgets | 0 |  |  |
| [Widget_Tooltip](blocks/Widget_Tooltip.md) | nao | Shows a tooltip when hovering a widget. | 2 |  |  |

## RichWidgets (36)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [ApplicationSwitcher](blocks/ApplicationSwitcher.md) | sim | Shows a dropdown with a list of links to all applications that the currently logged user has access to (i.e. | 1 |  |  |
| [Container_ExpandCollapse](blocks/Container_ExpandCollapse.md) | sim | Expands and collapses the specified container. | 1 |  |  |
| [Deprecated_Cell_MergeRight](blocks/Deprecated_Cell_MergeRight.md) | sim | DEPRECATED: Use the cell merge in Service Studio instead. | 0 |  |  |
| [Deprecated_Container_Round](blocks/Deprecated_Container_Round.md) | sim | DEPRECATED: Design a container with rounded corners using JQuery Curvy Corners by Mike Jolley. | 2 |  |  |
| [Deprecated_Input_SetPrompt](blocks/Deprecated_Input_SetPrompt.md) | sim | DEPRECATED: Use the Prompt property of the Input widget instead. | 2 |  |  |
| [Deprecated_LastModified](blocks/Deprecated_LastModified.md) | sim | DEPRECATED: Consider creating a similar webblock in a different eSpace. | 2 |  |  |
| [Deprecated_Menu_HighlightActive](blocks/Deprecated_Menu_HighlightActive.md) | sim | DEPRECATED: Use the Menu_GetStyle action instead. | 1 |  |  |
| [Deprecated_RecentItems](blocks/Deprecated_RecentItems.md) | sim | DEPRECATED: Consider creating a similar webblock in a different eSpace. | 1 |  |  |
| [DropDownMenu](blocks/DropDownMenu.md) | sim | When clicked, shows a dropdown menu with all the submenu items. | 1 | MenuItem, MenuSubItems |  |
| [FakeNotifyWidget](blocks/FakeNotifyWidget.md) | sim | Use this widget to call a screen action from JavaScript: 1. | 0 |  |  |
| [Feedback_AjaxWait](blocks/Feedback_AjaxWait.md) | sim | Shows a message if Ajax calls take too much time to show. | 0 |  |  |
| [Feedback_Message](blocks/Feedback_Message.md) | sim | Displays a feedback box based on the last call to the Feedback_SetMessage() action. | 0 |  |  |
| [Help_Contextual](blocks/Help_Contextual.md) | sim | Displays a ? icon that when hovered show the help message for a part of the screen. | 1 |  |  |
| [Help_Screen](blocks/Help_Screen.md) | sim | Displays a "Need Help" label and a ? icon that when hovered show the help message for a screen. | 1 |  |  |
| [Icon](blocks/Icon.md) | sim | Please refer to http://fontawesome.io/icons/ for complete list of icons | 2 |  |  |
| [Input_AutoComplete](blocks/Input_AutoComplete.md) | sim | Shows a list of options in a dropdown that match what the user types on an input widget. | 4 |  |  |
| [Input_Calendar](blocks/Input_Calendar.md) | sim | Shows a calendar when clicking the selected Input widget. | 19 |  |  |
| [Input_SetFocus](blocks/Input_SetFocus.md) | sim | Sets the focus on the specified Input or Input Password widget when the screen loads. | 1 |  |  |
| [List_BulkSelect](blocks/List_BulkSelect.md) | sim | Checkbox to drag into a column header of the Table Records widget to allow bulk selection (select all / select none) of the rows. | 3 |  |  |
| [List_Counter](blocks/List_Counter.md) | sim | Shows a counter of a TableRecords widget (e.g. | 3 |  |  |
| [List_LateLoad](blocks/List_LateLoad.md) | sim | Runs the OnNotify action on first screen load. | 0 |  |  |
| [List_Move](blocks/List_Move.md) | sim | Use this widget with TableRecords widgets to have arrows in rows to move them up and down. | 4 |  |  |
| [List_Navigation](blocks/List_Navigation.md) | sim | Use this widget with a TableRecords or ListRecords widget for pagination: - Shows Next (page) and Previous (page) links  - Shows page numbers Create a screen... | 4 |  |  |
| [List_SortColumn](blocks/List_SortColumn.md) | sim | Use this widget with a column of a TableRecords widget to sort by that column (ascending and descending). | 1 |  |  |
| [MenuSlider](blocks/MenuSlider.md) | sim | Toggler that appears on mobile devices (smartphones and tables in portrait) that hides the menu and slides it in when clicked. | 0 |  |  |
| [MobileAddToIPhoneHomeBubble](blocks/MobileAddToIPhoneHomeBubble.md) | sim | Bubble to ask user to add the application to the Home screen to work as an iPhone native app. | 1 |  |  |
| [MobileScripts](blocks/MobileScripts.md) | sim | Set of scripts to add functionality to mobile devices: - Orientation change CSS landscape/portrait - Slide animations. | 0 |  |  |
| [Popup_Editor](blocks/Popup_Editor.md) | sim | [DEPRECATED] Opens the specified link on a modal pop-up that can have editable screens. | 7 |  |  |
| [Popup_Editor_Legacy](blocks/Popup_Editor_Legacy.md) | nao | Opens the specified link on a modal pop-up that can have editable screens. | 7 |  |  |
| [Popup_Editor_WithToken](blocks/Popup_Editor_WithToken.md) | nao | Opens the specified link on a modal pop-up that can have editable screens. | 7 |  |  |
| [Popup_EditorForUpload](blocks/Popup_EditorForUpload.md) | sim | Opens the specified link on a modal pop-up that can have editable screens. | 7 |  |  |
| [Popup_EditorVanilla](blocks/Popup_EditorVanilla.md) | sim | Opens the specified link on a modal pop-up that can have editable screens. | 7 |  |  |
| [Popup_InfoBalloon](blocks/Popup_InfoBalloon.md) | sim | Displays the selected link on a pop-up balloon when hovering the link. | 3 |  |  |
| [RemovePopups](blocks/RemovePopups.md) | sim | Prevents the page from appearing inside a popup. | 0 |  |  |
| [ResponsiveTableRecords](blocks/ResponsiveTableRecords.md) | sim | Makes tables stack cells on top of each other in mobile. | 0 |  |  |
| [Tabs_ClientSide](blocks/Tabs_ClientSide.md) | sim | Allows the selective display of content using a tab interface. | 6 |  |  |

Veja tambem: [config-values.md](config-values.md) (static entities), [actions.md](actions.md) (actions publicas), [themes.md](themes.md) (tokens CSS).
