# OutSystemsUIWeb 1.12.8: valores de configuracao (static entities)

## Entities.Alert

Different types of alert messages.

| Id | Alert |
|---|---|
| Error | "background-error" |
| Info | "background-info" |
| Success | "background-success" |
| Warning | "background-warning" |

## Entities.BreakColumns

Different ways of breaking the columns.

| Id | BreakColumns |
|---|---|
| All | "break-all" |
| None | "break-none" |
| First | "break-first" |
| Middle | "break-middle" |
| Last | "break-last" |

## Entities.Color

Different colors available.

| Id | Color | Order |
|---|---|---|
| Yellow | "yellow" | 5 |
| Neutral0 | "neutral-0" | 16 |
| Indigo | "indigo" | 11 |
| Neutral7 | "neutral-7" | 23 |
| Neutral8 | "neutral-8" | 24 |
| Primary | "primary" | 1 |
| Grape | "grape" | 13 |
| Neutral10 | "neutral-10" | 26 |
| Blue | "blue" | 10 |
| Orange | "orange" | 4 |
| Green | "green" | 7 |
| Lime | "lime" | 6 |
| Neutral5 | "neutral-5" | 21 |
| Secondary | "secondary" | 2 |
| Neutral6 | "neutral-6" | 22 |
| Violet | "violet" | 12 |
| Cyan | "cyan" | 9 |
| Pink | "pink" | 14 |
| Red | "red" | 3 |
| Neutral1 | "neutral-1" | 17 |
| Teal | "teal" | 8 |
| Neutral3 | "neutral-3" | 19 |
| Neutral4 | "neutral-4" | 20 |
| Neutral2 | "neutral-2" | 18 |
| Transparent | "transparent" | 15 |
| Neutral9 | "neutral-9" | 25 |

## Entities.DeviceResponsive

Defines the behavior response according to the device or group of devices types.

| Id | Type | Order | Is_Active |
|---|---|---|---|
| TabletOnly | "TabletOnly" | 3 | True |
| PhoneOnly | "PhoneOnly" | 5 | True |
| TabletAndPhone | "TabletAndPhone" | 4 | True |
| DesktopAndTablet | "DesktopAndTablet" | 2 | True |
| DesktopOnly | "DesktopOnly" | 1 | True |
| AllDevices | "AllDevices" | 6 | True |

## Entities.EnterAnimation

Different types of entering animations.

| Id | EnterAnimation |
|---|---|
| EnterFade | "enter-fade" |
| EnterScale | "enter-scale" |
| EnterTop | "enter-top" |
| EnterRight | "enter-right" |
| EnterBottom | "enter-bottom" |
| EnterLeft | "enter-left" |

## Entities.GutterSize

Different sizes of gutter.

| Id | GutterSize | Order |
|---|---|---|
| Gutter_XS | "gutter-xs" | 2 |
| Gutter_XL | "gutter-xl" | 7 |
| Gutter_M | "gutter-m" | 5 |
| Gutter_None | "gutter-none" | 1 |
| Gutter_Base | "gutter-base" | 4 |
| Gutter_XXL | "gutter-xxl" | 8 |
| Gutter_L | "gutter-l" | 6 |
| Gutter_S | "gutter-s" | 3 |

## Entities.LeaveAnimation

Different types of leaving animations.

| Id | LeaveAnimation |
|---|---|
| LeaveBottom | "leave-bottom" |
| LeaveScale | "leave-scale" |
| LeaveFade | "leave-fade" |
| LeaveLeft | "leave-left" |
| LeaveTop | "leave-top" |
| LeaveRight | "leave-right" |

## Entities.Orientation

Different orientations.

| Id | Orientation |
|---|---|
| Horizontal | "flex-direction-row" |
| Vertical | "flex-direction-column" |

## Entities.PositionBase

Different positions.

| Id | PositionBase |
|---|---|
| Right | "tooltip-right" |
| Bottom | "tooltip-bottom" |
| Top | "tooltip-top" |
| Left | "tooltip-left" |

## Entities.PositionExtended

Added more options for positions.

| Id | PositionExtended |
|---|---|
| TopLeft | "top-left" |
| TopRight | "top-right" |
| TopCenter | "top-center" |
| BottomRight | "bottom-right" |
| Center | "center" |
| CenterLeft | "center-left" |
| CenterRight | "center-right" |
| BottomCenter | "bottom-center" |
| BottomLeft | "bottom-left" |

## Entities.ProgressBarSize

Different sizes for the progress bar.

| Id | ProgressBarSize | Order |
|---|---|---|
| Base | "progress-bar-base" | 3 |
| ExtraSmall | "progress-bar-extra-small" | 1 |
| Small | "progress-bar-small" | 2 |

## Entities.ResponsiveTableRecords

Different options for responsive for the responsive table.

| Id | ResponsiveTableRecords |
|---|---|
| ExpandableRows | "expandable-row" |
| ScrollabeRows | "scrollable-row" |

## Entities.Shape

Different shapes.

| Id | Shape | Order |
|---|---|---|
| Rounded | "rounded" | 2 |
| Sharp | "none" | 4 |
| SoftRounded | "soft" | 3 |

## Entities.Size

Different sizes.

| Id | Size |
|---|---|
| Small | "small" |
| Medium | "medium" |

## Entities.Space

Different spaces.

| Id | Space | Order |
|---|---|---|
| Medium | "m" | 5 |
| ExtraSmall | "xs" | 2 |
| None | "none" | 1 |
| XXLarge | "xxl" | 8 |
| Base | "base" | 4 |
| Small | "s" | 3 |
| Large | "l" | 6 |
| ExtraLarge | "xl" | 7 |

## Entities.Speed

Different speed of animations.

| Id | Speed |
|---|---|
| Normal | "animate-normal" |
| Fast | "animate-fast" |
| Slow | "animate-slow" |

## Entities.Step

Different types of status.

| Id | Steps |
|---|---|
| Past | "past" |
| Next | "next" |
| Active | "active" |

## Entities.Trigger

Different types of triggers.

| Id | TriggerAction | Order |
|---|---|---|
| Click | "click" | 1 |
| Manual | "manual" | 3 |
| Hover | "hover" | 2 |

# Structures

## AccessibilityConfiguration

Structure used for the configuration of the Accessibility options.

- ResetTabIndex: Boolean = False - Set to True to reset tabindex values to '0'. This is useful for acessibility reasons, to override the incremental values from the platform.
- ShowFocus: Boolean = False - Set to True, to make the outline styles visible on focus.
- ShowSkipToContent: Boolean = False - Set this option to True, to show a link on header to skip to the main content of the screen.

A skip (navigation) link provides a way for users of assistive technology to skip what can often be many navigation links.

The link is only visible when focused.
- Lang: Text = "" - Set the lang attribute to be defined on the html.

## DatePickerAdvancedFormat

Structure used for the Date Picker's Advanced Format parameter.

Allows for more options that the ones given in the input parameters.

- EventsList: Date Time List - A list of events (type Date Time)
- AdvancedFormatJSON: Text = "{}" - A string with options such as:
    "{
        disableWeekends: true
    }"

For more advanced options, read the official documentation:
https://github.com/dbushell/Pikaday

## DeviceConfiguration

Structure used for the customization of the Device Detection.

- PhoneWidth: Integer = 420 - Maximum value (pixels) for the device to be considered a phone.
- TabletWidth: Integer = 1024 - Maximum value (pixels) for the device to be considered a tablet.
- DesktopSmallWidth: Integer = 1366 - Maximum value (pixels)  for the device to be considered a desktop small.
- DesktopWidth: Integer = 1600 - Maximum value (pixels)  for the device to be considered a desktop.
- DesktopBigWidth: Integer = 1920 - Maximum value (pixels)  for the device to be considered a desktop big.
Above this value the device will be considered Desktop HD.

## Time

Time structure for Time Picker

- Id: Long Integer [obrigatorio]
- Time: Time
- IsEnable: Boolean
- IsAm: Boolean

## TimePickerAdvancedFormat

Structure used for the Time Picker's Advanced Format parameter.

Allows for more options that the ones given in the input parameters.

- DisabledTimes: Time List - A list of disabled dates (type Time)
- MinTime: Time - The minimum time for time options (type Time)
- MaxTime: Time - The maximum time for time options (type Time)
- StartEmpty: Boolean = False - Determines if the input for time starts as empty

