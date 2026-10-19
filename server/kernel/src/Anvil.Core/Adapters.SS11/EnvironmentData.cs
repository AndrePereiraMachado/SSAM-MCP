using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Communication.RESTServices.DTO;
using OutSystems.Model;
using OutSystems.Model.Data;
using ServiceStudio.ServerCommunications;

namespace Anvil.Core;

/// <summary>Service Studio's own Edit Data over the Studio-owned login (SSO included): the provider's GetRecords,
/// InsertRecords, UpdateRecords and DeleteRecords, the calls behind View/Edit Data of an entity. The Studio side only
/// relays keys and text values; the CLI resolves names to keys from a published OML snapshot. No SQL, no model change,
/// no credential. DECISOES 2026-09-29 15:40 ("Autorizo trocar a bridge (Recomendado)").</summary>
public static class EnvironmentData
{
    public const string ReadOperation = "data-read";
    public const string WriteOperation = "data-write";

    // (System) and Users hold users, roles and password hashes: never read or written here.
    private static readonly string[] RefusedModuleKeys = ["uXCIR2Atc0+es3zYuZSnNw", "WWAQZTkE5UuwES8B+6Svpg"];

    public sealed record Cell(string Key, string? Value);
    public sealed record Row(string Id, Cell[] Attributes);
    public sealed record Report(string? RecordId, string? ClientRecordId, string Status, string? Error);

    // ---- Studio side (bridge) ---------------------------------------------

    public static object Execute(HeadlessSession session, string operation, JsonObject? arguments)
    {
        var provider = session.StudioProvider as ServerCommunicationsProvider
            ?? throw new InvalidOperationException("The Studio data provider is unavailable for this lease");
        var moduleKey = Text(arguments, "moduleKey");
        var entityKey = Text(arguments, "entityKey");
        if (IsRefusedModule(moduleKey)) throw new InvalidOperationException("Users and roles are out of reach of Edit Data here");
        int? tenantId = arguments?["tenantId"] is JsonValue tenant ? tenant.GetValue<int>() : null;
        if (operation == ReadOperation)
        {
            var ids = arguments?["ids"]?.AsArray().Select(x => x!.GetValue<string>()).ToArray();
            var offset = arguments?["offset"]?.GetValue<int>() ?? 0;
            // One page, bounded: the Studio never holds the environment gate (and its own HTTP client) past the chunk
            // timeout for a single page, whatever the server does with a deep offset (P3, 2026-10-08: 330 s inside the Studio).
            var rows = Bounded(() => provider.GetRecords(moduleKey, entityKey, tenantId, ids is { Length: > 0 } ? ids : null, false,
                    arguments?["includeBinary"]?.GetValue<bool>() ?? false, offset),
                ChunkTimeoutOf(arguments), $"one Edit Data page of {entityKey} at offset {offset}")
                ?? throw new InvalidOperationException("The environment does not advertise Edit Data (EditDataV4)");
            return rows.Select(r => new Row(r.Id, (r.EntityAttributesInfo ?? []).Select(a => new Cell(a.Key, a.Value)).ToArray())).ToArray();
        }
        if (operation != WriteOperation) throw new ArgumentException("Unknown data operation: " + operation);
        session.RequireWrite("data");
        var kind = Text(arguments, "operation");
        IEnumerable<EditDataOperationReport>? reports = kind switch
        {
            "insert" => provider.InsertRecords(moduleKey, entityKey, Records(arguments, insert: true), tenantId),
            "update" => provider.UpdateRecords(moduleKey, entityKey, Records(arguments, insert: false), tenantId),
            "delete" => provider.DeleteRecords(moduleKey, entityKey, Ids(arguments), tenantId),
            _ => throw new ArgumentException("operation must be insert, update or delete"),
        };
        if (reports == null) throw new InvalidOperationException("The environment does not advertise Edit Data (EditDataV4)");
        return reports.Select(r => new Report(r.RecordId, r.ClientRecordId, r.Status.ToString(), r.ErrorMessage)).ToArray();
    }

    // ---- bounded reads (P3, friction cc5deb6b, 2026-10-08) ------------------------------------------------------------
    //
    // A read-all of AuditEntry from offset 100000 ran 330 s against the Studio and the Studio froze and closed; reads of
    // 220-320 s were routine that night (session 534731c6) and two of them ended together when the Studio died. read-all
    // looped up to 1000 pages in one call, every page through the Studio, with no deadline and every row in memory. Now:
    // each page has a hard timeout on both sides (the Studio's call and the CLI's wait), one call stops at a row limit or
    // at its deadline, and an incomplete answer says the offset to continue from. Edit Data pages only by offset (no
    // filter, no keyset): a deep offset is still the server's work, but never more than one bounded page at a time.

    /// <summary>The limits of one data call: rows a read-all gathers, its whole deadline, and the timeout of one page.</summary>
    public sealed record ReadLimits(int MaxRows, TimeSpan Deadline, TimeSpan ChunkTimeout)
    {
        public const int DefaultMaxRows = 2000, RowCap = 10000;
        public const int DefaultDeadlineMs = 60000, MinDeadlineMs = 1000, MaxDeadlineMs = 120000;
        public static readonly TimeSpan DefaultChunkTimeout = TimeSpan.FromSeconds(30);
        public static readonly ReadLimits Default = new(DefaultMaxRows, TimeSpan.FromMilliseconds(DefaultDeadlineMs), DefaultChunkTimeout);

        /// <summary>The limits of one operation: limit (rows, 1..RowCap) and deadlineMs (1000..120000) of the request, never
        /// above the caps; the page timeout never exceeds the deadline.</summary>
        public ReadLimits For(JsonObject operation)
        {
            var rows = operation["limit"] is JsonValue l && l.TryGetValue<int>(out var limit) ? Math.Clamp(limit, 1, RowCap) : MaxRows;
            var deadline = operation["deadlineMs"] is JsonValue d && d.TryGetValue<int>(out var ms)
                ? TimeSpan.FromMilliseconds(Math.Clamp(ms, MinDeadlineMs, MaxDeadlineMs)) : Deadline;
            return new ReadLimits(rows, deadline, ChunkTimeout < deadline ? ChunkTimeout : deadline);
        }
    }

    /// <summary>A page that did not answer within its timeout: nothing of it is used, and the caller is never kept waiting.</summary>
    public sealed class DataReadTimeoutException(string message) : TimeoutException(message);

    /// <summary>Runs call on the thread pool and waits at most timeout: past it, DataReadTimeoutException, and the call's
    /// late answer (or fault) is dropped. The bridge's TCP call of each page is its own connection, so leaving it behind
    /// never blocks the next one.</summary>
    public static T Bounded<T>(Func<T> call, TimeSpan timeout, string what)
    {
        var task = Task.Run(call);
        if (Task.WhenAny(task, Task.Delay(timeout)).GetAwaiter().GetResult() != task)
        {
            _ = task.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
            throw new DataReadTimeoutException($"{what} did not answer within {(int)timeout.TotalSeconds} s");
        }
        return task.GetAwaiter().GetResult();
    }

    private static TimeSpan ChunkTimeoutOf(JsonObject? arguments)
        => arguments?["timeoutMs"] is JsonValue v && v.TryGetValue<int>(out var ms)
            ? TimeSpan.FromMilliseconds(Math.Clamp(ms, 1000, (int)ReadLimits.DefaultChunkTimeout.TotalMilliseconds * 2))
            : ReadLimits.DefaultChunkTimeout;

    public static bool IsRefusedModule(string moduleKey)
    {
        string Canonical(string key) { try { return Keys.ToStudio(key); } catch { return key; } }
        var studio = Canonical(moduleKey);
        return RefusedModuleKeys.Any(k => string.Equals(Canonical(k), studio, StringComparison.Ordinal));
    }

    private static string Text(JsonObject? arguments, string name)
        => arguments?[name]?.GetValue<string>() is { Length: > 0 } value ? value : throw new ArgumentException(name + " is required");

    private static EntityRecordInfo[] Records(JsonObject? arguments, bool insert)
    {
        var rows = arguments?["records"]?.AsArray() ?? throw new ArgumentException("records are required");
        if (rows.Count == 0) throw new ArgumentException("records must be nonempty");
        return rows.Select(row =>
        {
            var id = row?["id"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("Each record needs an id (a client id on insert)");
            var cells = row!["attributes"]?.AsArray() ?? throw new ArgumentException("Each record needs attributes");
            return new EntityRecordInfo { Id = id, EntityAttributesInfo = cells.Select(c => new EntityAttributeInfo {
                Key = c?["key"]?.GetValue<string>() ?? throw new ArgumentException("Each attribute needs a key"),
                Value = c["value"]?.GetValue<string>()! }).ToArray() };
        }).ToArray();
    }

    private static string[] Ids(JsonObject? arguments)
    {
        var ids = arguments?["ids"]?.AsArray().Select(x => x?.GetValue<string>() ?? "").ToArray() ?? throw new ArgumentException("ids are required");
        if (ids.Length == 0 || ids.Any(string.IsNullOrWhiteSpace) || ids.Distinct().Count() != ids.Length)
            throw new ArgumentException("ids must be nonempty and unique");
        return ids;
    }

    // ---- CLI side ------------------------------------------------------------

    /// <summary>Entities of the module itself (server entities with an identifier) from a published snapshot.</summary>
    public static DataSchema Schema(ModelHost host, string oml)
    {
        var model = host.Load(oml);
        try
        {
            var es = (IESpace)model;
            string TypeName(IEntityAttribute a)
            {
                var t = a.DataType;
                if (ReferenceEquals(t, es.BooleanType)) return "Boolean";
                if (ReferenceEquals(t, es.DateTimeType)) return "DateTime";
                if (ReferenceEquals(t, es.DateType)) return "Date";
                if (ReferenceEquals(t, es.TimeType)) return "Time";
                if (ReferenceEquals(t, es.BinaryDataType)) return "Binary";
                // A foreign key: the record id of another entity, read and written as text like a Long Integer.
                if (t is OutSystems.Model.Types.IIdentifierType identifier) return (TypeResolver.Name(identifier.Entity) ?? "Entity") + " Identifier";
                return TypeResolver.Name(t) ?? t?.GetType().Name ?? "Unknown";
            }
            return new DataSchema(es.Name, Keys.ToDb(es.ObjectKey.ToString()!),
                es.GetAllDescendantsOfType<IEntity>().Where(e => e.GetInterface()?.Name is "IServerEntity" or "IStaticEntity")
                .Select(e => new DataEntity(e.Name, Keys.ToDb(e.ObjectKey.ToString()!), e.GetInterface()?.Name == "IStaticEntity",
                    e.Attributes.Select(a => new DataAttribute(a.Name, Keys.ToDb(a.ObjectKey.ToString()!),
                        a.IsAutoNumber.ToString() == "Yes", ReferenceEquals(a.DataType, es.BinaryDataType), TypeName(a))).ToArray(),
                    e is ServiceStudio.Model.Entity native ? native.EntityIndices.Where(index => index.Unique).Select(index =>
                        new DataIndex(index.Name, index.Unique, index.IndexAttributes.Select(part => part.Attribute.Name).ToArray())).ToArray() : [])).ToArray());
        }
        finally { ModelHost.Release(model); }
    }

    /// <summary>The offline data contract read from a published module snapshot.</summary>
    public static JsonObject SchemaAnswer(DataSchema schema) => new()
    {
        ["ok"] = true, ["module"] = schema.Module, ["moduleKey"] = schema.Key,
        ["entities"] = new JsonArray(schema.Entities.Select(entity => (JsonNode)new JsonObject
        {
            ["name"] = entity.Name, ["key"] = entity.Key, ["static"] = entity.IsStatic, ["identifier"] = IdentifierOf(entity),
            ["indexes"] = new JsonArray((entity.Indexes ?? []).Select(index => (JsonNode)new JsonObject {
                ["name"] = index.Name, ["unique"] = index.Unique,
                ["attributes"] = new JsonArray(index.Attributes.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()),
            }).ToArray()),
            ["attributes"] = new JsonArray(entity.Attributes.Select(attribute => (JsonNode)new JsonObject
            {
                ["name"] = attribute.Name, ["type"] = attribute.Type,
                ["autoNumber"] = attribute.AutoNumber, ["binary"] = attribute.IsBinary,
            }).ToArray()),
        }).ToArray()),
    };

    // ---- values by type (C36) -------------------------------------------------
    //
    // Edit Data takes text and stores it by the attribute type; text it cannot read becomes the type's null value and the
    // write still reports Success (a DateTime "2026-10-04T15:38:07" was stored as 1900-01-01, session 890a2354, 04/10). So
    // every value is normalized by the attribute type to the text the grid writes right (measured: "2026-10-03 23:55:00"
    // and "2026-09-28" read back as "2026-10-03T23:55:00" and "2026-09-28T00:00:00"), and a value that cannot be read
    // is refused before any write. The read gives back the form the write takes, so a row read can be written unchanged.

    private enum Family { Unknown, Text, Boolean, Integer, LongInteger, Decimal, DateTime, Date, Time, Identifier, Binary }

    private static Family FamilyOf(string? type) => type switch
    {
        "Boolean" => Family.Boolean,
        "DateTime" or "Date Time" => Family.DateTime,
        "Date" => Family.Date,
        "Time" => Family.Time,
        "Integer" => Family.Integer,
        "Long Integer" => Family.LongInteger,
        "Decimal" or "Currency" => Family.Decimal,
        "Text" or "Email" or "Phone Number" => Family.Text,
        "Binary" or "Binary Data" => Family.Binary,
        { } t when t.EndsWith(" Identifier", StringComparison.Ordinal) => Family.Identifier,
        _ => Family.Unknown,
    };

    private static string Accepted(Family family) => family switch
    {
        Family.DateTime => "yyyy-MM-ddTHH:mm:ss[.fff], yyyy-MM-dd HH:mm:ss or yyyy-MM-dd, local time without Z or offset",
        Family.Date => "yyyy-MM-dd",
        Family.Time => "HH:mm:ss or HH:mm",
        Family.Boolean => "true/false (JSON) or \"True\"/\"False\"",
        Family.Integer => "an integer from -2147483648 to 2147483647, as a JSON number or digits",
        Family.LongInteger => "a JSON integer up to 2^53, or the digits as a string",
        Family.Decimal => "a JSON number, or a string with '.' as the decimal separator",
        Family.Identifier => "the record id as a string (or a JSON integer up to 2^53)",
        _ => "a scalar",
    };

    private const long JsonSafeInteger = 9007199254740992; // 2^53: a larger JSON number may already have lost digits
    private static readonly Regex DateTimeShape = new(@"^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?)?$", RegexOptions.Compiled);
    private static readonly Regex ZonedShape = new(@"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex TimeShape = new(@"^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?$", RegexOptions.Compiled);

    /// <summary>A data request refused before any write: the code (DATA_VALUE_INVALID, DATA_REF_UNRESOLVED,
    /// DATA_REQUEST_INVALID) and one line with the reason and what is accepted.</summary>
    public sealed class DataRequestException(string code, string message) : ArgumentException(message)
    {
        public string Code { get; } = code;
    }

    private static (JsonValueKind Kind, string? Text) Scalar(JsonNode value)
    {
        var kind = value.GetValueKind();
        return kind switch
        {
            JsonValueKind.String => (kind, value.GetValue<string>()),
            JsonValueKind.Number => (kind, value.ToJsonString()),
            JsonValueKind.True => (kind, "True"),
            JsonValueKind.False => (kind, "False"),
            _ => (kind, null),
        };
    }

    /// <summary>JSON value → the text Edit Data stores right for the attribute type (null stays null). A value that cannot
    /// be read as that type is refused with DATA_VALUE_INVALID: "&lt;Entity&gt;.&lt;Attribute&gt; (&lt;Type&gt;): '&lt;value&gt;' ...; accepted: ...".
    /// An attribute without a known type (a schema built elsewhere) keeps the raw text, as before.</summary>
    public static string? Encode(DataAttribute attribute, JsonNode? value, string? entity = null)
    {
        if (value == null) return null;
        if (value is JsonObject or JsonArray) throw new ArgumentException("Attribute values must be scalar: " + attribute.Name);
        var (kind, text) = Scalar(value);
        if (kind == JsonValueKind.Null) return null;
        if (text == null) throw new ArgumentException("Unsupported value for " + attribute.Name);
        var family = FamilyOf(attribute.Type);
        string Refuse(string why)
        {
            var shown = text.Length > 60 ? text[..60] + "..." : text;
            throw new DataRequestException("DATA_VALUE_INVALID", $"{entity ?? "?"}.{attribute.Name} ({attribute.Type}): '{shown}' {why}; accepted: {Accepted(family)}");
        }
        switch (family)
        {
            case Family.Unknown: case Family.Text: case Family.Binary:
                return text;
            case Family.Boolean:
                if (kind is JsonValueKind.True or JsonValueKind.False) return text;
                return kind == JsonValueKind.String && bool.TryParse(text.Trim(), out var flag) ? (flag ? "True" : "False") : Refuse("is not a Boolean");
            case Family.Integer:
                if (kind is JsonValueKind.Number or JsonValueKind.String && Integral(text, out var integer))
                    return integer is >= int.MinValue and <= int.MaxValue ? integer.ToString(CultureInfo.InvariantCulture) : Refuse("is out of the Integer range");
                return Refuse("is not an integer");
            case Family.LongInteger: case Family.Identifier:
                if (kind == JsonValueKind.Number)
                {
                    if (!Integral(text, out var number)) return Refuse("is not an integer");
                    return Math.Abs(number) <= JsonSafeInteger ? number.ToString(CultureInfo.InvariantCulture)
                        : Refuse("is a JSON number beyond 2^53, which may already have lost digits: send the digits as a string");
                }
                if (kind != JsonValueKind.String) return Refuse(family == Family.Identifier ? "is not a record id" : "is not an integer");
                if (family == Family.Identifier) return text.Trim().Length > 0 ? text.Trim() : Refuse("is empty; send null for no record");
                return long.TryParse(text.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var big)
                    ? big.ToString(CultureInfo.InvariantCulture) : Refuse("is not an integer");
            case Family.Decimal:
                return kind is JsonValueKind.Number or JsonValueKind.String
                    && decimal.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var amount)
                    ? amount.ToString(CultureInfo.InvariantCulture) : Refuse("is not a number with '.' as the decimal separator");
            case Family.DateTime:
                if (kind != JsonValueKind.String) return Refuse("is not a date and time");
                if (ZonedShape.IsMatch(text.Trim())) return Refuse("carries a time zone (Z or an offset); Edit Data stores the wall-clock time and the tool never guesses a conversion");
                return TryDateTime(text.Trim(), out var moment) ? moment.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) : Refuse("is not a date and time");
            case Family.Date:
                if (kind != JsonValueKind.String) return Refuse("is not a date");
                if (ZonedShape.IsMatch(text.Trim())) return Refuse("carries a time zone (Z or an offset); a Date keeps only yyyy-MM-dd");
                if (!TryDateTime(text.Trim(), out var day)) return Refuse("is not a date");
                return day.TimeOfDay == TimeSpan.Zero ? day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : Refuse("has a time of day; a Date keeps only yyyy-MM-dd");
            case Family.Time:
                return kind == JsonValueKind.String && TryTime(text.Trim(), out var time) ? time : Refuse("is not a time of day");
        }
        return text;
    }

    private static bool Integral(string text, out long value)
    {
        value = 0;
        if (long.TryParse(text.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value)) return true;
        if (!decimal.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) || d != decimal.Truncate(d)
            || d < long.MinValue || d > long.MaxValue) return false;
        value = (long)d; return true;
    }

    private static bool TryDateTime(string text, out DateTime value)
    {
        value = default;
        var match = DateTimeShape.Match(text);
        if (!match.Success || !DateTime.TryParseExact(match.Groups[1].Value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) return false;
        if (!match.Groups[2].Success) { value = date; return true; }
        var hours = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture); var minutes = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
        var seconds = match.Groups[4].Success ? int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture) : 0;
        if (hours > 23 || minutes > 59 || seconds > 59) return false;
        value = date.Add(new TimeSpan(hours, minutes, seconds)); return true;
    }

    private static bool TryTime(string text, out string value)
    {
        value = "";
        var match = TimeShape.Match(text);
        if (!match.Success)
        {
            // The read may carry the time on the null date (1900-01-01T13:45:00).
            if (!TryDateTime(text, out var moment) || !text.Contains(':')) return false;
            value = moment.ToString("HH:mm:ss", CultureInfo.InvariantCulture); return true;
        }
        var hours = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture); var minutes = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
        var seconds = match.Groups[3].Success ? int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture) : 0;
        if (hours > 23 || minutes > 59 || seconds > 59) return false;
        value = $"{hours:00}:{minutes:00}:{seconds:00}"; return true;
    }

    /// <summary>Stored text (what Edit Data reads) → the JSON the write takes back unchanged: DateTime
    /// yyyy-MM-ddTHH:mm:ss, Date yyyy-MM-dd, Time HH:mm:ss, Boolean a JSON bool, Integer and Decimal JSON numbers, Long
    /// Integer and record ids strings. Text the type cannot read is returned as it is.</summary>
    public static JsonNode? Decode(DataAttribute attribute, string? text)
    {
        if (text == null) return null;
        var trimmed = text.Trim();
        switch (FamilyOf(attribute.Type))
        {
            case Family.DateTime:
                if (TryDateTime(trimmed, out var moment)) return moment.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
                break;
            case Family.Date:
                if (TryDateTime(trimmed, out var day)) return day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                break;
            case Family.Time:
                if (TryTime(trimmed, out var time)) return time;
                break;
            case Family.Boolean:
                if (bool.TryParse(trimmed, out var flag)) return flag;
                if (trimmed is "1" or "0") return trimmed == "1";
                break;
            case Family.Integer:
                if (long.TryParse(trimmed, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var integer)) return integer;
                break;
            case Family.Decimal:
                if (decimal.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out var amount)) return amount;
                break;
        }
        return text;
    }

    /// <summary>The canonical text of a value for comparisons: the text the write sends for it (decimals without trailing
    /// zeros). Stored and sent texts of the same value compare equal; text the type cannot read stays as it is.</summary>
    public static string? Canonical(DataAttribute attribute, string? text)
    {
        if (text == null) return null;
        string? encoded;
        try { encoded = Encode(attribute, Decode(attribute, text)); }
        catch (ArgumentException) { return text; }
        if (encoded != null && FamilyOf(attribute.Type) == Family.Decimal && decimal.TryParse(encoded, NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
            return (d / 1.000000000000000000000000000000000m).ToString(CultureInfo.InvariantCulture);
        return encoded;
    }

    /// <summary>The value the database keeps for "nothing" (null sent, NULL or the platform's null value read).</summary>
    private static string? NullValue(DataAttribute attribute) => FamilyOf(attribute.Type) switch
    {
        Family.Text => "", Family.Boolean => "False", Family.Integer or Family.LongInteger or Family.Decimal => "0",
        Family.DateTime => "1900-01-01 00:00:00", Family.Date => "1900-01-01", Family.Time => "00:00:00",
        _ => null,
    };

    /// <summary>Two texts hold the same value of the attribute: equal canonical texts, or null against the type's null value.</summary>
    public static bool SameValue(DataAttribute attribute, string? a, string? b)
    {
        var left = Canonical(attribute, a) ?? NullValue(attribute); var right = Canonical(attribute, b) ?? NullValue(attribute);
        return string.Equals(left, right, StringComparison.Ordinal);
    }

    /// <summary>Attributes by key, in database form and in the model's base64 form (the bridge may answer either).</summary>
    private static Dictionary<string, DataAttribute> AttributeIndex(DataEntity entity)
    {
        var index = new Dictionary<string, DataAttribute>(StringComparer.OrdinalIgnoreCase);
        foreach (var a in entity.Attributes)
        {
            index[a.Key] = a;
            try { index[Keys.ToStudio(a.Key)] = a; } catch { }
        }
        return index;
    }

    private static string IdentifierOf(DataEntity entity) => entity.Attributes.FirstOrDefault(a => a.AutoNumber)?.Name ?? "Id";

    /// <summary>Plan records (attribute names → values) as wire records (attribute keys → text normalized by type).</summary>
    public static JsonArray WireRecords(DataEntity entity, JsonArray records, bool insert)
    {
        if (records.Count == 0) throw new ArgumentException("records must be nonempty");
        var identifier = IdentifierOf(entity);
        var wire = new JsonArray();
        for (var i = 0; i < records.Count; i++)
        {
            var record = records[i]?.AsObject() ?? throw new ArgumentException("Each record must be an object");
            var id = insert ? "new-" + i : record[identifier]?.ToString();
            if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException($"update needs {identifier} on every record");
            var cells = new JsonArray();
            foreach (var pair in record)
            {
                var a = entity.Attributes.SingleOrDefault(x => x.Name == pair.Key) ?? throw new ArgumentException($"Unknown attribute {entity.Name}.{pair.Key}");
                if (a.Name == identifier) { if (insert && a.AutoNumber) throw new ArgumentException("AutoNumber is assigned by the server: " + a.Name); if (!insert) continue; }
                if (a.IsBinary) throw new ArgumentException("Binary Data is not written by this command: " + a.Name);
                cells.Add(new JsonObject { ["key"] = a.Key, ["value"] = Encode(a, pair.Value, entity.Name) });
            }
            wire.Add(new JsonObject { ["id"] = id, ["attributes"] = cells });
        }
        return wire;
    }

    /// <summary>Wire rows (keys) → named rows, the identifier first as "Id", every value decoded by its type (the form the
    /// write accepts back unchanged).</summary>
    public static JsonArray NamedRows(DataEntity entity, IEnumerable<Row> rows)
    {
        var index = AttributeIndex(entity);
        var identifier = IdentifierOf(entity);
        var result = new JsonArray();
        foreach (var row in rows)
        {
            var named = new JsonObject { ["Id"] = row.Id };
            foreach (var cell in row.Attributes)
            {
                if (!index.TryGetValue(cell.Key, out var a)) { named[cell.Key] = cell.Value; continue; }
                named[a.Name] = a.Name == identifier ? cell.Value : Decode(a, cell.Value);
            }
            result.Add(named);
        }
        return result;
    }

    /// <summary>The cells of an update whose canonical value differs from the stored record: equal cells are dropped and a
    /// record with no change is not sent. A record the read did not return is sent whole.</summary>
    public static JsonArray ChangedCells(DataEntity entity, JsonArray wire, IEnumerable<Row> current, out int unchanged)
    {
        var index = AttributeIndex(entity);
        var stored = new Dictionary<string, Row>(StringComparer.Ordinal);
        foreach (var row in current) stored[row.Id] = row;
        var changed = new JsonArray(); unchanged = 0;
        foreach (var record in wire.OfType<JsonObject>())
        {
            var id = record["id"]!.ToString();
            if (!stored.TryGetValue(id, out var row)) { changed.Add(record.DeepClone()); continue; }
            var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            foreach (var cell in row.Attributes) if (index.TryGetValue(cell.Key, out var a)) values[a.Key] = cell.Value;
            var cells = new JsonArray();
            foreach (var cell in record["attributes"]!.AsArray().OfType<JsonObject>())
            {
                var key = cell["key"]!.ToString(); var sent = cell["value"]?.ToString();
                if (index.TryGetValue(key, out var a) && values.TryGetValue(a.Key, out var before) && SameValue(a, sent, before)) continue;
                cells.Add(cell.DeepClone());
            }
            if (cells.Count == 0) { unchanged++; continue; }
            changed.Add(new JsonObject { ["id"] = id, ["attributes"] = cells });
        }
        return changed;
    }

    /// <summary>What the read-back of written records contradicts: one {id, attribute, sent, stored} per cell whose stored
    /// value is not the value sent (a record the read does not return contradicts every cell sent).</summary>
    public static JsonArray ReadbackDifferences(DataEntity entity, JsonArray sent, IEnumerable<Row> stored)
    {
        var index = AttributeIndex(entity);
        var rows = new Dictionary<string, Row>(StringComparer.Ordinal);
        foreach (var row in stored) rows[row.Id] = row;
        var differences = new JsonArray();
        foreach (var record in sent.OfType<JsonObject>())
        {
            var id = record["id"]!.ToString();
            rows.TryGetValue(id, out var row);
            var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            foreach (var cell in row?.Attributes ?? []) if (index.TryGetValue(cell.Key, out var a)) values[a.Key] = cell.Value;
            foreach (var cell in record["attributes"]!.AsArray().OfType<JsonObject>())
            {
                if (!index.TryGetValue(cell["key"]!.ToString(), out var a)) continue;
                var value = cell["value"]?.ToString();
                values.TryGetValue(a.Key, out var kept);
                if (row != null && SameValue(a, value, kept)) continue;
                differences.Add(new JsonObject { ["id"] = id, ["attribute"] = a.Name, ["sent"] = value, ["stored"] = row == null ? null : kept });
            }
        }
        return differences;
    }

    // ---- batch: $ref, all problems before any write, read-back (C36, C24/I12) ---------------------------------------

    /// <summary>The Edit Data calls of one lease: HeadlessSession through the Studio in the CLI, fakes in the tests.
    /// Read(entityKey, tenantId, ids, offset); Write(entityKey, tenantId, operation, wire records, ids); Receipt(entity,
    /// write request, send) runs send once under the durable receipt (DataReceipt) and returns its result.</summary>
    public sealed record DataStore(
        Func<string, int?, string[]?, int, Row[]> Read,
        Func<string, int?, string, JsonArray?, string[]?, Report[]> Write,
        Func<DataEntity, JsonObject, Func<JsonObject>, JsonObject> Receipt);

    private static readonly string[] Operations = ["read", "read-all", "insert", "update", "delete"];

    /// <summary>{"$ref":"step"} or {"$ref":"step#i"}: the id an earlier insert of the same batch returned (I12).</summary>
    public static bool IsRef(JsonNode? node, out string step, out int? index)
    {
        step = ""; index = null;
        if (node is not JsonObject o || o.Count != 1 || o["$ref"] is not JsonValue v || !v.TryGetValue<string>(out var text) || text.Length == 0) return false;
        var hash = text.LastIndexOf('#');
        if (hash > 0 && int.TryParse(text[(hash + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var i)) { step = text[..hash]; index = i; }
        else step = text;
        return true;
    }

    /// <summary>The operation with every $ref (attribute values of records, ids, and the identifier of an update) replaced
    /// by the id the step returned; a reference to a step that has not run, or to an index it did not return, is refused
    /// with DATA_REF_UNRESOLVED.</summary>
    public static JsonObject ResolveRefs(JsonObject operation, IReadOnlyDictionary<string, IReadOnlyList<string>> stepIds)
    {
        JsonNode? Resolve(JsonNode? node)
        {
            if (!IsRef(node, out var step, out var index)) return node?.DeepClone();
            if (!stepIds.TryGetValue(step, out var ids))
                throw new DataRequestException("DATA_REF_UNRESOLVED", $"$ref '{node!["$ref"]}' names no insert that ran before this operation; known steps: {(stepIds.Count == 0 ? "none" : string.Join(", ", stepIds.Keys))}");
            if (index == null && ids.Count != 1)
                throw new DataRequestException("DATA_REF_UNRESOLVED", $"$ref '{step}' needs an index: that insert returned {ids.Count} ids; write {{\"$ref\":\"{step}#0\"}} for the first");
            var i = index ?? 0;
            if (i < 0 || i >= ids.Count || string.IsNullOrEmpty(ids[i]))
                throw new DataRequestException("DATA_REF_UNRESOLVED", $"$ref '{step}#{i}' is beyond the {ids.Count} ids that insert returned (base 0)");
            return ids[i];
        }
        var resolved = operation.DeepClone().AsObject();
        if (resolved["records"] is JsonArray records)
            foreach (var record in records.OfType<JsonObject>())
                foreach (var key in record.Select(p => p.Key).ToArray()) record[key] = Resolve(record[key]);
        if (resolved["ids"] is JsonArray ids)
            for (var i = 0; i < ids.Count; i++) ids[i] = Resolve(ids[i]);
        return resolved;
    }

    private static JsonObject Problem(int op, string pointer, string code, string message) => new()
    {
        ["op"] = op, ["pointer"] = pointer, ["code"] = code, ["severity"] = "error", ["message"] = message,
    };

    private static List<JsonObject> OperationsOf(JsonObject request)
        => request["batch"] is JsonArray batch ? batch.Select(o => o as JsonObject ?? new JsonObject()).ToList() : [request];

    /// <summary>Every problem of the request, found before any call: entity and operation names, write authorization and
    /// operationId, attributes, each value against its type (DATA_VALUE_INVALID) and each $ref against the inserts that come
    /// before it (DATA_REF_UNRESOLVED). Empty when the batch can run.</summary>
    public static JsonArray ValidateBatch(DataSchema schema, JsonObject request, bool writeFields = true)
    {
        var problems = new JsonArray();
        var operations = OperationsOf(request);
        var batched = request["batch"] is JsonArray;
        if (request["batch"] is { } b && b is not JsonArray) problems.Add(Problem(0, "/batch", "DATA_REQUEST_INVALID", "batch must be an array of operations"));
        if (batched && operations.Count == 0) problems.Add(Problem(0, "/batch", "DATA_REQUEST_INVALID", "batch must hold at least one operation"));
        var inserts = new Dictionary<string, int>(StringComparer.Ordinal); // step → number of records, for the inserts seen so far
        var operationIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var k = 0; k < operations.Count; k++)
        {
            var operation = operations[k];
            var at = batched ? $"/batch/{k}" : "";
            var kind = operation["operation"]?.ToString();
            if (!Operations.Contains(kind)) { problems.Add(Problem(k, at + "/operation", "DATA_REQUEST_INVALID", $"operation must be {string.Join(", ", Operations)}; got '{kind}'")); continue; }
            var entity = schema.Entities.SingleOrDefault(e => e.Name == operation["entity"]?.ToString());
            if (entity == null)
            {
                problems.Add(Problem(k, at + "/entity", "DATA_REQUEST_INVALID", $"Entity not found in this module: {operation["entity"]}; entities: {string.Join(", ", schema.Entities.Select(e => e.Name))}"));
                continue;
            }
            void CheckRef(JsonNode? node, string pointer)
            {
                if (!IsRef(node, out var step, out var index)) return;
                if (!inserts.TryGetValue(step, out var count))
                    problems.Add(Problem(k, pointer, "DATA_REF_UNRESOLVED", $"$ref '{node!["$ref"]}' names no insert step before operation {k}: a reference reaches only earlier inserts of the batch; steps before it: {(inserts.Count == 0 ? "none" : string.Join(", ", inserts.Keys))}"));
                else if (index == null && count != 1)
                    problems.Add(Problem(k, pointer, "DATA_REF_UNRESOLVED", $"$ref '{step}' needs an index: that insert writes {count} records; write {{\"$ref\":\"{step}#0\"}} for the first (base 0)"));
                else if (index >= count)
                    problems.Add(Problem(k, pointer, "DATA_REF_UNRESOLVED", $"$ref '{step}#{index}' is beyond the {count} records of that insert (base 0)"));
            }
            if (operation["ids"] is JsonArray ids)
                for (var i = 0; i < ids.Count; i++) CheckRef(ids[i], $"{at}/ids/{i}");
            if (kind is "read" or "read-all")
            {
                bool Integer(string name, int min, int max)
                    => operation[name] is null || operation[name] is JsonValue v && v.TryGetValue<int>(out var n) && n >= min && n <= max;
                if (!Integer("offset", 0, int.MaxValue)) problems.Add(Problem(k, at + "/offset", "DATA_REQUEST_INVALID", "offset is an integer >= 0"));
                if (!Integer("limit", 1, ReadLimits.RowCap)) problems.Add(Problem(k, at + "/limit", "DATA_REQUEST_INVALID", $"limit is the most rows one read-all answers, 1..{ReadLimits.RowCap} (default {ReadLimits.DefaultMaxRows}); continue with the offset the answer gives"));
                if (!Integer("deadlineMs", ReadLimits.MinDeadlineMs, ReadLimits.MaxDeadlineMs)) problems.Add(Problem(k, at + "/deadlineMs", "DATA_REQUEST_INVALID", $"deadlineMs is {ReadLimits.MinDeadlineMs}..{ReadLimits.MaxDeadlineMs} (default {ReadLimits.DefaultDeadlineMs})"));
                continue;
            }

            if (entity.IsStatic) problems.Add(Problem(k, at + "/entity", "DATA_REQUEST_INVALID", $"{entity.Name} is a static entity: its records change in the model and are published, not through Edit Data"));
            if (writeFields)
            {
                if (string.IsNullOrWhiteSpace(operation["authorization"]?.ToString() ?? request["authorization"]?.ToString()))
                    problems.Add(Problem(k, at + "/authorization", "DATA_REQUEST_INVALID", "Writing data requires the user's original authorization words in authorization (on the operation or on the batch)"));
                var operationId = operation["operationId"]?.ToString();
                if (!Guid.TryParse(operationId, out _)) problems.Add(Problem(k, at + "/operationId", "DATA_REQUEST_INVALID", "Writing data requires a stable UUID operationId on every write"));
                else if (!operationIds.Add(operationId!)) problems.Add(Problem(k, at + "/operationId", "DATA_REQUEST_INVALID", $"operationId {operationId} is used by two writes of the batch; each write needs its own UUID"));
            }
            if (kind == "delete")
            {
                if (operation["ids"] is not JsonArray deleteIds || deleteIds.Count == 0)
                    problems.Add(Problem(k, at + "/ids", "DATA_REQUEST_INVALID", "delete needs ids, a nonempty array of record ids"));
                else if (deleteIds.Where(x => !IsRef(x, out _, out _)).Select(x => x?.ToString()).ToArray() is var plain && (plain.Any(string.IsNullOrWhiteSpace) || plain.Distinct().Count() != plain.Length))
                    problems.Add(Problem(k, at + "/ids", "DATA_REQUEST_INVALID", "delete ids must be nonempty and unique"));
                continue;
            }
            if (operation["records"] is not JsonArray records || records.Count == 0)
            {
                problems.Add(Problem(k, at + "/records", "DATA_REQUEST_INVALID", $"{kind} needs records, a nonempty array of {{Attribute: value}}"));
                continue;
            }
            var identifier = IdentifierOf(entity);
            for (var r = 0; r < records.Count; r++)
            {
                if (records[r] is not JsonObject record) { problems.Add(Problem(k, $"{at}/records/{r}", "DATA_REQUEST_INVALID", "Each record must be an object")); continue; }
                if (kind == "update" && (record[identifier] is not { } id || !IsRef(id, out _, out _) && string.IsNullOrWhiteSpace(id.ToString())))
                    problems.Add(Problem(k, $"{at}/records/{r}/{identifier}", "DATA_REQUEST_INVALID", $"update needs {identifier} on every record"));
                foreach (var (name, value) in record)
                {
                    var pointer = $"{at}/records/{r}/{name}";
                    var a = entity.Attributes.SingleOrDefault(x => x.Name == name);
                    if (a == null) { problems.Add(Problem(k, pointer, "DATA_REQUEST_INVALID", $"Unknown attribute {entity.Name}.{name}; attributes: {string.Join(", ", entity.Attributes.Select(x => x.Name))}")); continue; }
                    if (a.Name == identifier && kind == "insert" && a.AutoNumber) { problems.Add(Problem(k, pointer, "DATA_REQUEST_INVALID", "AutoNumber is assigned by the server: " + a.Name)); continue; }
                    if (a.IsBinary) { problems.Add(Problem(k, pointer, "DATA_REQUEST_INVALID", "Binary Data is not written by this command: " + a.Name)); continue; }
                    if (IsRef(value, out _, out _)) { CheckRef(value, pointer); continue; }
                    try { Encode(a, value, entity.Name); }
                    catch (DataRequestException e) { problems.Add(Problem(k, pointer, e.Code, e.Message)); }
                    catch (ArgumentException e) { problems.Add(Problem(k, pointer, "DATA_REQUEST_INVALID", e.Message)); }
                }
            }
            if (kind == "insert" && operation["step"] is { } stepNode)
            {
                var step = stepNode.ToString();
                if (!inserts.TryAdd(step, records.Count)) problems.Add(Problem(k, at + "/step", "DATA_REQUEST_INVALID", $"step '{step}' names two inserts; a $ref needs one"));
            }
        }
        return problems;
    }

    /// <summary>The refusal of a request with problems (nothing sent), or null when it can run.</summary>
    public static JsonObject? Refusal(DataSchema schema, JsonObject request, bool writeFields = true)
    {
        var problems = ValidateBatch(schema, request, writeFields);
        if (problems.Count == 0) return null;
        var first = problems[0]!.AsObject();
        return new JsonObject
        {
            ["ok"] = false, ["code"] = first["code"]!.DeepClone(), ["error"] = $"{problems.Count} problem(s) before any write; first: {first["message"]}",
            ["problems"] = problems, ["submitted"] = 0, ["total"] = OperationsOf(request).Count, ["results"] = new JsonArray(),
        };
    }

    /// <summary>Validate the entire request offline, without a Studio session or data store. A dry run may omit only
    /// the write authorization and operationId fields; every model, value and reference rule still applies.</summary>
    public static JsonObject Check(DataSchema schema, JsonObject request, bool writeFields)
    {
        if (Refusal(schema, request, writeFields) is { } refusal) return refusal;
        var operations = OperationsOf(request);
        return new JsonObject
        {
            ["ok"] = true, ["operations"] = operations.Count,
            ["records"] = operations.Sum(operation => (operation["records"] as JsonArray)?.Count ?? 0),
        };
    }

    /// <summary>The request, one operation or {authorization?, batch:[...]}: refused whole before any call when it has a
    /// problem; otherwise run in order in one lease, stopping at the first failure. Inserts answer their ids in record order
    /// and feed later $refs; an update sends only the cells whose value changes (nothing at all when every value is equal);
    /// every insert and update reads back what it wrote and fails with DATA_READBACK_MISMATCH when the database keeps another
    /// value. Writes go through the receipt, which records them and never repeats them.</summary>
    public static JsonObject RunBatch(DataSchema schema, JsonObject request, DataStore store, ReadLimits? limits = null)
    {
        if (Refusal(schema, request) is { } refusal) return refusal;
        var operations = OperationsOf(request);
        var authorization = request["batch"] is JsonArray ? request["authorization"] : null;
        var stepIds = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        var results = new JsonArray();
        var ok = true; string? code = null;
        // The reads of the whole call share one clock: its deadline counts from the start of the call, never per page.
        var clock = System.Diagnostics.Stopwatch.StartNew();
        foreach (var operation in operations)
        {
            JsonObject result;
            try { result = RunOne(schema, ResolveRefs(operation, stepIds), authorization, store, (limits ?? ReadLimits.Default).For(operation), clock); }
            catch (DataRequestException error) { result = new JsonObject { ["ok"] = false, ["code"] = error.Code, ["error"] = error.Message }; }
            catch (Exception error) { result = new JsonObject { ["ok"] = false, ["error"] = error.GetType().Name + ": " + error.Message }; }
            result["entity"] = operation["entity"]?.ToString();
            result["operation"] = operation["operation"]?.ToString();
            if (operation["step"] != null) result["step"] = operation["step"]!.DeepClone();
            results.Add(result);
            if (result["ok"]?.GetValue<bool>() == true && operation["operation"]?.ToString() == "insert" && operation["step"] is { } step
                && result["ids"] is JsonArray ids)
                stepIds[step.ToString()] = ids.Select(x => x?.ToString() ?? "").ToArray();
            if (result["ok"]?.GetValue<bool>() != true) { ok = false; code = result["code"]?.ToString(); break; }
        }
        var output = new JsonObject { ["ok"] = ok, ["submitted"] = results.Count, ["total"] = operations.Count, ["results"] = results };
        if (code != null) output["code"] = code;
        return output;
    }

    private static JsonObject RunOne(DataSchema schema, JsonObject operation, JsonNode? batchAuthorization, DataStore store,
        ReadLimits limits, System.Diagnostics.Stopwatch clock)
    {
        var entity = schema.Entities.Single(e => e.Name == operation["entity"]?.ToString());
        var kind = operation["operation"]!.ToString();
        int? tenantId = operation["tenantId"] is JsonValue tenant ? tenant.GetValue<int>() : null;
        if (kind is "read" or "read-all") return ReadPaged(entity, operation, kind, tenantId, store, limits, clock);
        var write = operation.DeepClone().AsObject();
        if (write["authorization"] == null && batchAuthorization != null) write["authorization"] = batchAuthorization.DeepClone();
        if (kind == "delete")
        {
            var deleteIds = operation["ids"]!.AsArray().Select(x => x!.ToString()).ToArray();
            return store.Receipt(entity, write, () =>
            {
                var reports = store.Write(entity.Key, tenantId, "delete", null, deleteIds);
                return new JsonObject { ["ok"] = Succeeded(reports, deleteIds.Length), ["reports"] = Reports(reports) };
            });
        }
        var insert = kind == "insert";
        var wire = WireRecords(entity, operation["records"]!.AsArray(), insert);
        if (insert)
            return store.Receipt(entity, write, () =>
            {
                var reports = store.Write(entity.Key, tenantId, "insert", wire, null);
                var result = new JsonObject { ["ok"] = Succeeded(reports, wire.Count), ["reports"] = Reports(reports) };
                var ids = InsertedIds(reports, wire.Count);
                result["ids"] = new JsonArray(ids.Select(id => (JsonNode?)id).ToArray());
                if (result["ok"]!.GetValue<bool>())
                {
                    var written = new JsonArray();
                    for (var i = 0; i < wire.Count; i++) written.Add(new JsonObject { ["id"] = ids[i], ["attributes"] = wire[i]!["attributes"]!.DeepClone() });
                    ReadBack(entity, tenantId, written, store, result);
                }
                return result;
            });
        // Update: the stored records are read first (no write yet), so only the cells whose value changes are sent.
        var targets = wire.Select(r => r!["id"]!.ToString()).Distinct().ToArray();
        var changed = ChangedCells(entity, wire, store.Read(entity.Key, tenantId, targets, 0), out var unchanged);
        return store.Receipt(entity, write, () =>
        {
            if (changed.Count == 0) return new JsonObject { ["ok"] = true, ["unchanged"] = unchanged, ["written"] = 0, ["reports"] = new JsonArray() };
            var reports = store.Write(entity.Key, tenantId, "update", changed, null);
            var result = new JsonObject { ["ok"] = Succeeded(reports, changed.Count), ["unchanged"] = unchanged, ["written"] = changed.Count, ["reports"] = Reports(reports) };
            if (result["ok"]!.GetValue<bool>()) ReadBack(entity, tenantId, changed, store, result);
            return result;
        });
    }

    /// <summary>read: one page. read-all: pages until the end, limits.MaxRows rows (plus at most the page that crossed it) or
    /// the deadline of the call. Every page is bounded by limits.ChunkTimeout (never beyond the deadline left). An answer
    /// that stopped early is complete:false with stoppedBy (limit, deadline, page-timeout) and a continuation {offset}: the
    /// same read-all from that offset goes on. A first page that times out answers DATA_READ_TIMEOUT with the same offset.</summary>
    private static JsonObject ReadPaged(DataEntity entity, JsonObject operation, string kind, int? tenantId, DataStore store,
        ReadLimits limits, System.Diagnostics.Stopwatch clock)
    {
        var ids = operation["ids"]?.AsArray().Select(x => x!.ToString()).ToArray();
        var byIds = ids is { Length: > 0 };
        var start = operation["offset"]?.GetValue<int>() ?? 0;
        var offset = start;
        var rows = new List<Row>();
        var seen = new HashSet<string>();
        string? stoppedBy = null; string? why = null;
        var complete = false; var pages = 0;
        while (true)
        {
            var left = limits.Deadline - clock.Elapsed;
            if (left <= TimeSpan.Zero) { stoppedBy = "deadline"; why = $"the call reached its deadline of {(int)limits.Deadline.TotalSeconds} s"; break; }
            Row[] chunk;
            var byDeadline = left < limits.ChunkTimeout;
            try { chunk = Bounded(() => store.Read(entity.Key, tenantId, ids, offset), byDeadline ? left : limits.ChunkTimeout, $"the page of {entity.Name} at offset {offset}"); }
            catch (DataReadTimeoutException error)
            {
                stoppedBy = byDeadline && pages > 0 ? "deadline" : "page-timeout";
                why = stoppedBy == "deadline" ? $"the call reached its deadline of {(int)limits.Deadline.TotalSeconds} s" : error.Message;
                break;
            }
            pages++;
            var fresh = chunk.Where(r => seen.Add(r.Id)).ToArray();
            rows.AddRange(fresh);
            offset += chunk.Length;
            if (kind == "read" || byIds) { complete = byIds || chunk.Length == 0; break; }
            if (chunk.Length == 0 || fresh.Length == 0) { complete = true; break; }
            if (rows.Count >= limits.MaxRows) { stoppedBy = "limit"; why = $"{rows.Count} rows reached the limit of {limits.MaxRows} rows per call"; break; }
        }
        if (stoppedBy == "page-timeout" && pages == 0)
            return new JsonObject
            {
                ["ok"] = false, ["code"] = "DATA_READ_TIMEOUT", ["count"] = 0, ["nextOffset"] = offset, ["complete"] = false, ["stoppedBy"] = stoppedBy,
                ["error"] = why + "; nothing was read. Edit Data pages only by offset, so a deep offset costs the server a scan: read by ids when you know them, or narrow the question.",
                ["continuation"] = new JsonObject { ["offset"] = offset },
            };
        var result = new JsonObject { ["ok"] = true, ["count"] = rows.Count, ["nextOffset"] = offset, ["pages"] = pages };
        if (kind == "read-all")
        {
            result["complete"] = complete;
            if (!complete)
            {
                result["stoppedBy"] = stoppedBy;
                result["continuation"] = new JsonObject { ["offset"] = offset };
                result["next"] = $"{why}; continue with the same read-all and offset {offset} (rows {start}..{offset - 1} are in this answer)";
            }
        }
        result["records"] = NamedRows(entity, rows);
        return result;
    }

    /// <summary>Reads the written ids back and records what the database kept differently (DATA_READBACK_MISMATCH). A
    /// read-back that fails leaves the write recorded and the outcome uncertain; the write is never repeated.</summary>
    private static void ReadBack(DataEntity entity, int? tenantId, JsonArray written, DataStore store, JsonObject result)
    {
        var ids = written.Select(r => r!["id"]?.ToString()).Where(id => !string.IsNullOrEmpty(id)).Cast<string>().Distinct().ToArray();
        try
        {
            var differences = ReadbackDifferences(entity, written, store.Read(entity.Key, tenantId, ids, 0));
            result["readback"] = new JsonObject { ["records"] = ids.Length, ["differences"] = differences.Count };
            if (differences.Count == 0) return;
            result["ok"] = false; result["code"] = "DATA_READBACK_MISMATCH";
            result["error"] = $"the database keeps another value in {differences.Count} cell(s) of what was written; the write is recorded in the receipt and is not repeated";
            result["differences"] = differences;
        }
        catch (Exception error)
        {
            result["ok"] = false; result["code"] = "DATA_READBACK_FAILED"; result["outcome"] = "uncertain";
            result["error"] = "the write reported Success but reading it back failed (" + error.GetType().Name + ": " + error.Message + "); it is recorded in the receipt and is not repeated";
        }
    }

    private static bool Succeeded(Report[] reports, int expected)
        => reports.Length == expected && reports.All(r => r.Status == "Success" && string.IsNullOrEmpty(r.Error));

    private static JsonArray Reports(Report[] reports) => new(reports.Select(r => (JsonNode)new JsonObject
    {
        ["recordId"] = r.RecordId, ["clientRecordId"] = r.ClientRecordId, ["status"] = r.Status, ["error"] = r.Error,
    }).ToArray());

    /// <summary>The ids an insert returned, in record order: each report names its record by the client id "new-&lt;i&gt;"
    /// (WireRecords); without client ids the report order is the record order.</summary>
    private static string?[] InsertedIds(Report[] reports, int count)
    {
        var ids = new string?[count];
        var byClient = reports.All(r => r.ClientRecordId is { } c && c.StartsWith("new-", StringComparison.Ordinal));
        for (var i = 0; i < reports.Length; i++)
        {
            var at = byClient && int.TryParse(reports[i].ClientRecordId!["new-".Length..], NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : i;
            if (at >= 0 && at < count && reports[i].Status == "Success") ids[at] = reports[i].RecordId;
        }
        return ids;
    }
}

// Shared with EntityData (the private-credential path of `data`), which builds the schema the same way.
public sealed record DataSchema(string Module, string Key, DataEntity[] Entities);
public sealed record DataEntity(string Name, string Key, bool IsStatic, DataAttribute[] Attributes, DataIndex[]? Indexes = null);
public sealed record DataIndex(string Name, bool Unique, string[] Attributes);
public sealed record DataAttribute(string Name, string Key, bool AutoNumber, bool IsBinary, string Type = "");
// The write receipt of both paths is DataReceipt (DataReceipt.cs).
