using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Authoring.Transport;

/// <summary>ABI4 BCL temporal values within the declared native representation. Only fixed framework accessors and
/// constructors run; arbitrary source fields/getters never define a temporal codec.</summary>
public sealed record GraphTemporal(Type Type) : GraphShape
{
    private const long MaximumDateTimeTicks = 3_155_378_975_999_999_999;
    private const int MaximumDayNumber = 3_652_058;
    internal static readonly IReadOnlyDictionary<string, Type> Types = new[] {
        typeof(DateOnly), typeof(TimeOnly), typeof(TimeSpan), typeof(DateTime), typeof(DateTimeOffset)
    }.ToDictionary(type => type.FullName!, StringComparer.Ordinal);

    internal void Validate()
    {
        if (Type.FullName == null || !Types.TryGetValue(Type.FullName, out var known) || Type != known)
            throw new ArgumentException("A temporal graph shape requires an exact supported BCL value type.");
    }
    internal GraphTemporalValue Encode(object? value)
    {
        Validate();
        if (value?.GetType() != Type) throw new InvalidDataException("Temporal graph value differs from its exact BCL type.");
        if (value is DateTime local && local.Kind == DateTimeKind.Local &&
            local.ToBinary() != new DateTime(local.Ticks, local.Kind).ToBinary())
            throw new InvalidDataException("Local DateTime contains ambiguous daylight-saving state that the native ticks/Kind representation cannot preserve.");
        var encoded = value switch {
            DateOnly date => new GraphTemporalValue(date.DayNumber),
            TimeOnly time => new GraphTemporalValue(time.Ticks),
            TimeSpan duration => new GraphTemporalValue(duration.Ticks),
            DateTime dateTime => new GraphTemporalValue(dateTime.Ticks, (int)dateTime.Kind),
            DateTimeOffset timestamp => new GraphTemporalValue(timestamp.UtcTicks, checked((int)(timestamp.Offset.Ticks / TimeSpan.TicksPerMinute))),
            _ => throw new InvalidDataException("Unsupported temporal source value.")
        };
        return Checked(encoded);
    }
    internal GraphTemporalValue Checked(object? value)
    {
        Validate();
        if (value is not GraphTemporalValue encoded) throw new InvalidDataException("Expected a typed temporal graph payload.");
        var valid = Type == typeof(DateOnly) ? encoded.Value is >= 0 and <= MaximumDayNumber && encoded.Qualifier == 0
            : Type == typeof(TimeOnly) ? encoded.Value is >= 0 and < TimeSpan.TicksPerDay && encoded.Qualifier == 0
            : Type == typeof(TimeSpan) ? encoded.Qualifier == 0
            : Type == typeof(DateTime) ? encoded.Value is >= 0 and <= MaximumDateTimeTicks && encoded.Qualifier is >= 0 and <= 2
            : encoded.Value is >= 0 and <= MaximumDateTimeTicks && encoded.Qualifier is >= -840 and <= 840
                && (decimal)encoded.Value + encoded.Qualifier * (decimal)TimeSpan.TicksPerMinute is >= 0 and <= MaximumDateTimeTicks;
        if (!valid) throw new InvalidDataException("Temporal graph payload is outside its exact BCL value domain.");
        return encoded;
    }
    internal object Decode(object? value)
    {
        var encoded = Checked(value);
        if (Type == typeof(DateOnly)) return DateOnly.FromDayNumber((int)encoded.Value);
        if (Type == typeof(TimeOnly)) return new TimeOnly(encoded.Value);
        if (Type == typeof(TimeSpan)) return TimeSpan.FromTicks(encoded.Value);
        if (Type == typeof(DateTime)) return new DateTime(encoded.Value, (DateTimeKind)encoded.Qualifier);
        var offset = (long)encoded.Qualifier * TimeSpan.TicksPerMinute;
        return new DateTimeOffset(encoded.Value + offset, TimeSpan.FromTicks(offset));
    }
    internal JsonObject EncodeWire(object? value)
    {
        var encoded = Checked(value);
        if (Type == typeof(DateOnly)) return new() { ["DayNumber"] = (int)encoded.Value };
        if (Type == typeof(DateTimeOffset)) return new() { ["UtcTicks"] = encoded.Value, ["OffsetMinutes"] = encoded.Qualifier };
        var result = new JsonObject { ["Ticks"] = encoded.Value };
        if (Type == typeof(DateTime)) result["Kind"] = encoded.Qualifier;
        return result;
    }
    internal GraphTemporalValue DecodeWire(JsonNode? value)
    {
        try
        {
            var record = value as JsonObject ?? throw new InvalidDataException("Expected a native temporal record.");
            var fields = Type == typeof(DateOnly) ? new[] { "DayNumber" }
                : Type == typeof(DateTimeOffset) ? new[] { "UtcTicks", "OffsetMinutes" }
                : Type == typeof(DateTime) ? new[] { "Ticks", "Kind" } : new[] { "Ticks" };
            if (record.Count != fields.Length || fields.Any(field => !record.ContainsKey(field) || record[field] == null))
                throw new InvalidDataException("Native temporal record has missing, null or unknown fields.");
            return Checked(new GraphTemporalValue(JsonSerializer.Deserialize<long>(record[fields[0]]!.ToJsonString()),
                fields.Length == 1 ? 0 : JsonSerializer.Deserialize<int>(record[fields[1]]!.ToJsonString())));
        }
        catch (Exception error) when (error is InvalidOperationException or FormatException or OverflowException or JsonException)
        { throw new InvalidDataException("Native temporal values require exact integers in the declared BCL domain.", error); }
    }
}

/// <summary>The declared temporal shape defines the number and optional Kind/offset.
/// This is typed value data, not an execution instruction.</summary>
public sealed record GraphTemporalValue(long Value, int Qualifier = 0);
