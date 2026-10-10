using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

// Source identity is separate from transport fields. Durations and offset timestamps
// must not inherit integral wrapping or record equality when their lowering is added.
internal enum TemporalKind { None, DateOnly, TimeOnly, TimeSpan, DateTimeOffset, DateTime }

internal static class TemporalModel
{
    internal const int MaximumDayNumber = 3_652_058;
    internal const long TicksPerDay = 864_000_000_000;
    internal const long TicksPerMinute = 600_000_000;
    internal const long MaximumDateTimeTicks = 3_155_378_975_999_999_999;
    internal static TemporalKind Kind(ITypeSymbol type) => type.Locations.Any(l => l.IsInSource) ? TemporalKind.None : type.ToDisplayString() switch
    {
        "System.DateOnly" => TemporalKind.DateOnly,
        "System.TimeOnly" => TemporalKind.TimeOnly,
        "System.TimeSpan" => TemporalKind.TimeSpan,
        "System.DateTimeOffset" => TemporalKind.DateTimeOffset,
        "System.DateTime" => TemporalKind.DateTime,
        _ => TemporalKind.None
    };
    internal static string Field(TemporalKind kind) => kind switch
    {
        TemporalKind.DateOnly => "DayNumber",
        TemporalKind.TimeOnly or TemporalKind.TimeSpan or TemporalKind.DateTime => "Ticks",
        TemporalKind.DateTimeOffset => "UtcTicks",
        _ => throw new ArgumentException("Unknown temporal representation")
    };
    internal static JsonObject Structure(string name, TemporalKind kind)
    {
        var attributes = new JsonArray(new JsonObject { ["name"] = Field(kind), ["type"] = kind == TemporalKind.DateOnly ? "Integer" : "Long Integer" });
        if (kind == TemporalKind.DateTimeOffset) attributes.Add(new JsonObject { ["name"] = "OffsetMinutes", ["type"] = "Integer" });
        if (kind == TemporalKind.DateTime) attributes.Add(new JsonObject { ["name"] = "Kind", ["type"] = "Integer" });
        return new JsonObject
        {
            ["name"] = name, ["public"] = true, ["attributes"] = attributes,
            ["description"] = kind switch
            {
                TemporalKind.DateOnly => "C# System.DateOnly value: Gregorian day number, 0..3652058 since 0001-01-01. Not a native Date storage codec.",
                TemporalKind.TimeOnly => "C# System.TimeOnly value: 100 ns ticks since midnight, 0..863999999999. Not a native Time storage codec.",
                TemporalKind.TimeSpan => "C# System.TimeSpan value: signed Int64 duration ticks of 100 ns. Not a persistent storage codec.",
                TemporalKind.DateTimeOffset => "C# System.DateTimeOffset value: UTC ticks and whole offset minutes. UTC and civil ticks must be in 0..3155378975999999999; offset -840..840. Not a persistent storage codec.",
                _ => "Exact C# System.DateTime intermediate: ticks and Kind. Conversion to legacy native Date Time, storage and boundary codecs remain unimplemented."
            }
        };
    }
}
