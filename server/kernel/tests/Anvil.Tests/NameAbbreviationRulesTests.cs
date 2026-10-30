using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R3-C (K9): N1_ABBREVIATION in the preflight of every job (JobPreflight.Analyze, the job alone). A word of a new name that
/// starts, or keeps the consonants of, a longer word of the element's OWN context (what it calls and passes, what it reads,
/// its type) is an abbreviation: a warning, never a refusal (A03), with the whole name as a certain patch when there is one
/// reading. No list of words: every expected expansion comes from the job below (a synthetic shipping module). Controls:
/// whole words, inflections, acronyms in capitals, the platform's own names (Id), basic types, and two readings (candidates,
/// no certain patch).
/// </summary>
public sealed class NameAbbreviationRulesTests
{
    private const string Ship = """
        server action ParcelShip
          in ParcelId: Parcel Identifier
          in WarehouseId: Warehouse Identifier
          out TrackingCode: Text
          local Whs: Warehouse
          GetWare = GetWarehouse(Id=WarehouseId)
          TrkGen = Tracking_Generate(Prefix="Whs")
          Cour = Courier_GetCurrent()
          assign Whs = GetWare.Record  # Keep the GetWare record
          assign TrackingCode = TrkGen.Code + Cour.Name
          end

        """;

    private const string Partner = """
        server action ParcelPartnerOf
          in ParcelId: Parcel Identifier
          out PartnerName: Text
          local I: Integer
          GetPar = Parcel_GetPartner(ParcelId=ParcelId)
          GetURL = Parcel_GetURLPath(ParcelId=ParcelId)
          SendSMS = Courier_SendSMS(Message="Out")
          GetCourier = Courier_GetCouriers()
          Parcels = aggregate FROM Parcel WHERE (Parcel.Id = ParcelId) MAX 1
          assign PartnerName = GetPar.Name + GetURL.Path + GetCourier.Name + Parcels.List.Current.Parcel.Label
          end

        """;

    private const string Declared = """
        {"op":"logic","data":{"actions":[{"name":"QueueClose","inputs":[{"name":"QId","type":"Queue Identifier"}],
          "steps":[{"get":"Queue","as":"GetQ","where":"Queue.Id = QId","max":1},{"call":"Queue_Archive","as":"Arch","args":{"QueueId":"QId"}}]}]}}
        """;

    private static JsonObject Analyze(out JsonObject job)
    {
        job = new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(JsonValue.Create(Ship), JsonValue.Create(Partner)) } },
            JsonNode.Parse(Declared)) };
        return JobPreflight.Analyze(job["ops"]!.AsArray(), job);
    }

    private static List<JsonObject> Findings(JsonObject analysis, string list) =>
        (analysis[list] as JsonArray ?? []).OfType<JsonObject>().Where(p => p["code"]?.ToString() == "N1_ABBREVIATION").ToList();

    private static JsonObject Named(List<JsonObject> findings, string name)
    {
        var found = findings.Where(f => f["name"]?.ToString() == name).ToList();
        Assert.True(found.Count == 1, name + ": " + new JsonArray(findings.Select(f => f.DeepClone()).ToArray()).ToJsonString());
        return found[0];
    }

    [Fact]
    public void AnAbbreviatedNewNameIsAWarningWithItsWholeNameFromItsOwnContext()
    {
        var analysis = Analyze(out _);
        var warnings = Findings(analysis, "warnings");
        // Never a refusal: A03 (only errors block).
        Assert.Empty(Findings(analysis, "problems"));
        Assert.All(warnings, w => Assert.Equal("warning", w["severity"]!.ToString()));

        // Start of a word of the callee (Ware of Warehouse), consonants of one (Trk of Tracking) and start of another (Gen of
        // Generate), start of a word of the callee that is not the only word starting alike (Cour of Courier, not Current), the
        // consonants of the type (Whs of Warehouse).
        foreach (var (name, whole) in new[] { ("GetWare", "GetWarehouse"), ("TrkGen", "TrackingGenerate"), ("Cour", "Courier"), ("Whs", "Warehouse") })
        {
            var finding = Named(warnings, name);
            Assert.Equal(whole, finding["wholeName"]!.ToString());
            Assert.Equal("ABBREVIATION_EXPANDED", finding["patchRule"]!.ToString());
            Assert.True(finding["patchCertain"]!.GetValue<bool>(), name);
            Assert.Equal("/ops/0/data/flow/0", finding["pointer"]!.ToString());
        }
        Assert.Contains("'Ware' of 'Warehouse' (the call of GetWarehouse)", Named(warnings, "GetWare")["message"]!.ToString());

        // The one patch of the op: every certain rename of its texts, each use rewritten, the label, the text literal and the
        // parameter name of the call untouched.
        var patch = Named(warnings, "GetWare")["patch"]!.AsArray();
        Assert.Equal(patch.ToJsonString(), Named(warnings, "Whs")["patch"]!.ToJsonString());
        Assert.Equal("/ops/0/data/flow", patch[0]!["path"]!.ToString());
        var text = patch[0]!["value"]![0]!.ToString();
        Assert.Contains("GetWarehouse = GetWarehouse(Id=WarehouseId)", text);
        Assert.Contains("TrackingGenerate = Tracking_Generate(Prefix=\"Whs\")", text);
        Assert.Contains("Courier = Courier_GetCurrent()", text);
        Assert.Contains("local Warehouse: Warehouse", text);
        Assert.Contains("assign Warehouse = GetWarehouse.Record  # Keep the GetWare record", text);
        Assert.Contains("assign TrackingCode = TrackingGenerate.Code + Courier.Name", text);
        // Text 1 is untouched, whatever the line endings of this source file (core.autocrlf): compared in one form.
        Assert.Equal(Partner.Replace("\r\n", "\n"), patch[0]!["value"]![1]!.ToString().Replace("\r\n", "\n"));
    }

    private static List<JsonObject> AnalyzeText(string text)
    {
        var job = new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(JsonValue.Create(text)) } }) };
        return Findings(JobPreflight.Analyze(job["ops"]!.AsArray(), job), "warnings");
    }

    [Fact]
    public void AWholeEnglishWordThatStartsAWordOfTheContextIsNoAbbreviation()
    {
        // Add of Address, Log of Login, Pay of Payment: whole words of the shipped dictionary, never an abbreviation, never a
        // certain patch (AddressAddress, LoginIn, PaymentOrder).
        var warnings = AnalyzeText("""
            server action CustomerOnboard
              in CustomerId: Customer Identifier
              AddAddress = Address_Create(CustomerId=CustomerId)
              LogIn = User_Login(CustomerId=CustomerId)
              PayOrder = Payment_Create(CustomerId=CustomerId)
              end

            """);
        Assert.DoesNotContain(warnings, w => w["patchCertain"]?.GetValue<bool>() == true);
        foreach (var name in new[] { "AddAddress", "LogIn", "PayOrder" }) Assert.DoesNotContain(warnings, w => w["name"]?.ToString() == name);
    }

    [Fact]
    public void AnExpansionThatDoesNotAbbreviateItsCalleeWordByWordIsNeverCertain()
    {
        // Sum is a built-in of the platform and a word; Net and Tab are words too. Wherever a dictionary has a gap, a
        // reading is certain only when the name abbreviates the name it calls, word by word and in order (GetWare of
        // GetWarehouse): SumOrder of Order_SummaryRead, NetOrder of Network_Check, TabOrder of Table_Open are not.
        var warnings = AnalyzeText("""
            server action OrderReport
              in OrderId: Order Identifier
              SumOrder = Order_SummaryRead(OrderId=OrderId)
              NetOrder = Network_Check(OrderId=OrderId)
              TabOrder = Table_Open(OrderId=OrderId)
              DscOrder = Order_DiscountRead(OrderId=OrderId)
              end

            """);
        Assert.DoesNotContain(warnings, w => w["patchCertain"]?.GetValue<bool>() == true);
        // A real abbreviation out of order (Dsc of Discount, before Order): still said, as a candidate without a patch.
        var outOfOrder = Named(warnings, "DscOrder");
        Assert.Equal("DiscountOrder", outOfOrder["wholeName"]!.ToString());
        Assert.Equal("ABBREVIATION_CHOICE", outOfOrder["patchRule"]!.ToString());
        Assert.Null(outOfOrder["patch"]);
    }

    [Fact]
    public void TwoAbbreviationsOfOneActionWithOneWholeNameAreAChoiceNeverACertainPatch()
    {
        var warnings = AnalyzeText("""
            server action CustomerTouch
              in Cust: Customer Identifier
              local Cst: Customer
              out Total: Integer
              assign Total = 1
              end

            """);
        foreach (var name in new[] { "Cust", "Cst" })
        {
            var finding = Named(warnings, name);
            Assert.Equal("Customer", finding["wholeName"]!.ToString());
            Assert.False(finding["patchCertain"]!.GetValue<bool>(), name);
            Assert.Equal("ABBREVIATION_CHOICE", finding["patchRule"]!.ToString());
            Assert.Null(finding["patch"]);
        }
        // No patch of any warning names two inputs/locals alike.
        foreach (var patch in warnings.Select(w => w["patch"]).OfType<JsonArray>())
            Assert.DoesNotContain("local Customer", patch.ToJsonString());
    }

    [Fact]
    public void TwoReadingsAreCandidatesAndWholeWordsAcronymsAndThePlatformsNamesAreNoAbbreviation()
    {
        var warnings = Findings(Analyze(out _), "warnings");
        // Par starts Parcel and Partner, both words of its context: two candidates, no certain patch.
        var both = Named(warnings, "GetPar");
        Assert.Equal("ABBREVIATION_CHOICE", both["patchRule"]!.ToString());
        Assert.False(both["patchCertain"]!.GetValue<bool>());
        Assert.Equal(["GetParcel", "GetPartner"], both["candidates"]!.AsArray().Select(c => c!["name"]!.ToString()).Order(StringComparer.Ordinal));
        Assert.All(both["candidates"]!.AsArray(), c => Assert.Contains(c!["name"]!.ToString() + ".Name", c["patch"]![0]!["value"]![1]!.ToString()));
        // Whole words: the callee's word (GetCourier beside Couriers), an inflection (Parcels), capitals (URL, SMS), the
        // platform's Id, a basic type (I of Integer), a name with no context (PartnerName of Text), the action's own name.
        foreach (var name in new[] { "GetCourier", "Parcels", "GetURL", "SendSMS", "ParcelId", "WarehouseId", "I", "PartnerName", "TrackingCode", "ParcelShip", "ParcelPartnerOf" })
            Assert.DoesNotContain(warnings, w => w["name"]?.ToString() == name);
    }

    [Fact]
    public void TheDeclarationFormNamesTheWholeNameWithoutRewritingItsUses()
    {
        var warnings = Findings(Analyze(out _), "warnings");
        foreach (var (name, whole, pointer) in new[] { ("QId", "QueueId", "/ops/1/data/actions/0/inputs/0/name"), ("GetQ", "GetQueue", "/ops/1/data/actions/0/steps/0/as"),
                     ("Arch", "Archive", "/ops/1/data/actions/0/steps/1/as") })
        {
            var finding = Named(warnings, name);
            Assert.Equal(whole, finding["wholeName"]!.ToString());
            Assert.Equal(pointer, finding["pointer"]!.ToString());
            Assert.Null(finding["patch"]);
            Assert.False(finding["patchCertain"]!.GetValue<bool>());
        }
    }

    /// <summary>R3-D (integration with R2-A): the callee N1 reads its words from is the name R2-A's one reading of a written
    /// name gives (NameResolution.Parse), for every written form: bare, qualified by a producer, by (System), with a kind and with
    /// a namespaced kind.</summary>
    [Theory]
    [InlineData("GetWarehouse", "GetWarehouse")]
    [InlineData(" GetWarehouse ", "GetWarehouse")]
    [InlineData("Producer.GetWarehouse", "GetWarehouse")]
    [InlineData("ServerAction:Producer.GetWarehouse", "GetWarehouse")]
    [InlineData("OutSystems.Model.IServerAction:Tracking_Generate", "Tracking_Generate")]
    [InlineData("(System).ListAppend", "ListAppend")]
    // The one form the two readings ever differed on (a leading dot): no text form writes it; R2-A's reading keeps it whole.
    [InlineData(".GetWarehouse", ".GetWarehouse")]
    public void TheCalleeIsTheNameTheResolverReads(string written, string name)
    {
        Assert.Equal(name, Anvil.Core.Preflight.AbbreviationRules.Callee(written));
    }

    /// <summary>R3-D review A2: end to end through AbbreviationRules.Check, a call of the logic text written with its producer
    /// gives the same N1 as the bare call: the context word is the callee's own name (GetWarehouse), never the producer's, and
    /// the whole name is the certain patch.</summary>
    [Theory]
    [InlineData("Producer.GetWarehouse")]
    [InlineData("GetWarehouse")]
    public void AQualifiedCalleeGivesTheWholeNameOfItsOwnName(string callee)
    {
        var text = $"""
            server action ParcelStock
              in WarehouseId: Warehouse Identifier
              out Stock: Integer
              GetWare = {callee}(Id=WarehouseId)
              assign Stock = GetWare.Count
              end

            """;
        var ops = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(JsonValue.Create(text)) } });
        var found = Anvil.Core.Preflight.AbbreviationRules.Check(ops, "/ops").Where(p => p["name"]?.ToString() == "GetWare").ToList();
        var finding = Assert.Single(found);
        Assert.Equal("N1_ABBREVIATION", finding["code"]!.ToString());
        Assert.Equal("ABBREVIATION_EXPANDED", finding["patchRule"]!.ToString());
        Assert.Equal("GetWarehouse", finding["wholeName"]!.ToString());
        Assert.Contains("(the call of GetWarehouse)", finding["message"]!.ToString());
    }

    /// <summary>R3-D review A2: the JSON form writes a call with its kind and producer (Kind:Producer.Name, (System).Name); N1
    /// reads the callee's own name there too (the whole name, no patch: the declaration form).</summary>
    [Theory]
    [InlineData("ServerAction:Producer.GetWarehouse", "GetWare", "GetWarehouse")]
    [InlineData("(System).GetWarehouse", "GetWare", "GetWarehouse")]
    public void ACalleeWithItsKindAndProducerInTheJsonFormGivesTheWholeNameOfItsOwnName(string callee, string name, string whole)
    {
        var ops = new JsonArray(JsonNode.Parse($$$"""
            {"op":"logic","data":{"actions":[{"name":"ParcelStock","inputs":[{"name":"WarehouseId","type":"Warehouse Identifier"}],
              "steps":[{"call":"{{{callee}}}","as":"{{{name}}}","args":{"Id":"WarehouseId"}}]}]}}
            """));
        var finding = Assert.Single(Anvil.Core.Preflight.AbbreviationRules.Check(ops, "/ops").Where(p => p["name"]?.ToString() == name));
        Assert.Equal("N1_ABBREVIATION", finding["code"]!.ToString());
        Assert.Equal(whole, finding["wholeName"]!.ToString());
        Assert.Contains("(the call of " + whole + ")", finding["message"]!.ToString());
        Assert.Null(finding["patch"]);
    }
}
