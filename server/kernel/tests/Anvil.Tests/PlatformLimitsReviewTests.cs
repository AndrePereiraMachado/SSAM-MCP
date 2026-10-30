using System.Buffers.Binary;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The review of the platform limits table (PlatformLimits): the preflight and the apply judge an image by one
/// rule, a certain patch needs exclusive correspondence against the job and the module and renames only the cut element,
/// the byte readers are total, and the name the preflight says is the one the create writes.</summary>
public sealed class PlatformLimitsReviewTests(ITestOutputHelper output)
{
    private static JsonObject Analyze(params string[] ops)
    {
        var job = new JsonObject { ["ops"] = new JsonArray(ops.Select(o => JsonNode.Parse(o)).ToArray()) };
        return JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
    }

    private static List<JsonObject> Coded(JsonObject analysis, string code, string field = "problems")
        => (analysis[field] as JsonArray ?? []).OfType<JsonObject>().Where(p => p["code"]?.ToString() == code).ToList();

    private static string Image(byte[] bytes, string extra = "")
        => $$$"""{"op":"create","parent":"@espace","type":"IImage","name":"Avatar","args":{"binary":"{{{Convert.ToBase64String(bytes)}}}","originalPath":"avatar.svg"{{{extra}}}}}""";

    private static byte[] Png(int width, int height)
    {
        var bytes = new byte[33];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13 }.CopyTo(bytes, 0);
        Encoding.ASCII.GetBytes("IHDR").CopyTo(bytes, 12);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(16), width);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(20), height);
        bytes[24] = 8; bytes[25] = 6;
        return bytes;
    }

    private static object? FromBytes(byte[] bytes)
    {
        var type = typeof(JobRunner).Assembly.GetType("Anvil.Core.AssetFacts");
        Assert.True(type != null, "AssetFacts is missing");
        try { return type!.GetMethod("FromBytes")!.Invoke(null, [bytes]); }
        catch (TargetInvocationException error) { throw error.InnerException!; }
    }

    // P1: an SVG whose own size is in % (no viewBox), with format, width and height written by the author: the apply
    // (ModelSession.ImageFactsFromBytes) returns early when the three are written, the preflight refuses.
    [Fact]
    public void SvgWithTheThreeFactsWrittenIsNotRefusedByThePreflight()
    {
        var svg = Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100%\" height=\"100%\"><rect width=\"10\" height=\"10\"/></svg>");
        var analysis = Analyze(Image(svg, ",\"format\":\"Svg\",\"width\":24,\"height\":24"));
        output.WriteLine(analysis.ToJsonString());
        Assert.Empty(Coded(analysis, "IMAGE_FORMAT_UNKNOWN"));
    }

    // P1b: the same parity for written facts the bytes contradict: the apply does not judge them (all three written).
    [Fact]
    public void PngWithTheThreeFactsWrittenIsJudgedAsTheApplyJudgesIt()
    {
        var analysis = Analyze(Image(Png(64, 64), ",\"format\":\"Png\",\"width\":32,\"height\":32"));
        output.WriteLine(analysis.ToJsonString());
        Assert.Empty(Coded(analysis, "IMAGE_FACTS_MISMATCH"));
    }

    // P2: a crafted BMP (height int.MinValue) must give no facts, never an exception.
    [Fact]
    public void ACraftedBmpThrowsNothing()
    {
        var bmp = new byte[54];
        bmp[0] = (byte)'B'; bmp[1] = (byte)'M';
        BinaryPrimitives.WriteInt32LittleEndian(bmp.AsSpan(14), 40);
        BinaryPrimitives.WriteInt32LittleEndian(bmp.AsSpan(18), 10);
        BinaryPrimitives.WriteInt32LittleEndian(bmp.AsSpan(22), int.MinValue);
        var error = Record.Exception(() => FromBytes(bmp));
        output.WriteLine(error?.ToString() ?? "no exception");
        Assert.Null(error);
    }

    // P2b: the same BMP in a job: the preflight rule must not be skipped (its other findings lost).
    [Fact]
    public void ACraftedBmpDoesNotSkipThePlatformLimitRules()
    {
        var bmp = new byte[54];
        bmp[0] = (byte)'B'; bmp[1] = (byte)'M';
        BinaryPrimitives.WriteInt32LittleEndian(bmp.AsSpan(18), 10);
        BinaryPrimitives.WriteInt32LittleEndian(bmp.AsSpan(22), int.MinValue);
        var analysis = Analyze(Image(bmp));
        output.WriteLine(analysis.ToJsonString());
        Assert.DoesNotContain("PREFLIGHT_RULE_FAILED", analysis.ToJsonString());
    }

    // P3: a data text cut name that collides with an index another op of the job creates on the same entity: the patch is
    // not certain (no exclusive correspondence: the patched job creates the same index name twice).
    [Fact]
    public void ADataTextCutNameTakenOutsideTheTextHasNoCertainPatch()
    {
        var analysis = Analyze(
            """{"op":"spec","data":{"entities":[{"name":"Contact","attributes":[{"name":"Email","type":"Email"},{"name":"Name","type":"Text"}]}]}}""",
            """{"op":"create","parent":"IServerEntity:Contact","type":"EntityIndex","name":"IX_Contact_Email_Name_Status","args":{"unique":false,"attributes":["IServerEntity:Contact/Email"]}}""",
            """{"op":"spec","data":{"ddl":"create index IX_Contact_Email_Name_Status30 on Contact (Name);\n"}}""");
        output.WriteLine(analysis.ToJsonString());
        foreach (var p in Coded(analysis, "PLATFORM_NAME_LIMIT"))
            Assert.False(p["patchCertain"]?.GetValue<bool>() ?? false, p.ToJsonString());
    }

    // P4: the certain patch renames every whole word of the long name in the text: an entity of that name (entities have no
    // row in the table) is renamed too.
    [Fact]
    public void TheCertainPatchRenamesOnlyTheCutElement()
    {
        const string text = "create entity SignatureAuthenticationMethod (\n  Id Long Integer identifier auto required,\n  Label Text(50)\n);\n"
            + "create entity Probe (\n  Id Long Integer identifier auto required,\n  SignatureAuthenticationMethod SignatureAuthenticationMethod\n);\n";
        var analysis = Analyze(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } }.ToJsonString());
        output.WriteLine(analysis.ToJsonString());
        foreach (var p in Coded(analysis, "PLATFORM_NAME_LIMIT"))
            if (p["patch"] is JsonArray patch)
                Assert.Contains("create entity SignatureAuthenticationMethod (", patch[0]!["value"]!.ToString());
    }

    // P5: the parity of the JSON name (preflight PLATFORM_NAME_KEPT = apply nameTruncations) when the sibling is named by
    // another parent spelling (an alias of the spec vs IServerEntity:X). Studio-gated.
    [Fact]
    public void ThePreflightNameIsTheApplysNameWhenTheSiblingIsOfTheSameEntity()
    {
        var ops = new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"entities":[{"name":"Pa3Long","attributes":[{"name":"SignatureAuthenticationMetho","type":"Text"}]}]}}"""),
            JsonNode.Parse("""{"op":"create","parent":"IServerEntity:Pa3Long","type":"IEntityAttribute","name":"SignatureAuthenticationMethodXYZ"}"""));
        var job = new JsonObject { ["base"] = "blank-service.oml", ["ops"] = ops };
        var preflight = JobPreflight.Analyze(job["ops"]!.DeepClone().AsArray(), job.DeepClone(), []);
        var predicted = (preflight["normalizations"] as JsonArray ?? []).OfType<JsonObject>().Where(n => n["rule"]?.ToString() == "PLATFORM_NAME_KEPT")
            .Select(n => n["to"]!.ToString()).ToList();
        output.WriteLine("preflight: " + string.Join(",", predicted));
        if (!PacoteBPolicyTests.StudioAvailable()) { output.WriteLine("no studio"); return; }
        var root = PacoteBPolicyTests.FindRoot();
        var dir = Path.Combine(root, ".local", "r3b-review", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "p5.json");
        File.WriteAllText(path, job.ToJsonString());
        JsonNode applied;
        try { applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, "p5.oml")))!; }
        catch (Exception error) { applied = new JsonObject { ["error"] = Errors.Text(error) }; }
        output.WriteLine("apply: " + applied["nameTruncations"]?.ToJsonString() + " " + applied["error"]);
        var truncated = (applied["nameTruncations"] as JsonArray ?? []).OfType<JsonObject>().Select(t => t["to"]!.ToString()).ToList();
        Assert.Equal(truncated, predicted);
    }

    // ---- the byte readers are total (fuzz) ---------------------------------------------------------------------------------

    /// <summary>Random bytes behind every signature the readers know, truncated and mutated: FromBytes and Sniff never throw,
    /// and a job with such an image never skips the platform limit rules.</summary>
    [Fact]
    public void TheByteReadersAreTotalOverMalformedInput()
    {
        var heads = new[]
        {
            new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R' },
            new byte[] { 0xFF, 0xD8, 0xFF, 0xC0 }, new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x01 },
            Encoding.ASCII.GetBytes("GIF89a"), Encoding.ASCII.GetBytes("RIFF\0\0\0\0WEBPVP8X"), Encoding.ASCII.GetBytes("RIFF\0\0\0\0WEBPVP8L"),
            Encoding.ASCII.GetBytes("RIFF\0\0\0\0WEBPVP8 "), new byte[] { 0, 0, 1, 0, 1, 0 }, Encoding.ASCII.GetBytes("BM"),
            Encoding.UTF8.GetBytes("<svg viewBox=\""), Encoding.UTF8.GetBytes("\uFEFF<svg width=\"1e400\" height=\"-0\""),
        };
        var random = new Random(20261029);
        foreach (var head in heads)
            for (var n = 0; n < 400; n++)
            {
                var bytes = new byte[head.Length + random.Next(0, 64)];
                random.NextBytes(bytes);
                head.CopyTo(bytes, 0);
                if (n % 3 == 0) for (var k = head.Length; k < bytes.Length; k += 4) bytes[k] = (byte)(random.Next(2) == 0 ? 0xFF : 0x80);
                var cut = bytes[..random.Next(0, bytes.Length + 1)];
                Assert.Null(Record.Exception(() => FromBytes(cut)));
                Assert.Null(Record.Exception(() => typeof(AssetFacts).GetMethod("Sniff")!.Invoke(null, [cut])));
                if (n % 50 == 0) Assert.DoesNotContain("PREFLIGHT_RULE_FAILED", Analyze(Image(cut)).ToJsonString());
            }
    }

    // ---- exclusive correspondence against the module -----------------------------------------------------------------------

    /// <summary>The module (the apply's reading) is a sibling too: a cut name an index of the module already has on that
    /// entity gives no patch; with the module free of it, the patch is the one correction.</summary>
    [Fact]
    public void ACutNameTheModuleHasOnThatEntityGivesNoPatch()
    {
        const string text = "create index IX_Contact_Email_Name_Status30 on Contact (Name);\n";
        var edit = Anvil.Reading.DdlParser.Parse(text, "o11");
        var module = Anvil.Reading.DdlParser.Parse("create entity Contact (\n  Id Long Integer identifier auto required,\n  Email Text(50),\n  Name Text(50)\n);\n"
            + "create index IX_Contact_Email_Name_Status on Contact (Email);\n", "o11");
        var taken = Assert.Single(PlatformLimits.DdlNames(edit, text, "o11", module));
        Assert.Null(taken.Corrected);
        var free = Anvil.Reading.DdlParser.Parse("create entity Contact (\n  Id Long Integer identifier auto required,\n  Email Text(50),\n  Name Text(50)\n);\n", "o11");
        Assert.Equal("create index IX_Contact_Email_Name_Status on Contact (Name);\n", Assert.Single(PlatformLimits.DdlNames(edit, text, "o11", free)).Corrected);
    }
}