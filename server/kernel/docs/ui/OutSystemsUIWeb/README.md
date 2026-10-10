# OutSystemsUIWeb 1.12.8 (WebResponsive)

Gerado em 2026-09-04T09:44:31 de `OutSystemsUIWeb.oml` pelo `anvil ui-catalog`. Nao editar a mao: regenerar quando a versao do ambiente mudar.

112 blocos (93 publicos), 18 static entities de configuracao, 29 actions publicas, 0 scripts, 2 temas.

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

## Content (18)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Accordion](blocks/Accordion.md) | sim | Arrange the content by having vertically stacked tabs that expand when clicked. | 2 | Content |  |
| [AccordionItem](blocks/AccordionItem.md) | sim | A single Accordion item should be placed inside the Accordion placeholder. | 3 | Content, Title |  |
| [Alert](blocks/Alert.md) | sim | Alert messages give feedback after different types of actions: Success, Warning, Error or Info. | 3 | Text |  |
| [Balloon](blocks/Balloon.md) | sim | The Balloon offers a more robust alternative to the Tooltip for displaying overlays of content. | 5 | Title, Content, Footer | OnHide, OnShow |
| [BlankSlate](blocks/BlankSlate.md) | sim | A simple box to be presented as an empty state to the user and providing direction. | 2 | Content |  |
| [BulletItem](blocks/BulletItem.md) | sim | Break up blocks of text into tidy chunks so the reader can skim through information, using BulletItems. | 0 | Content |  |
| [Bullets](blocks/Bullets.md) | sim | Make complex data easier to grasp, while highlighting key information. | 1 | BulletsItems |  |
| [Card](blocks/Card.md) | sim | A simple Card with a Content placeholder. | 1 | Content |  |
| [CardBackground](blocks/CardBackground.md) | sim | Card with a background image and placeholder for content with input parameters to configure the style of the card. | 4 | Content, BackgroundImage |  |
| [CardSectioned](blocks/CardSectioned.md) | sim | Card with placeholders for Title, Content and Footer. | 4 | Image, Title, Content, Footer |  |
| [Carousel](blocks/Carousel.md) | sim | A Carousel with responsive behavior that can display multiple images or other items in any device and highly customizable. | 13 | Items |  |
| [ChatMessage](blocks/ChatMessage.md) | sim | Display conversational content such as user photo, text, images, delivery time and status. | 4 | Image, Actions, Name, Content | OnClick |
| [LightBoxImage](blocks/LightBoxImage.md) | sim | Block with only one placeholder for image. | 4 | Thumbnail |  |
| [Modal](blocks/Modal.md) | sim | The Modal is a dialog box/popup window that is displayed on top of the current page. | 5 | Content, Footer, Title, Icon |  |
| [Panel](blocks/Panel.md) | sim | Used to isolate and highlight content with a title, content and optional footer inside a webscreen. | 1 | Content, Footer, Title, Actions |  |
| [Section](blocks/Section.md) | sim | The Section has three placeholders, for the Title, Actions and Content. | 1 | Content, Title, Actions |  |
| [Tag](blocks/Tag.md) | sim | Displays text in a colored and shapped tag layout. | 5 | Content |  |
| [Tooltip](blocks/Tooltip.md) | sim | Dynamic tooltip displaying simple content. | 5 | Widget, Content | OnShow, OnHide |

## Controls (20)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [AnimatedLabel](blocks/AnimatedLabel.md) | sim | Input fields with labels that animate when users focus the input. | 2 | Label, Input |  |
| [ButtonGroup](blocks/ButtonGroup.md) | sim | A row of buttons grouped in a single element. | 1 | Content |  |
| [ButtonGroupItem](blocks/ButtonGroupItem.md) | sim | A row of buttons grouped in a single element. | 1 | Label |  |
| [DatePicker](blocks/DatePicker.md) | sim | Used to select a date or simply check the calendar and allows to be displayed on smartphones instead of reverting to the native picker. | 10 |  | OnSelect, onClose, onOpen |
| [DEPRECATED_DatePicker](blocks/DEPRECATED_DatePicker.md) | sim | Used to select a date or simply check the calendar and allows to be displayed on smartphones instead of reverting to the native picker. | 9 |  | onClose, OnSelect, onOpen |
| [DEPRECATED_RangeSlider](blocks/DEPRECATED_RangeSlider.md) | sim | Select a single value between two range values. | 8 | Label | OnChange |
| [DEPRECATED_RangeSliderInterval](blocks/DEPRECATED_RangeSliderInterval.md) | sim | Select an interval between two range values. | 9 | Label | OnChange |
| [Dropdown](blocks/Dropdown.md) | sim | Button which triggers a dropdown of links. | 1 | Prompt, DropdownList |  |
| [DropdownSelect](blocks/DropdownSelect.md) | sim | Enhanced Combo/ List box usable in forms. | 6 |  |  |
| [FileUpload](blocks/FileUpload.md) | sim | Masks a File upload widget. | 1 | EmptyMessage, UploadWidget |  |
| [FloatingActions](blocks/FloatingActions.md) | sim | Display an action that floats on the bottom right of the screen, providing access to a set of additional actions. | 2 | Items, Button | OnToggle |
| [FloatingActionsItem](blocks/FloatingActionsItem.md) | sim | Used within the FloatingActions Pattern. | 1 | Label, Item |  |
| [InputWithIcon](blocks/InputWithIcon.md) | sim | Customize an input with an Icon. | 2 | Icon, Input |  |
| [RangeSlider](blocks/RangeSlider.md) | sim | Select a single value between two range values. | 11 | Label | OnChange |
| [RangeSliderInterval](blocks/RangeSliderInterval.md) | sim | Select an interval between two range values. | 12 | Label | OnChange |
| [Search](blocks/Search.md) | sim | Simple search form pattern with a search icon. | 1 | Icon, Input, Actions |  |
| [SearchBalloon](blocks/SearchBalloon.md) | sim | Pattern of Search combined with an input Widget and the Balloon Pattern, in which you will be able to make a display of results inside a ballon. | 2 | Icon, Input, Actions, Answers | OnShow, OnHide |
| [TimePicker](blocks/TimePicker.md) | sim | Select a single time. | 4 | Input | OnSelect |
| [ToggleButton](blocks/ToggleButton.md) | sim | A mobile friendly pattern to switch between two states. | 1 | CheckBox |  |
| [Video](blocks/Video.md) | sim | Embed a native video player. | 8 |  |  |

## Email (3)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Email3Rows](blocks/Email3Rows.md) | sim | A layout for emails with 3 rows to provide a simple interface and a light email structure. | 2 | Row1, Row2, Row3 |  |
| [EmailSection](blocks/EmailSection.md) | sim | A section for the email screen that allows to create a custom structure. | 0 | Content |  |
| [LayoutEmail](blocks/LayoutEmail.md) | sim |  | 1 | Logo, Source, Heading, MainContent, Action, Notes, Unsubscribe, Address |  |

## Layouts (9)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [LayoutLogin](blocks/LayoutLogin.md) | sim | A custom page Layout for the login screen. | 2 | Login, BackgroundImage |  |
| [LayoutLoginSplit](blocks/LayoutLoginSplit.md) | sim | A custom page Layout for the login screen that divides the page in 2 columns. | 2 | Login |  |
| [LayoutMenuSide](blocks/LayoutMenuSide.md) | sim | Custom layout with a menu on side. | 3 | Navigation, Header, Content |  |
| [LayoutMenuTop](blocks/LayoutMenuTop.md) | sim | Custom layout with a menu on top. | 3 | Header, Content |  |
| [LayoutPopup](blocks/LayoutPopup.md) | sim | The Layout for the RichWidgets Popup Editor. | 2 | MainContent |  |
| [LayoutSimple](blocks/LayoutSimple.md) | sim | A custom simple Layout with a single placeholder for content. | 3 | Content |  |
| [LayoutWidgets](blocks/LayoutWidgets.md) | sim | The must have widgets in every OutSystems UI layout, it contains essential pieces like feedback messages, device detection, internet explorer compatibility a... | 2 |  |  |
| [LoginForm](blocks/LoginForm.md) | sim | Component used in the Login Layout. | 0 | Login |  |
| [Website_Section](blocks/Website_Section.md) | sim |  | 3 | Content |  |

## Libraries (8)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Choices_v3_0_3](blocks/Choices_v3_0_3.md) | nao | Choices library. | 0 |  |  |
| [DEPRECATED_NoUiSlider_11_0_3](blocks/DEPRECATED_NoUiSlider_11_0_3.md) | nao | NoUiSlider library. | 0 |  |  |
| [JSON5_2_1_0](blocks/JSON5_2_1_0.md) | nao | The JSON5 Data Interchange Format (JSON5) is a superset of JSON that aims to alleviate some of the limitations of JSON by expanding its syntax to include som... | 0 |  |  |
| [Moment_2_29_4](blocks/Moment_2_29_4.md) | nao | Moment library. | 0 |  |  |
| [NoUiSlider_14_1_1](blocks/NoUiSlider_14_1_1.md) | nao | NoUiSlider library. | 0 |  |  |
| [ProgressBarJS_1_0_0](blocks/ProgressBarJS_1_0_0.md) | nao |  | 0 |  |  |
| [Tippy_3_0_6](blocks/Tippy_3_0_6.md) | nao | A highly customizable vanilla JS tooltip & popover library | 0 |  |  |
| [wNumb_1_2_0](blocks/wNumb_1_2_0.md) | nao | JavaScript Number & Money formatting wNumb is a formatting library with a dead-simple interface. | 0 |  |  |

## Navigation (14)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Breadcrumbs](blocks/Breadcrumbs.md) | sim | Present the current user location in applications with a deep page hierarchy. | 1 | Content |  |
| [BreadcrumbsItem](blocks/BreadcrumbsItem.md) | sim | Used in the Content placeholder of the Breadcrumbs Block. | 1 | Title, Icon |  |
| [NavigationBar](blocks/NavigationBar.md) | sim | Navigation pattern with vertically stacked links that can be displayed with different hierarchy levels. | 4 | Content |  |
| [NavigationBarItem](blocks/NavigationBarItem.md) | sim | Used within the NavigationBar Pattern. | 3 | Title, Content |  |
| [NavigationBarSubItem](blocks/NavigationBarSubItem.md) | sim | Used within the NavigationBarItem Pattern. | 1 | Content |  |
| [SectionIndex](blocks/SectionIndex.md) | sim | Use the Section Index to organize a screen's content, enabling quick navigation within a page. | 4 |  |  |
| [Sidebar](blocks/Sidebar.md) | sim | Sidebar for additional content on the side of the screen. | 2 | Header, Content | OnClickOverlay |
| [Tabs](blocks/Tabs.md) | sim | Used to display large sets of information which can be split into different areas, whilst always remaining a click away. | 6 | Tabs_Header, Tabs_Content | OnTabChange |
| [TabsContentItem](blocks/TabsContentItem.md) | sim | Item for placeholder Content in the Tabs Block. | 2 | Content |  |
| [TabsHeaderItem](blocks/TabsHeaderItem.md) | sim | Item for placeholder Header in the Tabs Block. | 2 | Title |  |
| [Timeline](blocks/Timeline.md) | sim | Used to create a sequence of chronologically related events. | 1 | Content |  |
| [TimelineItem](blocks/TimelineItem.md) | sim | Item to create a timeline of event information, with placeholders for icon, title text and dates. | 2 | Icon, Date, Content |  |
| [Wizard](blocks/Wizard.md) | sim | Used to split larger tasks into more manageable steps. | 2 | Content |  |
| [WizardItem](blocks/WizardItem.md) | sim | Step item to add in the Wizard pattern. | 3 | Label, Icon |  |

## Numbers (6)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Badge](blocks/Badge.md) | sim | Display content as notification. | 6 |  |  |
| [Counter](blocks/Counter.md) | sim | Use counters to give feedback about the current count of several elements. | 3 | Content |  |
| [IconBadge](blocks/IconBadge.md) | sim | Icon with a badge on top of it. | 4 | Icon |  |
| [ProgressBar](blocks/ProgressBar.md) | sim | Progress bar with indication of a current action in percentage values. | 6 | Title, Value |  |
| [ProgressCircle](blocks/ProgressCircle.md) | sim | Easy to create circular or semi circular progress indicators. | 7 | Content |  |
| [UserInitials](blocks/UserInitials.md) | sim | Display initials of the user in a nice circular badge. | 6 |  |  |

## Private (11)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [ClosestPolyfill](blocks/ClosestPolyfill.md) | nao | Used to provide closest() compability with the Internet Explorer browsers. | 0 |  |  |
| [CSSVarsPonyfill](blocks/CSSVarsPonyfill.md) | nao | Used to provide compability in the CSS with the Internet Explorer browsers. | 0 |  |  |
| [DeviceDetection](blocks/DeviceDetection.md) | nao | Javascript for Device Detection | 1 |  |  |
| [EventThroughExtensibility](blocks/EventThroughExtensibility.md) | nao | Block used to allow blocks to have events. | 0 |  | EventFromJS |
| [JavaScriptNode](blocks/JavaScriptNode.md) | nao | Used to organize JS code. | 1 | Description |  |
| [LightBox](blocks/LightBox.md) | nao |  | 0 |  |  |
| [ObjectAssignPolyfill](blocks/ObjectAssignPolyfill.md) | nao | JavaScript for polyfill Object.assign (choices library) | 0 |  |  |
| [RTL](blocks/RTL.md) | nao | Script used to add the is-rtl class. | 0 |  |  |
| [ServiceStudioPreview](blocks/ServiceStudioPreview.md) | nao | CSS for the Service Studio Preview. | 0 |  |  |
| [TrapFocusPopupJS](blocks/TrapFocusPopupJS.md) | nao |  | 0 |  |  |
| [WidgetLateLoad](blocks/WidgetLateLoad.md) | nao | Runs the OnNotify action on first screen load. | 0 |  |  |

## Responsive (4)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [DisplayOnDevice](blocks/DisplayOnDevice.md) | sim | Use to select if an element should be loaded in a specific device. | 1 | Content |  |
| [LoadOnVisible](blocks/LoadOnVisible.md) | sim | Use the viewport position to late-load content. | 0 | Content |  |
| [MoveOnDevice](blocks/MoveOnDevice.md) | sim | Define the target container for several elements in different devices without duplicating them, i.e. | 2 | Content |  |
| [ResponsiveTableRecords](blocks/ResponsiveTableRecords.md) | sim | Makes table rows expandable or make table rows horizontally scrollable in phone and tablet portrait. | 1 | Content |  |

## Structure (11)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [AlignCenter](blocks/AlignCenter.md) | sim | Align multiple elements with different heights or widths. | 2 | Content |  |
| [Columns2](blocks/Columns2.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [Columns3](blocks/Columns3.md) | sim | Split content in 3 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2, Column3 |  |
| [Columns4](blocks/Columns4.md) | sim | Split content in 4 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2, Column3, Column4 |  |
| [Columns5](blocks/Columns5.md) | sim | Split content in 5 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2, Column3, Column4, Column5 |  |
| [Columns6](blocks/Columns6.md) | sim | Split content in 6 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2, Column3, Column4, Column5, Column6 |  |
| [ColumnsMediumLeft](blocks/ColumnsMediumLeft.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [ColumnsMediumRight](blocks/ColumnsMediumRight.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [ColumnsSmallLeft](blocks/ColumnsSmallLeft.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [ColumnsSmallRight](blocks/ColumnsSmallRight.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [Gallery](blocks/Gallery.md) | sim | Creates a Gallery list, with full control over the number of items per line. | 4 | ListRecords |  |

## Utilities (8)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Animate](blocks/Animate.md) | sim | Create animations on elements inside the placeholder of this Block. | 5 | Content |  |
| [ButtonLoading](blocks/ButtonLoading.md) | sim | Button with loading state when is clicked. | 3 | Button |  |
| [CharacterCount](blocks/CharacterCount.md) | sim | Displays the characters left in a target input field. | 3 | Content |  |
| [Fieldset](blocks/Fieldset.md) | sim | Group thematically related elements, such as controls and labels. | 2 | Content |  |
| [FlipContent](blocks/FlipContent.md) | sim | A container that builds a flippable widget, has placeholders for front and back elements. | 2 | CardFront, CardBack | OnFlipped |
| [Iframe](blocks/Iframe.md) | sim | Display additional information in one view. | 4 |  |  |
| [Separator](blocks/Separator.md) | sim | Allows to split information with a horizontal or vertical line. | 4 |  |  |
| [StackedIcon](blocks/StackedIcon.md) | sim | Use this pattern to be able to stack two RichWidget Icons on top of each other. | 7 |  |  |

Veja tambem: [config-values.md](config-values.md) (static entities), [actions.md](actions.md) (actions publicas), [themes.md](themes.md) (tokens CSS).
