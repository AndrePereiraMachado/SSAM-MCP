using System.Globalization;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Temporal migration values retain their meaning; wall-clock values never enter an implicit machine-zone conversion.</summary>
public static class TemporalContract
{
    public sealed record Value(DateTime WallClock, DateTimeOffset? Instant, bool DateOnly);
    public static Value Parse(string text, string semantics)
    {
        if (semantics == "date")
        {
            if (!DateTime.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
                throw new ArgumentException("TEMPORAL_DATE_INVALID: date requires yyyy-MM-dd without a time or offset");
            return new(DateTime.SpecifyKind(date, DateTimeKind.Unspecified), null, true);
        }
        if (semantics == "client-local")
        {
            // O11 may serialize client-local time with Z. Its declared meaning remains local; Z is transport syntax here.
            if (!Regex.IsMatch(text, @"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z?$"))
                throw new ArgumentException("TEMPORAL_LOCAL_INVALID: client-local requires wall-clock components; nonzero offsets are ambiguous");
            if (!DateTime.TryParse(text.TrimEnd('Z'), CultureInfo.InvariantCulture, DateTimeStyles.None, out var local))
                throw new ArgumentException("TEMPORAL_LOCAL_INVALID: invalid calendar value");
            return new(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), null, false);
        }
        if (semantics != "instant") throw new ArgumentException("TEMPORAL_SEMANTICS_REQUIRED: use date, client-local or instant");
        if (!Regex.IsMatch(text, @"^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$")
            || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var instant))
            throw new ArgumentException("TEMPORAL_INSTANT_INVALID: instant requires an explicit UTC offset");
        return new(instant.UtcDateTime, instant.ToUniversalTime(), false);
    }

    public static Value Display(Value value, string timeZone)
    {
        if (value.Instant == null) return value;
        var zone = TimeZoneInfo.FindSystemTimeZoneById(timeZone);
        var displayed = TimeZoneInfo.ConvertTime(value.Instant.Value, zone).DateTime;
        // Conversion consumes the instant. Rendering an already displayed value again cannot apply a second offset.
        return new(DateTime.SpecifyKind(displayed, DateTimeKind.Unspecified), null, false);
    }

    public static string NativeLiteral(string text, string semantics, string? timeZone = null)
    {
        var value = Parse(text, semantics);
        if (value.Instant != null)
        {
            if (string.IsNullOrWhiteSpace(timeZone)) throw new ArgumentException("TEMPORAL_ZONE_REQUIRED: an instant needs a declared display timezone");
            value = Display(value, timeZone);
        }
        return "#" + value.WallClock.ToString(value.DateOnly ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "#";
    }
}
