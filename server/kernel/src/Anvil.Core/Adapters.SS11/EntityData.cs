using System.Text.Json.Nodes;
using OutSystems.Communication.RESTServices.DTO;
using OutSystems.Communication.RESTServices.EditData;
using OutSystems.Communication.RESTServices.RESTUtils;
using OutSystems.Model;
using OutSystems.Model.Data;
using ServiceStudio.Model.API.V1;

namespace Anvil.Core;

/// <summary>Headless adapter for Service Studio Edit Data. No model mutations or SQL.</summary>
public sealed class EntityData
{
    private readonly HeadlessSession session;
    private readonly EditDataAPIRestClient client;
    public EntityData(HeadlessSession session)
    {
        this.session = session;
        var properties = session.Client.GetProperties(session.Username, session.Secret);
        if (!properties.TryGetValue("EditDataV4", out var enabled) || !bool.TryParse(enabled, out var yes) || !yes)
            throw new InvalidOperationException("The environment does not advertise EditDataV4.");
        client = new EditDataAPIRestClient(TimeSpan.FromSeconds(60), OAuthHttpClient.ForServiceStudio);
    }

    /// <summary>The same schema as the Studio path (EnvironmentData.Schema), attribute types included: both paths
    /// normalize values by type the same way.</summary>
    public static DataSchema Schema(ModelHost host, string oml) => EnvironmentData.Schema(host, oml);

    public JsonObject Read(DataSchema schema, DataEntity entity, int offset = 0, int? tenantId = null, string[]? ids = null, bool binary = false)
    {
        if (offset < 0) throw new ArgumentOutOfRangeException(nameof(offset));
        var rows = client.GetRecords(session.Login, true, schema.Key, entity.Key, tenantId,
            ids ?? [], false, binary, offset).ToArray();
        // Values decoded by type, the form the write takes back unchanged (EnvironmentData.NamedRows).
        var records = EnvironmentData.NamedRows(entity, rows.Select(r => new EnvironmentData.Row(r.Id,
            (r.EntityAttributesInfo ?? []).Select(a => new EnvironmentData.Cell(a.Key, a.Value)).ToArray())));
        return new JsonObject { ["ok"] = true, ["entity"] = entity.Name, ["offset"] = offset,
            ["count"] = rows.Length, ["nextOffset"] = offset + rows.Length, ["records"] = records };
    }

    public JsonObject Write(DataSchema schema, DataEntity entity, JsonObject request)
    {
        session.RequireWrite("data");
        ValidateWrite(entity, request);
        if (entity.IsStatic) throw new InvalidOperationException("Static entity records are changed in the model and published, not through Edit Data.");
        var operation = request["operation"]?.ToString();
        int? tenantId = request["tenantId"]?.GetValue<int>();
        if (operation == "binary")
        {
            var attribute = entity.Attributes.Single(a => a.Name == request["attribute"]?.ToString());
            if (!attribute.IsBinary) throw new InvalidOperationException("The selected attribute is not Binary Data.");
            var bytes = Convert.FromBase64String(request["base64"]?.ToString() ?? throw new ArgumentException("base64 required"));
            var ok = client.InsertBinaryToRecord(session.Login, true, schema.Key, entity.Key,
                RequiredId(request["recordId"]), attribute.Key, bytes, tenantId);
            return new JsonObject { ["ok"] = ok, ["bytes"] = bytes.Length };
        }
        EditDataOperationReport[] reports;
        var expected = 0;
        if (operation == "delete")
        {
            var ids = request["ids"]?.AsArray().Select(RequiredId).ToArray() ?? throw new ArgumentException("ids required");
            if (ids.Length == 0 || ids.Distinct().Count() != ids.Length) throw new ArgumentException("ids must be nonempty and unique");
            expected = ids.Length;
            reports = client.DeleteRecords(session.Login, true, schema.Key, entity.Key, ids, tenantId).ToArray();
        }
        else
        {
            if (operation is not ("insert" or "update")) throw new ArgumentException("operation must be read, insert, update, delete or binary");
            var records = Encode(entity, request["records"]?.AsArray() ?? throw new ArgumentException("records required"), operation == "insert");
            expected = records.Length;
            reports = (operation == "insert"
                ? client.InsertRecords(session.Login, true, schema.Key, entity.Key, records, tenantId)
                : client.UpdateRecords(session.Login, true, schema.Key, entity.Key, records, tenantId)).ToArray();
        }
        var result = new JsonArray(reports.Select(r => (JsonNode)new JsonObject { ["recordId"] = r.RecordId,
            ["clientRecordId"] = r.ClientRecordId, ["status"] = r.Status.ToString(), ["error"] = r.ErrorMessage }).ToArray());
        return new JsonObject { ["ok"] = reports.Length == expected && reports.All(r => r.Status.ToString() == "Success" && string.IsNullOrEmpty(r.ErrorMessage)), ["reports"] = result };
    }

    public static void ValidateWrite(DataEntity entity, JsonObject request)
    {
        if (entity.IsStatic) throw new InvalidOperationException("Static entities must be edited in the model and published.");
        switch (request["operation"]?.ToString())
        {
            case "insert": case "update":
                Encode(entity, request["records"]?.AsArray() ?? throw new ArgumentException("records required"), request["operation"]!.ToString() == "insert"); break;
            case "delete":
                var ids = request["ids"]?.AsArray().Select(RequiredId).ToArray() ?? throw new ArgumentException("ids required");
                if (ids.Length == 0 || ids.Distinct().Count() != ids.Length) throw new ArgumentException("ids must be nonempty and unique");
                break;
            case "binary":
                if (!entity.Attributes.Any(a => a.Name == request["attribute"]?.ToString() && a.IsBinary)) throw new ArgumentException("Binary Data attribute required");
                RequiredId(request["recordId"]); Convert.FromBase64String(request["base64"]?.ToString() ?? throw new ArgumentException("base64 required")); break;
            default: throw new ArgumentException("operation must be read, insert, update, delete or binary");
        }
    }

    private static string RequiredId(JsonNode? value)
    {
        var id = value?.ToString();
        if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("A nonempty record ID is required");
        return id;
    }

    internal static EntityRecordInfo[] Encode(DataEntity entity, JsonArray rows, bool insert)
    {
        if (rows.Count == 0) throw new ArgumentException("records must be nonempty");
        return rows.Select((row, index) =>
        {
            var record = row?.AsObject() ?? throw new ArgumentException("Each record must be an object");
            var id = insert ? "new-" + index : RequiredId(record["Id"]);
            var values = new List<EntityAttributeInfo>();
            foreach (var pair in record)
            {
                var a = entity.Attributes.SingleOrDefault(a => a.Name == pair.Key) ?? throw new ArgumentException("Unknown attribute: " + pair.Key);
                if (a.AutoNumber && insert) throw new ArgumentException("AutoNumber must be assigned by the server: " + pair.Key);
                if (!insert && pair.Key == "Id") continue;
                if (a.IsBinary) throw new ArgumentException("Use operation binary for " + pair.Key);
                if (pair.Value is JsonObject or JsonArray) throw new ArgumentException("Attribute values must be scalar: " + pair.Key);
                // The same normalization by type as the Studio path: a value the type cannot read is refused before sending.
                values.Add(new EntityAttributeInfo { Key = a.Key, Value = EnvironmentData.Encode(a, pair.Value, entity.Name)! });
            }
            return new EntityRecordInfo { Id = id, EntityAttributesInfo = values.ToArray() };
        }).ToArray();
    }
}

// DataSchema, DataEntity and DataAttribute are shared with the Studio path of `data` (EnvironmentData.cs).
