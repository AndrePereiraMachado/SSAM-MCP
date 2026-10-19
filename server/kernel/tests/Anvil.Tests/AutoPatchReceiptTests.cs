using System.Text.Json;
using Anvil.Core.Preflight;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class AutoPatchReceiptTests
{
    [Fact]
    public void ACertainBuiltinCorrectionAcceptsNativelyAndPreservesLiteralText()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var work = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "auto-patch-builtin-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var jobPath = Path.Combine(work, "job.json");
        var outputPath = Path.Combine(work, "candidate.oml");
        File.WriteAllText(jobPath, """
            {"base":"blank-service.oml","ops":[
              {"op":"logic","data":{"actions":[{"name":"ReadCorrectedDate","outputs":[{"name":"At","type":"Date Time"},{"name":"Text","type":"Text"}],"steps":[
                {"assign":{"At":"If(True, NullDateTime(), CurrDateTime())"}},
                {"assign":{"Text":"\"NullDateTime()\" + DateTimeToText(NullDateTime())"}}]}]}}]}
            """);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "runtime")), null, jobPath, outputPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.True(result["isValid"]!.GetValue<bool>(), result.ToJsonString());
        Assert.True(File.Exists(outputPath));
        var applied = Assert.Single(result["patchesApplied"]!.AsArray().OfType<JsonObject>());
        Assert.Equal("BUILTIN_FUNCTION_RENAMED", applied["patchRule"]!.GetValue<string>());
        var corrected = JsonNode.Parse(File.ReadAllText(result["patchedJob"]!["path"]!.GetValue<string>()))!;
        var steps = corrected["ops"]![0]!["data"]!["actions"]![0]!["steps"]!.AsArray();
        Assert.Equal("If(True, NullDate(), CurrDateTime())", steps[0]!["assign"]!["At"]!.GetValue<string>());
        Assert.Equal("\"NullDateTime()\" + DateTimeToText(NullDate())", steps[1]!["assign"]!["Text"]!.GetValue<string>());
        Assert.Equal("NullDate", FunctionCatalog.Certain("NullDateTime"));
    }
    [Fact]
    public void SentDocumentsPreserveTheirWrittenBindingsAndIgnoreExecutionOnlyResolution()
    {
        var work = Path.Combine(Path.GetTempPath(), "auto-patch-source", Guid.NewGuid().ToString("N"));
        var originalDir = Path.Combine(work, "original"); var outputDir = Path.Combine(work, "output");
        Directory.CreateDirectory(originalDir); Directory.CreateDirectory(outputDir);
        try
        {
            foreach (var file in new[] { "original.oml", "override.oml", "producer.avsig", "service.wsdl", "schema.xsd", "api.json", "external.json" })
                File.WriteAllText(Path.Combine(originalDir, file), "{}");
            var original = new JsonObject {
                ["base"] = "original.oml", ["expectValid"] = true, ["autoPatch"] = true, ["custom"] = "preserved",
                ["ops"] = new JsonArray(
                    new JsonObject { ["op"] = "reference", ["producer"] = "producer.avsig" },
                    new JsonObject { ["op"] = "soap", ["data"] = new JsonObject { ["wsdl"] = new JsonObject {
                        ["path"] = "service.wsdl", ["imports"] = new JsonObject { ["schema"] = new JsonObject { ["path"] = "schema.xsd" } } } } },
                    new JsonObject { ["op"] = "rest", ["data"] = new JsonObject { ["openapi"] = new JsonObject {
                        ["path"] = "api.json", ["external"] = new JsonObject { ["schema"] = new JsonObject { ["path"] = "external.json" } } } } },
                    new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "original prose" } })
            };
            var resolved = JobRunner.CollectOps(original, originalDir).DeepClone().AsArray();
            // Sources.Build resolves reference bindings through JobSources before this helper.
            resolved[0]!["producer"] = Path.Combine(originalDir, "producer.avsig");
            var before = resolved.DeepClone();
            var source = JobRunner.AutoPatchSource(original, resolved, Path.Combine(originalDir, "override.oml"));
            var corrected = source.DeepClone(); corrected["ops"]![3]!["data"]!["html"] = "\"original prose\"";
            var problem = new JsonObject { ["code"] = "HTML_INVALID", ["pointer"] = "/ops/3/data/html", ["phase"] = "apply",
                ["patchRule"] = "TEXT_LITERAL_QUOTED", ["patch"] = new JsonArray(new JsonObject {
                    ["op"] = "replace", ["path"] = "/ops/3/data/html", ["value"] = "\"original prose\"" }) };
            var result = JobRunner.AutoPatchReceipt(new JobRunner.AutoPatchResult(new JsonObject { ["accepted"] = true }, corrected, [problem], 1),
                source, Path.Combine(outputDir, "candidate.oml"), null, 1);
            var replay = JsonNode.Parse(File.ReadAllText(result["patchedJob"]!["path"]!.ToString()))!;
            Assert.Equal("original.oml", replay["base"]!.ToString());
            Assert.Equal("preserved", replay["custom"]!.ToString());
            Assert.True(replay["autoPatch"]!.GetValue<bool>()); Assert.True(replay["expectValid"]!.GetValue<bool>());
            Assert.Equal("producer.avsig", replay["ops"]![0]!["producer"]!.ToString());
            // The real Sources path, including a moved corrected job and the same bindings, is covered by AutoPatchSourceRevisionTests.
            var replayOps = JobRunner.CollectOps(replay, originalDir);
            Assert.Equal(Path.Combine(originalDir, "service.wsdl"), replayOps[1]!["data"]!["wsdl"]!["path"]!.ToString());
            Assert.Equal(Path.Combine(originalDir, "schema.xsd"), replayOps[1]!["data"]!["wsdl"]!["imports"]!["schema"]!["path"]!.ToString());
            Assert.Equal(Path.Combine(originalDir, "api.json"), replayOps[2]!["data"]!["openapi"]!["path"]!.ToString());
            Assert.Equal(Path.Combine(originalDir, "external.json"), replayOps[2]!["data"]!["openapi"]!["external"]!["schema"]!["path"]!.ToString());
            Assert.Equal("\"original prose\"", replayOps[3]!["data"]!["html"]!.ToString());
            Assert.True(JsonNode.DeepEquals(before, resolved));
            Assert.Equal("original.oml", original["base"]!.ToString());
        }
        finally { Directory.Delete(work, true); }
    }

    [Fact]
    public void ArraySourcesKeepTheirShapeAndTheirWrittenPrototypeProducer()
    {
        var original = new JsonArray(new JsonObject { ["op"] = "prototype", ["data"] = new JsonObject {
            ["source"] = "inline-source", ["bind"] = new JsonObject { ["producer"] = "job:producer" } } });
        var resolved = original.DeepClone().AsArray();
        var file = Path.Combine(Path.GetTempPath(), "built-producer.oml");
        resolved[0]!["data"]!["_producer"] = file;
        var source = Assert.IsType<JsonArray>(JobRunner.AutoPatchSource(original, resolved, Path.Combine(Path.GetTempPath(), "base.oml")));
        Assert.Equal("job:producer", source[0]!["data"]!["bind"]!["producer"]!.ToString());
        Assert.False(source[0]!["data"]!.AsObject().ContainsKey("_producer"));
        Assert.Equal("job:producer", original[0]!["data"]!["bind"]!["producer"]!.ToString());
        Assert.Equal(file, resolved[0]!["data"]!["_producer"]!.ToString());
        Assert.Equal("inline-source", source[0]!["data"]!["source"]!.ToString());
    }

    [Fact]
    public void WholeDocumentPatchesDiscloseOnlyChangedLinesAndKeepTheCorrectedJobIdentity()
    {
        var work = Path.Combine(Path.GetTempPath(), "auto-patch-receipt", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        const string from = "<screen>\nunchanged secret body\nplaceholder=Search for a name\n</screen>";
        const string to = "<screen>\nunchanged secret body\nplaceholder=\"Search for a name\"\n</screen>";
        var original = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["data"] = new JsonObject { ["html"] = from } }), ["custom"] = "preserved" };
        var corrected = original.DeepClone(); corrected["ops"]![0]!["data"]!["html"] = to;
        var problem = new JsonObject { ["code"] = "HTML_INVALID", ["pointer"] = "/ops/0/data/html", ["phase"] = "apply", ["patchRule"] = "TEXT_LITERAL_QUOTED",
            ["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/ops/0/data/html", ["value"] = to }) };
        var outcome = new JobRunner.AutoPatchResult(new JsonObject { ["accepted"] = true }, corrected, [problem], 2);
        var prior = new JsonArray(new JsonObject { ["rule"] = "ICON_WEIGHT_DROPPED", ["path"] = "/ops/0", ["message"] = "kept" });
        var result = JobRunner.AutoPatchReceipt(outcome, original, Path.Combine(work, "candidate.oml"), prior, 125);
        var item = Assert.Single(result["patchesApplied"]!.AsArray());
        Assert.Equal("placeholder=Search for a name", item!["from"]!.ToString());
        Assert.Equal("placeholder=\"Search for a name\"", item["to"]!.ToString());
        Assert.DoesNotContain("secret", item.ToJsonString()); Assert.Equal(64, item["patchSha256"]!.ToString().Length);
        Assert.Equal(2, result["normalizations"]!.AsArray().Count); Assert.True(result["normalizations"]![1]!["patchApplied"]!.GetValue<bool>());
        var path = result["patchedJob"]!["path"]!.ToString();
        Assert.True(JsonNode.DeepEquals(corrected, JsonNode.Parse(File.ReadAllText(path))));
        Assert.Equal(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant(), result["patchedJob"]!["sha256"]!.ToString());
        Assert.Equal(2, result["autoPatch"]!["rounds"]!.GetValue<int>());
    }

    [Fact]
    public void InsertionsAndDeletionsDoNotDiscloseUnchangedLines()
    {
        var result = JobRunner.ChangedPatchLines("keep\nremove\ntail", "keep\ninsert\ntail\nnew");
        Assert.Equal(new[] { "remove" }, result.From); Assert.Equal(new[] { "insert", "new" }, result.To);
    }

    [Fact]
    public void EachProblemOfAComposedPatchShowsItsOwnChangedRun()
    {
        const string before = "header\nfirst prose\nunchanged\nsecond prose\ntail";
        const string after = "header\n\"first prose\"\nunchanged\n\"second prose\"\ntail";
        var first = JobRunner.ChangedPatchLines(before, after, 2); var second = JobRunner.ChangedPatchLines(before, after, 4);
        Assert.Equal(new[] { "first prose" }, first.From); Assert.Equal(new[] { "\"first prose\"" }, first.To);
        Assert.Equal(new[] { "second prose" }, second.From); Assert.Equal(new[] { "\"second prose\"" }, second.To);
    }
}
