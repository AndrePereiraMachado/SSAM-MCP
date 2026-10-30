using System.Buffers.Binary;
using System.Collections;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R3-B (KERNEL K3 and K6, MINERACAO F8): one table of the platform's static limits (PlatformLimits), read by the preflight of
/// the data text, the logic text and the JSON ops and by the apply. One test per row of the table, plus the parity of the
/// preflight and the apply (Studio-gated), plus the facts of an image read from synthetic bytes. The types new with R3-B are
/// reached by reflection, so this file compiles on the base and each test there fails by its name.
/// </summary>
public sealed class PlatformLimitsTests
{
    // ---- reflection over what R3-B adds -----------------------------------------------------------------------------------

    private static Type Type(string name)
    {
        var type = typeof(JobRunner).Assembly.GetType(name);
        Assert.True(type != null, name + " is missing");
        return type!;
    }

    private static object? Call(string type, string method, params object?[] args)
    {
        var found = Type(type).GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(m => m.Name == method && m.GetParameters().Length == args.Length);
        Assert.True(found != null, $"{type}.{method} is missing");
        return found!.Invoke(null, args);
    }

    private static object? Get(object target, string property) => target.GetType().GetProperty(property)!.GetValue(target);

    private static List<object> Rows() => ((IEnumerable)Type("Anvil.Core.PlatformLimits").GetProperty("Rows")!.GetValue(null)!).Cast<object>().ToList();

    private static object Row(string id)
    {
        var row = Rows().FirstOrDefault(r => (string)Get(r, "Id")! == id);
        Assert.True(row != null, "the table has no row " + id);
        return row!;
    }

    // ---- the table --------------------------------------------------------------------------------------------------------

    [Fact]
    public void EveryRowOfTheTableSaysItsValueItsConsumersAndItsSource()
    {
        var rows = Rows();
        Assert.Equal(rows.Count, rows.Select(r => Get(r, "Id")).Distinct().Count());
        foreach (var row in rows)
            foreach (var field in new[] { "Lanes", "Aspect", "Kinds", "Where", "Value", "Action", "Consumers", "Source" })
                Assert.False(string.IsNullOrWhiteSpace((string?)Get(row, field)), $"{Get(row, "Id")}.{field}");
        var aspects = rows.Select(r => (string)Get(r, "Aspect")!).ToHashSet();
        foreach (var aspect in new[] { "name.maxLength", "type.modifiers", "property.writable", "parent.allowed", "element.requiresOp", "asset.format" })
            Assert.Contains(aspect, aspects);
        // The table as data (what an answer or the documentation reads): every row, with its source.
        var described = (JsonArray)Call("Anvil.Core.PlatformLimits", "Describe", (string?)null)!;
        Assert.Equal(rows.Count, described.Count);
        Assert.All(described, r => Assert.False(string.IsNullOrWhiteSpace(r!["source"]?.ToString())));
    }

    // ---- name.index / name.attribute: the data text ------------------------------------------------------------------------

    private const string LongIndexes = "create entity ProbeOfLongNames (\n  Id Long Integer identifier auto required,\n  First Text(50),\n  Second Text(50)\n);\n"
        + "create unique index UQ_ProbeOfLongNames_FirstColumnIndex on ProbeOfLongNames (First);\n"
        + "create index IX_ProbeOfLongNames_SecondColumnIndex on ProbeOfLongNames (Second);\n";

    private static JsonObject Analyze(params JsonObject[] ops)
    {
        var job = new JsonObject { ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o).ToArray()) };
        return JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
    }

    private static JsonObject Ddl(string text) => new() { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } };

    private static List<JsonObject> Coded(JsonObject analysis, string code, string field = "problems")
        => (analysis[field] as JsonArray ?? []).OfType<JsonObject>().Where(p => p["code"]?.ToString() == code).ToList();

    /// <summary>Before: the data text passed the preflight, the first round created the indexes with their names, the platform
    /// cut them, and the second round refused the text (DDL_NOT_CONVERGED, 8 indexes of BankDash). Now: the preflight says
    /// every one, before the first round, each with the one patch (the text with every cut name), certain.</summary>
    [Fact]
    public void ADataTextNameLongerThanThePlatformKeepsIsRefusedBeforeTheFirstRoundWithOneCertainPatch()
    {
        var analysis = Analyze(Ddl(LongIndexes));
        var cut = Coded(analysis, "PLATFORM_NAME_LIMIT");
        Assert.Equal(2, cut.Count);
        Assert.All(cut, p => Assert.Equal("PLATFORM_NAME_KEPT", p["patchRule"]?.ToString()));
        Assert.All(cut, p => Assert.True(p["patchCertain"]?.GetValue<bool>(), p.ToJsonString()));
        var patch = Assert.Single(cut.Select(p => p["patch"]!.ToJsonString()).Distinct());
        var step = Assert.Single(JsonNode.Parse(patch)!.AsArray())!.AsObject();
        Assert.Equal("/ops/0/data/ddl", step["path"]?.ToString());
        Assert.Equal(LongIndexes.Replace("UQ_ProbeOfLongNames_FirstColumnIndex", "UQ_ProbeOfLongNames_FirstCol").Replace("IX_ProbeOfLongNames_SecondColumnIndex", "IX_ProbeOfLongNames_SecondCo"),
            step["value"]!.ToString());
        Assert.Contains("the platform keeps at most 28", cut[0]["message"]!.ToString());
        // An attribute is cut the same way (name.attribute), and every place the text names it is written with the cut.
        const string attribute = "create entity Probe (\n  Id Long Integer identifier auto required,\n  SignatureAuthenticationMethod Text(50)\n);\n"
            + "create index IX_Probe_Method on Probe (SignatureAuthenticationMethod);\n";
        var one = Assert.Single(Coded(Analyze(Ddl(attribute)), "PLATFORM_NAME_LIMIT"));
        Assert.Equal(attribute.Replace("SignatureAuthenticationMethod", "SignatureAuthenticationMetho"), one["patch"]![0]!["value"]!.ToString());
        // A text whose names fit is not judged.
        Assert.Empty(Coded(Analyze(Ddl("create entity Short (\n  Id Long Integer identifier auto required,\n  First Text(50)\n);\ncreate index IX_Short_First on Short (First);\n")), "PLATFORM_NAME_LIMIT"));
    }

    /// <summary>The same family as R2-B's convergence (exclusive correspondence): two names of one kind and one parent that the
    /// platform would cut to one name have no certain patch: neither cut is the one correction.</summary>
    [Fact]
    public void TwoDataTextNamesCutToOneNameHaveNoPatch()
    {
        const string text = "create entity ProbeOfLongNames (\n  Id Long Integer identifier auto required,\n  First Text(50),\n  Second Text(50)\n);\n"
            + "create unique index UQ_ProbeOfLongNames_FirstColumnIndex on ProbeOfLongNames (First);\n"
            + "create index UQ_ProbeOfLongNames_FirstColumnOther on ProbeOfLongNames (Second);\n";
        var cut = Coded(Analyze(Ddl(text)), "PLATFORM_NAME_LIMIT");
        Assert.Equal(2, cut.Count);
        Assert.All(cut, p => Assert.Null(p["patch"]));
        Assert.All(cut, p => Assert.False(p["patchCertain"]?.GetValue<bool>() ?? false));
        Assert.All(cut, p => Assert.Contains("are the name of another index there", p["message"]!.ToString()));
    }

    // ---- name.index / name.attribute: the JSON forms -----------------------------------------------------------------------

    private const string LongSpec = """
        {"op":"spec","data":{"entities":[{"name":"Pa3Long","attributes":[{"name":"SignatureAuthenticationMethodXYZ","type":"Text"},{"name":"SignatureAuthenticationMethodABC","type":"Text"}],
          "indexes":[{"name":"IX_Pa3Long_SignatureAuthenticationMethod","attributes":["SignatureAuthenticationMethodXYZ"]}]}]}}
        """;

    /// <summary>Before: the create cut the name in silence for the preflight (only the apply's nameTruncations said it). Now the
    /// preflight lists the name the create will write (PLATFORM_NAME_KEPT), the same the apply writes (Pa3KlSpecTests).</summary>
    [Fact]
    public void AJsonCreateWithALongNameListsTheNameTheCreateWrites()
    {
        var analysis = Analyze(JsonNode.Parse(LongSpec)!.AsObject(),
            JsonNode.Parse("""{"op":"create","parent":"IServerEntity:Pa3Long","type":"IEntityAttribute","name":"AnotherAttributeWithAVeryLongName","as":"$another"}""")!.AsObject());
        Assert.True(analysis["valid"]!.GetValue<bool>(), analysis["errors"]!.ToJsonString());
        var kept = (analysis["normalizations"] as JsonArray ?? []).OfType<JsonObject>().Where(n => n["rule"]?.ToString() == "PLATFORM_NAME_KEPT")
            .ToDictionary(n => n["from"]!.ToString(), n => n["to"]!.ToString());
        Assert.Equal("SignatureAuthenticationMetho", kept["SignatureAuthenticationMethodXYZ"]);
        Assert.Equal("SignatureAuthenticationMeth2", kept["SignatureAuthenticationMethodABC"]);
        Assert.Equal("IX_Pa3Long_SignatureAuthenti", kept["IX_Pa3Long_SignatureAuthenticationMethod"]);
        Assert.Equal("AnotherAttributeWithAVeryLon", kept["AnotherAttributeWithAVeryLongName"]);
        Assert.Contains(Coded(analysis, "PLATFORM_NAME_KEPT", "warnings"), w => w["pointer"]?.ToString() == "/ops/1/name");
    }

    /// <summary>A rename is the author's own name: refused by the preflight with the apply's words (EntityIndexes.CheckName,
    /// the strings tests/jobs-negative/index-name-too-long.json expects), before the base is read.</summary>
    [Fact]
    public void ARenameToALongNameIsRefusedInThePreflightWithTheApplysWords()
    {
        var analysis = Analyze(
            JsonNode.Parse("""{"op":"create","parent":"IServerEntity:Contact","type":"EntityIndex","name":"IX_Contact_EmailOnly","args":{"unique":false,"attributes":["IServerEntity:Contact/Email"]}}""")!.AsObject(),
            JsonNode.Parse("""{"op":"rename","target":"EntityIndex:IX_Contact_EmailOnly","name":"IX_Contact_Email_Name_Status30"}""")!.AsObject(),
            JsonNode.Parse("""{"op":"rename","target":"IEntityAttribute:Email","name":"TheEmailAddressOfTheContactPerson"}""")!.AsObject());
        var refused = Coded(analysis, "PLATFORM_NAME_LIMIT");
        Assert.Equal(2, refused.Count);
        var index = refused.Single(p => p["op"]!.GetValue<int>() == 1);
        foreach (var expected in new[] { "EntityIndex name 'IX_Contact_Email_Name_Status30' has 30 characters", "truncates index names to 28", "IX_Contact_Email_Name_Status" })
            Assert.Contains(expected, index["message"]!.ToString());
        Assert.Equal("/ops/1/name", index["pointer"]?.ToString());
        Assert.Contains("truncates attribute names to 28", refused.Single(p => p["op"]!.GetValue<int>() == 2)["message"]!.ToString());
    }

    // ---- type.modifiers / property.writable -------------------------------------------------------------------------------

    /// <summary>type.size.kept and type.size.none agree with the Model API the apply writes through (the O11 catalog): only an
    /// attribute of an entity or a structure has Length and Decimals. R2-C's TYPE_SIZE_DROPPED drops the size of the others.</summary>
    [Fact]
    public void TheKindsThatKeepASizeAreTheOnesTheModelApiWritesItOn()
    {
        foreach (var (kind, keeps) in new[] { ("IEntityAttribute", true), ("IStructureAttribute", true), ("ISiteProperty", false), ("IInputParameter", false), ("IOutputParameter", false), ("ILocalVariable", false), ("ISQLInputParameter", false) })
        {
            Assert.Equal(keeps, (bool?)Call("Anvil.Core.PlatformLimits", "KeepsSize", kind));
            var facts = ModelTypes.Of(kind, "o11");
            Assert.True(facts != null, kind + " is not in the catalog");
            Assert.Equal(keeps, facts!.Knows("Length") && facts.Writable().Contains("Length"));
            Assert.Equal(keeps, facts.Knows("Decimals") && facts.Writable().Contains("Decimals"));
        }
        Assert.Equal("TYPE_SIZE_DROPPED", Get(Row("type.size.none"), "Code"));
        Assert.Null(Call("Anvil.Core.PlatformLimits", "KeepsSize", "IServerAction"));
    }

    /// <summary>R3-D review A1 (pending A6 of R3-B): R2-C's TypeSizes drops the size of a form only where the table's
    /// type.size.none row says its kind keeps none, and every form it reads has its kind there: the site property (an ODC setting)
    /// of the data text, in, out, local and binding (a parameter of an SQL, ISQLInputParameter) of a logic text; the JSON inputs,
    /// outputs and vars are in, out and local. The table and the normalization are one list.</summary>
    [Fact]
    public void EveryFormTypeSizesDropsIsAKindTheTableKeepsNoSizeOn()
    {
        var field = Type("Anvil.Core.Preflight.TypeSizes").GetField("Kinds", BindingFlags.Static | BindingFlags.Public);
        Assert.True(field != null, "TypeSizes.Kinds is missing");
        var kinds = (IReadOnlyDictionary<string, string>)field!.GetValue(null)!;
        Assert.Equal(new[] { "SiteProperty", "binding", "in", "local", "out" }, kinds.Keys.Order(StringComparer.Ordinal));
        foreach (var (form, kind) in kinds)
        {
            Assert.True((bool?)Call("Anvil.Core.PlatformLimits", "KeepsSize", kind) == false, $"{form}: the table says {kind} keeps a size, or does not name it");
            Assert.True((bool)Call("Anvil.Core.Preflight.TypeSizes", "Drops", form)!, form);
        }
        Assert.False((bool)Call("Anvil.Core.Preflight.TypeSizes", "Drops", "Attribute")!);
    }

    /// <summary>property.writable: the row names the one Model API the preflight's PropertyRules and the apply's set read; a
    /// size on a site property, the case of the scenario, is refused by the preflight with the writable properties.</summary>
    [Fact]
    public void AWritablePropertyIsTheModelApisForThePreflightAndTheApply()
    {
        Assert.Contains("PROPERTY_NOT_WRITABLE", (string)Get(Row("property.writable"), "Code")!);
        var analysis = Analyze(JsonNode.Parse("""{"op":"create","parent":"@espace","type":"ISiteProperty","name":"Limit","as":"$limit"}""")!.AsObject(),
            JsonNode.Parse("""{"op":"set","target":"$limit","prop":"Length","value":37}""")!.AsObject());
        Assert.Contains("DataType", Assert.Single(Coded(analysis, "PROPERTY_NOT_WRITABLE"))["message"]!.ToString());
    }

    // ---- parent.allowed ---------------------------------------------------------------------------------------------------

    private static List<JsonObject> Kinds(string moduleType, params string[] ops)
    {
        var array = new JsonArray(ops.Select(o => JsonNode.Parse(o)).ToArray());
        return ScopeRules.Kinds(array, "/ops", ScopeJob.Of(array), moduleType, "o11").ToList();
    }

    /// <summary>Before: an image created in a Service module passed every check and the Studio refused it at apply ("Image
    /// objects can't be children of Module objects", 3 of 3 in the scenario). Now the scope phase refuses it before the first
    /// op, with the alternative.</summary>
    [Fact]
    public void AServiceModuleKeepsNoImageAndTheScopePhaseSaysSoWithTheAlternative()
    {
        var png = Convert.ToBase64String(Png(4, 4));
        var refused = Assert.Single(Kinds("Service", $$$"""{"op":"create","parent":"@espace","type":"IImage","name":"Avatar","args":{"binary":"{{{png}}}"}}"""));
        Assert.Equal(ScopeRules.KindNode, refused["code"]?.ToString());
        Assert.Equal("/ops/0/parent", refused["pointer"]?.ToString());
        Assert.Contains("Image objects can't be children of Module objects", refused["message"]!.ToString());
        Assert.Contains("IResource", refused["fix"]!.ToString());
        // The same create in a module that keeps images is not judged.
        Assert.Empty(Kinds("CrossDevice", $$$"""{"op":"create","parent":"@espace","type":"IImage","name":"Avatar","args":{"binary":"{{{png}}}"}}"""));
    }

    /// <summary>parent.map: a Service module is judged by its own creation map (docs/mapa/criar-blank-service.json), which the
    /// scope phase never read: a client variable or a client action of the module is refused there by the Studio.</summary>
    [Fact]
    public void AServiceModuleIsJudgedByItsCreationMap()
    {
        Assert.Equal("blank-service", Call("Anvil.Core.PlatformLimits", "MapFixture", "Service"));
        var refused = Kinds("Service", """{"op":"create","parent":"@espace","type":"IClientVariable","name":"Theme"}""",
            """{"op":"create","parent":"@espace","type":"IServerAction","name":"Allowed"}""");
        var one = Assert.Single(refused);
        Assert.Equal(0, one["op"]!.GetValue<int>());
        Assert.Contains("Client Variable objects can't be children of Module objects", one["message"]!.ToString());
    }

    // ---- element.requiresOp -----------------------------------------------------------------------------------------------

    private static string Logic(string text) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } }.ToJsonString();

    /// <summary>Before: a logic text that raised a user exception nothing created was refused at apply (FLOW_NAME_UNKNOWN, one
    /// round later). Now the scope phase says it, with the op that creates it; an exception of the module, of the job or of
    /// the System is not judged.</summary>
    [Fact]
    public void AUserExceptionNothingDeclaresIsSaidBeforeTheApplyWithTheOpThatCreatesIt()
    {
        const string text = "server action Check\n  in Code: Text\n  raise AccountLockedException(\"locked\")\n";
        var refused = ScopePhaseTests.Code(ScopePhaseTests.Run("o11", ScopePhaseTests.Ops(Logic(text))), "ELEMENT_REQUIRES_OP");
        var problem = Assert.Single(refused);
        Assert.Equal("FLOW_NAME_UNKNOWN", problem["predicts"]?.ToString());
        Assert.Contains("\"type\":\"IUserException\",\"name\":\"AccountLockedException\"", problem["fix"]!.ToString());
        Assert.Empty(ScopePhaseTests.Code(ScopePhaseTests.Run("o11", ScopePhaseTests.Ops(
            """{"op":"create","parent":"@espace","type":"IUserException","name":"AccountLockedException"}""", Logic(text))), "ELEMENT_REQUIRES_OP"));
        Assert.Empty(ScopePhaseTests.Code(ScopePhaseTests.Run("o11", ScopePhaseTests.Ops(Logic("server action Check\n  on exception AllExceptions:\n    end\n  end\n"))), "ELEMENT_REQUIRES_OP"));
        // The JSON form: a step that raises it (APPLY_FAILED at apply).
        var json = Assert.Single(ScopePhaseTests.Code(ScopePhaseTests.Run("o11", ScopePhaseTests.Ops(
            """{"op":"logic","data":{"actions":[{"name":"Check","steps":[{"raise":"AccountLockedException"}]}]}}""")), "ELEMENT_REQUIRES_OP"));
        Assert.Equal("/ops/0/data/actions/0/steps/0/raise", json["pointer"]?.ToString());
    }

    // ---- asset.format: the facts of the bytes -----------------------------------------------------------------------------

    internal static byte[] Png(int width, int height)
    {
        var bytes = new byte[33];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13 }.CopyTo(bytes, 0);
        Encoding.ASCII.GetBytes("IHDR").CopyTo(bytes, 12);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(16), width);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(20), height);
        bytes[24] = 8; bytes[25] = 6;
        return bytes;
    }

    private static byte[] Jpeg(int width, int height)
    {
        var bytes = new List<byte> { 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10 };
        bytes.AddRange(Encoding.ASCII.GetBytes("JFIF\0")); bytes.AddRange(new byte[9]);
        bytes.AddRange(new byte[] { 0xFF, 0xC0, 0x00, 0x11, 0x08, (byte)(height >> 8), (byte)height, (byte)(width >> 8), (byte)width, 0x03 });
        bytes.AddRange(new byte[9]);
        return bytes.ToArray();
    }

    private static byte[] Gif(int width, int height)
    {
        var bytes = new byte[13];
        Encoding.ASCII.GetBytes("GIF89a").CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(6), (ushort)width);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(8), (ushort)height);
        return bytes;
    }

    private static byte[] WebP(string chunk, int width, int height)
    {
        var bytes = new byte[40];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(bytes, 0);
        Encoding.ASCII.GetBytes("WEBP").CopyTo(bytes, 8);
        Encoding.ASCII.GetBytes(chunk).CopyTo(bytes, 12);
        switch (chunk)
        {
            case "VP8X":
                bytes[24] = (byte)(width - 1); bytes[25] = (byte)((width - 1) >> 8); bytes[26] = (byte)((width - 1) >> 16);
                bytes[27] = (byte)(height - 1); bytes[28] = (byte)((height - 1) >> 8); bytes[29] = (byte)((height - 1) >> 16);
                break;
            case "VP8L":
                bytes[20] = 0x2F;
                BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(21), (uint)((width - 1) | (height - 1) << 14));
                break;
            default:
                bytes[23] = 0x9D; bytes[24] = 0x01; bytes[25] = 0x2A;
                BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(26), (ushort)width);
                BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(28), (ushort)height);
                break;
        }
        return bytes;
    }

    private static (string Format, int Width, int Height)? Facts(byte[] bytes)
    {
        var facts = Call("Anvil.Core.AssetFacts", "FromBytes", bytes);
        return facts == null ? null : ((string)Get(facts, "Format")!, (int)Get(facts, "Width")!, (int)Get(facts, "Height")!);
    }

    [Fact]
    public void TheFormatWidthAndHeightOfAnImageAreReadFromItsBytes()
    {
        Assert.Equal(("png", 1, 1), Facts(Png(1, 1)));
        Assert.Equal(("png", 640, 480), Facts(Png(640, 480)));
        Assert.Equal(("jpeg", 300, 200), Facts(Jpeg(300, 200)));
        Assert.Equal(("gif", 16, 9), Facts(Gif(16, 9)));
        Assert.Equal(("webp", 1024, 768), Facts(WebP("VP8X", 1024, 768)));
        Assert.Equal(("webp", 100, 50), Facts(WebP("VP8L", 100, 50)));
        Assert.Equal(("webp", 64, 32), Facts(WebP("VP8 ", 64, 32)));
        Assert.Equal(("svg", 24, 16), Facts(Encoding.UTF8.GetBytes("<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 16\"><path d=\"M0 0\"/></svg>")));
        Assert.Equal(("svg", 50, 40), Facts(Encoding.UTF8.GetBytes("<svg width=\"50px\" height=\"40\" viewBox=\"0 0 10 10\" xmlns=\"http://www.w3.org/2000/svg\"></svg>")));
        // An SVG with no size of its own, and bytes of no image, have no facts (the refusal says which).
        Assert.Null(Facts(Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100%\"></svg>")));
        Assert.Equal("svg", Call("Anvil.Core.AssetFacts", "Sniff", Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")));
        Assert.Null(Facts(Encoding.ASCII.GetBytes("not an image at all")));
        Assert.Null(Facts([0x89, 0x50]));
    }

    private static string Image(byte[] bytes, string extra = "")
        => $$$"""{"op":"create","parent":"@espace","type":"IImage","name":"Avatar","args":{"binary":"{{{Convert.ToBase64String(bytes)}}}","originalPath":"avatar.png"{{{extra}}}}}""";

    /// <summary>Before: a PNG sent with binary and originalPath reached the Studio, which answered "Image format could not be
    /// determined" (4 of 4 in the scenario). Now the preflight writes format, width and height from the bytes and lists it.</summary>
    [Fact]
    public void AnImageCreateGetsTheFactsOfItsBytesBeforeTheBuild()
    {
        var job = new JsonObject { ["ops"] = new JsonArray(JsonNode.Parse(Image(Png(3, 2)))) };
        var analysis = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        Assert.True(analysis["valid"]!.GetValue<bool>(), analysis["errors"]!.ToJsonString());
        var entry = Assert.Single((analysis["normalizations"] as JsonArray ?? []).OfType<JsonObject>(), n => n["rule"]?.ToString() == "IMAGE_FACTS_FROM_BYTES");
        Assert.Equal("/ops/0/args", entry["path"]?.ToString());
        Assert.Equal("format Png, width 3, height 2", entry["to"]?.ToString());
        var args = job["ops"]![0]!["args"]!;
        Assert.Equal("Png", args["format"]?.ToString());
        Assert.Equal(3, args["width"]!.GetValue<int>());
        Assert.Equal(2, args["height"]!.GetValue<int>());
        // Facts already written as the bytes say them are left alone.
        var written = new JsonObject { ["ops"] = new JsonArray(JsonNode.Parse(Image(Jpeg(8, 8), ",\"format\":\"Jpg\",\"width\":8,\"height\":8"))) };
        Assert.DoesNotContain((JobPreflight.Analyze(written["ops"]!.AsArray(), written, [])["normalizations"] as JsonArray ?? []).OfType<JsonObject>(), n => n["rule"]?.ToString() == "IMAGE_FACTS_FROM_BYTES");
    }

    /// <summary>Bytes of a format the lane does not store (WebP in O11), an SVG with no size, and facts written that the bytes
    /// contradict are refused before the build, with the formats the lane stores and both values.</summary>
    [Fact]
    public void ImageBytesOfNoStoredFormatOrContradictedFactsAreRefusedBeforeTheBuild()
    {
        var webp = Assert.Single(Coded(Analyze(JsonNode.Parse(Image(WebP("VP8X", 10, 10)))!.AsObject()), "IMAGE_FORMAT_UNKNOWN"));
        Assert.Contains("WEBP", webp["message"]!.ToString());
        Assert.Contains("Png, Jpg, Gif, Ico, Svg", webp["message"]!.ToString());
        Assert.Equal("/ops/0/args/binary", webp["pointer"]?.ToString());
        var svg = Assert.Single(Coded(Analyze(JsonNode.Parse(Image(Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")))!.AsObject()), "IMAGE_FORMAT_UNKNOWN"));
        Assert.Contains("viewBox", svg["fix"]!.ToString());
        var wrong = Assert.Single(Coded(Analyze(JsonNode.Parse(Image(Png(3, 2), ",\"format\":\"Png\",\"width\":99"))!.AsObject()), "IMAGE_FACTS_MISMATCH"));
        Assert.Contains("width 99 (the bytes say 3)", wrong["message"]!.ToString());
    }

    // ---- parity: the preflight and the apply read one table (Studio) -------------------------------------------------------

    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static JsonNode Run(string name, JsonObject job)
    {
        var dir = Path.Combine(Root, ".local", "r3-limits-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml")))!; }
        catch (Exception error) { return new JsonObject { ["error"] = Errors.Text(error), ["problems"] = Errors.FindCoded(error)?.Problems?.DeepClone() }; }
    }

    /// <summary>For each row with a behavior both sides have, the same job through the preflight (no Studio) and through the
    /// apply: the names the preflight lists are the names the create writes; the data text the preflight refuses is never
    /// cut by a first round; an image of a module that keeps images is created from its bytes alone; an image of a Service
    /// module is refused before the first op.</summary>
    [Fact]
    public void ThePreflightAndTheApplyReadOneTable()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // name.attribute and name.index, JSON: the preflight's PLATFORM_NAME_KEPT are the apply's nameTruncations.
        var spec = new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(JsonNode.Parse(LongSpec)) };
        var preflight = JobPreflight.Analyze(spec["ops"]!.DeepClone().AsArray(), spec.DeepClone(), []);
        var predicted = (preflight["normalizations"] as JsonArray ?? []).OfType<JsonObject>().Where(n => n["rule"]?.ToString() == "PLATFORM_NAME_KEPT")
            .ToDictionary(n => n["from"]!.ToString(), n => n["to"]!.ToString());
        var applied = Run("names", spec);
        Assert.True(applied["accepted"]?.GetValue<bool>(), applied.ToJsonString());
        var truncated = applied["nameTruncations"]!.AsArray().OfType<JsonObject>().ToDictionary(t => t["from"]!.ToString(), t => t["to"]!.ToString());
        Assert.Equal(truncated.OrderBy(t => t.Key), predicted.OrderBy(t => t.Key));
        // name.index, data text: refused by the preflight's rule, never DDL_NOT_CONVERGED after a round.
        var ddl = Run("ddl", new JsonObject { ["base"] = "blank-service.oml", ["autoPatch"] = false, ["ops"] = new JsonArray(Ddl(LongIndexes)) });
        Assert.Contains("PLATFORM_NAME_LIMIT", ddl.ToJsonString());
        Assert.DoesNotContain("DDL_NOT_CONVERGED", ddl.ToJsonString());
        // asset.format: a PNG with its binary and originalPath alone is created, its facts read from the bytes.
        var image = Run("image", new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(JsonNode.Parse(Image(Png(3, 2)))) });
        Assert.True(image["accepted"]?.GetValue<bool>(), image.ToJsonString());
        Assert.Contains("IMAGE_FACTS_FROM_BYTES", image["normalizations"]?.ToJsonString() ?? "");
        // parent.image.service: the scope phase, before the first op.
        var service = Run("service-image", new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(JsonNode.Parse(Image(Png(3, 2)))) });
        Assert.Contains("ACTION_KIND_NODE", service.ToJsonString());
        Assert.DoesNotContain("\"phase\":\"apply\"", service.ToJsonString());
    }
}
