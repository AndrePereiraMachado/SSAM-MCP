# OutSystemsUI 2.28.1: actions publicas

## AccordionCollapseAll (ClientAction)

Function to collapse all the expanded items of a given accordion.

- in WidgetId: Text [obrigatorio] - The accordion's id to perform the action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.AccordionAPI.CollapseAllItems`

## AccordionExpandAll (ClientAction)

Function to expand all the collapsed items of a given accordion.

- in WidgetId: Text [obrigatorio] - The accordion's id to perform the action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.AccordionAPI.ExpandAllItems`

## AccordionItemAllowTitleEvents (ClientAction)

Enable the events of a given AccordionItem title’s elements. Use this action to trigger element events (e.g. link on click) without opening/closing the Accordion Item.

- in WidgetId: Text [obrigatorio] - Identifier of the AccordionItem block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.AccordionItemAPI.AllowTitleEvents`

## AccordionItemCollapse (ClientAction)

Closes an AccordionItem with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the AccordionItem block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.AccordionItemAPI.Collapse`

## AccordionItemExpand (ClientAction)

Opens an AccordionItem with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the AccordionItem block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.AccordionItemAPI.Expand`

## AddFavicon (ClientAction)

Add a favicon to your web application by providing the icon's URL.
This action should be used in the Layout OnReady event or on an OnApplicationStart event.
Note: This action is only compatible with Chrome, Firefox and Edge.

- in URL: Text [obrigatorio] - URL of the image to be used as favicon
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: AddFavicon_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.AddFavicon`

## BinaryToURLImage (ClientAction)

Generates an image URL from a binary file. This action can be used to generate the URl to be used in patterns like the LighboxImage or the OutSystems Maps Marker.

- in Image: Binary Data [obrigatorio] - Input parameter with the image binary file to be converted.
- out URL: Text - Output parameter with the image URL converted from the binary file.

## BottomSheetClose (ClientAction)

Closes a BottomSheet with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the BottomSheet block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.BottomSheetAPI.Close`

## BottomSheetOpen (ClientAction)

Opens a BottomSheet with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the BottomSheet block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.BottomSheetAPI.Open`

## CarouselDisableOnRender (ClientAction)

Prevents the Carousel block from auto-updating every time that there’s a change on the Carousel items. This will prevent unnecessary destroy/init cycles of the provider, resulting in better performance.

This action can be used in combination with the CarouselEnableOnRender action (for instance, before adding a new class to an element inside the Carousel, use the CarouselDisableOnRender action and after doing it, use the CarouselEnableOnRender action, so that the carousel can auto-update if needed). 
 
By default, the Carousel auto-updates itself.

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.CarouselDisableOnRender`

## CarouselEnableOnRender (ClientAction)

Prevents the Carousel block from auto-updating every time that there’s a change on the Carousel items. This will prevent unnecessary destroy/init cycles of the provider, resulting in better performance.

This action can be used in combination with the CarouselDisableOnRender action (for instance, before adding a new class to an element inside the Carousel, use the CarouselDisableOnRender action and after doing it, use the CarouselEnableOnRender action, so that the carousel can auto-update if needed). 
 
By default, the Carousel auto-updates itself.

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.CarouselEnableOnRender`

## CarouselGoTo (ClientAction)

Set the item that Carousel will go to.

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block.
- in ItemIndex: Integer [obrigatorio] - Index of the item that the Carousel will go to.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.GoTo`

## CarouselNext (ClientAction)

Use to move the Carousel to the next item.

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.Next`

## CarouselPrevious (ClientAction)

Use to move the carousel to the previous item.

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.Previous`

## CarouselToggleDrag (ClientAction)

Enable the drag to navigate between items.

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block.
- in HasDrag: Boolean [obrigatorio] - Set to "True" to enable the drag functionality of the Carousel block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.ToggleDrag`

## ConfigureOfflineDataSync (ClientAction)

Offline data synchronization settings.

- in SyncOnOnline: Boolean [obrigatorio] - Set to True to sync when the application is online.
- in SyncOnResume: Boolean [obrigatorio] - Set to True to sync when the application is resumed.
- in RetryOnError: Boolean [obrigatorio] - Set to True to retry the offline data sync if there is an error.
- in RetryIntervalInSeconds: Integer [obrigatorio] - Time interval to retry the offline data sync.

## DatePickerClear (ClientAction)

Resets the selected dates (if any) and clears the input of a DatePicker with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.Clear`

## DatePickerClose (ClientAction)

Closes a Datepicker block with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.Close`

## DatePickerDisableDays (ClientAction)

Set a list of specific days unavailable for selection on the DatePicker.

Note:
- Due to a provider issue, when using this action on the DatePickerRange, the component behaves differently in Web and Mobile. In Web, it is not possible to select an interval that includes disabled dates. In Mobile, it's possible to do it. Our team is working to ensure an identical experience for Web and Mobile and will update this action as soon as the provider reviews the component behavior.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- in DisabledDays: Date List [obrigatorio] - List of days that will be disabled in the DatePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.DisableDays`

## DatePickerDisableWeekDays (ClientAction)

Disable one or more days of the week on a given DatePicker.

Note: 
- Due to a provider issue, when using this action on the DatePickerRange, the component behaves differently in Web and Mobile. In Web, it is not possible to select an interval that includes disabled dates. In Mobile, it's possible to do it. Our team is working to ensure an identical experience for Web and Mobile and will update this action as soon as the provider reviews the component behavior.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- in DisableMondays: Boolean = False - Set to True to disable all Mondays of the DatePicker.
- in DisableTuesdays: Boolean = False - Set to True to disable all Tuesdays of the DatePicker.
- in DisableWednesdays: Boolean = False - Set to True to disable all Wednesdays of the DatePicker.
- in DisableThursdays: Boolean = False - Set to True to disable all Thursdays of the DatePicker.
- in DisableFridays: Boolean = False - Set to True to disable all Fridays of the DatePicker.
- in DisableSaturdays: Boolean = False - Set to True to disable all Saturdays of the DatePicker.
- in DisableSundays: Boolean = False - Set to True to disable all Sundays of the DatePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: ListClear, ListAppend
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.DisableWeekDays`

## DatePickerOpen (ClientAction)

Opens a Datepicker block with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.Open`

## DatePickerRangeUpdateDates (ClientAction)

Update the selected start and end dates shown in a given DatePickerRange.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- in NewStartDate: Date Time [obrigatorio] - The new selected start date for the DatePickerRange.
- in NewEndDate: Date Time - The new selected end date for the DatePickerRange.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.UpdateInitialDate`

## DatePickerSetEditableInput (ClientAction)

Use this action to enable the end-user to write on the DatePicker input. By default, the input is read-only.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- in IsEditableInput: Boolean = True - Set if the input of the DatePicker is editable or not. If True, the user will be able to write on the input. If False, the input will be read-only.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.SetEditableInput`

## DatePickerSetLanguage (ClientAction)

Set a new language on a DatePicker block with a given identifier. All the elements shown in the DatePicker will the translated into the selected language.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- in Language: DatePickerLanguage Identifier [obrigatorio] - The ISO 639-1 code of the language. Example: en, fr, jpn
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.SetLanguage`

## DatePickerToggleNativeBehavior (ClientAction)

Use this action to control the DatePicker behavior when opened in mobile. By default, the DatePicker is opened as native, in mobile.

- in WidgetId: Text [obrigatorio] - Widget Id of the DatePicker.
- in IsNative: Boolean [obrigatorio] - Set to True to open as native. False, otherwise.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.ToggleNativeBehavior`

## DatePickerUpdateDate (ClientAction)

Update the selected date shown in a given DatePicker.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- in NewDate: Date Time [obrigatorio] - The new selected start date for the DatePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.UpdateInitialDate`

## DatePickerUpdatePrompt (ClientAction)

Update the prompt message in a given DatePicker. Use this action for changing the prompt message based on certain conditions or when using variables.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block.
- in Prompt: Text [obrigatorio] - The new prompt message for the DatePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DatePickerAPI.UpdatePrompt`

## DEPRECATED_AccessibilityConfiguration (ClientAction)

This action is deprecated, to enable accessibility features, such as the focus styles, you need to use a new version of the Layout, where the configuration is set through an input parameter. See more information at https://success.outsystems.com/Documentation/11/Developing_an_Application/Design_UI/Accessibility

- in ShowFocus: Boolean = False - Set to True, to make the outline styles visible on focus.
- in ShowSkipToContent: Boolean = False - Set this option to True, to show a link on header to skip to the main content of the screen.
- in Lang: Text = "" - Set the lang attribute to be defined on the html.

## DEPRECATED_CarouselDisableSwipe (ClientAction)

Use this action to set the Carousel to not allow to move using swipe actions, but rather control it using the arrows or dot naviagation.

- in CarouselID: Text [obrigatorio]

## DEPRECATED_CarouselGoTo (ClientAction)

Action to call specific element on Carousel.

- in WidgetId: Text [obrigatorio] - Widget Id of the Carousel
- in Target: Integer [obrigatorio] - Carousel element number to navigate to

## DEPRECATED_CarouselNext (ClientAction)

Action to call next element on Carousel.

- in WidgetId: Text [obrigatorio] - Widget Id of the Carousel

## DEPRECATED_CarouselPrevious (ClientAction)

Action to call previous element on Carousel.

- in WidgetId: Text [obrigatorio] - Widget Id of the Carousel

## DEPRECATED_CarouselUpdate (ClientAction)

Update elements on Carousel after a List remove or action triggered.

- in WidgetId: Text [obrigatorio] - Widget Id of the Carousel

## DEPRECATED_DatePickerClearInputDate (ClientAction)

Use this action to clear the date on the DatePicker's input. This will make the input appear empty or with the default prompt value.

- in InputId: Text [obrigatorio] - Widget Id of the input bounded to the Date Picker.

## DEPRECATED_GetBrowser (ClientAction, function)

This action is deprecated since version 2.6.13. 
Identifies the browser being used.

- in UserAgent: Text [obrigatorio]
- out Browser: Text

## DEPRECATED_LayoutReadyMobile (ClientAction)

DEPRECATED - Pre-defined actions to prepare your layout for mobile.

- in HideHeaderOnScroll: Boolean [obrigatorio]
- chama: HasMasterDetail, FixInputs, ECTCall, SetDeviceClass, HideHeader

## DEPRECATED_RangeSliderReset (ClientAction)

Use this action to reset your RangeSlider or RangeSliderInterval, applying the 'start' values.

Please visit https://refreshless.com/nouislider/slider-read-write/#section-setting for more information.

- in WidgetId: Text [obrigatorio] - Widget Id of the RangeSlider or RangeSliderInterval

## DEPRECATED_SetActiveMenuItems (ClientAction)

Adds the selected states to menu items.

- in ActiveItem: Integer = -1 - Manually set as active a menu item, using it's index.
- in ActiveSubItem: Integer = -1 - Manually set as active a submenu item, using it's index.

## DEPRECATED_SetMenuListeners (ClientAction)

Makes the menu navigation accessibility-ready.


## DEPRECATED_ShowPassword (ClientAction)

Action to be used on the Login screen to enable users to show or hide the password characters.

- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.ShowPassword`

## DEPRECATED_SidebarToggle (ClientAction)

Action to toggle the Sidebar between the open and closed state. 
Drag the action and provide the Sidebar widget ID to target the right element.
If no widget ID is provided, the action will toggle the first Sidebar on the screen.

- in WidgetId: Text [obrigatorio]

## DEPRECATED_TabsDisableSwipe (ClientAction)

Use this action to set the Tabs to not allow to move using swipe actions, but rather control it using the Tabs Header.

- in TabID: Text [obrigatorio]

## DEPRECATED_TabsGoTo (ClientAction)

Action to call specific element on Tabs.

- in WidgetId: Text [obrigatorio] - Widget Id of the Tabs
- in TabNumber: Integer [obrigatorio] - Tabs element number to navigate to

## DEPRECATED_VideoPause (ClientAction)

Use your own action to pause a Video instead of using the default controls.

- in WidgetId: Text [obrigatorio]

## DEPRECATED_VideoPlay (ClientAction)

Use your own action to play a Video instead of using the default controls.

- in WidgetId: Text [obrigatorio]

## DisableTabItem (ClientAction)

Disable a TabHeaderItem with a specific identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the TabsHeaderItem block that will be disabled.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TabsHeaderItemAPI.DisableTabItem`

## DropdownClear (ClientAction)

Unselects all selected values of a Dropdown (DropdownTags, DropdownSearch) with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- in SilentOnChangedEvent: Boolean = True - Set to True to not trigger the OnChange event of the Dropdown. Set to False, otherwise. By default, the event is silent and will not be triggered (True).
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Clear`

## DropdownClearValidation (ClientAction)

Clears the validation style of a Dropdown (DropdownTags or DropdownSearch) with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.SetValidation`

## DropdownClose (ClientAction)

Closes the options list of a Dropdown (DropdownTags or DropdownSearch) block with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Close`

## DropdownDisable (ClientAction)

Sets a Dropdown (DropdownTags or DropdownSearch) with given identifier as disabled.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Disable`

## DropdownEnable (ClientAction)

Sets a Dropdown (DropdownTags or DropdownSearch) with given identifier as enabled.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Enable`

## DropdownGetSelectedValues (ClientAction)

Returns a list with the selected values of a Dropdown (DropdownTags or DropdownSearch) with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- out SelectedOptionList: DropdownOption List - List of selected options.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.GetSelectedValues`

## DropdownNotValid (ClientAction)

Apply the invalid style to a Dropdown (DropdownTags or DropdownSearch) with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- in ValidationMessage: Text [obrigatorio] - Text to be added when not IsValid.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.SetValidation`

## DropdownOpen (ClientAction)

Opens the Dropdown (DropdownTags or DropdownSearch) block with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Open`

## DropdownServerSideClear (ClientAction)

Unselects all selected values of a DropdownServerSide with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownServerSide block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Clear`

## DropdownServerSideClearValidation (ClientAction)

Clears the validation style of a DropdownServerSide with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownServerSide block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.SetValidation`

## DropdownServerSideClose (ClientAction)

Closes the options list of a DropdownServerSide block with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownServerSide block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Close`

## DropdownServerSideDisable (ClientAction)

Sets a DropdownServerSide with given identifier as disabled.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownServerSide block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Disable`

## DropdownServerSideEnable (ClientAction)

Sets a DropdownServerSide with given identifier as enabled.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownServerSide block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Enable`

## DropdownServerSideNotValid (ClientAction)

Apply the invalid style to a DropdownServerSide with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownServerSide block.
- in ValidationMessage: Text [obrigatorio] - Text to be added when not IsValid.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.SetValidation`

## DropdownServerSideOpen (ClientAction)

Opens the options list of a DropdownServerSide block with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownServerSide block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.Open`

## DropdownSetValue (ClientAction)

Set the selected values of a Dropdown (DropdownTags or DropdownSearch) block. 
Please note, that doing this doesn’t update the new selected value on your Data. 
You will need to do it manually, after the action is used.

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- in SelectedValues: DropdownOption List [obrigatorio] - List of options that will be set as selected in the Dropdown.
- in SilentOnChangedEvent: Boolean = True - Set to True to not trigger the OnChange event of the Dropdown. Set to False, otherwise. 
By default, the event is silent and will not be triggered (True).
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.SetValues`

## DropdownTogglePopup (ClientAction)

Enables or disables the default behavior of Dropdowns (DropdownTags or DropdownSearch) of opening as a popup in mobile apps (responsive and native). By default, Dropdowns open as popups in mobile apps (responsive and native).

- in WidgetId: Text [obrigatorio] - Identifier of the DropdownTags or DropdownSearch block.
- in EnablePopup: Boolean = True - Set to True to open the Dropdown as a popup in Native Apps. Set to False, otherwise. By default, opening as a popup is enabled (True).
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.TogglePopup`

## EnableTabItem (ClientAction)

Enable a TabHeaderItem with a specific identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the TabsHeaderItem block that will be disabled.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TabsHeaderItemAPI.EnableTabItem`

## EndOfflineDataSync (ClientAction)

Disables the offline data synchronization.

- in HasError: Boolean [obrigatorio] - Set to True to end offline data sync when there is an error.
- in ErrorMessage: Text = "" - Set the error message that shown when the data sync ends.
- in AllowRetry: Boolean = False - Set to True to retry when the offline data sync fails.

## FeedbackMessageClose (ClientAction)

Closes the FeedbackMessage that is currently open.


## FeedbackMessageShow (ClientAction)

Shows a FeedbackMessage with a specified message. You can enable HTML encoding, add CSS classes, and set the behavior on click.

- in Message: Text [obrigatorio] - Message to be displayed.
- in MessageType: Integer [obrigatorio] - Type of feedback message to show (0 = Info, 1 = Success, 2 = Warning or 3 = Error).
- in EncodedHTML: Boolean = True - Whether to escape HTML characters (default is true so the message is treated as text).
- in ExtendedClass: Text - Whitespace-separated class names to be added to the feedback message container to customize the appearance of the message.
- in CloseOnClick: Boolean = True - When true, indicates that the message box will be closed when the user clicks on it.

## FlipContentBack (ClientAction)

Shows the back of the FlipContent.

- in WidgetId: Text [obrigatorio] - The FlipContent's id to perform the action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.FlipContentAPI.ShowBackContent`

## FlipContentFront (ClientAction)

Shows the front of the FlipContent.

- in WidgetId: Text [obrigatorio] - The FlipContent's id to perform the action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.FlipContentAPI.ShowFrontContent`

## FlipContentToggle (ClientAction)

Flips the content of the FlipContent with the ID.

- in WidgetId: Text [obrigatorio] - The FlipContent's id to perform the action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.FlipContentAPI.ToggleFlipContent`

## FocusFirstInvalidInput (ClientAction)

Set the focus on the first invalid input of the screen. Due to the unsupported scrollend event on Safari/iOS, the smooth transition is disabled and the invalid input will be focused directly.

- in WidgetId: Text [obrigatorio] - The form element to check if contains invalid inputs. Also works with other elements, like Blocks or Containers.
- in IsSmooth: Boolean = False - If IsSmooth is true, the navigation to destination will animate. If set to false, it will navigate instantly.
- in ElementParentClass: Text - Set the name of the CSS class of the element inside which the scroll will happen (parent of the element).Fill this property when the element is not on the page body. By default (if left empty), the action will scroll to the element with the given WidgetID in the page body.
Below, you'll find some examples of situations where it's necessary to set this property and the corresponding value:
   - Popup: "popup-dialog"
   - Sidebar: “osui-sidebar__content”
   - BottomSheet: “osui-bottom-sheet__content"
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.InvalidInputs.FocusFirstInvalidInput`

## GetBrowser (ClientAction, function)

Identifies the browser being used.

- out Browser: Text - Output parameter with the name of the browser. If not found, will return empty.
- chama: CheckOutSystemsUIScript, GetBrowser_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.GetBrowser`

## GetDeviceOrientation (ClientAction, function)

Get the current device orientation

- out Orientation: Text - The current device orientation: "Portrait" or "Landscape"
- chama: GetDeviceOrientation_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.GetDeviceOrientation`

## GetDeviceType (ClientAction, function)

Get the current device type

- out Device: Text - The current device type: "Phone" or "Tablet"
- chama: CheckOutSystemsUIScript, GetDeviceType_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.GetDeviceType`

## GetIsTouch (ClientAction, function)

Identifies if the device has a touchscreen.

- out IsTouch: Boolean - Returns True if the device is touch. False, otherwise.
- chama: CheckOutSystemsUIScript, GetIsTouch_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.IsTouch`

## GetNetworkStatus (ClientAction, function)

Check if device is online.

- out IsOnline: Boolean - Returns True if the device is online. False, otherwise.
- chama: GetNetworkStatus_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.Network.IsOnline`

## GetNetworkType (ClientAction, function)

Get connection type.

- out NetworkType: Text - Returns the type of the network being used.
- chama: GetNetworkType_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.Network.Type`

## GetOS (ClientAction, function)

Identifies the operating system being used.

- in UserAgent: Text [obrigatorio] - Input parameter with the user agent to which we want to get the browser name.
- out OS: Text - Output parameter with the name of the operating system returned.
- chama: GetOS_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.GetOperatingSystem`

## IsDesktop (ClientAction, function)

Check if the current device is desktop

- out IsDesktop: Boolean - Returns True if the current device is desktop
- chama: CheckOutSystemsUIScript, IsDesktop_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.IsDesktop`

## IsLayoutNative (ClientAction, function)

Check if the current layout is native.

- out IsNative: Boolean - Returns True if the layout is native. False, otherwise.
- chama: IsLayoutNative_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.CheckIsLayoutNative`

## IsMenuDraggable (ClientAction)

Check if the menu is draggable or not.

- out AddDrag: Boolean - Returns True if the Menu is draggable. False, otherwise.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.IsMenuDraggable`

## IsPhone (ClientAction, function)

Check if the current device is phone

- out IsPhone: Boolean - Returns True if the current device is phone
- chama: IsPhone_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.IsPhone`

## IsRTL (ClientAction, function)

Function that exposes if RTL is applied.

- out IsRTL: Boolean - Returns True if RTL is applied. False, otherwise.
- chama: IsRTL_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.GetIsRTL`

## IsRunningAsPWA (ClientAction, function)

Check if running as PWA.

- out IsStandalone: Boolean - Returns True if the app is running in standalone mode. False, otherwise.
- chama: IsRunningAsPWA_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.IsRunningAsPWA`

## IsTablet (ClientAction, function)

Check if the current device is tablet

- out IsTablet: Boolean - Returns True if the current device is tablet
- chama: CheckOutSystemsUIScript, IsTablet_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.IsTablet`

## IsWebApp (ClientAction, function)

Returns true if using a WebApp Template.

- out IsWebApp: Boolean - Returns true if using a WebApp Template
- chama: CheckOutSystemsUIScript, IsWebApp_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.IsWebApp`

## LayoutDestroy (ClientAction)

Pre-defined actions to properly destroy layout for reactive and native applications.

- APIs OSUI: `OutSystems.OSUI.Utils.LayoutPrivate.Dispose`

## LayoutReady (ClientAction)

Pre-defined actions to prepare your layout for reactive and native applications.

- chama: FixInputs
- APIs OSUI: `OutSystems.OSUI.Utils.LayoutPrivate.SetA11Y`, `OutSystems.OSUI.Utils.LayoutPrivate.OnOrientationChange.Set`, `OutSystems.OSUI.Utils.Application.SetExpandableExceptions`, `OutSystems.OSUI.Utils.LayoutPrivate.SkipContentLink.Set`, `OutSystems.OSUI.Utils.LayoutPrivate.CssBodyVariables.Set`, `OutSystems.OSUI.Utils.LayoutPrivate.CloseDeprecatedSubmenu.Set`

## ListItemHint (ClientAction)

Action to hint users that the list item has swipe actions available to use, either on the left or right side. In case of both left and right actions, the default animation is on the left. This animation will be active when there are left and/or right actions available, based on the animation time parameter.

- in ListId: Text [obrigatorio] - Set the List to add the animation effect to the first item
- in HasLeftAction: Boolean [obrigatorio] - Set to True in case of left actions
- in HasRightAction: Boolean [obrigatorio] - Set to True in case of right actions
- in AnimationTime: Decimal [obrigatorio] - The total time it takes to display the action hint, hold it and then hide it again. You can increase and decrease the time, depending on whether you want the animation to take longer or less.
- out Success: Boolean
- out ErrorMessage: ErrorMessage
- APIs OSUI: `OutSystems.OSUI.Utils.ListItemAnimate`

## LoadOutSystemsUIScript (ClientAction)

Checks if the OutSystemsUI script is already defined. Otherwise, the script is loaded. This is used on DevicedDetection client actions, that could be used in contexts where the script was not loaded yet. Please note, don't use calls to OutSystems UI API on this action.

- chama: CheckOutSystemsUIScript

## MasterDetailSetContentFocus (ClientAction)

Use this action on the ListItemOnClick action from the list in your Master Detail. 

This is needed for Accessibility compliance, as it allows the changing of focus between the detail and the next listitem.

- in ContentId: Text [obrigatorio] - Id from the content that will be focused.
- in TriggerItem: Text [obrigatorio] - Id from item that was clicked.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: CheckOutSystemsUIScript, MasterDetailSetContentFocus_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.SetFocusBehaviour`

## MenuDestroy (ClientAction)

Pre-defined action to properly destroy menu for reactive and native applications.

- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.OnDestroy`

## MenuHide (ClientAction)

Closes the extended menu content.

- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.MenuHide`

## MenuReady (ClientAction)

Pre-defined action to prepare your menu for reactive and native applications.

- in Callback: Object - Callback to be registered on the Menu for the screen's orientation change event, used only for TabletApps (Template_TabletApp > Menu)
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.OnReady`

## MenuShow (ClientAction)

Opens the extended menu content.

- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.MenuShow`

## MonthPickerClear (ClientAction)

Cleans a MonthPicker with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the MonthPicker widget.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.MonthPickerAPI.Clear`

## MonthPickerClose (ClientAction)

Closes a MonthPicker block with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the MonthPicker block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.MonthPickerAPI.Close`

## MonthPickerGetMonthYearFromDate (ClientAction, function)

Get the Month identifier and Year from a date.

- in Date: Date Time [obrigatorio] - The Date to get the Month identifier from.
- out MonthYear: MonthYear - Structure with the Month identifier and Year.

## MonthPickerOpen (ClientAction)

Opens a MonthPicker block with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the MonthPicker block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.MonthPickerAPI.Open`

## MonthPickerSetEditableInput (ClientAction)

Use this action to enable the end-user to write on the MonthPicker input. By default, the input is read-only.

- in WidgetId: Text [obrigatorio] - Identifier of the MonthPicker block.
- in IsEditableInput: Boolean = True - Set if the input of the MonthPicker is editable or not. If True, the user will be able to write on the input. If False, the input will be read-only.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.MonthPickerAPI.SetEditableInput`

## MonthPickerSetLanguage (ClientAction)

Set a new language on a MonthPicker block with a given identifier. All the elements shown in the MonthPicker will the translated into the selected language.

- in WidgetId: Text [obrigatorio] - Identifier of the MonthPicker block.
- in Language: DatePickerLanguage Identifier [obrigatorio] - The ISO 639-1 code of the language. Example: en, fr, jpn
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.MonthPickerAPI.SetLanguage`

## MonthPickerUpdateMonth (ClientAction)

Update the selected month shown in a given MonthPicker.

- in WidgetId: Text [obrigatorio] - Identifier of the MonthPicker block.
- in NewMonth: MonthYear [obrigatorio] - The new selected month for the DatePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.MonthPickerAPI.UpdateInitialMonth`

## MonthPickerUpdatePrompt (ClientAction)

Update the prompt message in a given MonthPicker. Use this action for changing the prompt message based on certain conditions or when using variables.

- in WidgetId: Text [obrigatorio] - Identifier of the MonthPicker block.
- in Prompt: Text [obrigatorio] - The new prompt message for the MonthPicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.MonthPickerAPI.UpdatePrompt`

## MoveElement (ClientAction)

Action that moves elements on the DOM tree. Define the WidgetID of the element to be moved and the Target selector that will receive the element.

Example: $actions.MoveElement($parameters.WidgetId, ".active-screen .screen");

- in WidgetId: Object [obrigatorio] - The ID of the element that will be moved.
- in Target: Object [obrigatorio] - HTML selector of the target element that will receive the element being moved
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: MoveElement_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.MoveElement`

## NotificationClose (ClientAction)

Hides a Notification with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the Notification block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.NotificationAPI.Hide`

## NotificationOpen (ClientAction)

Shows a Notification with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the Notification block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.NotificationAPI.Show`

## OverflowMenuClose (ClientAction)

Closes a OverflowMenu with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the OverflowMenu block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.OverflowMenuAPI.Close`

## OverflowMenuDisable (ClientAction)

Sets a OverflowMenu with given identifier as disabled.

- in WidgetId: Text [obrigatorio] - Identifier of the OverflowMenu block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.OverflowMenuAPI.Disable`

## OverflowMenuEnable (ClientAction)

Sets a OverflowMenu with given identifier as enabled.

- in WidgetId: Text [obrigatorio] - Identifier of the OverflowMenu block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.OverflowMenuAPI.Enable`

## OverflowMenuOpen (ClientAction)

Opens a OverflowMenu with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the OverflowMenu block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.OverflowMenuAPI.Open`

## ProgressApplyGradient (ClientAction)

Use to apply a gradient to the ProgressBar or ProgressCircle.

- in WidgetId: Text [obrigatorio] - Identifier of the ProgressBar/Circle block.
- in GradientType: Gradient Identifier = Entities.Gradient.LinearHorizontal - The type of gradient to be applied to the progress.
- in Colors: GradientColor List [obrigatorio] - List of hex colors in the gradient. The gradient will be applied according to the order of colors.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.ProgressAPI.ProgressApplyGradient`

## RangeSliderDisable (ClientAction)

Method that will set RangeSlider with given RangeSlider ID as Disabled.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSlider block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.Disable`

## RangeSliderEnable (ClientAction)

Method that will set RangeSlider with given RangeSlider ID as Enabled.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSlider block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.Enable`

## RatingDisable (ClientAction)

Method that will set Rating with given Rating ID as Disabled.

- in WidgetId: Text [obrigatorio] - Identifier of the Rating block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RatingAPI.Disable`

## RatingEnable (ClientAction)

Method that will set Rating with given Rating ID as Enabled.

- in WidgetId: Text [obrigatorio] - Identifier of the Rating block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RatingAPI.Enable`

## ResetProgressBar (ClientAction)

Resets the ProgressBar value to the Progress value.

- in WidgetId: Text [obrigatorio] - Identifier of the ProgressBar block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.ProgressAPI.ResetProgressValue`

## ResetProgressCircle (ClientAction)

Resets the ProgressCircle value to the Progress value.

- in WidgetId: Text [obrigatorio] - Identifier of the ProgressCircle block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.ProgressAPI.ResetProgressValue`

## ResetRangeSlider (ClientAction)

Resets the RangeSlider value to the StartingValue.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSlider block
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.ResetRangeSliderValue`

## ResetRangeSliderInterval (ClientAction)

Resets the RangeSlider value to the IntervalStart and IntervalEnd values.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSliderInterval block
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.ResetRangeSliderValue`

## ScrollToElement (ClientAction)

Automatically scroll to a given element on the page.

- in WidgetId: Text [obrigatorio] - The target element to scroll to after the page loads.
- in IsSmooth: Boolean = True - If IsSmooth is true, the navigation to destination will animate. If set to false, it will navigate instantly.
- in OffSet: Integer = 0 - Space, in pixels, that you want of margin from the top.
- in ElementParentClass: Text - Set the name of the CSS class of the element inside which the scroll will happen (parent of the element).Fill this property when the element is not on the page body. By default (if left empty), the action will scroll to the element with the given WidgetID in the page body.
Below, you'll find some examples of situations where it's necessary to set this property and the corresponding value:
- Popup: "popup-dialog"
- Sidebar: “osui-sidebar__content”
- BottomSheet: “osui-bottom-sheet__content"
- in ScrollDelay: Integer = 0 - Sets the delay for the start of the scroll, in milliseconds.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.ScrollToElement`

## SetAccessibilityRole (ClientAction)

Use this action to set the aria-role of an element, for better Accessibility compliance.

E.g. use this action to change Alert default values for the role attribute. This action should be used only when the pattern's visibility is set to true.

- in WidgetId: Text [obrigatorio] - The widget's id that is going to be altered.
- in Role: Text [obrigatorio] - The role's attribute.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: CheckOutSystemsUIScript, SetAccessibilityRole_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.Accessibility.SetAccessibilityRole`

## SetActiveElement (ClientAction)

Allows to change the selected state of Cards and List Items. Set a Widget Id and the Active state to change an element on the screen.

- in WidgetId: Text [obrigatorio] - Element that will be marked as selected
- in IsActive: Boolean [obrigatorio] - Set the state of the target element, passed with a Widget Id
- out Success: Boolean
- out ErrorMessage: ErrorMessage
- APIs OSUI: `OutSystems.OSUI.Utils.SetActiveElement`

## SetActiveMenuItems (ClientAction)

Adds the selected states to menu items.

- in WidgetId: Text - Pass the widget id in order to isolate the context menu where the actions will be applied.
If this is empty, the logic will be applied in the context of the ".app-menu-links" element.
- in ActiveItem: Integer = -1 - Manually set as active a menu item, using it's index.
- in ActiveSubItem: Integer = -1 - Manually set as active a submenu item, using it's index.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.SetActiveMenuItems`

## SetActiveTab (ClientAction)

Action to change to specific TabsHeaderItem.

- in WidgetId: Text [obrigatorio] - Widget Id of the Tabs.
- in TabsNumber: Integer [obrigatorio] - TabsHeaderItem element index to navigate to.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TabsAPI.SetActiveTab`

## SetAriaHidden (ClientAction)

Use this action to toggle the status of the aria-hidden attribute of an element.

- in WidgetId: Text [obrigatorio] - The target element to receive the attribute.
- in IsHidden: Boolean [obrigatorio] - Option to control the hidden status between true or false.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: CheckOutSystemsUIScript, SetAriaHidden_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.Accessibility.SetAriaHidden`

## SetBottomBarActiveElement (ClientAction)

Use this action on a BottomBar block to set an active state to a BottomBarItem.

Used by default on the BottomBar block inside the OutSystems UI Mobile Templates.

- in ActiveItem: Integer = -1 - Index of the Current Active Item.

The index starts on 0.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.SetBottomBarActiveElement`

## SetCarouselDirection (ClientAction)

Set the direction in which the carousel is sliding when it is automatically looping (Loop). By default, the carousel direction is from left to right.

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block.
- in Direction: CarouselDirection Identifier [obrigatorio] - The direction of the carousel. By default, from left to right.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.SetCarouselDirection`

## SetDeviceBreakpoints (ClientAction)

Use this action to set custom breakpoints for Phone and Tablet.

Must be used on the OnApplicationStart of your App.

- in DeviceConfiguration: DeviceConfiguration [obrigatorio] - Set the new device breakpoints that identify tablet and phone devices. 
By default, screen resolutions between 1024px to 768px of width are recognized as tablets and screen resolutions lower than 768px of width are recognized as phones.
- chama: SetDeviceBreakpoints_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.DeviceDetection.SetDeviceBreakpoints`

## SetFlatpickrConfigs (ClientAction)

Use this action on the Initialized event of the DatePicker Pattern, to set additional configs supported by the provider.

Use this link to check all available configs: https://flatpickr.js.org/options/

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block where the configurations will be applied.
- in ProviderConfigs: FlatpickrConfigs - List of available provider configurations that can be customized.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.GetPickerExtensibilityAPI`

## SetFlatpickrEvent (ClientAction)

Use this action on the Initialized event of the DatePicker Pattern, to set additional events supported by the provider.

Use this link to check all available configs: https://flatpickr.js.org/events/

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block where the event listener will be added.
- in EventName: Text [obrigatorio] - Define the name of the event to be added to the DatePicker element.
Examples:

"onChange": triggered on every date selection.

"onClose": triggered every time the DatePicker is closed.

"onOpen": triggered every time the DatePicker is opened.

Check all available events at: https://flatpickr.js.org/events/
- in Handler: Object - Action that will be performed once the event with the EventName occurs. Note: Please ensure that inside the JS Node, the client actions are correctly referenced. E.g. ClientActionName with no ()
- out FlatpickrEventId: Text - FlatpickrEventId: Identifier of the event. You can use the id on the UnsetFlatpickrEvent to remove the handler from a given DatePicker block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.GetPickerExtensibilityAPI`

## SetFocus (ClientAction)

Use this action to focus the element.

- in WidgetId: Text [obrigatorio] - The target element to get focused.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: CheckOutSystemsUIScript, SetFocus_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.Accessibility.SetFocus`

## SetLang (ClientAction)

Use this action to specify the language of the element's content. E.g. "en"

- in Lang: Text = "" - Set the lang attribute to be defined on the html.

Check all the correct ISO Languange Code:
https://www.w3schools.com/tags/ref_language_codes.asp
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: CheckOutSystemsUIScript, SetLang_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.Accessibility.SetLang`

## SetMenuAttributes (ClientAction)

Supports the items accessible on the menu.

- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.SetMenuAttributes`

## SetMenuIcon (ClientAction)

Changes the menu icon automatic behavior.

- in MenuAction: MenuAction Identifier [obrigatorio] - Identifier of the Menu Action to be set.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.SetMenuIcon`

## SetMenuIconListeners (ClientAction)

Makes the menu accessibility-ready.

- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.SetMenuIconListeners`

## SetMenuListeners (ClientAction)

Makes the menu navigation accessibility-ready.

- in WidgetId: Text - Pass the widget id in order to isolate the context menu where the actions will be applied.
If this is empty, the logic will be applied in the context of the ".app-menu-links" element.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.SetMenuListeners`

## SetNoUISliderConfigs (ClientAction)

Use this action on the Initialized event of the RangeSlider Pattern, to set additional configs supported by the provider.

Use this link to check all available configs: https://refreshless.com/nouislider/slider-options/

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSlider block where the configurations will be applied.
- in ProviderConfigs: NoUiSliderConfigs - List of provider configurations that can be customized.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.SetProviderConfigs`

## SetNoUISliderEvent (ClientAction)

Use this action on the Initialized event of the RangeSlider Pattern, to set additional events supported by the provider.

Use this link to check all available configs: https://refreshless.com/nouislider/events-callbacks/

- in WidgetId: Text [obrigatorio] - Identifier of the Dropdown block where the event listener will be added.
- in EventName: Text [obrigatorio] - Define the name of the event to be added to the RangeSlider element.
Examples:

"change": It fires when a user stops sliding, when a slider value is changed by 'tap', or on keyboard interaction.

Check all available events at: https://refreshless.com/nouislider/events-callbacks/
- in Handler: Object - Action that will be performed once the event with the EventName occurs. Note: Please ensure that inside the JS Node, the client actions are correctly referenced. E.g. ClientActionName with no ()
- out NoUISliderEventId: Text - NoUISliderEventId: Identifier of the event. You can use the id on the UnsetNoUISliderEvent to remove the handler from a given RangeSlider block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.SetProviderEvent`

## SetProgressBarValue (ClientAction)

Set a value on the Progress Bar.

- in WidgetId: Text [obrigatorio] - The progress's id
- in Progress: Integer [obrigatorio] - The value to set the progress.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.ProgressAPI.SetProgressValue`

## SetProgressCircleValue (ClientAction)

Set a value on the Progress Circle.

- in WidgetId: Text [obrigatorio] - The progress's id
- in Progress: Integer [obrigatorio] - The value to set the progress.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.ProgressAPI.SetProgressValue`

## SetRangeSliderChangeOnDragEnd (ClientAction)

Use this action on the Initialize event or on the Screen's OnReady event.

By using this action, the change events will only be triggered when the user releases the slider.

Tip: if you're refreshing a query based on the value of the slider, we recommend using this action.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSlider block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.SetRangeIntervalChangeOnDragEnd`

## SetRangeSliderIntervalChangeOnDragEnd (ClientAction)

Use this action on the Initialize event or on the Screen's OnReady event.

By using this action, the change events will only be triggered when the user releases the slider.

Tip: if you're refreshing a query based on the value of the slider, we recommend using this action.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSliderInterval block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.SetRangeIntervalChangeOnDragEnd`

## SetRangeSliderIntervalValue (ClientAction)

Set a value on the RangeSliderInterval.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSliderInterval block
- in IntervalStart: Decimal [obrigatorio] - The minimum interval value to be set on the RangeSlider. The value must be greater or equal to the RangeSlider MinValue.
- in IntervalEnd: Decimal [obrigatorio] - The maximum interval value to be set on the RangeSlider. The value must be less or equal to the RangeSlider MaxValue.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.SetRangeSliderValue`

## SetRangeSliderValue (ClientAction)

Set a value on the RangeSlider.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSlider block
- in Value: Decimal [obrigatorio] - The value that will be set on the RangeSlider. The value must be within the MinValue and MaxValue.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.SetRangeSliderValue`

## SetSelectedTableRow (ClientAction)

To be used to complement Bulk Actions logic. Drag this action to your checkbox OnChange action.

This will afftect the styles of the checkbox used, and the selected table rows, containing a checked checkbox.

- in TableId: Text [obrigatorio] - Set the table widget Id
- in RowNumber: Integer [obrigatorio] - Set the current RowNumber
- in IsSelected: Boolean [obrigatorio] - Set the current checkbox value
- out Success: Boolean
- out ErrorMessage: ErrorMessage
- APIs OSUI: `OutSystems.OSUI.Utils.SetSelectedTableRow`

## SetSplideConfigs (ClientAction)

Use this action on the Initialized event of the Carousel Pattern, to set additional events supported by the provider.

Use this link to check all available configs: https://splidejs.com/v3/guides/options/

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block where the configurations will be applied.
- in ProviderConfigs: SplideConfigs - List of provider configurations that can be customized.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.SetProviderConfigs`

## SetSplideEvent (ClientAction)

Use this action on the Initialized event of the Carousel Pattern, to set additional configs supported by the provider.

Use this link to check all available configs: https://splidejs.com/v3/guides/events/#event-list

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block where the event listener will be added.
- in EventName: Text [obrigatorio] - Define the name of the event to be added to the Carousel element.
Examples:

"move": Fired right before the slider moves..

"resized": Fired whenever Splide completes resizing the slider.

"dragged": Fired right after the user finishes dragging the slider.

Check all available events at: https://splidejs.com/v3/guides/events/#event-list
- in Handler: Object - Action that will be performed once the event with the EventName occurs. Note: Please ensure that inside the JS Node, the client actions are correctly referenced. E.g. ClientActionName with no ()
- out SplideEventId: Text - SplideEventId: Identifier of the event. You can use the id on the UnsetSplideEvent to remove the handler from a given Carousel block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.SetProviderEvent`

## SetVirtualSelectConfigs (ClientAction)

Use this action on the Initialized event of the Dropdown (DropdownTags or DropdownSearch) block, to set additional configs supported by the provider.

Use this link to check all available configs: https://sa-si-dev.github.io/virtual-select/#/properties

- in WidgetId: Text [obrigatorio] - Identifier of the Dropdown block where the configurations will be applied.
- in ProviderConfigs: VirtualSelectConfigs - List of provider configurations that can be customized.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.SetProviderConfigs`

## SetVirtualSelectEvent (ClientAction)

Use this action on the Initialized event of the DropdownTags or DropdownSearch, to set additional events supported by the provider.

Use this link to check all available configs: https://sa-si-dev.github.io/virtual-select/#/events

- in WidgetId: Text [obrigatorio] - Identifier of the Dropdown block where the event listener will be added.
- in EventName: Text [obrigatorio] - Define the name of the event to be added to the Dropdown element.
Examples:

"change": Fired right before the slider moves..

Check all available events at: https://sa-si-dev.github.io/virtual-select/#/events
- in Handler: Object - Action that will be performed once the event with the EventName occurs. 
Note: Please ensure that inside the JS Node, the client actions are correctly referenced. 
E.g. ClientActionName with no ()
- out VirtualSelectEventId: Text - VirtualSelectEventId: Identifier of the event. You can use the id on the UnsetVirtualSelectEvent to remove the handler from a given Dropdown block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.SetProviderEvent`

## ShowPassword (ClientAction)

Shows and hides the value of an Input of type password, allowing users to view their entered password temporarily for verification or editing purposes.
If WidgetId is left empty, the action affects the first password Input on the screen.

- in WidgetId: Text - Identifier of the Input widget.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.ShowPassword`

## SidebarClickOutsideToClose (ClientAction)

Use this action to enable/disable the click outside to close the Sidebar.

- in WidgetId: Text [obrigatorio] - Identifier of the Sidebar block.
- in CloseOnOutsideClick: Boolean [obrigatorio] - Set to True to close the Sidebar when the user clicks outside.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.SidebarAPI.ClickOutsideToClose`

## SidebarClose (ClientAction)

Action to close the Sidebar block.

- in WidgetId: Text [obrigatorio] - Identifier of the Sidebar block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.SidebarAPI.Close`

## SidebarOpen (ClientAction)

Action to open the Sidebar block.

- in WidgetId: Text [obrigatorio] - Identifier of the Sidebar block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.SidebarAPI.Open`

## SidebarToggleSwipe (ClientAction)

Use this action to enable/disable the Sidebar swipe actions on Native Apps. By default, the swipe actions are enabled.

- in WidgetId: Text [obrigatorio] - Identifier of the Sidebar block.
- in EnableSwipe: Boolean = True - Set to True to enable swipe events on the Sidebar. Set to False, otherwise. By default, swipe is enabled (True).
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.SidebarAPI.ToggleGestures`

## SkipToContent (ClientAction)

Action used on OutSystems UI layouts, to allow the user to skip the navigation elements on the screen, and tab directly into content.

By default, the MainContentWrapper.Id is used. Use the targetId parameter to set a custom target.

- in TargetId: Text [obrigatorio] - Custom target element to get focused.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: SkipToContent_Legacy, CheckOutSystemsUIScript
- APIs OSUI: `OutSystems.OSUI.Utils.Accessibility.SkipToContent`

## StackedCardsSwipeLeft (ClientAction)

Call this action to swipe active card to left. You need to set the Stacked Cards ID (Widget Id).

- in WidgetId: Text [obrigatorio] - Widget Id of the StackedCards

## StackedCardsSwipeRight (ClientAction)

Call this action to swipe active card to right. You need to set the Stacked Cards ID (Widget Id).

- in WidgetId: Text [obrigatorio] - Widget Id of the StackedCards

## StackedCardsSwipeTop (ClientAction)

Call this action to swipe active card to top. You need to set the Stacked Cards ID (Widget Id).

- in WidgetId: Text [obrigatorio] - Widget Id of the StackedCards

## StackedCardsUpdate (ClientAction)

This action must be used on list remove action from OS platform. The UpdateStackedCards update all the cards and rearrange the order, scale and opacity for each one.

- in WidgetId: Text [obrigatorio] - Widget Id of the StackedCards

## StartOfflineDataSync (ClientAction)

This action starts the offline data synchronization in background.

- in SyncUnit: Text - Allows you to specify what unit to sync. This parameter is available in the 'OfflineDataSync' action, so you can have finer grain control on what data to sync.
- in DiscardPendingSyncUnits: Boolean = False - Whether pending sync units should be discarded.

## SubmenuClickOutsideToClose (ClientAction)

Use this action to enable/disable the click outside to close the Submenu.

- in WidgetId: Text [obrigatorio] - Identifier of the Submenu block.
- in CloseOnOutsideClick: Boolean [obrigatorio] - Set to False to close the Submenu when the user clicks outside.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.SubmenuAPI.ClickOutsideToClose`

## SubmenuClose (ClientAction)

Action to close the Submenu block.

- in WidgetId: Text [obrigatorio] - Identifier of the Submenu block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.SubmenuAPI.Close`

## SubmenuOpen (ClientAction)

Action to open the Submenu block.

- in WidgetId: Text [obrigatorio] - Identifier of the Submenu block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.SubmenuAPI.Open`

## SubmenuOpenOnHover (ClientAction)

Action to change the trigger that opens the Submenu block from click to hover.

- in WidgetId: Text [obrigatorio] - Identifier of the Submenu block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.SubmenuAPI.SubmenuOpenOnHover`

## TabsToggleSwipe (ClientAction)

Use this action to set the Tabs to toggle using swipe actions on Native Apps, but rather control it using the Tabs Header.

- in WidgetId: Text [obrigatorio] - Widget Id of the Tabs.
- in EnableSwipe: Boolean [obrigatorio] - Set to True to enable swipe on Tabs. Set to False, otherwise.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TabsAPI.TabsToggleSwipe`

## TextEllipsis (ClientAction, function)

Cut off text to input size ending in ...

- in Text: Text [obrigatorio] - Text that will be cut off.
- in NumberOfChars: Integer [obrigatorio] - Maximum number of chars that will be visible.
- out Out: Text - Returns the output text. It will have the maximum number of chars and will be ending in "...", if bigger than the number defined.

## TimePickerClear (ClientAction)

Cleans a TimePicker with a given identifier.

- in WidgetId: Text [obrigatorio] - Widget Id of the TimePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TimePickerAPI.Clear`

## TimePickerClose (ClientAction)

Closes a TimePicker with a given identifier.

- in WidgetId: Text [obrigatorio] - Widget Id of the TimePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TimePickerAPI.Close`

## TimePickerOpen (ClientAction)

Opens a TimePicker with a given identifier.

- in WidgetId: Text [obrigatorio] - Widget Id of the TimePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TimePickerAPI.Open`

## TimePickerSetEditableInput (ClientAction)

Use this action to enable the end-user to write on the TimePicker input. By default, the input is read-only.

- in WidgetId: Text [obrigatorio] - Widget Id of the TimePicker.
- in IsEditableInput: Boolean = True - Set if the input of the TimePicker is editable or not. If True, the user will be able to write on the input. If False, the input will be read-only.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TimePickerAPI.SetEditableInput`

## TimePickerSetLanguage (ClientAction)

Set a new language on a TimePicker block with a given identifier. All the elements shown in the TimePicker will the translated into the selected language.

- in WidgetId: Text [obrigatorio] - Widget Id of the TimePicker.
- in Language: DatePickerLanguage Identifier [obrigatorio] - The ISO 639-1 code of the language. Example: en, fr, jpn
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TimePickerAPI.SetLanguage`

## TimePickerToggleNativeBehavior (ClientAction)

Use this action to control the TimePicker behavior when opened in mobile. By default, the TimePicker is opened as native, in mobile.

- in WidgetId: Text [obrigatorio] - Widget Id of the TimePicker.
- in IsNative: Boolean [obrigatorio] - Set to True to open as native. False, otherwise.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TimePickerAPI.ToggleNativeBehavior`

## TimePickerUpdatePrompt (ClientAction)

Update the prompt message in a given TimePicker. Use this action for changing the prompt message based on certain conditions or when using variables.

- in WidgetId: Text [obrigatorio] - Identifier of the TimePicker block.
- in Prompt: Text [obrigatorio] - The new prompt message for the TimePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TimePickerAPI.UpdatePrompt`

## TimePickerUpdateTime (ClientAction)

Update the selected time shown in a given TimePicker.

- in WidgetId: Text [obrigatorio] - Widget Id of the TimePicker.
- in NewTime: Time [obrigatorio] - The new selected start time for the TimePicker.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TimePickerAPI.UpdateInitialTime`

## ToggleSideMenu (ClientAction)

Expands the menu.

- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.Menu.ToggleSideMenu`

## ToggleTextSpacing (ClientAction)

Use this action to increase the letter spacing, word spacing and line-height across the application

- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- chama: CheckOutSystemsUIScript, ToggleTextSpacing_Legacy
- APIs OSUI: `OutSystems.OSUI.Utils.Accessibility.ToggleTextSpacing`

## TooltipClose (ClientAction)

Action to close the Tooltip block.

- in WidgetId: Text [obrigatorio] - Identifier of the Tooltip block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TooltipAPI.Close`

## TooltipOpen (ClientAction)

Action to open the Tooltip block.

- in WidgetId: Text [obrigatorio] - Identifier of the Tooltip block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.TooltipAPI.Open`

## UnsetFlatpickrEvent (ClientAction)

Remove an event handler from a given DatePicker block.

- in WidgetId: Text [obrigatorio] - Identifier of the DatePicker block where the event listener will be removed.
- in FlatpickrEventId: Text [obrigatorio] - FlatpickrEventId: Identifier of the event. This id is returned by the SetFlatpickrEvent client action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Utils.GetPickerExtensibilityAPI`

## UnsetNoUISliderEvent (ClientAction)

Remove an event handler from a given RangeSlider block.

- in WidgetId: Text [obrigatorio] - Identifier of the RangeSlider block where the event listener will be removed.
- in NoUISliderEventId: Text [obrigatorio] - NoUISliderId: Identifier of the event. This id is returned by the SetNoUISliderEvent client action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.RangeSliderAPI.UnsetProviderEvent`

## UnsetSplideEvent (ClientAction)

Remove an event handler from a given Carousel block.

- in WidgetId: Text [obrigatorio] - Identifier of the Carousel block where the event listener will be removed.
- in SplideEventId: Text [obrigatorio] - SplideEventId: Identifier of the event. This id is returned by the SetSplideEvent client action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.CarouselAPI.UnsetProviderEvent`

## UnsetVirtualSelectEvent (ClientAction)

Remove an event handler from a given DropdownTags or DropdownSearch block.

- in WidgetId: Text [obrigatorio] - Identifier of the Dropdown block where the event listener will be removed.
- in VirtualSelectEventId: Text [obrigatorio] - VirtualSelectId: Identifier of the event. This id is returned by the SetVirtualSelectEvent client action.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.DropdownAPI.UnsetProviderEvent`

## VideoGetState (ClientAction)

Returns the reproduction state of the video. The different states of the video are:
- Unstarted: if the video did not start being played.
- Playing: if the video is being played.
- Paused: if the video is currently paused.
- Ended: if the video is ended.

- in WidgetId: Text [obrigatorio] - Identifier of the Video block.
- out VideoState: VideoState Identifier - The state of the video.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.VideoAPI.GetState`

## VideoJumpToTime (ClientAction)

Jump to a specific time of a Video with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the Video block.
- in JumpToTime: Time [obrigatorio] - Specific time, in seconds, on a given video where you want to navigate.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.VideoAPI.JumpToTime`, `OSFramework.OSUI.Helper.Times.ConvertInSeconds`

## VideoPause (ClientAction)

Pause a Video with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the Video block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.VideoAPI.Pause`

## VideoPlay (ClientAction)

Play a Video with a given identifier.

- in WidgetId: Text [obrigatorio] - Identifier of the Video block.
- out Success: Boolean - Boolean that indicates if the action was successfully performed.
- out ErrorMessage: ErrorMessage - Shows details about errors that occur after performing the action. It contains a code and a message explaining the error.
- APIs OSUI: `OutSystems.OSUI.Patterns.VideoAPI.Play`

