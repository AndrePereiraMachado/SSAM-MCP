# OutSystemsUIWeb 1.12.8: actions publicas

## AddDeviceMetatag (ServerAction)

Adds the respective metatags for android or ios to make width=device-width. Useful for layouts.

- chama: AddMetaTag

## EncapsulateJS (ServerAction, function)

Encapsulates content in <script> tag.﻿

- in Content: Text [obrigatorio] - JavaScript to set inside a <script> tag.
- out Out: Text

## EnterAnimation (ServerAction)

Set type of enter animation for a specific block.

- in WidgetId: Text [obrigatorio] - Name of the block to be affected.
- in EnterAnimation: EnterAnimation Identifier [obrigatorio] - Animation that will be used as the block enters.
- chama: RunJavaScript

## GetBrowser (ServerAction, function)

Gets the browser.

- out Browser: Text
- chama: GetCookie

## GetDevice (ServerAction, function)

Gets the Device.

- out Device: Text
- chama: GetCookie

## GetDeviceOrientation (ServerAction, function)

Gets the Device Orientation.

- out Orientation: Text
- chama: GetCookie

## GetOS (ServerAction, function)

Gets the Operating System.

- out OS: Text
- chama: GetCookie

## GoTo (ServerAction)

Go to a specific item on Carousel. It's a zero-based action, meaning that the first item index is 0.

- in WidgetId: Text [obrigatorio]
- in Index: Integer [obrigatorio]
- chama: RunJavaScript

## HideElement (ServerAction)

Hide a specific block.

- in WidgetId: Text [obrigatorio] - Name of the block to be affected.
- chama: RunJavaScript

## IsDesktop (ServerAction, function)

- out IsDesktop: Boolean
- chama: GetDevice

## IsPhone (ServerAction, function)

Indicates if the app is currently running on a phone.

- out IsPhone: Boolean
- chama: GetDevice

## IsTablet (ServerAction, function)

Indicates if the app is currently running on a tablet.

- out IsTablet: Boolean
- chama: GetDevice

## Next (ServerAction)

Go to the next item on Carousel.

- in WidgetId: Text [obrigatorio]
- chama: RunJavaScript

## PauseVideo (ServerAction)

- in WidgetId: Text [obrigatorio]
- chama: RunJavaScript

## PlayVideo (ServerAction)

- in WidgetId: Text [obrigatorio]
- chama: RunJavaScript

## Previous (ServerAction)

Go to the previous item on Carousel.

- in WidgetId: Text [obrigatorio]
- chama: RunJavaScript

## ScrollToElement (ServerAction)

Automatically scroll to a given element on the page.

- in WidgetId: Text [obrigatorio] - The target element to scroll to after the page loads.
- in IsSmooth: Boolean = True - If IsSmooth is true, the navigation to destination will animate. If set to false, it will navigate instantly.
- in OffSet: Integer = 0 - Space, in pixels, that you want of margin from the top.
- chama: RunJavaScript

## SetAriaHidden (ServerAction)

Use this action to toggle the status of the aria-hidden attribute of an element.

- in WidgetId: Text [obrigatorio] - Name of the block to be affected.
- in IsHidden: Boolean [obrigatorio] - Variable that holds the value of the aria-hidden attribute.
- chama: RunJavaScript

## SetFocus (ServerAction)

Use this action to set the focus to an element.

- in WidgetId: Text [obrigatorio] - Name of the block to be affected.
- chama: RunJavaScript

## SetHourFor12hFormat (ServerAction)

Returns Set 12h format time (06:00pm) into a 24h format hour (18)

- in Time12Format: Text [obrigatorio]
- out Hour24Format: Text
- chama: Feedback_Message

## ShowElement (ServerAction)

Show a specific block.

- in WidgetId: Text [obrigatorio] - Name of the block to be affected.
- chama: RunJavaScript

## TextEllipsis (ServerAction, function)

Cut off text to input size ending in ...

- in Text: Text [obrigatorio]
- in NumberOfChars: Integer [obrigatorio]
- out Out: Text

## ToggleAnimate (ServerAction)

Toggle the Enter and Leave Animation from Animate pattern.

- in WidgetId: Text [obrigatorio] - Name of the block to be affected.
- chama: RunJavaScript

## ToggleChatActions (ServerAction)

Toggle Actions placeholder from ChatMessage pattern.

- in WidgetId: Text [obrigatorio] - Name of the block to be affected.
- chama: RunJavaScript

## ToggleElement (ServerAction)

Toggle a specific block.

- in WidgetId: Text [obrigatorio] - Name of the block to be affected.
- in TriggerButtonId: Text - Id of the button that triggers the interaction. Use this parameter to ensure the focus stays in the same trigger, after closing the element. 

This is important for Accessibility compliance.
- chama: RunJavaScript

## ToggleFlipContent (ServerAction)

- in WidgetId: Text [obrigatorio]
- chama: RunJavaScript

## ToggleModal (ServerAction)

Toggles the opening and closing of a specific modal.

- in WidgetId: Text [obrigatorio] - Toggle a specific modal.
- in TriggerButtonId: Text - Id of the button that triggers the interaction. Use this parameter to ensure the focus stays in the same trigger after closing the element. 

This is important for Acessibility compliance.
- chama: ToggleElement

## TogglePassword (ServerAction)

Use this action to show or hide the password on an input widget of type password, a common use case for login screens.

- in WidgetId: Text [obrigatorio] - Name of the input to be affected.
- chama: RunJavaScript

## ToggleSidebar (ServerAction)

Toggles the opening and closing of a specific sidebar.

- in WidgetId: Text [obrigatorio] - Toggle a specific sidebar.
- in TriggerButtonId: Text - Id of the button that triggers the interaction. Use this parameter to ensure the focus stays in the same trigger after closing the element. 

This is important for Acessibility compliance.
- chama: ToggleElement

