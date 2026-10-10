using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The O11 deliver path of an integration import (op soap), end to end over Delivery.Run with the real job apply and a
/// bridge whose Studio is faked (the pattern of DeliveryMergeOrderTests). A bridge without integration_import:wsdl is
/// refused before the snapshot, nothing captured or merged; with it the order is snapshot, integration_import (absolute
/// paths, sha256), apply on the candidate, merge with the snapshot as base; a candidate whose contract check fails is
/// refused with SOAP_CONTRACT_TYPE_MISMATCH and never merged.
/// </summary>
public class DeliveryIntegrationImportTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DeliveryIntegrationImportTests).Assembly.Location)!)!;
    private static readonly string Wsdl = Path.Combine(Root, "tests", "fixtures", "wsdl", "calculator-two-ports.wsdl");

    [Fact]
    public void ABridgeWithoutTheImportIsRefusedBeforeTheSnapshot()
    {
        if (!StudioAvailable()) return;
        var (result, bridge) = Deliver(b => b.Capabilities = ["publish_log", Delivery.MergeOrderCapability]);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal(IntegrationImport.NeedsBridge, result["code"]!.ToString());
        Assert.Equal("not-sent", result["writeState"]!.ToString());
        Assert.Contains("integration_import:wsdl", result["error"]!.ToString());
        Assert.DoesNotContain(bridge.Calls, c => c is "snapshot_module" or "merge_from_oml" or "integration_import");
    }

    [Fact]
    public void TheOrderIsSnapshotImportApplyMerge()
    {
        if (!StudioAvailable()) return;
        var (result, bridge) = Deliver();
        Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
        Assert.Equal(["snapshot_module", "integration_import", "apply", "merge_from_oml"], bridge.Calls.Where(c => c is "snapshot_module" or "integration_import" or "apply" or "merge_from_oml").Take(4));
        var import = Assert.Single(bridge.Imports);
        Assert.True(Path.IsPathFullyQualified(import["base_path"]!.ToString()));
        Assert.Equal(DeliveryReceipt.Hash(import["base_path"]!.ToString()), import["base_sha256"]!.ToString());
        Assert.Equal(Wsdl, import["document_path"]!.ToString());
        Assert.Equal("CalculatorSoap", import["selection"]!["port"]!.ToString());
        Assert.Equal("module", import["module_key"]!.ToString());
        // The job ran on the candidate; the merge took the snapshot as its base and the job's output as foreign.
        Assert.Equal(import["out_path"]!.ToString(), bridge.AppliedBase);
        var merge = Assert.Single(bridge.Merges);
        Assert.Equal(import["base_path"]!.ToString(), merge["base_path"]!.ToString());
        var report = Assert.Single(result["integration"]!.AsArray())!;
        Assert.Equal("soap", report["op"]!.ToString());
        Assert.Equal(["Add"], report["imported"]!.AsArray().Select(i => i!.ToString()));
        Assert.True(report["client"]!["created"]!.GetValue<bool>());
        Assert.Equal("CalculatorSoap", report["selection"]!["port"]!.ToString());
    }

    [Fact]
    public void ACandidateWhoseContractFailsIsRefusedWithoutMerge()
    {
        if (!StudioAvailable()) return;
        var (result, bridge) = Deliver(b => b.BreakContract = true);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("SOAP_CONTRACT_TYPE_MISMATCH", result["code"]!.ToString());
        Assert.Empty(bridge.Merges);
        Assert.Contains(bridge.Calls, c => c == "integration_import");
        Assert.Equal("not-sent", result["writeState"]!.ToString());
    }

    private static (JsonObject Result, ImportingBridge Bridge) Deliver(Action<ImportingBridge>? configure = null)
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "delivery-integration-import-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "soap-calculator.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "soap", ["data"] = new JsonObject
        {
            ["wsdl"] = new JsonObject { ["path"] = Wsdl, ["sha256"] = IntegrationDocuments.Sha256(File.ReadAllBytes(Wsdl)) },
            ["port"] = "CalculatorSoap", ["methods"] = new JsonArray("Add"),
        } }) }.ToJsonString());
        var live = Path.Combine(work, "live.oml"); File.Copy(Path.Combine(Root, "tests", "fixtures", "blank-service.oml"), live);
        var bridge = new ImportingBridge(live, work);
        configure?.Invoke(bridge);
        var result = Delivery.Run(bridge, new("Headless_CS", job, work, Array.Empty<string>()),
            (basePath, jobPath, output) =>
            {
                bridge.Calls.Add("apply"); bridge.AppliedBase = basePath;
                return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject();
            },
            inspectData: (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions));
        return (result, bridge);
    }

    /// <summary>The Studio boundary: the open module is a file; integration_import builds the candidate the Studio's
    /// importer would (a SOAP client with the requested method) on a copy of base_path; merge_from_oml records.</summary>
    private sealed class ImportingBridge(string live, string work) : IBridgeClient
    {
        public string[] Capabilities { get; set; } = ["publish_log", Delivery.MergeOrderCapability, IntegrationImport.WsdlCapability, IntegrationImport.OpenApiCapability];
        public bool BreakContract { get; set; }
        public List<string> Calls { get; } = new();
        public List<JsonObject> Imports { get; } = new();
        public List<JsonObject> Merges { get; } = new();
        public string? AppliedBase { get; set; }

        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "bridge_manifest": return new() { ["protocolVersion"] = 2, ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)c).ToArray()) };
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Headless_CS", ["key"] = "module" };
                case "snapshot_module":
                    File.Copy(live, parameters!["path"]!.ToString(), true);
                    return new() { ["key"] = "module", ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = new JsonArray() };
                case IntegrationImport.Verb:
                    Imports.Add(parameters!.DeepClone().AsObject());
                    var problems = IntegrationImport.Validate(parameters);
                    if (problems.Count > 0) throw new BridgeCallException("integration_import: " + string.Join("; ", problems), executed: false);
                    return Import(parameters);
                case "merge_from_oml":
                    Merges.Add(parameters!.DeepClone().AsObject());
                    return new() { ["merged"] = true, ["result"] = "Merge", ["hasConflicts"] = false, ["newErrors"] = 0 };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["rawMessages"] = new JsonArray() };
                default: throw new InvalidOperationException("unexpected bridge call " + method);
            }
        }

        private JsonObject Import(JsonObject parameters)
        {
            var dir = Path.Combine(work, "importer-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
            var job = Path.Combine(dir, "native-import.json");
            var ops = new JsonArray(
                new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "ISOAPClient", ["name"] = parameters["client"]!.ToString(), ["as"] = "$c" },
                new JsonObject { ["op"] = "create", ["parent"] = "$c", ["type"] = "ISOAPAction", ["name"] = "Add", ["as"] = "$m" });
            if (BreakContract)
            {
                ops.Add(new JsonObject { ["op"] = "create", ["parent"] = "$m", ["type"] = "ISOAPActionOutput", ["name"] = "AddResult", ["as"] = "$out" });
                ops.Add(new JsonObject { ["op"] = "set", ["target"] = "$out", ["prop"] = "OriginalType", ["value"] = "s:int" });
                ops.Add(new JsonObject { ["op"] = "set", ["target"] = "$out", ["prop"] = "DataType", ["value"] = "Text" });
            }
            File.WriteAllText(job, new JsonObject { ["expectValid"] = false, ["ops"] = ops }.ToJsonString());
            var output = parameters["out_path"]!.ToString();
            var built = Path.Combine(dir, "candidate.oml");
            JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), parameters["base_path"]!.ToString(), job, built);
            File.Copy(built, output);
            return new()
            {
                ["candidate_path"] = output, ["candidate_sha256"] = DeliveryReceipt.Hash(output),
                ["client"] = new JsonObject { ["name"] = parameters["client"]!.ToString(), ["key"] = null, ["created"] = true },
                ["imported"] = new JsonArray("Add"), ["skipped"] = new JsonArray(), ["warnings"] = new JsonArray(), ["errors"] = new JsonArray(),
            };
        }
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
