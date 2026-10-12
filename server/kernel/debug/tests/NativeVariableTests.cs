using System.Text.Json;
using System.Xml.Linq;

// Formats from the installed O11/ODC ServerVariableContainerUtils contract.
// All payload values below are synthetic; no customer evaluation XML is saved.
internal static class NativeVariableTests {
    static JsonElement Read(string xml, bool full = true, DebugPolicy.PrivateValues? secrets = null, int max = 30) =>
        JsonSerializer.SerializeToElement(Variables.Read(xml, full, max, secrets));
    static IEnumerable<JsonElement> Flatten(JsonElement rows) {
        foreach (var row in rows.EnumerateArray()) {
            yield return row;
            foreach (var child in Flatten(row.GetProperty("children"))) yield return child;
        }
    }
    static JsonElement Find(JsonElement rows, string path) => Flatten(rows).Single(row => row.GetProperty("path").GetString() == path);
    static string? Text(JsonElement rows, string path) => Find(rows, path).GetProperty("value").GetString();
    // Server Binary Data: the installed debugger surface has no content channel. IDebuggerAdapter.Evaluate fills
    // containers from the server's string and IDebuggerClient.Evaluate returns a string (both SDKs; findings in
    // .local/debugger/item2-odc-server-binary-contract). The size summary stays a summary at every native detail.
    static void BinarySizeOnly() {
        var adapter = typeof(ServiceStudio.PluginAPI.Debugger.IDebuggerAdapter).GetMethods();
        var client = typeof(OutSystems.DebuggerClient.IDebuggerClient).GetMethods();
        Tests.Check(adapter.Where(m => m.GetParameters().Any(p => p.ParameterType == typeof(IEnumerable<ServiceStudio.PluginAPI.Debugger.IVariableContainer>)))
                .Select(m => m.Name).SequenceEqual(["Evaluate"]) && adapter.Single(m => m.Name == "Evaluate").ReturnType == typeof(void) &&
            client.Single(m => m.Name == "Evaluate").ReturnType == typeof(string) && !adapter.Concat(client).Any(m => m.ReturnType == typeof(byte[]) ||
                m.ReturnType == typeof(Stream) || m.GetParameters().Any(p => p.ParameterType == typeof(byte[]) || p.ParameterType == typeof(Stream))),
            "installed debugger surface gained a binary content channel");
        var key = OutSystems.ObjectKeys.ObjectKey.Parse(Tests.ModuleKey);
        var point = new ServiceStudio.PluginAPI.Debugger.Breakpoint(key, OutSystems.ObjectKeys.ObjectKey.Parse(Tests.NodeKey));
        var thread = new ServiceStudio.PluginAPI.Debugger.ThreadData(key, "T1", "Test", "", 1, false, "PRIVATE-SESSION", true,
            [new ServiceStudio.PluginAPI.Debugger.StackElement(0, "Fixture", "Call", point, "ServerAction", point, null, OutSystems.RuntimeCommon.BreakpointType.Normal, "")], false);
        var definition = new InspectionVariable { ModuleKey = Tests.ModuleKey, FunctionKey = Tests.NodeKey, VariableKey = Tests.NodeKey,
            SourceSha256 = new string('a', 64), Name = "Payload", Path = "Payload", Category = "input" };
        for (var detail = 0; detail <= 4; detail++) {
            var requested = -1;
            var inspection = new NativeInspection(new InspectionOptions { Variables = [definition] }, new(), thread, request => {
                requested = int.Parse(XElement.Parse(request).Elements().Single().Attribute("detail")!.Value);
                return "<vars><local name=\"Payload\">BinaryData (2048 bytes)</local></vars>";
            });
            var reference = JsonSerializer.SerializeToElement(inspection.Scope(), Wire.Options).GetProperty("variables")[0].GetProperty("reference").GetString();
            var read = JsonSerializer.SerializeToElement(inspection.Read(new Request { Reference = reference, Depth = detail }), Wire.Options);
            var value = read.GetProperty("value");
            Tests.Check(requested == detail && read.GetProperty("nativeEvaluationDetail").GetInt32() == detail && value.GetProperty("nativeSummary").GetBoolean() &&
                !value.GetProperty("valueComplete").GetBoolean() && value.GetProperty("value").GetString() == "BinaryData (2048 bytes)",
                "Binary size summary at native detail " + detail + " was taken for content");
        }
        // Bounded capture keeps the native text and marks it as a summary too.
        var captured = Read("<vars><local name=\"Payload\">BinaryData (2048 bytes)</local><local name=\"Note\">\"BinaryData (2048 bytes)\"</local></vars>");
        Tests.Check(Find(captured, "Payload").GetProperty("nativeSummary").GetBoolean() && !Find(captured, "Note").GetProperty("nativeSummary").GetBoolean(),
            "bounded capture did not distinguish the native Binary summary from quoted Text");
    }
    internal static void Run() {
        BinarySizeOnly();
        var record = Read("""
            <vars><local name="R"><Entity Id="9223372036854775806" Amount="12345678901234567890.123456789" name="business" value="field-value" debug.trimmed.Amount="True" debug.value="entity-summary" /></local></vars>
            """);
        Tests.Check(Find(record, "R").GetProperty("type").GetString() == "Entity", "native entity envelope must not add a fictitious Entity path segment");
        Tests.Check(Text(record, "R.Id") == "9223372036854775806" && Text(record, "R.Amount") == "12345678901234567890.123456789", "native scalar attributes lost exact integer or decimal digits");
        Tests.Check(Text(record, "R.name") == "business" && Text(record, "R.value") == "field-value", "native name/value attributes are business fields");
        Tests.Check(Text(record, "R") == "entity-summary" && Find(record, "R.Amount").GetProperty("trimmed").GetBoolean(), "native summary/field trimming metadata lost");
        Tests.Check(!Flatten(record).Any(row => row.GetProperty("path").GetString()!.Contains("debug.")), "debug metadata became business fields");

        var list = Read("""
            <vars><local name="Rows"><Record.List Length="2"><Record debug.field="[0]"><Entity debug.field="Order" Id="7" /><Structure debug.field="Details" Count="3" /></Record><Record debug.field="[1]"><Entity debug.field="Order" Id="8" /></Record></Record.List></local></vars>
            """);
        Tests.Check(Text(list, "Rows.Length") == "2" && Text(list, "Rows[0].Order.Id") == "7" && Text(list, "Rows[1].Order.Id") == "8", "native list/record fields lost their debug.field identities");
        Tests.Check(Text(list, "Rows[0].Details.Count") == "3" && Find(list, "Rows[0].Details").GetProperty("type").GetString() == "Structure", "native structure fields or type lost");
        var deferred = Read("""
            <vars><local name="Rows"><Record.List Length="2"><DeferredEvaluation/><Entity debug.field="Unexpected" Id="99" /></Record.List></local><local name="Later"><DeferredEvaluation /></local></vars>
            """);
        Tests.Check(Find(deferred, "Rows").GetProperty("deferred").GetBoolean() && Find(deferred, "Later").GetProperty("deferred").GetBoolean(), "deferred evaluation must remain explicit");
        Tests.Check(Text(deferred, "Rows.Length") == "2" && !Flatten(deferred).Any(row => row.GetProperty("path").GetString()!.Contains("Unexpected")), "deferred container must not fabricate expanded children");
        var expanded = Read("""
            <vars><local name="Rows"><Record.List><Entity debug.field="[0]"><DeferredEvaluation /></Entity></Record.List></local><local name="Rows[0]"><Entity Id="11" /></local></vars>
            """);
        Tests.Check(Text(expanded[0].GetProperty("children"), "Rows[0].Id") == "11", "explicit expanded response row must override the deferred child");

        var scalars = Read("<vars><local name=\"Direct\">42</local><local name=\"Summary\" debug.value=\"48\" debug.trimmed=\"1\"/><local name=\"Legacy\" value=\"50\"/></vars>");
        Tests.Check(Text(scalars, "Direct") == "42" && Text(scalars, "Summary") == "48" && Text(scalars, "Legacy") == "50", "native scalar text/debug.value or prior value format lost");
        Tests.Check(Find(scalars, "Summary").GetProperty("trimmed").GetBoolean(), "native scalar truncation flag lost");

        const string secret = "opaque-compound-fixture-secret", copiedField = "copied-identity-fixture";
        var privateValues = new DebugPolicy.PrivateValues(); privateValues.Add(secret, copiedField);
        var privateXml = new XElement("vars", new XElement("local", new XAttribute("name", "Business"),
            new XElement("Record", new XElement("Entity", new XAttribute("debug.field", "Account"),
                new XAttribute("Count", "5"), new XAttribute("Password", "field-secret-synthetic"), new XAttribute("Alias", secret),
                new XAttribute("Message", Uri.EscapeDataString(secret)), new XAttribute(copiedField, "safe")),
                new XElement("Structure", new XAttribute("debug.field", "PasswordCopy"), new XAttribute("Count", "nested-secret-synthetic")),
                new XElement("Structure", new XAttribute("debug.field", "Details"),
                    new XElement("Text", new XAttribute("debug.field", "Password"), "text-secret-synthetic")),
                new XElement("Structure", new XAttribute("debug.field", "Summary"), new XAttribute("debug.value", secret))))).ToString();
        foreach (var full in new[] { false, true }) {
            var projected = Read(privateXml, full, privateValues); var json = projected.GetRawText();
            foreach (var value in new[] { secret, copiedField, "field-secret-synthetic", "nested-secret-synthetic", "text-secret-synthetic" })
                Tests.Check(!json.Contains(value, StringComparison.Ordinal), "compound attribute/text/identity leaked private data");
            Tests.Check(Find(projected, "Business").GetProperty("value").ValueKind == JsonValueKind.Null &&
                Find(projected, "Business.Details").GetProperty("value").ValueKind == JsonValueKind.Null, "parent concatenated a secret descendant's text");
            Tests.Check(Find(projected, "Business.PasswordCopy").GetProperty("children").GetArrayLength() == 0, "sensitive parent expanded private descendants");
            if (full) Tests.Check(Text(projected, "Business.Account.Count") == "5", "attribute redaction removed safe business fields");
        }
        var policy = Read("<vars><local name=\"R\"><Entity StatusCode=\"200\" Alias=\"withheld-business\" /></local></vars>", full: false);
        Tests.Check(Text(policy, "R.StatusCode") == "200" && Text(policy, "R.Alias") == DebugPolicy.Redacted, "attribute fields bypassed the normal value policy");
        privateValues.Clear();

        var wide = new XElement("vars", new XElement("local", new XAttribute("name", "Wide"), new XElement("Entity",
            Enumerable.Range(0, 120).Select(index => new XAttribute("F" + index, index)))));
        var bounded = Read(wide.ToString());
        Tests.Check(bounded[0].GetProperty("children").GetArrayLength() == 100 && bounded[0].GetProperty("childrenOmitted").GetInt32() == 20, "attribute expansion lost the 100-child bound");
        var deep = new XElement("Entity", new XAttribute("Id", "1"));
        for (var index = 0; index < 10; index++) deep = new XElement("Record", new XAttribute("debug.field", "Nested"), deep);
        var limited = Read(new XElement("vars", new XElement("local", new XAttribute("name", "Deep"), deep)).ToString());
        Tests.Check(Flatten(limited).Count() == 7 && Flatten(limited).Last().GetProperty("childrenOmitted").GetInt32() == 1, "native expansion lost the depth bound");
        Tests.Check(Read("<vars><local name=\"One\">1</local><local name=\"Two\">2</local></vars>", max: 1).GetArrayLength() == 1, "native projection lost root bound");
    }
}
