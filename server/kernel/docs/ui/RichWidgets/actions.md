# RichWidgets : actions publicas

## Date_MonthName (ServerAction, function)

Returns the name of the month in a date.

- in Date: Date [obrigatorio] - The date containing the month to get the name.
- out MonthName: Text - The name of the month.

## Date_PrettyFormat (ServerAction, function)

Formats a date relatively to today’s date:
<= 1 day
    yesterday, today, tomorrow
<= 14 days
    8 Aug (9 days ago), 27 Aug (in 10 days)
<= 30 days
    30 Jul (3 weeks ago), 16 Sep (in 4 weeks)
> 30 days
   30 Apr, 20 Oct
For a different year
    2008/11/30, 2014/03/30
    In this case:
       - It overrides the previous formats except the first one.
        - The date format is as defined in the Service Center.

- in Date: Date [obrigatorio] - The date to format.
- out FormattedText: Text - Returns a date relatively to today’s date:
<= 1 day
    yesterday, today, tomorrow
<= 14 days
    8 Aug (9 days ago), 27 Aug (in 10 days)
<= 30 days
    30 Jul (3 weeks ago), 16 Sep (in 4 weeks)
> 30 days
   30 Apr, 20 Oct
For a different year
    2008/11/30, 2014/03/30
    In this case:
       - It overrides the previous formats except the first one.
        - The date format is as defined in the Service Center.

## DateTime_PrettyFormat (ServerAction, function)

Formats a date and time relatively to the current moment.
<= 1 min
    16:08 (just now)
< 24 hours
    16:07 (1 minute ago), 22:09 (in 6 hours)
>=24 hours and <= 1 day
    yesterday, today, tomorrow
<= 30 days
    30 Jul (3 weeks ago), 8 Aug (9 days ago), 27 Aug (in 10 days), 16 Sep (in 4 weeks)
> 30 days
   30 Apr, 20 Oct
The year is different 
    2008/11/30, 2014/03/30
    In this case:
       - It overrides the previous formats except the first one.
        - The date format is as defined in the Service Center.

- in DateTime: Date Time [obrigatorio] - The date to format.
- out FormattedText: Text - Returns the date and time relatively to the current moment.
<= 1 min
    16:08 (just now)
< 24 hours
    16:07 (1 minute ago), 22:09 (in 6 hours)
>=24 hours and <= 1 day
    yesterday, today, tomorrow
<= 30 days
    30 Jul (3 weeks ago), 8 Aug (9 days ago), 27 Aug (in 10 days), 16 Sep (in 4 weeks)
> 30 days
   30 Apr, 20 Oct
The year is different 
    2008/11/30, 2014/03/30
    In this case:
       - It overrides the previous formats except the first one.
        - The date format is as defined in the Service Center.

## Deprecated_RecentItem_Add (ServerAction)

DEPRECATED: Add a new item for the current URL to the recent items list.

- in Label: Text [obrigatorio] - The name that identifies the item.
- in Tag: Text - The type of the item.
- chama: CreateRecentItem, UpdateRecentItem

## Deprecated_RecentItem_Remove (ServerAction)

DEPRECATED: Removes the item for the current URL from the recent items list.

- chama: DeleteRecentItem

## Feedback_Message (ServerAction)

Sets the message to be displayed on the Feedback_Message widget.

- in MessageText: Text [obrigatorio] - The content of the feedback message.
- in MessageType: MessageType Identifier [obrigatorio] - The type of the message for the Feedback_Message widget.
- chama: RunJavaScript

## FormatAddress (ServerAction, function)

Returns an address with specified elements separated by commas (',').

- in Address: Text [obrigatorio] - The street, number, floor, etc.
- in PostalCode: Text [obrigatorio] - The postal code.
- in City: Text [obrigatorio] - The name of the city.
- in Country: Text [obrigatorio] - The name of the country.
- out CompleteAddress: Text - The formatted address: <Address>, <Postal Code>, <City>, <Country>

## GetApplicationName (ServerAction, function)

Returns the name of the application for the specified eSpace.

- in ESpaceId: Espace Identifier [obrigatorio] - The identifier of the eSpace.
Use the GetOwnerEspaceIdentifier() built-in function to get the eSpace identifier from an eSpace element.
- out ApplicationName: Text - The name of the application.

## GetServerName (ServerAction, function)

- out ServerName: Text

## Input_AutoComplete_GetIdentifier (ServerAction, function)

Gets the identifier of the currently selected value in the Input widget bound to an Input_AutoComplete widget.

- in InputWidgetId: Text [obrigatorio] - The 'Id' runtime property of the Input widget bound to the Input_AutoComplete widget.
- in PreviousIdentifier: Text = "" - The identifier of the previously selected value which is returned when no changes occurr.
- out Identifier: Text - The identifier of the currently selected value.

## Input_AutoComplete_ShowList (ServerAction)

Shows the list of options for the drop down list of an Input widget bound to an Input_AutoComplete widget.

- in InputWidgetId: Text [obrigatorio] - The 'Id' runtime property of the Input widget bound to the Input_AutoComplete widget.
- in List: Input_AutoComplete_ListEntry Record List [obrigatorio] - The list of options filled with 'Input_AutoComplete_ListEntry' records.
- chama: StringBuilder_Create, StringBuilder_ToString, RunJavaScript, StringBuilder_Append

## Input_FocusFirstInvalid (ServerAction)

Set the focus in the first invalid input.

- chama: RunJavaScript

## IsMobileBrowser (ServerAction, function)

Returns whether the browser that is currently making the request is a mobile browser. 
This is done using regular expressions on the browser user agent. 
To add more mobile browsers change Richwidgets.Site.MobileBrowsersRegExp1 and Richwidgets.Site.MobileBrowsersRegExp2.

- out IsMobileBrowser: Boolean - Returns True if it is a mobile browser.
- chama: Regex_Search

## List_BulkSelectToggleEnabled (ServerAction)

Disables buttons associated with listed rows when no row is selected in the Table Records widget.

- in TableRecordsWidget: Text [obrigatorio] - The 'Id' runtime property of the Table Records widget.
- in ButtonWidgetList: Text [obrigatorio] - The 'Id' runtime properties of all Button widgets separated by commas (',').
- chama: RunJavaScript

## List_Move_Down (ServerAction, function)

Use this action in the 'OnNotify' action of the 'List_Move' widget to know the move direction.
Compare with the 'NotifyWidgetGetMessage()' built-in action.

- out Message: Text - Returns 'DOWN'.

## List_Move_Up (ServerAction, function)

Use this action in the 'OnNotify' action of the 'List_Move' widget to know the move direction.
Compare with the 'NotifyWidgetGetMessage()' built-in action.

- out Message: Text - Returns 'UP'.

## List_Navigation_GetStartIndex (ServerAction, function)

Resets the index stored in the Session Variable that is used in the 'List_Navigation_GetStartIndex' action.

- in ListWidgetId: Text [obrigatorio] - The 'Id' runtime property of the paginated TableRecords or ListRecords widget.
- in RememberStartIndex: Boolean = False - If True, a Session Variable is used to store the index of the first row to be shown. 
The default value is False.
- in StartIndexOverride: Integer = -1 - The index of the first row to be shown.
The default is the first row or the one stored in the Session Variable (if enabled).
- out StartIndex: Integer - The start index for the TableRecords or ListRecords widget.
- chama: Private_List_Navigation_SaveStartIndex

## List_Navigation_ResetStartIndex (ServerAction)

Clears the session variable used to remember the index of the first row to show in the page.

- in ListWidgetId: Text [obrigatorio] - The 'Id' runtime property of the paginated TableRecords or ListRecords widget.
- chama: Private_List_Navigation_SaveStartIndex

## List_SortColumn_GetOrderBy (ServerAction, function)

Retrieves the order by string currently in use by a TableRecords widget (if any).

- in TableRecordsId: Text [obrigatorio] - The 'Id' runtime property of the TableRecords widget.
- in DefaultOrder: Text - Set with an order by string to be returned if no order by string exists.
- out OrderBy: Text - Returns the order by string.

## List_SortColumn_SetOrderBy (ServerAction)

Sets the which column the rows in the Table Records widget are going to be sorted.

- in TableRecordsId: Text [obrigatorio] - The 'Id' runtime property of the TableRecords widget.
- in Column: Text [obrigatorio] - The name of the column to be sorted.
- in Direction: Text = "ASC" - Sets the sort direction: 'ASC' for ascending order or 'DESC' for descending order.
The default is 'ASC'.

## Menu_GetStyle (ServerAction, function)

Returns the styles for the menu options.

- in IsActive: Boolean [obrigatorio] - If True, the 'ActiveStyle' value is returned.
If False, the 'InactiveStyle' value is returned.
- in ActiveStyle: Text = "Menu_TopMenu Menu_TopMenuActive" - Set with the your style for the active menu option.
The default value is 'Menu_TopMenu Menu_TopMenuActive'.
- in InactiveStyle: Text = "Menu_TopMenu" - Set with the your style for an inactive menu option.
The default value is 'Menu_TopMenu'.
- out Style: Text - Returns the style for the menu option.

## Popup_Editor_Close (ServerAction)

Closes a PopupEditor window.

- chama: RunJavaScript

## Popup_Editor_GetMessage (ServerAction)

Returns the notification message sent by the Notify action.

- out Message: Text
- chama: Deprecated_NotifyGetMessage

## Popup_Editor_Notify (ServerAction)

Makes a PopupEditor trigger the OnNotify action on the web block.

- in Argument: Text [obrigatorio]
- chama: RunJavaScript

## Popup_Upload_GetFile (ServerAction, function)

DEPRECATED: Returns the binary file uploaded in the Popup_Upload web screen. 

This action should be run on the OnNotify action of the Popup_Editor widget that links to the Popup_Upload web screen and in the Id parameter it should send the result of NotifyWidgetGetMessage() built-in function.

- in Id: Integer [obrigatorio] - The Id of the uploaded file, which is passed by Popup_Upload as the message of the OnNotify
- out File: UploadedFile Record - Returns the uploaded file data.
- chama: DeleteUploadCache, GetUploadCache

## Tabs_ClientSide_GetJavaScriptToActivateTab (ServerAction, function)

Returns the JavaScript code to activate a tab. Use it to fill the URL property of an External Site link or in the onclick extended property of buttons.

- in TabsWidgetId: Text [obrigatorio] - The Id of the Tabs_ClientSide web block widget
- in Tab: Text [obrigatorio] - The Id or the title extended property of the tab to activate.
- in IgnoreErrors: Boolean = False - When set to True, disables the display of error messages.
- out JavaScript: Text - The JavaScript code that activates the specified tab.

## Tabs_ClientSide_GetJavaScriptToDisableTab (ServerAction, function)

Returns the JavaScript code to disable a tab. Use it to fill the URL property of an External Site link or in the onclick extended property of buttons.

- in TabsWidgetId: Text [obrigatorio] - The Id of the Tabs_ClientSide web block widget
- in Tab: Text [obrigatorio] - The Id or the title extended property of the tab to disable.
- in IgnoreErrors: Boolean = False - When set to True, disables the display of error messages.
- out JavaScript: Text - The JavaScript code that enables the specified tab.

## Tabs_ClientSide_GetJavaScriptToEnableTab (ServerAction, function)

Returns the JavaScript code to enable a tab. Use it to fill the URL property of an External Site link or in the onclick extended property of buttons.

- in TabsWidgetId: Text [obrigatorio] - The Id of the Tabs_ClientSide web block widget
- in Tab: Text [obrigatorio] - The Id or the title extended property of the tab to enable.
- in IgnoreErrors: Boolean = False - When set to True, disables the display of error messages.
- out JavaScript: Text - The JavaScript code that enables the specified tab.

## Tabs_ClientSide_SetNextActiveTab (ServerAction)

Sets the tab that will be active the next time the page is displayed. It has no effect if used on the Preparation of the page when IsLoadingScreen() is true. In that case, use the InitialActiveTab parameter of the Tabs_ClientSide web block instead.

- in TabsWidgetId: Text [obrigatorio] - The Id of the Tabs_ClientSide web block widget.
- in Tab: Text [obrigatorio] - The Id or the title extended property of the tab that will be active the next time the page is displayed.

## Widget_Click (ServerAction)

Clicks a button or a link. It does not work for Links with Method Navigate or Submit.

- in WidgetId: Text [obrigatorio] - The id of the link or button to click (triggers the onclick event).
- chama: RunJavaScript

## Widget_Hide (ServerAction)

Hides a widget by setting the CSS property 'display' to 'none'.

- in WidgetId: Text [obrigatorio] - The id of the widget to hide.
- chama: RunJavaScript

## Widget_Show (ServerAction)

Shows a widget by setting the CSS property 'display' to ''. Only works if the widget was hidden by setting that property to 'none'. It won't work for widgets hidden by setting their 'Visible' property to false.

- in WidgetId: Text [obrigatorio] - The id of the widget to show.
- chama: RunJavaScript

