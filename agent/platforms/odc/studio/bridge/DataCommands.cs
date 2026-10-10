using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.ObjectKeys;
using ServiceStudio.Presenter;
using ServiceStudio.ServerCommunications.API;
using DataDtos = ServiceStudio.ServerCommunications.API.Services.Data.DTOs;

// Data lane of the bridge: records of an entity in the development database, through the Studio's own
// IDataService (GetRecords / InsertRecords / UpdateRecords / DeleteRecords), the calls behind "View data" and
// "Edit data" in the entity editor. Keys travel in their database form (ObjectKeyUtils.DatabaseValue) and values
// as text, which is what the Studio's grid sends. The entity may be the open module's own or one of its references.
// Reads never touch the model. Writes need the user's own words and leave request and report under journal\data;
// request files are read only from journal\data\requests, where the facade writes them.
// Usage: data <Module> <Entity> [--limit N] [--offset N] [--fields A,B] [--out name.json]
//        data-insert <Module> <Entity> --records-file <request.json: array of {Attribute: value}> --authorize <text>
//        data-update <Module> <Entity> --records-file <request.json: array of {<Id>, Attribute: value}> --authorize <text>
//        data-delete <Module> <Entity> --ids <id,id,...> --authorize <text>
internal static partial class Bridge {
    // Computed on demand: static initializers of a partial class have no defined order across files, and Root lives in StartupHook.cs.
    private static string DataDir => Path.Combine(Root, "journal", "data");
    private sealed record DataAttribute(string Name, string Key, string Type);
    private sealed record DataTarget(string Module, string ModuleKey, string Entity, string EntityKey, string Owner, string IdName, string IdKey, DataAttribute[] Attributes);
    private static string DbKey(object key) => OutSystems.RuntimeCommon.ObjectKeyUtils.DatabaseValue(ObjectKey.Parse(key.ToString()!));
    private static string TypeName(object? type) => type is IModelObject t ? t.DisplayName : type?.ToString() ?? "";

    private static DataTarget ResolveDataTarget(IAggregatorPresenter p, string entityName) {
        var space = (IESpace)p.ActiveESpace;
        var own = space.Entities.FirstOrDefault(e => e.Name == entityName);
        if (own != null)
            return new DataTarget(space.Name, DbKey(space.Key), own.Name, DbKey(own.Key), "own", own.IdentifierAttribute.Name, DbKey(own.IdentifierAttribute.Key),
                own.Attributes.Select(a => new DataAttribute(a.Name, DbKey(a.Key), TypeName(a.DataType))).ToArray());
        foreach (var reference in space.References) {
            var shared = reference.Entities.FirstOrDefault(e => e.DisplayName == entityName);
            if (shared == null) continue;
            return new DataTarget(reference.DisplayName, DbKey(reference.Key), shared.DisplayName, DbKey(shared.Key), "reference:" + reference.DisplayName, shared.IdentifierAttribute.DisplayName, DbKey(shared.IdentifierAttribute.Key),
                shared.Attributes.Select(a => new DataAttribute(a.DisplayName, DbKey(a.Key), TypeName(a.DataType))).ToArray());
        }
        var known = space.Entities.Select(e => e.Name).Concat(space.References.SelectMany(r => r.Entities.Select(e => r.DisplayName + "." + e.DisplayName))).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToArray();
        throw new InvalidOperationException("No entity named " + entityName + " in " + space.Name + " or its references. Known: " + string.Join(", ", known));
    }

    // A file name inside journal\data (requests are written there by the facade); no other location is read or written.
    private static string DataFile(string subfolder, string name) {
        var full = Path.GetFullPath(Path.Combine(DataDir, subfolder, Path.GetFileName(name)));
        Require(full.StartsWith(DataDir, StringComparison.OrdinalIgnoreCase), "Data files live under journal\\data only.");
        return full;
    }

    private static async Task<object> Data(string op, string argument, Context c) {
        var tokens = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        Require(tokens.Length >= 2 && !tokens[0].StartsWith("--") && !tokens[1].StartsWith("--"), "data commands take <Module> <Entity> first.");
        var module = tokens[0]; var entityName = tokens[1];
        string? Option(string name) { var i = Array.IndexOf(tokens, name); return i >= 0 && i + 1 < tokens.Length && !tokens[i + 1].StartsWith("--") ? tokens[i + 1] : null; }
        string? Words(string name) { var i = Array.IndexOf(tokens, name); if (i < 0) return null; var words = tokens.Skip(i + 1).TakeWhile(t => !t.StartsWith("--")).ToArray(); return words.Length == 0 ? null : string.Join(' ', words); }
        var started = DateTimeOffset.UtcNow;
        var (p, target, moduleKey) = await Ui(() => { var presenter = Active(module); return (presenter, ResolveDataTarget(presenter, entityName), presenter.ActiveESpace.Key.ToString()); });
        c.Module = module; c.ModuleKey = moduleKey; c.Feature = "data:" + target.Entity;
        var provider = (IServerCommunicationsServicesProvider)p.ServerCommunicationsProvider;
        var host = p.ServerCommunicationsProvider?.LoginInfo?.HostInfo?.Hostname;
        var names = target.Attributes.ToDictionary(a => a.Key, a => a);
        var byName = target.Attributes.ToDictionary(a => a.Name, a => a, StringComparer.OrdinalIgnoreCase);
        long Elapsed() => (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
        if (op == "read") {
            var limit = int.TryParse(Option("--limit"), out var l) ? Math.Clamp(l, 1, 5000) : 100;
            var offset = int.TryParse(Option("--offset"), out var o) ? Math.Max(0, o) : 0;
            var fields = Option("--fields")?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var selected = fields == null ? target.Attributes.Where(a => a.Key != target.IdKey).ToArray()
                : fields.Select(f => byName.TryGetValue(f, out var a) ? a : throw new InvalidOperationException("Unknown attribute " + f + " on " + target.Entity + "; known: " + string.Join(", ", target.Attributes.Select(x => x.Name)))).ToArray();
            var records = provider.DataService.GetRecords(target.ModuleKey, target.EntityKey, target.IdKey, selected.Select(a => a.Key).ToArray(), offset, limit).ToArray();
            var rows = records.Select(r => Row(r, target.IdName, names)).ToArray();
            var result = new {
                ok = true, module, entity = target.Entity, owner = target.Owner, moduleKey = target.ModuleKey, entityKey = target.EntityKey, tenant = host, offset, limit, count = rows.Length, more = rows.Length >= limit,
                attributes = target.Attributes.Select(a => a.Name + ":" + a.Type).ToArray(), records = rows, source = "DataService.GetRecords (development database)", readAt = started.ToString("o"), elapsedMs = Elapsed()
            };
            var outFile = Option("--out"); if (outFile != null) TryWrite(DataFile("reads", outFile), result);
            return result;
        }
        var authorization = Words("--authorize");
        Require(!string.IsNullOrWhiteSpace(authorization), "data-" + op + " writes to the development database and requires --authorize <the user's own words>.");
        var evidence = DataFile("", started.ToString("yyyyMMdd-HHmmss") + "-" + target.Entity + "-" + op + ".json");
        DataDtos.EditDataOperationReport[] reports; object request;
        if (op == "delete") {
            var ids = (Option("--ids") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            Require(ids.Length > 0, "data-delete requires --ids <id,id,...>.");
            request = new { ids };
            reports = provider.DataService.DeleteRecords(target.ModuleKey, target.EntityKey, target.IdKey, ids).ToArray();
        } else {
            var file = Option("--records-file"); Require(file != null, "data-" + op + " requires --records-file <request written under journal\\data\\requests>.");
            var array = JsonNode.Parse(File.ReadAllText(DataFile("requests", file!))) as JsonArray;
            Require(array != null && array.Count > 0, "The request file must hold a non-empty JSON array of objects.");
            var infos = array!.Select((node, i) => ToRecordInfo(node, i, op, target, byName)).ToArray();
            request = new { records = infos.Select(r => new { id = r.Id, attributes = r.EntityAttributesInfo.Select(a => new { name = names.TryGetValue(a.Key, out var n) ? n.Name : a.Key, value = a.Value }).ToArray() }).ToArray() };
            reports = (op == "insert" ? provider.DataService.InsertRecords(target.ModuleKey, target.EntityKey, target.IdKey, infos) : provider.DataService.UpdateRecords(target.ModuleKey, target.EntityKey, target.IdKey, infos)).ToArray();
        }
        var outcome = reports.Select(r => new { recordId = r.RecordId, clientRecordId = r.ClientRecordId, status = r.Status.ToString(), error = r.ErrorMessage }).ToArray();
        var failed = outcome.Where(r => r.status != "Success").ToArray();
        var report = new {
            ok = failed.Length == 0, module, entity = target.Entity, owner = target.Owner, operation = "data-" + op, tenant = host, authorization, count = outcome.Length, failed = failed.Length, reports = outcome, request, evidence,
            source = "DataService." + (op == "insert" ? "InsertRecords" : op == "update" ? "UpdateRecords" : "DeleteRecords") + " (development database)", at = started.ToString("o"), elapsedMs = Elapsed()
        };
        TryWrite(evidence, report);
        if (failed.Length > 0) throw new InvalidOperationException("data-" + op + ": " + failed.Length + " of " + outcome.Length + " records failed (" + (failed[0].error ?? failed[0].status) + "); the full report is in " + evidence + ". Do not repeat without reading it.");
        return report;
    }

    private static Dictionary<string, object?> Row(DataDtos.EntityRecordInfo record, string idName, Dictionary<string, DataAttribute> names) {
        var row = new Dictionary<string, object?> { [idName] = record.Id };
        foreach (var a in record.EntityAttributesInfo ?? Array.Empty<DataDtos.EntityAttributeInfo>()) {
            var known = names.TryGetValue(a.Key, out var attribute);
            row[known ? attribute!.Name : a.Key] = Plain(a.Value, known ? attribute!.Type : "");
        }
        return row;
    }
    // The service returns every value as text; booleans arrive as decimals ("1.00000000"), which read back as true/false.
    private static object? Plain(object? value, string type) {
        var text = value switch { null => null, string s => s, _ => value.ToString() };
        if (type == "Boolean" && text != null && decimal.TryParse(text, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var d)) return d != 0;
        return text;
    }

    private static DataDtos.EntityRecordInfo ToRecordInfo(JsonNode? node, int index, string op, DataTarget target, Dictionary<string, DataAttribute> byName) {
        var record = node as JsonObject ?? throw new InvalidOperationException("records[" + index + "] must be a JSON object of Attribute: value.");
        var id = record.TryGetPropertyValue(target.IdName, out var idNode) ? Text(idNode) : null;
        if (op == "update") Require(!string.IsNullOrEmpty(id), "records[" + index + "] needs " + target.IdName + " for data-update.");
        var attributes = new List<DataDtos.EntityAttributeInfo>();
        foreach (var (name, valueNode) in record) {
            if (string.Equals(name, target.IdName, StringComparison.OrdinalIgnoreCase)) continue;
            Require(byName.TryGetValue(name, out var attribute), "records[" + index + "]: unknown attribute " + name + " on " + target.Entity + "; known: " + string.Join(", ", target.Attributes.Select(a => a.Name)));
            attributes.Add(new DataDtos.EntityAttributeInfo { Key = attribute!.Key, Value = Text(valueNode) });
        }
        Require(attributes.Count > 0, "records[" + index + "] has no attribute values.");
        // Inserted records carry a client id the report echoes back as clientRecordId next to the server's recordId.
        return new DataDtos.EntityRecordInfo { Id = string.IsNullOrEmpty(id) ? "new-" + (index + 1) : id!, EntityAttributesInfo = attributes.ToArray() };
    }

    // The Studio's grid sends every value as text: booleans as True/False, numbers as written, empty as null.
    private static string? Text(JsonNode? node) => node switch {
        null => null,
        JsonValue v when v.TryGetValue<string>(out var s) => s == "" ? null : s,
        JsonValue v when v.TryGetValue<bool>(out var b) => b ? "True" : "False",
        JsonValue v => v.ToJsonString(),
        _ => node.ToJsonString()
    };
}
