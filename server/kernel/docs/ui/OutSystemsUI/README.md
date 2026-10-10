# OutSystemsUI 2.28.1 (ReactiveLibrary)

Gerado em 2026-09-04T09:44:29 de `OutSystemsUI.oml` pelo `anvil ui-catalog`. Nao editar a mao: regenerar quando a versao do ambiente mudar.

141 blocos (141 publicos), 45 static entities de configuracao, 186 actions publicas, 29 scripts, 4 temas.

## Como instanciar um bloco com os verbos

O modulo alvo precisa referenciar a biblioteca (`references`). Um bloco entra na tela como block instance:

```json
{"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IMobileBlockInstanceWidget","name":"Accordion1","source":"IMobileBlock:Accordion","empty":true,"as":"$acc"}
// source = SourceBlock na criacao; empty = apaga o conteudo de exemplo dos placeholders (nasce ao definir o SourceBlock)
{"op":"set","target":"$acc/MultipleItems","prop":"Value","value":"True"}          // input -> IArgument.Value
{"op":"create","parent":"$acc/Content","type":"IContainer","name":"Inner"}      // placeholder por nome
```

Widgets nativos do Reactive/Mobile: IContainer, IExpression, IInput, IButton, ILink, IList, IListItem, ITableRecords, IDropdown, ICheckbox, ISwitch, IIcon, IImage, IForm (plugin NRWidgets). Leia a pagina do bloco antes de usar: placeholders esperam filhos especificos e eventos obrigatorios precisam de handler (secao 'Como ligar um evento' da pagina).

## Adaptive (22)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Columns2](blocks/Columns2.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [Columns3](blocks/Columns3.md) | sim | Split content in 3 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2, Column3 |  |
| [Columns4](blocks/Columns4.md) | sim | Split content in 4 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2, Column3, Column4 |  |
| [Columns5](blocks/Columns5.md) | sim | Split content in 5 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2, Column3, Column4, Column5 |  |
| [Columns6](blocks/Columns6.md) | sim | Split content in 6 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2, Column3, Column4, Column5, Column6 |  |
| [ColumnsMediumLeft](blocks/ColumnsMediumLeft.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [ColumnsMediumRight](blocks/ColumnsMediumRight.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [ColumnsSmallLeft](blocks/ColumnsSmallLeft.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [ColumnsSmallRight](blocks/ColumnsSmallRight.md) | sim | Split content in 2 columns with responsive capabilities to improve the way information is displayed. | 4 | Column1, Column2 |  |
| [DEPRECATED_Columns2](blocks/DEPRECATED_Columns2.md) | sim | Split content in multiple columns. | 5 | Column1, Column2 |  |
| [DEPRECATED_Columns3](blocks/DEPRECATED_Columns3.md) | sim | Split content in multiple columns. | 5 | Column1, Column2, Column3 |  |
| [DEPRECATED_Columns4](blocks/DEPRECATED_Columns4.md) | sim | Split content in multiple columns. | 5 | Column1, Column2, Column3, Column4 |  |
| [DEPRECATED_Columns5](blocks/DEPRECATED_Columns5.md) | sim | Split content in multiple columns. | 5 | Column1, Column2, Column3, Column4, Column5 |  |
| [DEPRECATED_Columns6](blocks/DEPRECATED_Columns6.md) | sim | Split content in multiple columns. | 5 | Column1, Column2, Column3, Column4, Column5, Column6 |  |
| [DEPRECATED_ColumnsSmallLeft](blocks/DEPRECATED_ColumnsSmallLeft.md) | sim | Split content in multiple columns. | 5 | Column1, Column2 |  |
| [DEPRECATED_ColumnsSmallRight](blocks/DEPRECATED_ColumnsSmallRight.md) | sim | Split content in multiple columns. | 5 | Column1, Column2 |  |
| [DEPRECATED_Gallery](blocks/DEPRECATED_Gallery.md) | sim | Display content in gallery style with different columns per device type/orientation | 5 | Content |  |
| [DEPRECATED_GalleryV2](blocks/DEPRECATED_GalleryV2.md) | sim | Display content in gallery style with different columns per device type/orientation | 4 | Content |  |
| [DEPRECATED_MasterDetail](blocks/DEPRECATED_MasterDetail.md) | sim | Similar to the Split Screen, but receives an item list for the left panel. | 1 | Content | DetailClose, ItemSelected |
| [DisplayOnDevice](blocks/DisplayOnDevice.md) | sim | Display content depending on which device is being used. | 0 | OnDesktop, OnTablet, OnPhone |  |
| [Gallery](blocks/Gallery.md) | sim | Display content in gallery style with different columns per device type/orientation | 5 | Content | Initialized |
| [MasterDetail](blocks/MasterDetail.md) | sim | Displays a list of items and their related details, for example, a list of employees and their corresponding details. | 3 | LeftContent, RightContent | DetailClose |

## Advanced (2)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [DropdownServerSide](blocks/DropdownServerSide.md) | sim | Dropdown block that allows you to manage large datasets in a more flexible and efficient way. | 3 | BalloonContent, BalloonFooter, BalloonSearchInput, BalloonSearchInputIcon, SelectedValues | OnToggle, Initialized |
| [DropdownServerSideItem](blocks/DropdownServerSideItem.md) | sim | DropdownOptionItem block, this block should be use as a DropdownServerAction option item. | 3 | DropdownItemContent | OnSelected, Initialized |

## AppFeedback (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [AppFeedbackHelp](blocks/AppFeedbackHelp.md) | sim | Displays information if the App Feedback is enabled in the application. | 0 | Title, Message |  |

## Content (25)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Accordion](blocks/Accordion.md) | sim | Arrange the content by having vertically stacked tabs that expand when clicked. | 2 | Content | Initialized |
| [AccordionItem](blocks/AccordionItem.md) | sim | An area that can be expanded or collapsed. | 5 | Title, CustomIcon, Content | OnToggle, Initialized |
| [Alert](blocks/Alert.md) | sim | Alert box with a placeholder for custom content, supports Success, Danger, Warning and Info messages. | 2 | MessageText |  |
| [BlankSlate](blocks/BlankSlate.md) | sim | A simple box that presents an empty state to the user and provides directions. | 2 | Icon, Content, Actions |  |
| [Card](blocks/Card.md) | sim | Card with placeholder for Content. | 2 | Content |  |
| [CardBackground](blocks/CardBackground.md) | sim | Card with a background image, GIF or video. | 3 | Content, BackgroundImage |  |
| [CardItem](blocks/CardItem.md) | sim | Card with placeholders for Title, Text, Left side and Right side. | 1 | Left, Right, Title, Content |  |
| [CardSectioned](blocks/CardSectioned.md) | sim | Card with placeholders for Title, Content and Footer. | 4 | Image, Title, Content, Footer |  |
| [ChatMessage](blocks/ChatMessage.md) | sim | Block with Chat Message content, such as user photo, text, images, delivery time and status. | 4 | Image, Content |  |
| [DEPRECATED_Accordion](blocks/DEPRECATED_Accordion.md) | sim | Arrange the content by having vertically stacked tabs that expand when clicked. | 2 | Content |  |
| [DEPRECATED_AccordionItem](blocks/DEPRECATED_AccordionItem.md) | sim | An area that can be expanded or collapsed. | 4 | Title, Content | OnToggle |
| [DEPRECATED_CardAction](blocks/DEPRECATED_CardAction.md) | sim | Card with placeholders for Title, Content, Footer and Action. | 0 | Content, Footer, Actions | OnActionClick |
| [DEPRECATED_CardBackground](blocks/DEPRECATED_CardBackground.md) | sim | Card with a background image, GIF or video. | 2 | Content, BackgroundImage |  |
| [DEPRECATED_FlipContent](blocks/DEPRECATED_FlipContent.md) | sim | This pattern is DEPRECATED. | 3 | CardFront, CardBack | OnFlip |
| [DEPRECATED_Tag](blocks/DEPRECATED_Tag.md) | sim | Display text highlighting its importance. | 1 | Tag |  |
| [DEPRECATED_Tooltip](blocks/DEPRECATED_Tooltip.md) | sim | This pattern is DEPRECATED. | 4 | Content, Tooltip |  |
| [DEPRECATED_UserAvatar](blocks/DEPRECATED_UserAvatar.md) | sim | Display the picture or initials of a user. | 3 |  |  |
| [FlipContent](blocks/FlipContent.md) | sim | Flip between two placeholders. | 3 | CardFront, CardBack | OnFlip, Initialized |
| [FloatingContent](blocks/FloatingContent.md) | sim | Inserts a floating panel with content docked to a direction in the page | 5 | Content |  |
| [ListItemContent](blocks/ListItemContent.md) | sim | Block to use inside a List Item to create content on the left, center and right. | 1 | Left, Right, Title, Content |  |
| [Section](blocks/Section.md) | sim | Use it to segment and arrange blocks of content on a page. | 2 | Title, Content |  |
| [SectionGroup](blocks/SectionGroup.md) | sim | Use to apply sticky headers to Sections inside this Block. | 3 | Sections |  |
| [Tag](blocks/Tag.md) | sim | Display text highlighting its importance. | 5 | Tag |  |
| [Tooltip](blocks/Tooltip.md) | sim | Dynamic tooltip displaying simple content. | 4 | Content, Tooltip | OnToggle, Initialized |
| [UserAvatar](blocks/UserAvatar.md) | sim | Display the picture or initials of a user. | 7 |  |  |

## Interaction (37)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [ActionSheet](blocks/ActionSheet.md) | sim | Menu with several buttons and a slide-up animation. | 2 | Button1, Button2, Button3, Button4, Button5 | OnClose |
| [Animate](blocks/Animate.md) | sim | Use this Block to emphasise elements as they come on screen or while the screen is loading. | 3 | Content |  |
| [AnimatedLabel](blocks/AnimatedLabel.md) | sim | Input fields with labels that animate when users focus the input. | 1 | Label, Input | Initialized |
| [BottomSheet](blocks/BottomSheet.md) | sim | Use this block to add a container that slides up from the bottom of the screen to reveal more content. | 3 | Content, TopBar | Initialized, OnToggle |
| [Carousel](blocks/Carousel.md) | sim | Displays multiple items in a horizontal slide. | 5 | CarouselItems | OnSlideMoved, Initialized |
| [DatePicker](blocks/DatePicker.md) | sim | Allows the user to select a single date using a calendar. | 5 | Datepicker, Placeholder_SSPreview | Initialized, OnSelected |
| [DatePickerRange](blocks/DatePickerRange.md) | sim | Allows the user to select a range of dates using a calendar. | 4 | Datepicker, Placeholder_SSPreview | OnSelected, Initialized |
| [DEPRECATED_Carousel](blocks/DEPRECATED_Carousel.md) | sim | A Carousel with multiple items in an horizontal slide. | 12 | CarouselItems | OnItemChange |
| [DEPRECATED_DatePicker](blocks/DEPRECATED_DatePicker.md) | sim | Date and time picker with a flat UI to be displayed inline on the screen. | 17 |  | OnSelect |
| [DEPRECATED_DropdownSearch](blocks/DEPRECATED_DropdownSearch.md) | sim | Enhanced Dropdown block, with search functionality. | 8 |  | OnSelect |
| [DEPRECATED_DropdownTags](blocks/DEPRECATED_DropdownTags.md) | sim | Enhanced Dropdown block, with search functionality and multiple tags selection. | 8 |  | OnChange |
| [DEPRECATED_FloatingActions](blocks/DEPRECATED_FloatingActions.md) | sim | Button that displays a group of buttons when pressed. | 0 | Button1, Icon1, Button2, Icon2, Button3, Icon3, Button4, Icon4, Button5, Icon5 | OnToggle |
| [DEPRECATED_HorizontalScroll](blocks/DEPRECATED_HorizontalScroll.md) | sim | Simple horizontally scrollable Block with a placeholder for content. | 1 | Content |  |
| [DEPRECATED_Notification](blocks/DEPRECATED_Notification.md) | sim | Simple notification Block displayed on top of the screen. | 2 | Content | OnClose |
| [DEPRECATED_RangeSlider](blocks/DEPRECATED_RangeSlider.md) | sim | Select a single value within a range, using a sliding handle. | 9 |  | OnChange |
| [DEPRECATED_RangeSliderInterval](blocks/DEPRECATED_RangeSliderInterval.md) | sim | Select an interval within a range of values, using two sliding handles  For advanced options, read the official documentation: https://refreshless.com/nouisl... | 10 |  | OnChange |
| [DEPRECATED_RangeSliderIntervalV2](blocks/DEPRECATED_RangeSliderIntervalV2.md) | sim | Select an interval within a range of values, using two sliding handles  For advanced options, read the official documentation: https://refreshless.com/nouisl... | 13 |  | OnChange |
| [DEPRECATED_RangeSliderV2](blocks/DEPRECATED_RangeSliderV2.md) | sim | Select a single value within a range, using a sliding handle. | 12 |  | OnChange |
| [DEPRECATED_Search](blocks/DEPRECATED_Search.md) | sim | A search icon that opens an input above the header to search within the application. | 1 | Input | OnCollapse |
| [DEPRECATED_Sidebar](blocks/DEPRECATED_Sidebar.md) | sim | This pattern is DEPRECATED. | 2 | Header, Content | OnToggle |
| [DEPRECATED_Video](blocks/DEPRECATED_Video.md) | sim | A simple way to embed video content directly into your web pages without the need for a third-party plug-in. | 9 |  |  |
| [DropdownSearch](blocks/DropdownSearch.md) | sim | Enhanced DropdownSearch block, with search functionality. | 5 |  | OnChanged, Initialized |
| [DropdownTags](blocks/DropdownTags.md) | sim | Enhanced Dropdown block, with search functionality and multiple tags selection. | 5 |  | Initialized, OnChanged |
| [FloatingActions](blocks/FloatingActions.md) | sim | Display an action that floats on the bottom right of the screen, providing access to a set of additional actions. | 3 | Button, Items | OnToggle |
| [FloatingActionsItem](blocks/FloatingActionsItem.md) | sim | Used within the FloatingActions Pattern. | 1 | Label, Item |  |
| [InputWithIcon](blocks/InputWithIcon.md) | sim | Customize an input with an Icon. | 2 | Icon, Input |  |
| [LightboxImage](blocks/LightboxImage.md) | sim | Block with only one placeholder for image. | 6 | Thumbnail | Initialized |
| [MonthPicker](blocks/MonthPicker.md) | sim | Allows the user to select a single month and year using a calendar. | 5 | MonthPicker, Placeholder_SSPreview | OnSelected, Initialized |
| [Notification](blocks/Notification.md) | sim | Use this block to add a notification. | 5 | Content | Initialized, OnToggle |
| [RangeSlider](blocks/RangeSlider.md) | sim | Select a single value within a range, using a sliding handle. | 7 |  | OnValueChange, Initialized |
| [RangeSliderInterval](blocks/RangeSliderInterval.md) | sim | Select an interval within a range of values, using two sliding handles. | 8 |  | Initialized, OnValueChange |
| [ScrollableArea](blocks/ScrollableArea.md) | sim | Simple scrollable Block with a placeholder for content. | 5 | Content |  |
| [Search](blocks/Search.md) | sim | Input with search icon to search within the application. | 1 | Input | Initialized |
| [Sidebar](blocks/Sidebar.md) | sim | Display additional information on a floating panel on the side of the screen. | 5 | Header, Content | OnToggle, Initialized |
| [StackedCards](blocks/StackedCards.md) | sim | Stacked cards with multiple items. | 6 | Content, OverlayTop, OverlayRight, OverlayLeft | OnRightSwipe, OnItemChange, OnLeftSwipe, OnTopSwipe |
| [TimePicker](blocks/TimePicker.md) | sim | Allows the user to select a time using a picker. | 5 | Timepicker, Placeholder_SSPreview | OnSelected, Initialized |
| [Video](blocks/Video.md) | sim | Drag the pattern to the screen to add video content without the need for a third-party plug-in. | 7 |  | StateChanged, Initialized |

## Licenses (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Licenses](blocks/Licenses.md) | sim | Contains the OutSystems platform licenses. | 0 | CustomLicenses |  |

## Navigation (22)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [BottomBarItem](blocks/BottomBarItem.md) | sim | Item to be placed inside the Bottom Bar. | 1 | Icon, Text |  |
| [Breadcrumbs](blocks/Breadcrumbs.md) | sim | Present the current user location in applications with a deep page hierarchy. | 1 | Content |  |
| [BreadcrumbsItem](blocks/BreadcrumbsItem.md) | sim | Used in the Content placeholder of the Breadcrumbs Block. | 1 | Title, Icon |  |
| [DEPRECATED_SectionIndex](blocks/DEPRECATED_SectionIndex.md) | sim | Use the Section Index to organize a screen's content, enabling quick navigation within a page. | 4 |  |  |
| [DEPRECATED_Submenu](blocks/DEPRECATED_Submenu.md) | sim | This pattern is DEPRECATED. | 1 | Items, Menu |  |
| [DEPRECATED_Tabs](blocks/DEPRECATED_Tabs.md) | sim | Set of Tabs with placeholders for Title and Content. | 1 | Tab1, Tab2, Tab3, Tab4, Tab5, TabContent1, TabContent2, TabContent3, TabContent4, TabContent5 | OnTabChange |
| [DEPRECATED_TabsContentItem](blocks/DEPRECATED_TabsContentItem.md) | sim | Item for placeholder Content in the Tabs Block. | 1 | Content |  |
| [DEPRECATED_TabsHeaderItem](blocks/DEPRECATED_TabsHeaderItem.md) | sim | Item for placeholder Header in the Tabs Block. | 1 | Title |  |
| [DEPRECATED_TabsV2](blocks/DEPRECATED_TabsV2.md) | sim | Set of Tabs with placeholders for Title and Content. | 5 | Header, Content | OnTabChange |
| [DEPRECATED_Wizard](blocks/DEPRECATED_Wizard.md) | sim | Container for WizardItem Blocks that create a visual indication of the progress of a given set of tasks. | 0 | WizardItems |  |
| [DEPRECATED_WizardItem](blocks/DEPRECATED_WizardItem.md) | sim | One step of a Wizard Block. | 1 | Content | OnClick |
| [OverflowMenu](blocks/OverflowMenu.md) | sim | Clickable element that displays hidden actions, settings, or secondary options. | 3 | Menu, TriggerContent | OnMenuToggle, Initialized |
| [Pagination](blocks/Pagination.md) | sim | Drag the Pagination block to your screen. | 5 | Previous, Next | OnNavigate |
| [SectionIndex](blocks/SectionIndex.md) | sim | Use the Section Index to organize a screen's content, enabling quick navigation within a page. | 3 | Content | Initialized |
| [SectionIndexItem](blocks/SectionIndexItem.md) | sim | Use the Section Index to organize a screen's content, enabling quick navigation within a page. | 2 | Content | Initialized |
| [Submenu](blocks/Submenu.md) | sim | Menu item able to hold additional links inside the Submenu Items placeholder. | 1 | Menu, Items | Initialized, OnToggle |
| [Tabs](blocks/Tabs.md) | sim | Set of Tabs with placeholders for Title and Content. | 6 | Header, Content | Initialized, OnTabChange |
| [TabsContentItem](blocks/TabsContentItem.md) | sim | Item for placeholder Content in the Tabs Block. | 1 | Content | Initialized |
| [TabsHeaderItem](blocks/TabsHeaderItem.md) | sim | Item for placeholder Header in the Tabs Block. | 1 | Title | Initialized |
| [TimelineItem](blocks/TimelineItem.md) | sim | Item to create a timeline of event information, with placeholders for icon, title text and actions. | 3 | Left, Right, Icon, Title, Content |  |
| [Wizard](blocks/Wizard.md) | sim | Used to split larger tasks into more manageable steps. | 2 | Content |  |
| [WizardItem](blocks/WizardItem.md) | sim | Step item to add in the Wizard pattern. | 3 | Label, Icon | OnClick |

## Numbers (13)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [Badge](blocks/Badge.md) | sim | Displays a number as notification, a nice way to notify a user about new messages or tasks. | 6 |  |  |
| [Counter](blocks/Counter.md) | sim | Use counters to give feedback about the current count of several elements. | 4 | Content |  |
| [DEPRECATED_Badge](blocks/DEPRECATED_Badge.md) | sim | Displays a number as notification, a nice way to notify a user about new messages or tasks. | 2 |  |  |
| [DEPRECATED_Counter](blocks/DEPRECATED_Counter.md) | sim | Use counters to give feedback about the current count of several elements, very useful on dashboards or summary pages. | 3 | Number, Label |  |
| [DEPRECATED_IconBadge](blocks/DEPRECATED_IconBadge.md) | sim | Icon with a Badge stacked on top of it. | 2 | Icon |  |
| [DEPRECATED_ProgressBar](blocks/DEPRECATED_ProgressBar.md) | sim | Animated progress bar. | 5 |  |  |
| [DEPRECATED_ProgressBarV2](blocks/DEPRECATED_ProgressBarV2.md) | sim | Animated progress bar. | 7 |  |  |
| [DEPRECATED_ProgressCircle](blocks/DEPRECATED_ProgressCircle.md) | sim | Circular progress indicator, with a label on the center of the circle showing the input text. | 8 |  |  |
| [DEPRECATED_ProgressCircleFraction](blocks/DEPRECATED_ProgressCircleFraction.md) | sim | Circular progress indicator, with a label on the center of the circle showing progress as a fraction. | 8 |  |  |
| [IconBadge](blocks/IconBadge.md) | sim | Icon with a Badge stacked on top of it. | 4 | Icon |  |
| [ProgressBar](blocks/ProgressBar.md) | sim | You can use the ProgressBar to display the current progress in a bar. | 6 | Content | Initialized |
| [ProgressCircle](blocks/ProgressCircle.md) | sim | Circular progress indicator with a placeholder on the center of the circle. | 7 | Content | Initialized |
| [Rating](blocks/Rating.md) | sim | Use this pattern to let your users score your products and services. | 5 | FilledState, HalfState, EmptyState | Initialized, OnSelect |

## Private (8)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [ApplicationLoadEvents](blocks/ApplicationLoadEvents.md) | sim | Handles the loading progress on a splash screen. | 1 |  | OnLoadComplete, OnUpgradeProgress |
| [DEPRECATED_MenuDrag](blocks/DEPRECATED_MenuDrag.md) | sim | Contains the mobile phone screen gestures logic to apply on the menu to show its content. | 1 |  |  |
| [DEPRECATED_MenuTabletDrag](blocks/DEPRECATED_MenuTabletDrag.md) | sim | Contains the tablet screen gestures logic to apply on the menu to show its content. | 1 |  |  |
| [LightBox](blocks/LightBox.md) | sim | Base elements to create the Lightbox panel that Lightbox Items open on click. | 0 |  |  |
| [MenuDrag](blocks/MenuDrag.md) | sim | Contains the mobile phone screen gestures logic to apply on the menu to show its content. | 1 |  | OnOpen, OnClose |
| [NetworkStatusChanged](blocks/NetworkStatusChanged.md) | sim | Triggers different events depending on the device's network connection status. | 0 |  | NetworkStatusChanged |
| [OfflineDataSyncCore](blocks/OfflineDataSyncCore.md) | sim | Synchronizes data that can be used offline. | 0 |  | OnSyncComplete, OnSyncError, OnSyncStart, OnConfigure, OnSync |
| [PullToRefresh](blocks/PullToRefresh.md) | sim | Enable swiping down on the screen's content to trigger an action (usually refreshing part of the screen). | 0 |  | OnContentPull |

## Utilities (10)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [AlignCenter](blocks/AlignCenter.md) | sim | Vertically aligns multiple elements with different heights. | 2 | Content |  |
| [ButtonLoading](blocks/ButtonLoading.md) | sim | Button with loading state when is clicked. | 3 | Button | Initialized |
| [CenterContent](blocks/CenterContent.md) | sim | Vertically aligns content to the middle of its parent. | 2 | Top, Center, Bottom |  |
| [DEPRECATED_ButtonLoading](blocks/DEPRECATED_ButtonLoading.md) | sim | This pattern is DEPRECATED. | 3 | Button |  |
| [InlineSVG](blocks/InlineSVG.md) | sim | Use this pattern to be able to use an SVG inline, so that you can change the fill and stroke properties, or animate the SVG paths. | 2 |  | Initialized |
| [MarginContainer](blocks/MarginContainer.md) | sim | Adds a margin around this block's placeholder. | 1 | MarginContainer |  |
| [MouseEvents](blocks/MouseEvents.md) | sim | Enables Mouse events on a specific widget. | 2 |  | Move, End, Start |
| [Separator](blocks/Separator.md) | sim | Allows to split information with a horizontal line. | 4 |  |  |
| [SwipeEvents](blocks/SwipeEvents.md) | sim | Enable swipe events on a specific widget. | 1 |  | SwipeUp, SwipeLeft, SwipeRight, SwipeDown |
| [TouchEvents](blocks/TouchEvents.md) | sim | Enables touch events on a specific widget. | 2 |  | Move, Start, End |

Veja tambem: [config-values.md](config-values.md) (static entities), [actions.md](actions.md) (actions publicas), [themes.md](themes.md) (tokens CSS).
