using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;
using Cell = Anvil.Core.EnvironmentData.Cell;
using Report = Anvil.Core.EnvironmentData.Report;
using Row = Anvil.Core.EnvironmentData.Row;

namespace Anvil.Tests;

/// <summary>
/// Lane 0, C36 and the kernel part of C24 (I12). o11_data wrote ISO dates with 'T' as 1900-01-01 and answered Success
/// (session 890a2354, 04/10 12:10): values are now normalized by the attribute type to the text the Edit Data grid stores
/// right ("2026-10-03 23:55:00", "2026-09-28"), refused before any write when the type cannot read them, read back in the
/// form the write takes, compared after every write, and an update sends only what changes. A batch resolves {"$ref"} to the
/// ids of earlier inserts. The server here is a fake that answers in the read format measured on the tenant.
/// </summary>
public sealed class Pacote0DataTests
{
    private static DataAttribute A(string name, string type, bool autoNumber = false) => new(name, "k-" + name.ToLowerInvariant(), autoNumber, false, type);
    private static readonly DataEntity Game = new("Game", "e-game", false, [
        A("Id", "Long Integer", autoNumber: true), A("Title", "Text"), A("PriceCoins", "Integer"), A("Score", "Decimal"), A("IsActive", "Boolean"),
        A("ReleaseDate", "Date"), A("CreatedOn", "DateTime"), A("OpensAt", "Time"), A("PublisherId", "Publisher Identifier"), A("Downloads", "Long Integer")]);
    private static readonly DataEntity Review = new("Review", "e-review", false, [A("Id", "Long Integer", autoNumber: true), A("GameId", "Game Identifier"), A("Body", "Text")]);
    private static readonly DataSchema Schema = new("GameStore_CS", "e-module", [Game, Review]);
    private static DataAttribute Of(string name) => Game.Attributes.Single(a => a.Name == name);
    private static string Work() => Path.Combine(Path.GetTempPath(), "pacote0-data", Guid.NewGuid().ToString("N"));

    /// <summary>The read format of the tenant (890a2354): DateTime and Date with 'T', Boolean in lower case.</summary>
    private static string? ReadForm(string? value)
    {
        if (value == null) return null;
        if (Regex.IsMatch(value, @"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")) return value.Replace(' ', 'T');
        if (Regex.IsMatch(value, @"^\d{4}-\d{2}-\d{2}$")) return value + "T00:00:00";
        return value is "True" or "False" ? value.ToLowerInvariant() : value;
    }

    private sealed class FakeServer
    {
        public readonly Dictionary<string, Dictionary<string, Dictionary<string, string?>>> Tables = new();
        public readonly List<(string Entity, string Operation, JsonArray? Records, string[]? Ids)> Writes = [];
        public int Reads;
        public Func<string, string?, string?> Keep = (key, value) => ReadForm(value);
        private int next = 100;
        public Dictionary<string, Dictionary<string, string?>> Table(string entity) => Tables.TryGetValue(entity, out var t) ? t : Tables[entity] = new();
        public EnvironmentData.DataStore Store(string receipts) => new(Read, Write,
            (entity, write, send) => DataReceipt.Execute(receipts, "host", "e-module", entity.Key, "hash", write, send));
        private Row[] Read(string entity, int? tenant, string[]? ids, int offset)
        {
            Reads++;
            var table = Table(entity);
            var keys = ids is { Length: > 0 } ? ids.Where(table.ContainsKey) : table.Keys.Skip(offset);
            return keys.Select(id => new Row(id, table[id].Select(c => new Cell(c.Key, c.Value)).ToArray())).ToArray();
        }
        private Report[] Write(string entity, int? tenant, string operation, JsonArray? records, string[]? ids)
        {
            Writes.Add((entity, operation, records?.DeepClone().AsArray(), ids));
            var table = Table(entity);
            if (operation == "delete") { foreach (var id in ids!) table.Remove(id); return ids!.Select(id => new Report(id, null, "Success", null)).ToArray(); }
            var reports = new List<Report>();
            // Ids are given from the last record to the first, so the client ids (not the report order) must place them.
            foreach (var record in records!.OfType<JsonObject>().Reverse())
            {
                var client = record["id"]!.ToString();
                var id = operation == "insert" ? (next++).ToString() : client;
                var row = operation == "insert" ? table[id] = new() : table[id];
                foreach (var cell in record["attributes"]!.AsArray()) row[cell!["key"]!.ToString()] = Keep(cell["key"]!.ToString(), cell["value"]?.ToString());
                reports.Add(new Report(id, client, "Success", null));
            }
            return reports.ToArray();
        }
    }

    private static JsonObject Batch(params string[] operations) => JsonNode.Parse(
        "{\"authorization\":\"carregue os jogos de demonstracao\",\"batch\":[" + string.Join(",", operations) + "]}")!.AsObject();
    private static string Insert(string entity, string records, string? step = null) =>
        $"{{\"operation\":\"insert\",\"entity\":\"{entity}\",\"operationId\":\"{Guid.NewGuid()}\"{(step == null ? "" : $",\"step\":\"{step}\"")},\"records\":{records}}}";
    private static string Update(string entity, string records) =>
        $"{{\"operation\":\"update\",\"entity\":\"{entity}\",\"operationId\":\"{Guid.NewGuid()}\",\"records\":{records}}}";

    // ---- values by type ---------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("2026-10-04T15:38:07", "2026-10-04 15:38:07")]
    [InlineData("2026-10-04T15:38:07.123", "2026-10-04 15:38:07")]
    [InlineData("2026-10-04 15:38:07", "2026-10-04 15:38:07")]
    [InlineData("2026-10-04T15:38", "2026-10-04 15:38:00")]
    public void ADateTimeWithTIsWrittenInTheFormatTheGridStores(string sent, string written)
    {
        Assert.Equal(written, EnvironmentData.Encode(Of("CreatedOn"), JsonValue.Create(sent), "Game"));
        var wire = EnvironmentData.WireRecords(Game, JsonNode.Parse($$"""[{"Id":"7","CreatedOn":"{{sent}}"}]""")!.AsArray(), insert: false);
        Assert.Equal(written, wire[0]!["attributes"]![0]!["value"]!.ToString());
    }

    [Theory]
    [InlineData("2026-10-04T15:38:07Z")]
    [InlineData("2026-10-04T15:38:07.5+03:00")]
    [InlineData("2026-10-04 15:38:07 -0300")]
    public void ADateTimeWithAZoneIsRefusedWithoutAGuessedConversion(string sent)
    {
        var error = Assert.Throws<EnvironmentData.DataRequestException>(() => EnvironmentData.Encode(Of("CreatedOn"), JsonValue.Create(sent), "Game"));
        Assert.Equal("DATA_VALUE_INVALID", error.Code);
        Assert.StartsWith($"Game.CreatedOn (DateTime): '{sent}' carries a time zone", error.Message);
        Assert.Contains("; accepted: yyyy-MM-ddTHH:mm:ss[.fff], yyyy-MM-dd HH:mm:ss", error.Message);
    }

    [Theory]
    [InlineData("ReleaseDate", "\"2026-09-28\"", "2026-09-28")]
    [InlineData("ReleaseDate", "\"2026-09-28T00:00:00\"", "2026-09-28")]
    [InlineData("ReleaseDate", "\"28/09/2026\"", null)]
    [InlineData("ReleaseDate", "\"2026-09-28T10:00:00\"", null)]
    [InlineData("OpensAt", "\"13:45\"", "13:45:00")]
    [InlineData("OpensAt", "\"13:45:10\"", "13:45:10")]
    [InlineData("OpensAt", "\"1:45 PM\"", null)]
    [InlineData("IsActive", "true", "True")]
    [InlineData("IsActive", "\"false\"", "False")]
    [InlineData("IsActive", "\"True\"", "True")]
    [InlineData("IsActive", "\"yes\"", null)]
    [InlineData("PriceCoins", "720", "720")]
    [InlineData("PriceCoins", "\"720\"", "720")]
    [InlineData("PriceCoins", "7.5", null)]
    [InlineData("PriceCoins", "3000000000", null)]
    [InlineData("Downloads", "\"9007199254740993\"", "9007199254740993")]
    [InlineData("Downloads", "9007199254740993", null)]
    [InlineData("Downloads", "42", "42")]
    [InlineData("Score", "12.5", "12.5")]
    [InlineData("Score", "\"12.50\"", "12.50")]
    [InlineData("Score", "\"12,5\"", null)]
    [InlineData("Title", "\"Olá, mundo\"", "Olá, mundo")]
    [InlineData("PublisherId", "\"1\"", "1")]
    [InlineData("PublisherId", "3", "3")]
    [InlineData("PublisherId", "true", null)]
    [InlineData("CreatedOn", "null", null)]
    public void EveryTypeIsNormalizedOrRefusedBeforeAnyWrite(string attribute, string json, string? written)
    {
        var value = JsonNode.Parse(json);
        if (written != null || value == null) { Assert.Equal(written, EnvironmentData.Encode(Of(attribute), value, "Game")); return; }
        var error = Assert.Throws<EnvironmentData.DataRequestException>(() => EnvironmentData.Encode(Of(attribute), value, "Game"));
        Assert.Equal("DATA_VALUE_INVALID", error.Code);
        Assert.StartsWith($"Game.{attribute} ({Of(attribute).Type}): '", error.Message);
        Assert.Contains("; accepted: ", error.Message);
    }

    private static readonly Row Stored = new("7", [
        new("k-id", "7"), new("k-title", "Lumen Odyssey"), new("k-pricecoins", "720"), new("k-score", "12.50"), new("k-isactive", "true"),
        new("k-releasedate", "2026-09-28T00:00:00"), new("k-createdon", "2026-10-03T23:55:00"), new("k-opensat", "13:45:00"),
        new("k-publisherid", "1"), new("k-downloads", "9007199254740993")]);

    [Fact]
    public void TheReadGivesBackTheFormTheWriteTakesAndARowReadIsWrittenUnchanged()
    {
        var named = EnvironmentData.NamedRows(Game, [Stored])[0]!.AsObject();
        Assert.Equal("7", named["Id"]!.GetValue<string>());
        Assert.Equal("2026-10-03T23:55:00", named["CreatedOn"]!.GetValue<string>());
        Assert.Equal("2026-09-28", named["ReleaseDate"]!.GetValue<string>());
        Assert.Equal("13:45:00", named["OpensAt"]!.GetValue<string>());
        Assert.Equal(JsonValueKind.True, named["IsActive"]!.GetValueKind());
        Assert.Equal(JsonValueKind.Number, named["PriceCoins"]!.GetValueKind());
        Assert.Equal(JsonValueKind.Number, named["Score"]!.GetValueKind());
        Assert.Equal(JsonValueKind.String, named["Downloads"]!.GetValueKind());
        Assert.Equal("9007199254740993", named["Downloads"]!.GetValue<string>());
        Assert.Equal(JsonValueKind.String, named["PublisherId"]!.GetValueKind());

        // Written back as it was read: nothing changes, nothing is sent.
        var wire = EnvironmentData.WireRecords(Game, new JsonArray(named.DeepClone()), insert: false);
        Assert.Empty(EnvironmentData.ChangedCells(Game, wire, [Stored], out var unchanged));
        Assert.Equal(1, unchanged);
    }

    [Fact]
    public void DecodeThenEncodeIsTheIdentityForEveryType()
    {
        foreach (var cell in Stored.Attributes)
        {
            var a = Game.Attributes.Single(x => x.Key == cell.Key);
            var decoded = EnvironmentData.Decode(a, cell.Value);
            var written = EnvironmentData.Encode(a, decoded, "Game");
            Assert.True(EnvironmentData.SameValue(a, written, cell.Value), $"{a.Name}: wrote '{written}' for the stored '{cell.Value}'");
            Assert.True(JsonNode.DeepEquals(decoded, EnvironmentData.Decode(a, ReadForm(written))), $"{a.Name}: '{decoded?.ToJsonString()}' changed on the way back");
        }
    }

    [Fact]
    public void ChangedCellsDropsEqualValuesInAnyFormAndKeepsTheChangedOnes()
    {
        var wire = EnvironmentData.WireRecords(Game, JsonNode.Parse("""
            [{"Id":"7","Title":"Lumen Odyssey","CreatedOn":"2026-10-03 23:55:00","IsActive":"True","Score":12.5,"ReleaseDate":"2026-09-28"},
             {"Id":"8","Title":"New"},
             {"Id":"7","Title":"Lumen","CreatedOn":"2026-10-03T23:55:00","PriceCoins":721}]
            """)!.AsArray(), insert: false);
        var changed = EnvironmentData.ChangedCells(Game, wire, [Stored], out var unchanged);
        Assert.Equal(1, unchanged);
        Assert.Equal(2, changed.Count);
        Assert.Equal("8", changed[0]!["id"]!.ToString());   // a record the read did not return goes whole
        var cells = changed[1]!["attributes"]!.AsArray().Select(c => c!["key"]!.ToString()).ToArray();
        Assert.Equal(new[] { "k-title", "k-pricecoins" }, cells);
    }

    [Fact]
    public void ReadbackDifferencesNamesWhatTheDatabaseKeptDifferently()
    {
        var sent = JsonNode.Parse("""[{"id":"7","attributes":[{"key":"k-createdon","value":"2026-10-04 15:38:07"},{"key":"k-title","value":"Lumen Odyssey"}]}]""")!.AsArray();
        var corrupted = new Row("7", [new("k-createdon", "1900-01-01T00:00:00"), new("k-title", "Lumen Odyssey")]);
        var difference = Assert.Single(EnvironmentData.ReadbackDifferences(Game, sent, [corrupted]))!.AsObject();
        Assert.Equal("7", difference["id"]!.ToString());
        Assert.Equal("CreatedOn", difference["attribute"]!.ToString());
        Assert.Equal("2026-10-04 15:38:07", difference["sent"]!.ToString());
        Assert.Equal("1900-01-01T00:00:00", difference["stored"]!.ToString());
        Assert.Empty(EnvironmentData.ReadbackDifferences(Game, sent, [new Row("7", [new("k-createdon", "2026-10-04T15:38:07"), new("k-title", "Lumen Odyssey")])]));
    }

    [Fact]
    public void ThePrivateCredentialPathNormalizesTheSameWay()
    {
        if (!StudioAvailable()) return;   // EntityData loads the Studio's Edit Data client types
        var error = Assert.Throws<EnvironmentData.DataRequestException>(() =>
            EntityData.ValidateWrite(Game, JsonNode.Parse("""{"operation":"insert","records":[{"CreatedOn":"2026-10-04T15:38:07Z"}]}""")!.AsObject()));
        Assert.Equal("DATA_VALUE_INVALID", error.Code);
    }

    // ---- $ref (I12) ---------------------------------------------------------------------------------------------------

    [Fact]
    public void RefsReachEarlierInsertsAndAFutureOrUnknownStepIsRefused()
    {
        Assert.Empty(EnvironmentData.ValidateBatch(Schema, Batch(Insert("Game", """[{"Title":"A"}]""", "game"),
            Insert("Review", """[{"GameId":{"$ref":"game"},"Body":"x"},{"GameId":{"$ref":"game#0"},"Body":"y"}]"""))));

        JsonObject Only(JsonObject batch) => Assert.Single(EnvironmentData.ValidateBatch(Schema, batch))!.AsObject();
        var future = Only(Batch(Insert("Review", """[{"GameId":{"$ref":"later"}}]"""), Insert("Game", """[{"Title":"A"}]""", "later")));
        Assert.Equal("DATA_REF_UNRESOLVED", future["code"]!.ToString());
        Assert.Equal(0, future["op"]!.GetValue<int>());
        Assert.Equal("/batch/0/records/0/GameId", future["pointer"]!.ToString());
        Assert.Equal("DATA_REF_UNRESOLVED", Only(Batch(Insert("Review", """[{"GameId":{"$ref":"nope"}}]""")))["code"]!.ToString());
        var two = Insert("Game", """[{"Title":"A"},{"Title":"B"}]""", "games");
        Assert.Contains("needs an index", Only(Batch(two, Insert("Review", """[{"GameId":{"$ref":"games"}}]""")))["message"]!.ToString());
        Assert.Contains("beyond the 2 records", Only(Batch(two, Insert("Review", """[{"GameId":{"$ref":"games#2"}}]""")))["message"]!.ToString());

        var resolved = EnvironmentData.ResolveRefs(JsonNode.Parse("""{"records":[{"GameId":{"$ref":"games#1"}}],"ids":[{"$ref":"games#0"}]}""")!.AsObject(),
            new Dictionary<string, IReadOnlyList<string>> { ["games"] = ["101", "100"] });
        Assert.Equal("100", resolved["records"]![0]!["GameId"]!.ToString());
        Assert.Equal("101", resolved["ids"]![0]!.ToString());
        Assert.Equal("DATA_REF_UNRESOLVED", Assert.Throws<EnvironmentData.DataRequestException>(() =>
            EnvironmentData.ResolveRefs(JsonNode.Parse("""{"ids":[{"$ref":"other"}]}""")!.AsObject(), new Dictionary<string, IReadOnlyList<string>>())).Code);
    }

    // ---- the batch over a fake server ---------------------------------------------------------------------------------

    [Fact]
    public void ABatchInsertsWithRefsAnswersIdsInRecordOrderAndReadsBackWhatItWrote()
    {
        var server = new FakeServer();
        var result = EnvironmentData.RunBatch(Schema, Batch(
            Insert("Game", """[{"Title":"A","CreatedOn":"2026-10-04T15:38:07","IsActive":true},{"Title":"B","CreatedOn":"2026-10-04 16:00:00","IsActive":"False"}]""", "games"),
            Insert("Review", """[{"GameId":{"$ref":"games#1"},"Body":"ok"}]""")), server.Store(Work()));
        Assert.True(result["ok"]!.GetValue<bool>(), result.ToJsonString());
        var games = result["results"]![0]!.AsObject();
        var ids = games["ids"]!.AsArray().Select(x => x!.ToString()).ToArray();
        Assert.Equal(new[] { "101", "100" }, ids);   // the server gave 100 to the last record
        Assert.Equal(0, games["readback"]!["differences"]!.GetValue<int>());
        Assert.Equal("2026-10-04T15:38:07", server.Table("e-game")["101"]["k-createdon"]);
        var review = server.Writes.Single(w => w.Entity == "e-review").Records![0]!["attributes"]!.AsArray();
        Assert.Equal("100", review.Single(c => c!["key"]!.ToString() == "k-gameid")!["value"]!.ToString());
    }

    [Fact]
    public void AWriteTheDatabaseKeepsDifferentlyFailsWithTheDifferencesAndIsNeverRepeated()
    {
        var server = new FakeServer { Keep = (key, value) => key == "k-createdon" ? "1900-01-01T00:00:00" : ReadForm(value) };
        var receipts = Work();
        var request = Batch(Insert("Game", """[{"Title":"A","CreatedOn":"2026-10-04T15:38:07"}]""", "games"));
        var first = EnvironmentData.RunBatch(Schema, request, server.Store(receipts));
        Assert.False(first["ok"]!.GetValue<bool>());
        Assert.Equal("DATA_READBACK_MISMATCH", first["code"]!.ToString());
        var difference = Assert.Single(first["results"]![0]!["differences"]!.AsArray())!;
        Assert.Equal("CreatedOn", difference["attribute"]!.ToString());
        Assert.Equal("2026-10-04 15:38:07", difference["sent"]!.ToString());
        Assert.Equal("1900-01-01T00:00:00", difference["stored"]!.ToString());
        var again = EnvironmentData.RunBatch(Schema, request, server.Store(receipts));
        Assert.True(again["results"]![0]!["replayed"]!.GetValue<bool>());
        Assert.Single(server.Writes);
    }

    [Fact]
    public void AnUpdateSendsOnlyTheChangedCellsAndNothingWhenEveryValueIsEqual()
    {
        var server = new FakeServer();
        server.Table("e-game")["7"] = Stored.Attributes.ToDictionary(c => c.Key, c => c.Value);
        // The 04/10 case: a text-only change echoed from a read; the dates are equal, so they are never sent.
        var same = EnvironmentData.RunBatch(Schema, Batch(Update("Game", """[{"Id":"7","Title":"Lumen Odyssey","CreatedOn":"2026-10-03T23:55:00","IsActive":true,"Score":"12.5"}]""")), server.Store(Work()));
        Assert.True(same["ok"]!.GetValue<bool>(), same.ToJsonString());
        Assert.Equal(1, same["results"]![0]!["unchanged"]!.GetValue<int>());
        Assert.Equal(0, same["results"]![0]!["written"]!.GetValue<int>());
        Assert.Empty(server.Writes);

        var changed = EnvironmentData.RunBatch(Schema, Batch(Update("Game", """[{"Id":"7","Title":"Lumen","CreatedOn":"2026-10-03T23:55:00","ReleaseDate":"2026-09-28"}]""")), server.Store(Work()));
        Assert.True(changed["ok"]!.GetValue<bool>(), changed.ToJsonString());
        var cells = Assert.Single(server.Writes).Records![0]!["attributes"]!.AsArray();
        Assert.Equal("k-title", Assert.Single(cells)!["key"]!.ToString());
        Assert.Equal("2026-10-03T23:55:00", server.Table("e-game")["7"]["k-createdon"]);
    }

    [Fact]
    public void EveryProblemOfTheBatchIsRefusedTogetherBeforeAnyCall()
    {
        var server = new FakeServer();
        var request = Batch(Insert("Game", """[{"Title":"A"}]""", "games"),
            Update("Game", """[{"Id":"7","CreatedOn":"04/10/2026 12:10"}]"""),
            Insert("Review", """[{"GameId":{"$ref":"nope"}}]"""),
            """{"operation":"delete","entity":"Game","ids":["7"]}""");
        var result = EnvironmentData.RunBatch(Schema, request, server.Store(Work()));
        Assert.False(result["ok"]!.GetValue<bool>());
        Assert.Equal(0, result["submitted"]!.GetValue<int>());
        Assert.Equal("DATA_VALUE_INVALID", result["code"]!.ToString());
        var problems = result["problems"]!.AsArray().Select(p => (p!["op"]!.GetValue<int>(), p["code"]!.ToString())).ToArray();
        Assert.Equal(new[] { (1, "DATA_VALUE_INVALID"), (2, "DATA_REF_UNRESOLVED"), (3, "DATA_REQUEST_INVALID") }, problems);
        Assert.Equal("/batch/1/records/0/CreatedOn", result["problems"]![0]!["pointer"]!.ToString());
        Assert.Equal(0, server.Reads);
        Assert.Empty(server.Writes);
    }

    // ---- the schema the normalization reads, from the Service Studio's own model ---------------------------------------

    [Fact]
    public void TheSchemaNamesEveryTypeTheNormalizationReads()
    {
        if (!StudioAvailable()) return;
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pacote0DataTests).Assembly.Location)!)!;
        var work = Work(); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var job = Path.Combine(work, "job.json"); var output = Path.Combine(work, "data.oml");
        File.WriteAllText(job, """
            {"ops":[{"op":"spec","data":{"static":[{"name":"Category","records":[{"name":"One","label":"One"}]}],"entities":[{"name":"Item","attributes":[
              {"name":"Title","type":"Text"},{"name":"Quantity","type":"Integer"},{"name":"Views","type":"Long Integer"},{"name":"Score","type":"Decimal"},
              {"name":"Price","type":"Currency"},{"name":"IsActive","type":"Boolean"},{"name":"CreatedOn","type":"Date Time"},{"name":"ReleaseDate","type":"Date"},
              {"name":"OpensAt","type":"Time"},{"name":"Contact","type":"Email"},{"name":"Phone","type":"Phone Number"},{"name":"CategoryId","type":"Category Identifier"}]}]}}]}
            """);
        JobRunner.Run(host, Path.Combine(root, "tests", "fixtures", "blank-service.oml"), job, output);
        var item = EnvironmentData.Schema(host, output).Entities.Single(e => e.Name == "Item");
        var types = item.Attributes.ToDictionary(a => a.Name, a => a.Type);
        Assert.Equal("Text", types["Title"]); Assert.Equal("Integer", types["Quantity"]); Assert.Equal("Long Integer", types["Views"]);
        Assert.Equal("Decimal", types["Score"]); Assert.Equal("Currency", types["Price"]); Assert.Equal("Boolean", types["IsActive"]);
        Assert.Equal("DateTime", types["CreatedOn"]); Assert.Equal("Date", types["ReleaseDate"]); Assert.Equal("Time", types["OpensAt"]);
        Assert.Equal("Email", types["Contact"]); Assert.Equal("Phone Number", types["Phone"]); Assert.Equal("Category Identifier", types["CategoryId"]);
        // The credential path reads the same schema.
        Assert.Equal(types, EntityData.Schema(host, output).Entities.Single(e => e.Name == "Item").Attributes.ToDictionary(a => a.Name, a => a.Type));
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
