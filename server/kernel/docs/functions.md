# Funcoes built-in das expressoes OutSystems (Service Studio 11.55.87)

Gerado do registo do proprio Studio por `dotnet .local/cli/anvil.dll functions --out catalog/functions-<ver>.json --docs docs/functions.md`.
So o que esta aqui existe: qualquer outro nome seguido de `(` da `ExpressionUnknownFunction` no Verify, e o runner avisa antes
(`Hint UnknownFunction`, com as funcoes mais parecidas). Consulta rapida: `anvil functions --find data` ou `--name Substr`.

Onde: L = expressoes de logica server-side (server actions, timers, telas Traditional); C = client-side (client actions, telas
Reactive/Mobile); AS/AC = aggregates server/client (filtros, colunas calculadas); E = emails; vazio = so em contextos
especiais (ex.: telas Traditional Web). Parametro entre `[]` e opcional.

## Data Conversion (44)

| Assinatura | Onde | Descricao |
|---|---|---|
| `BooleanToInteger(b: Boolean): Integer` | L C AS AC E | Converts Boolean 'b' to an Integer value, either 1 if 'b' is True or 0 if 'b' is False. |
| `BooleanToText(b: Boolean): Text` | L C AS AC E | Converts Boolean 'b' to a Text value, either "True" or "False". |
| `DateTimeToDate(dt: Date Time): Date` | L C AS AC E | Converts Date Time 'dt' to a Date value dropping the Time component. |
| `DateTimeToText(dt: Date Time): Text` | L C AS AC E | Converts Date Time 'dt' to a Text value in the format specified in the environment configuration (by default, "yyyy-MM-dd HH:mm:ss"). |
| `DateTimeToTime(dt: Date Time): Time` | L C AS AC E | Converts Date Time 'dt' to a Time value dropping the Date component. |
| `DateToDateTime(d: Date): Date Time` | L C AS AC E | Converts Date 'd' to a Date Time value, adding the Time component (#00:00:00#). |
| `DateToText(d: Date): Text` | L C AS AC E | Converts Date 'd' to a Text value in the format specified in the environment configuration (by default, "yyyy-MM-dd"). |
| `DecimalToBoolean(d: Decimal): Boolean` | L C AS AC E | Converts Decimal 'd' to a Boolean value. Decimal value of 0.0 is False. Any other value is True. |
| `DecimalToInteger(d: Decimal): Integer` | L C AS AC E | Converts Decimal 'd' to an Integer value. In client-side and server-side logic, the function rounds the input using the round half to even method. In Aggregate expressions the function truncates to the integer part of the input. To check if the conversion is possible you can use the DecimalToIntegerValidate function. |
| `DecimalToIntegerValidate(d: Decimal): Boolean` | L C E | Returns true if Decimal 'd' can be converted to an Integer value. |
| `DecimalToLongInteger(d: Decimal): Long Integer` | L C AS AC E | Converts Decimal 'd' to a Long Integer value. In client-side and server-side logic, the function rounds the input using the round half to even method. In Aggregate expressions the function truncates to the integer part of the input. To check if the conversion is possible you can use the DecimalToLongIntegerValidate function. |
| `DecimalToLongIntegerValidate(d: Decimal): Boolean` | L C E | Returns true if Decimal 'd' can be converted to a Long Integer value. |
| `DecimalToText(d: Decimal): Text` | L C AS AC E | Converts Decimal 'd' to a Text value. |
| `IdentifierToInteger(id: Identifier): Integer` | L C AS AC E | Converts Identifier 'Id' to an Integer value. |
| `IdentifierToLongInteger(id: EntityReferenceLongInteger): Long Integer` | L C AS AC E | Converts Identifier 'Id' to a Long Integer value. |
| `IdentifierToText(id: EntityReferenceText): Text` | L C AS AC E | Converts Identifier 'Id' to a Text value. |
| `IntegerToBoolean(i: Integer): Boolean` | L C AS AC E | Converts Integer 'i' to a Boolean value. Boolean value of 0 is False. Any other value is True. |
| `IntegerToDecimal(i: Integer): Decimal` | L C AS AC E | Converts Integer 'i' to a Decimal value. |
| `IntegerToIdentifier(i: Integer): Identifier` | L C AS AC E | Converts Integer 'i' to an Integer Identifier. |
| `IntegerToText(i: Integer): Text` | L C AS AC E | Converts Integer 'i' to a Text value. |
| `LongIntegerToIdentifier(l: Long Integer): EntityReferenceLongInteger` | L C AS AC E | Converts Long Integer 'l' to a Long Integer Identifier. |
| `LongIntegerToInteger(l: Long Integer): Integer` | L C AS AC E | Converts Long Integer 'l' to an Integer value. If 'l' is outside the boundaries of the Integer values, the function will return the Integer default value. To check if the conversion is possible you can use the LongIntegerToIntegerValidate function. |
| `LongIntegerToIntegerValidate(l: Long Integer): Boolean` | L C E | Returns true if Long Integer 'l' can be converted to an Integer value. |
| `LongIntegerToText(l: Long Integer): Text` | L C AS AC E | Converts Long Integer 'l' to a Text value. |
| `NullBinary(): Binary Data` | L C E | Returns a null Binary Data value. |
| `NullDate(): Date` | L C AS AC E | Returns a null Date value. |
| `NullIdentifier(): Identifier` | L C AS AC E | Returns a null Identifier valid for Integer and Long Integer Identifiers. |
| `NullObject(): Object` | L C E | Returns a null Object value. |
| `NullTextIdentifier(): EntityReferenceText` | L C AS AC E | Returns a null Text Identifier. |
| `TextToDate(t: Text): Date` | L C AS AC E | Converts Text 't' to a Date value. If 't' can't be converted to a valid Date value, the function will return the Date default value. To check if the conversion is possible you can use the TextToDateValidate function. You should check the limits of the Date data type. You should also ensure that the date you type in the argument complies with the default date format (yyyy-mm-dd, yyyy/mm/dd, and yyyy.mm.dd) or the server’s environment configuration. |
| `TextToDateTime(t: Text): Date Time` | L C AS AC E | Converts Text 't' to a Date Time value. If 't' can't be converted to a valid Date Time value, the function will return a Date Time default value. To check if the conversion is possible you can use the TextToDateTimeValidate function. You should check the limits of the Date Time data type. You should also ensure that the Date Time you type in the argument complies with the default Date Time format (yyyy-mm-dd hh:mm:ss, yyyy/mm/dd hh:mm:ss, and yyyy.mm.dd hh:mm:ss) or the server’s environment configuration. |
| `TextToDateTimeValidate(t: Text): Boolean` | L C E | Returns true if Text 't' can be converted to a Date Time value. |
| `TextToDateValidate(t: Text): Boolean` | L C E | Returns true if Text 't' can be converted to a Date value. |
| `TextToDecimal(t: Text): Decimal` | L C AS AC E | Converts Text 't' to a Decimal value. The only allowed decimal separator is ""."" (period). If 't' is outside the boundaries of Decimal values, the function returns the Decimal default value. However, if you use TextToDecimal in an Aggregate and 't' is outside the boundaries of Decimal values, the function throws an exception. To check if the conversion is possible, use the TextToDecimalValidate function. |
| `TextToDecimalValidate(t: Text): Boolean` | L C E | Returns true if Text 't' can be converted to a Decimal value. |
| `TextToIdentifier(t: Text): EntityReferenceText` | L C AS AC E | Converts Text 't' to a Text Identifier. |
| `TextToInteger(t: Text): Integer` | L C AS AC E | Converts Text 't' to an Integer value. If 't' is outside the boundaries of Integer values, the function returns the Integer default value. However, if you use TextToInteger in an Aggregate and 't' is outside the boundaries of Integer values, the function throws an exception. To check if the conversion is possible, use the TextToIntegerValidate function. |
| `TextToIntegerValidate(t: Text): Boolean` | L C E | Returns true if Text 't' can be converted to an Integer value. |
| `TextToLongInteger(t: Text): Long Integer` | L C AS AC E | Converts Text 't' to a Long Integer value. If 't' is outside the boundaries of Long Integer values, the function returns the Long Integer default value. However, if you use TextToLongInteger in an Aggregate and 't' is outside the boundaries of Long Integer values, the function throws an exception. To check if the conversion is possible, use the TextToLongIntegerValidate function. |
| `TextToLongIntegerValidate(t: Text): Boolean` | L C E | Returns true if Text 't' can be converted to a Long Integer value. |
| `TextToTime(t: Text): Time` | L C AS AC E | Converts Text 't' to a Time value. If 't' can't be converted to a valid Time value, the function will return the Time default value. To check if the conversion is possible you can use the TextToTimeValidate function. You should check the limits of the Time data type. You should also ensure that the Time you type in the argument complies with the Time format (hh:mm:ss). |
| `TextToTimeValidate(t: Text): Boolean` | L C E | Returns true if Text 't' can be converted to a Time value. |
| `TimeToText(t: Time): Text` | L C AS AC E | Converts Time 't' to a Text value in the format "HH:mm:ss". |
| `ToObject(exp: Generic): Object` | L C E | Converts expression 'exp' to an Object value. |

## Date and Time (24)

| Assinatura | Onde | Descricao |
|---|---|---|
| `AddDays(dt: Date Time, n: Integer): Date Time` | L C AS AC E | Adds 'n' days to 'dt' and returns a valid Date Time. |
| `AddHours(dt: Date Time, n: Integer): Date Time` | L C AS AC E | Adds 'n' hours to 'dt' and returns a valid Date Time. |
| `AddMinutes(dt: Date Time, n: Integer): Date Time` | L C AS AC E | Adds 'n' minutes to 'dt' and returns a valid Date Time. |
| `AddMonths(dt: Date Time, n: Integer): Date Time` | L C AS AC E | Adds 'n' months to 'dt' and returns a valid Date Time. |
| `AddSeconds(dt: Date Time, n: Integer): Date Time` | L C AS AC E | Adds 'n' seconds to 'dt' and returns a valid Date Time. |
| `AddYears(dt: Date Time, n: Integer): Date Time` | L C AS AC E | Adds 'n' years to 'dt' and returns a valid Date Time. |
| `BuildDateTime(d: Date, t: Time): Date Time` | L C AS AC E | Returns a Date Time made up of the Date 'd' and Time 't'. |
| `CurrDate(): Date` | L C AS E | In client-side calls, it returns the device date. In server-side calls, it returns the platform server date. In query calls, it returns the platform server date. |
| `CurrDateTime(): Date Time` | L C AS E | In client-side calls, it returns the device date and time. It also returns milliseconds. In server-side calls, it returns the platform server date and time. In query calls, it returns the platform server date and time. Date times in the device are converted in the server to the server time zone. Conversely, date times in the server are converted in the device to the device time zone. |
| `CurrTime(): Time` | L C AS E | In client-side calls, it returns the device time. In server-side calls, it returns the platform server time. In query calls, it returns the platform server time. |
| `Day(dt: Date Time): Integer` | L C AS AC E | Returns the day of 'dt'. |
| `DayOfWeek(dt: Date Time): Integer` | L C AS AC E | Returns the week day of 'dt', ranging from 0 (Sunday) to 6 (Saturday). |
| `DiffDays(dt1: Date Time, dt2: Date Time): Integer` | L C AS AC E | Returns the difference in days between 'dt1' and 'dt2'; i.e. how many days have passed between these two dates: - Returns a positive number if 'dt1' is smaller than 'dt2'; - Returns a negative number if 'dt1' is bigger than 'dt2'; - Returns 0 if the two dates are equal. The Time component you provide in the parameters is ignored. The DiffDays function receives two Date Time parameters, and then replaces the Time component with 00:00:00. It calculates the elapsed time in milliseconds from the first date at 00:00:00 to the second date at 00:00:00, and then converts the difference in milliseconds into days. Daylight Saving Time (DST) is ignored. The time zone considered for evaluating this function is always the time zone of the Platform Server, regardless of the regional settings of the end-user. The maximum supported value is (2^31)-1 days. This corresponds to approximately 5879489.8 years. If DiffDays(dt1, dt2) is bigger than (2^31)-1, you will get an unexpected value. |
| `DiffHours(dt1: Date Time, dt2: Date Time): Integer` | L C AS AC E | Returns the difference in hours between 'dt1' and 'dt2'; i.e. how many hours have passed between these two dates: - Returns a positive number if 'dt1' is smaller than 'dt2'; - Returns a negative number if 'dt1' is bigger than 'dt2'. - Returns 0 if the two dates are equal. Daylight Saving Time (DST) is ignored. The time zone considered for evaluating this function is always the time zone of the Platform Server, regardless of the regional settings of the end-user. The maximum supported value is (2^31)-1 hours. This corresponds to approximately 244978.74 years. If DiffHours(dt1, dt2) is bigger than (2^31)-1, you will get an unexpected value. |
| `DiffMinutes(dt1: Date Time, dt2: Date Time): Integer` | L C AS AC E | Returns the difference in minutes between 'dt1' and 'dt2'; i.e. how many minutes have passed between these two dates: - Returns a positive number if 'dt1' is smaller than 'dt2'; - Returns a negative number if 'dt1' is bigger than 'dt2'. - Returns 0 if the two dates are equal. Daylight Saving Time (DST) is ignored. The time zone considered for evaluating this function is always the time zone of the Platform Server, regardless of the regional settings of the end-user. The maximum supported value is (2^31)-1 minutes. This corresponds to approximately 4085.78 years. If DiffMinutes(dt1, dt2) is bigger than (2^31)-1, you will get an unexpected value. |
| `DiffSeconds(dt1: Date Time, dt2: Date Time): Integer` | L C AS AC E | Returns the difference in seconds between 'dt1' and 'dt2'; i.e. how many seconds have passed between these two dates: - Returns a positive number if 'dt1' is smaller than 'dt2'; - Returns a negative number if 'dt1' is bigger than 'dt2'. - Returns 0 if the two dates are equal. Daylight Saving Time (DST) is ignored. The time zone considered for evaluating this function is always the time zone of the Platform Server, regardless of the regional settings of the end-user. The maximum supported value is (2^31)-1 seconds. This corresponds to approximately 68.10 years. If DiffSeconds(dt1, dt2) is bigger than (2^31)-1, you will get an unexpected value. |
| `Hour(dt: Date Time): Integer` | L C AS AC E | Returns the hour of 'dt'. |
| `Minute(dt: Date Time): Integer` | L C AS AC E | Returns the minute of 'dt'. |
| `Month(dt: Date Time): Integer` | L C AS AC E | Returns the month of 'dt'. |
| `NewDate(y: Integer, m: Integer, d: Integer): Date` | L C AS AC E | Returns a Date made up of year 'y', month 'm' and day 'd'. |
| `NewDateTime(y: Integer, mo: Integer, d: Integer, h: Integer, mi: Integer, s: Integer): Date Time` | L C AS AC E | Returns a Date Time made up of year 'y', month 'mo', day 'd', hour 'h', minute 'mi' and second 's'. |
| `NewTime(h: Integer, m: Integer, s: Integer): Time` | L C AS AC E | Returns a Time made up of hour 'h', minute 'm' and second 's'. |
| `Second(dt: Date Time): Integer` | L C AS AC E | Returns the seconds of 'dt'. |
| `Year(dt: Date Time): Integer` | L C AS AC E | Returns the year of 'dt'. |

## Email (3)

| Assinatura | Onde | Descricao |
|---|---|---|
| `EmailAddressCreate(name: Text, email: Text): Text` | L E | Returns a full email address string containing the display name (usually it's the name of the email address owner) and the email address itself. The resulting full email address may then be used in the Send Email element (action flows) or in the Send Email activity (process flows). To build a list of email addresses use the EmailAddressesConcatenate built-in function. |
| `EmailAddressValidate(address: Text): Boolean` | L C E | Returns true if Text 'address' is a valid email address. Note that EmailAddressValidate("") returns True. This built-in function implements the validation specified by HTML5 (https://html.spec.whatwg.org/multipage/input.html#valid-e-mail-address) which has a practical approach to RFC 5322. |
| `EmailAddressesConcatenate(address1: Text, address2: Text): Text` | L E | Returns the concatenation of email addresses, or list of email addresses, into a a new list of email addresses separated by a comma (','). The resulting list may then be used in the Send Email element (action flows) or in the Send Email activity (process flows). |

## Environment (8)

| Assinatura | Onde | Descricao |
|---|---|---|
| `GetApplicationServerType(): Text` |  | Returns ".Net". |
| `GetCurrentLocale(): Text` | C | Returns the name of the current language locale of the user session. The name of the language locale is used for presentation purposes and follows the RFC 1766 standard format. |
| `GetDatabaseProvider(): Text` |  | Returns the type of the Platform Database (SqlServer, Oracle or MySQL) where the module is running. |
| `GetEntryEspaceId(): EspaceId` |  | Returns the identifier of the module that is processing the web request. |
| `GetEntryEspaceName(): Text` | C | Returns the name of the module that is processing the web request. |
| `GetObsoleteTenantId(): TenantId` |  | Method to return a fake tenant identifier for single-tenant modules in order to mimic Site.TenantId semantic from the 6.0 version |
| `GetOwnerEspaceIdentifier(): EspaceId` |  | Returns the identifier of the module that owns the element that is being processed. |
| `GetUserAgent(): Text` | C | Returns the user agent, as indicated by the header of the HTTP message. |

## Format (6)

| Assinatura | Onde | Descricao |
|---|---|---|
| `FormatCurrency(value: Currency, symbol: Text, decimal_digits: Integer, decimal_separator: Text, group_separator: Text): Text` | L C E | Builds a Text output of the specified Currency 'value', preceded by the currency 'symbol', using 'decimal_digits' after the decimal point. The decimal point is specified using 'decimal_separator', while the thousands can be separated with the 'group_separator'. When rounding, the function behaves differently depending on where you use it: - In the application server, it applies the method round half up (rounds to the nearest integer, 0.5 rounds up). - In client-side logic, it applies the method round half to even (rounds to the nearest integer, 0.5 rounds to the nearest even integer). |
| `FormatDateTime(value: Date Time, format: Text): Text` | L C E | Builds a Text output of the specified Date Time 'value' using the specified 'format'. Formatting pattern can be any combination of the following: Day: - d: day without leading zero; - dd: day WITH leading zero; - ddd: abbreviated day name; - dddd: full day name; Month: - M: month without leading zero; - MM: month WITH leading zero; - MMM: abbreviated month name; - MMMM: full month name; Year: - y: last one or two digits of the year; - yy: last two digits of the year; - yyyy: year; Hour: - h: hour from 0 to 12 without leading zero; - hh: hour from 0 to 12 WITH leading zero; - H: hour from 0 to 24 without leading zero; - HH: hour from 0 to 24 WITH leading zero; Minute: - m: minutes without leading zero; - mm: minutes WITH leading zero; Second: - s: seconds without leading zero; - ss: seconds WITH leading zero; AM Designator: - t: first letter of AM or PM; - tt: AM or PM. If you want to output any of these characters then precede it with '\'. Changing the environment date format does not change the way the FormatDateTime function formats the dates. |
| `FormatDecimal(value: Decimal, decimal_digits: Integer, decimal_separator: Text, group_separator: Text): Text` | L C E | Builds a Text output of the specified Decimal 'value', using 'decimal_digits' after the decimal point. The decimal point is specified using 'decimal_separator', while the thousands can be separated with the 'group_separator'. When rounding, the function behaves differently depending on where you use it: - In the application server, it applies the method round half up (rounds to the nearest integer, 0.5 rounds up). - In client-side logic, it applies the method round half to even (rounds to the nearest integer, 0.5 rounds to the nearest even integer). |
| `FormatPercent(value: Decimal, decimal_digits: Integer, decimal_separator: Text): Text` | L C E | Builds a Text output of the specified Decimal 'value', followed by '%' using 'decimal_digits' after the decimal point. The decimal point is specified using 'decimal_separator'. When rounding, the function behaves differently depending on where you use it: - In the application server, it applies the method round half up (rounds to the nearest integer, 0.5 rounds up). - In client-side logic, it applies the method round half to even (rounds to the nearest integer, 0.5 rounds to the nearest even integer). |
| `FormatPhoneNumber(value: Text, int_code_digits: Integer, area_code_digits: Integer, phone_digits: Integer, int_separator: Text, area_separator: Text, phone_separator: Text): Text` | L C E | Builds a Text output of the specified phone number Text 'value', starting with the international separator 'int_separator', followed by the first 'int_code_digits' of 'value', then the 'area_separator', then the following 'area_code_digits' of 'value', then the 'phone_separator' and finally the following 'phone_digits' of 'value'. |
| `FormatText(value: Text, min_chars: Integer, max_chars: Integer, left_padding: Boolean, padding_char: Text): Text` | L C E | Builds a Text output of the specified Text 'value', by limiting it to the specified 'max_chars' count. If 'value' has less than the 'min_chars' characters limit, enough 'padding_char' characters are added to expand the length to that limit. In this case, 'left_padding' determines where the padding should be added. |

## Math (6)

| Assinatura | Onde | Descricao |
|---|---|---|
| `Abs(n: Decimal): Decimal` | L C AS AC E | Returns the absolute value (unsigned magnitude) of the decimal number 'n'. |
| `Mod(n: Decimal, m: Decimal): Decimal` | L C E | Returns the remainder of decimal division of 'n' by 'm'. |
| `Power(n: Decimal, m: Decimal): Decimal` | L C E | Returns 'n' raised to the power of 'm'. |
| `Round(n: Decimal, [fractionalDigits: Integer]): Decimal` | L C AS AC E | Returns the Decimal number 'n' rounded to a specific number of 'fractional digits'. The round method applied depends on where the function is used: - In expressions in client-side and server-side logic, applies the method round half to even (rounds to the nearest integer, 0.5 rounds to the nearest even integer). - In aggregates that query SQL Server or Oracle databases, applies the method round half away from 0 (rounds to the nearest integer, 0.5 rounds the number further away from 0). - In aggregates that query MySQL or iDB2 databases, applies the method round half up (rounds to the nearest integer, 0.5 rounds up). |
| `Sqrt(n: Decimal): Decimal` | L C AS E | Returns the square root of the Decimal number 'n'. |
| `Trunc(n: Decimal): Decimal` | L C AS AC E | Returns the Decimal number 'n' truncated to integer removing the decimal part of 'n'. |

## Miscellaneous (4)

| Assinatura | Onde | Descricao |
|---|---|---|
| `CurrentThemeIsMobile(): Boolean` |  | Returns true when the current web screen is using a mobile theme. |
| `GeneratePassword(l: Integer, alpha: Boolean): Text` | E | Generates and returns a password string of length 'l'. If 'alpha' is True the string can contain both digits and letters, if False the string can only contain digits. The generated password string is a random combination of letters and digits, or just digits, depending on 'alpha'. |
| `If(value: Boolean, true_return: Generic, false_return: Generic): Generic` | L C AS AC E | Returns 'true_return' if 'value' is True, otherwise returns 'false_return'. The return data type of the function is the type of 'true_return' unless there's an implicit conversion from 'true_return' type to 'false_return' type. When there's no implicit type conversion an invalid data type error will occur. |
| `IsLoadingScreen(): Boolean` |  | Returns true only when invoked within a screen Preparation execution and only if the screen is loading its content. Otherwise, if the screen is just being redrawn, i.e. posted back, it returns False. |

## Numeric (3)

| Assinatura | Onde | Descricao |
|---|---|---|
| `Max(n: Decimal, m: Decimal): Decimal` | L C E | Returns the largest number of 'n' and 'm'. |
| `Min(n: Decimal, m: Decimal): Decimal` | L C E | Returns the smallest number of 'n' and 'm'. |
| `Sign(n: Decimal): Integer` | L C E | Returns -1 if 'n' is negative; 1 if 'n' is positive; 0 if 'n' is 0. |

## Roles (2)

| Assinatura | Onde | Descricao |
|---|---|---|
| `CheckRole(RoleId: RoleId, UserId: UserId): Boolean` | AS AC | Returns true when the given user has the specific role. |
| `GetUserId(): UserId` | C | Returns the identifier of the user that is currently authenticated with the server or 'NullIdentifier()' if the user is not authenticated. |

## Text (16)

| Assinatura | Onde | Descricao |
|---|---|---|
| `Chr(c: Integer): Text` | L C E | Returns a single-character string corresponding to the 'c' character code. |
| `Concat(t1: Text, t2: Text): Text` | L C AS AC E | Returns the concatenation of two Texts: 't1' and 't2'. |
| `EncodeHtml(text: Text): Text` | C E | Replaces special characters in a string so that you can use it in HTML literals. Use this function when using unescaped expressions that contain content provided by end-users. Warning: Since this function only encodes strings that will be used in HTML literals, it does not protect you from cross-site scripting (XSS) or JavaScript injection vulnerabilities on its own. Do not use this function to encode text that might get executed as JavaScript code, only to encode HTML literals. |
| `EncodeJavaScript(text: Text): Text` | C | Replaces special characters in a string so that you can use it in JavaScript literals. Use this function when using unescaped expressions that contain content provided by end-users. Warning: Since this function only encodes strings that will be used in JavaScript literals, it does not protect you from cross-site scripting (XSS) or JavaScript injection vulnerabilities on its own. Do not use this function to encode text that might get executed as JavaScript code, only to encode JavaScript literals. |
| `EncodeSql(text: Text): Text` |  | Replaces special characters in a string literal so that you can use it in a SQL statement. Use this function when the Expand Inline property of a Query Parameter is enabled to escape content provided by end-users. Warning: Since this function only encodes string literals, it does not protect you from SQL injection vulnerabilities on its own. Do not use this function to encode text that might get executed as part of the SQL statement. Check the OutSystems Best Practices documentation for more information on building dynamic SQL statements the right way. |
| `EncodeUrl(text: Text): Text` | C E | Replaces all non-alphanumeric characters in a string, i.e. characters outside of the [0-9a-zA-Z] range, so that you can safely use it in URL parameter values. Use this function to build URLs in your application that may contain content provided by end-users, e.g. when dynamically building URLs to an external site. |
| `Index(t: Text, search: Text, [startIndex: Integer], [searchFromEnd: Boolean], [ignoreCase: Boolean]): Integer` | L C AS AC E | Returns the zero-based position in Text 't' where 'search' Text can be found. Returns -1 if 'search' is not found or if 'search' is empty. |
| `Length(t: Text): Integer` | L C AS AC E | Returns the number of characters in Text 't'. |
| `NewLine(): Text` | L C E | Returns a string containing the New Line (Return) character. |
| `Replace(t: Text, search: Text, replace: Text): Text` | L C AS AC E | Returns Text 't' after replacing all Text occurrences of 'search' with 'replace'. |
| `Substr(t: Text, start: Integer, length: Integer): Text` | L C AS AC E | Returns a sub-string of 't' beginning at 'start' zero-based position and with 'length' characters. |
| `ToLower(t: Text): Text` | L C AS AC E | Converts Text 't' to the equivalent lowercase text. |
| `ToUpper(t: Text): Text` | L C AS AC E | Converts Text 't' to the equivalent uppercase text. |
| `Trim(t: Text): Text` | L C AS AC E | Removes all leading and trailing space characters (' ') from Text 't'. |
| `TrimEnd(t: Text): Text` | L C AS AC E | Removes all trailing space characters (' ') from Text 't'. |
| `TrimStart(t: Text): Text` | L C AS AC E | Removes all leading space characters (' ') from Text 't'. |

## URL (5)

| Assinatura | Onde | Descricao |
|---|---|---|
| `AddPersonalAreaToURLPath(url: Text): Text` |  | Returns a string where the Personal Area is added (if applicable) to the URL path set in Text 't' input parameter. This function enables you to run any page (or resource) of your module in the Personal Area without having to manually change their paths. This function adds the Personal Area of the developer that is running the module to the URL path provided by the input parameter. |
| `GetBookmarkableURL(): Text` | C | Returns the URL of the screen that is currently being processed. The URL returned by this function is a complete URL with the format http://server/module/personal_area/screen?param1=value&param2=value... Parameters and their values aren't included when parameters are optional and their values aren't set. |
| `GetExceptionURL(): Text` |  | Returns the absolute URL of the screen where the last exception was raised. |
| `GetOwnerURLPath(): Text` | C | Returns the URL path of the module that owns the element that is being processed. Note that this function does not return the complete URL but only the component containing the location of the resource within the domain and, if applicable, the personal area. |
| `GetPersonalAreaName(): Text` |  | Returns the name of the Personal Area where the module is currently running. |

## Nomes de outras linguagens que NAO existem aqui

| Escreveu | Use |
|---|---|
| Ceiling | Round |
| Contains | Index |
| DateAdd | AddDays, AddHours, AddMinutes, AddMonths |
| DateDiff | DiffDays, DiffHours, DiffMinutes, DiffSeconds |
| Floor | Trunc |
| GetDate | CurrDate |
| IIf | If |
| IndexOf | Index |
| Left | Substr |
| Len | Length |
| Lower | ToLower |
| Mid | Substr |
| Now | CurrDateTime |
| ParseInt | TextToInteger |
| Right | Substr, Length |
| Substring | Substr |
| ToInt | TextToInteger, DecimalToInteger |
| ToInteger | TextToInteger, DecimalToInteger |
| ToString | IntegerToText, DecimalToText, BooleanToText |
| ToText | IntegerToText, DecimalToText, BooleanToText |
| Today | CurrDate |
| Upper | ToUpper |
