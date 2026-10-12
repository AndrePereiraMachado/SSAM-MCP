using System.Text.Json;
using System.Text.Json.Nodes;

static class O11NativeNeutralizationTests {
    internal static void Run() {
        var debugRoot = Path.Combine(Path.GetTempPath(), "neutralization-fixture", ".local", "debugger");
        var local = Path.GetDirectoryName(debugRoot)!;
        var origin = "https://" + O11NativeNeutralization.Host;
        var reportPath = Path.Combine(debugRoot, "assessment.json");
        var registrationPath = Path.Combine(debugRoot, "reconciled-bindings", BlockedBindings.Hash(origin, O11NativeNeutralization.ModuleKey) + ".json");
        var values = new Dictionary<string, byte[]>(); var hashes = new Dictionary<string, string>();
        var pins = new JsonObject();
        foreach (var name in new[] { "nativeReceipt", "controllerReceipt", "publicationRequest", "publicationAuthorization", "publicationReceipt",
            "publishedObservation", "nativePublishCheck", "serviceCenterObservation", "qualificationController", "qualificationNative", "publishedSnapshot" }) {
            var file = Path.Combine(local, name + ".json"); hashes[file] = new string('a', 64); values[file] = "{}"u8.ToArray();
            pins[name] = JsonSerializer.SerializeToNode(new { path = file, sha256 = hashes[file] });
        }
        var basePath = Path.Combine(local, "base.oml"); hashes[basePath] = new string('b', 64);
        var requestPath = Path.Combine(local, "publicationRequest.json");
        values[requestPath] = JsonSerializer.SerializeToUtf8Bytes(new { basePath, baseSha256 = hashes[basePath], candidatePath = basePath, candidateSha256 = hashes[basePath] });
        var report = new JsonObject {
            ["schema"] = "ssam-o11-historical-debug-neutralization/1", ["lane"] = "o11", ["host"] = O11NativeNeutralization.Host,
            ["moduleKey"] = O11NativeNeutralization.ModuleKey, ["operationId"] = O11NativeNeutralization.OperationId,
            ["nativeDebuggerInactive"] = true, ["originalReceiptPreserved"] = true, ["oldOperationReplayAllowed"] = false,
            ["newBindingOperationsAllowed"] = true, ["evidence"] = pins,
            ["publication"] = JsonSerializer.SerializeToNode(new { desiredPublishedStateConfirmed = true, publicationOperationIdentityProved = false,
                publicationLockReleaseAllowed = false, publishedVersionId = 5811 }) };
        var registration = new JsonObject { ["schema"] = "ssam-o11-neutralization-registration/1", ["lane"] = "o11", ["host"] = O11NativeNeutralization.Host,
            ["moduleKey"] = O11NativeNeutralization.ModuleKey, ["operationId"] = O11NativeNeutralization.OperationId,
            ["report"] = JsonSerializer.SerializeToNode(new { path = reportPath, sha256 = O11NativeNeutralization.ReportSha256 }) };
        void Save() { values[registrationPath] = JsonSerializer.SerializeToUtf8Bytes(registration); values[reportPath] = JsonSerializer.SerializeToUtf8Bytes(report); }
        hashes[reportPath] = O11NativeNeutralization.ReportSha256; Save();
        // The trusted immutable-byte boundary is injected separately from the
        // document structure, so these tests never copy customer OML/evidence.
        bool Verify(string? testOrigin = null, string? key = null) => O11NativeNeutralization.Verify(debugRoot, testOrigin ?? origin, key ?? O11NativeNeutralization.ModuleKey,
            file => values[file], file => hashes[file], _ => O11NativeNeutralization.ReportSha256);
#if ODC
        Tests.Check(!Verify(), "O11 qualification never releases ODC bindings");
#else
        Tests.Check(Verify(), "exact approved report with all pins permits new O11 binding operations");
        Tests.Check(!Verify("https://another.example.test"), "neutralization is host bound");
        Tests.Check(!Verify(key: Tests.ModuleKey), "neutralization is module bound");
        registration["lane"] = "odc"; Save(); Tests.Check(!Verify(), "wrong lane registration refused"); registration["lane"] = "o11";
        registration["operationId"] = Guid.NewGuid().ToString("N"); Save(); Tests.Check(!Verify(), "different historical operation refused"); registration["operationId"] = O11NativeNeutralization.OperationId;
        report["oldOperationReplayAllowed"] = true; Save(); Tests.Check(!Verify(), "historical operation can never become replayable"); report["oldOperationReplayAllowed"] = false;
        report["publication"]!["publicationLockReleaseAllowed"] = true; Save(); Tests.Check(!Verify(), "debugger reconciliation cannot release uncertain publication"); report["publication"]!["publicationLockReleaseAllowed"] = false; Save();
        var oldPath = Path.Combine(local, "nativeReceipt.json"); var oldHash = hashes[oldPath]; hashes[oldPath] = new string('f', 64);
        Tests.Check(!Verify(), "changed original native receipt remains blocked"); hashes[oldPath] = oldHash;
        hashes[reportPath] = new string('d', 64); Tests.Check(!Verify(), "changed report pin remains blocked"); hashes[reportPath] = O11NativeNeutralization.ReportSha256;
        Tests.Check(!O11NativeNeutralization.Verify(debugRoot, origin, O11NativeNeutralization.ModuleKey, file => values[file], file => hashes[file]),
            "default byte hashing refuses synthetic or tampered report bytes");
        var runtimeUrl = "https://" + O11NativeNeutralization.Host + "/Headless_UI/";
        var original = new Configuration { SessionId = O11NativeNeutralization.OperationId, Module = "Headless_UI", ModuleKey = O11NativeNeutralization.ModuleKey,
            RuntimeUrl = runtimeUrl, NodeKeys = [Tests.NodeKey], ReceiptPath = Path.Combine(debugRoot, "session", "receipt.json") };
        try { BlockedBindings.Refuse(original); throw new Exception("historical replay accepted"); }
        catch (DebugFailure error) { Tests.Check(error.Message == "debug_binding_blocked", "original 4c replay is unconditionally refused"); }
#endif
    }
}
