using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Validates the legacy Studio schedule before its permissive string setter runs.</summary>
public static class TimerScheduleValue
{
    private static readonly Regex Time = new(@"^(?:[01]\d|2[0-3]):[0-5]\d$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Days = new(StringComparer.Ordinal) { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
    private static readonly HashSet<string> Weeks = new(StringComparer.Ordinal) { "1st", "2nd", "3rd", "4th", "last" };

    public static (string Property, string Value) Prepare(JsonNode? value, bool supportsCron)
    {
        if (value is JsonObject interval)
        {
            if (interval.Count != 1 || interval["everyMinutes"] is not JsonValue number || !number.TryGetValue<int>(out var minutes)
                || minutes < 1 || minutes > 60 || 60 % minutes != 0)
                throw Invalid("everyMinutes must be an integer divisor of 60 between 1 and 60; intervals align to midnight");
            if (supportsCron)
                return ("CronSchedule", minutes == 60 ? "0 * * * *" : $"*/{minutes} * * * *");
            // O11's editor persists explicit daily HH:mm occurrences, not a cron expression.
            return ("Schedule", string.Join(" ", Enumerable.Range(0, 1440 / minutes)
                .Select(i => TimeSpan.FromMinutes(i * minutes).ToString(@"hh\:mm", CultureInfo.InvariantCulture))));
        }
        if (value is not JsonValue scalar || !scalar.TryGetValue<string>(out var text))
            throw Invalid("expected a native schedule string or {\"everyMinutes\":5}");
        text = text.Trim();
        if (text is "" or "WhenPublished") return ("Schedule", text);
        if (text == "When Published") return ("Schedule", "WhenPublished");
        var tokens = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var timeCount = tokens.TakeWhile(t => Time.IsMatch(t)).Count();
        var tail = tokens.Skip(timeCount).ToArray();
        var validTail = tail.Length == 0 || tail.All(Days.Contains)
            || tail.All(t => int.TryParse(t, NumberStyles.None, CultureInfo.InvariantCulture, out var day) && day >= 1 && day <= 31)
            || tail.Length == 2 && Weeks.Contains(tail[0]) && Days.Contains(tail[1]);
        if (timeCount == 0 || !validTail)
            throw Invalid("use HH:mm times followed optionally by weekdays or month days, WhenPublished, empty string for on-demand, or {\"everyMinutes\":5}; prose such as 'every five minutes' is not a native schedule");
        return ("Schedule", string.Join(" ", tokens));
    }

    private static InvalidOperationException Invalid(string detail) => new("TIMER_SCHEDULE_INVALID: " + detail);
}
