using System.Text.Encodings.Web;
using System.Text.Json;
using System.Xml.Linq;
using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.PluginAPI.Debugger;

internal static class PrivateValuePolicyTests {
    const string Password = "cópia-ç-\"-🔒", Username = "fixture-user@example.invalid", Token = "opaque-access-fixture-value", LateSecret = "opaque-legacy-fixture-value";
    static readonly string[] Secrets = [Password, Username, Token, LateSecret, "opaque-soap-fixture-value", "fixture-soap-user", "PrivateCopiedType"];
    static void Absent(string json) {
        foreach (var secret in Secrets) {
            Tests.Check(!json.Contains(secret, StringComparison.Ordinal), "private literal leaked");
            var encoded = JsonSerializer.Serialize(secret);
            var relaxed = JsonSerializer.Serialize(secret, new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
            // Recursively decode the output too: nested JSON strings add further quoting layers.
            CheckNode(JsonDocument.Parse(json).RootElement, secret);
            Tests.Check(!json.Contains(encoded[1..^1], StringComparison.Ordinal) && !json.Contains(relaxed[1..^1], StringComparison.Ordinal), "encoded private literal leaked");
        }
    }
    static void CheckNode(JsonElement node, string secret, int depth = 0) {
        if (depth > 20) return;
        if (node.ValueKind == JsonValueKind.Object) foreach (var field in node.EnumerateObject()) {
            Tests.Check(!field.Name.Contains(secret, StringComparison.Ordinal), "private key leaked"); CheckNode(field.Value, secret, depth + 1);
        }
        else if (node.ValueKind == JsonValueKind.Array) foreach (var child in node.EnumerateArray()) CheckNode(child, secret, depth + 1);
        else if (node.ValueKind == JsonValueKind.String) {
            var text = node.GetString()!;
            Tests.Check(!text.Contains(secret, StringComparison.Ordinal), "decoded private literal leaked");
            try { using var inner = JsonDocument.Parse(text); CheckNode(inner.RootElement, secret, depth + 1); } catch (JsonException) { }
        }
    }
    static string Xml() {
        var body = JsonSerializer.Serialize(new { count = 7, note = Password, nested = new { copied = Username }, list = new[] { Token, "safe-item" },
            jsonText = JsonSerializer.Serialize(new { business = 13, innocuous = Password }) });
        var vars = new XElement("vars",
            new XElement("local", new XAttribute("name", "Alias"), new XAttribute("value", Password)),
            new XElement("local", new XAttribute("name", "Message"), new XAttribute("value", "server echoed " + LateSecret)),
            new XElement("local", new XAttribute("name", "Record"), new XElement("Text", new XAttribute("name", "Plain"), new XAttribute("value", Username))),
            new XElement("local", new XAttribute("name", "Body"), new XAttribute("value", JsonSerializer.Serialize(body))),
            new XElement("local", new XAttribute("name", Password), new XAttribute("value", "safe-data")),
            new XElement("PrivateCopiedType", new XAttribute("name", "HarmlessType"), new XAttribute("value", "safe-data")),
            new XElement("local", new XAttribute("name", "SafeCount"), new XAttribute("value", "42")));
#if !ODC
        vars.Add(new XElement("local", new XAttribute("name", "FirstAlias"), new XAttribute("value", "fixture-soap-user")),
            new XElement("local", new XAttribute("name", "SecondAlias"), new XAttribute("value", "opaque-soap-fixture-value")));
#endif
        return vars.ToString();
    }
    internal static async Task Run() {
        var context = new DebugPolicy.PrivateValues(); context.Add(Secrets);
        foreach (var text in new[] { Password, "prefix " + Password + " suffix", JsonSerializer.Serialize(Password), "\"" + Password.Replace("\"", "\"\"") + "\"", Uri.EscapeDataString(Password) })
            Tests.Check((string?)DebugPolicy.FullValue("HarmlessAlias", text, context) == DebugPolicy.Redacted, "private copied text escaped protection");
        foreach (var safePath in new[] { "Message", "Error", "Address" })
            Tests.Check((string?)DebugPolicy.Value(safePath, "prefix " + Token, context) == DebugPolicy.Redacted, "allowlisted diagnostic echoed private value");
        foreach (var full in new[] { false, true }) Absent(Wire.Json(Variables.Read(Xml(), full, privateValues: context)));
        var nested = (string)DebugPolicy.FullValue("Body", JsonSerializer.Serialize(new { amount = 17, alias = Password, list = new[] { Password, "business" },
            jsonText = JsonSerializer.Serialize(new { amount = 19, alias = Password }) }), context)!;
        Absent(nested); Tests.Check(nested.Contains("17") && nested.Contains("19") && nested.Contains("business"), "business values lost during private redaction");
        var envelope = JsonSerializer.Serialize(new { alias = Password });
        for (var level = 0; level < 6; level++) {
            envelope = JsonSerializer.Serialize(envelope);
            Absent(Wire.Json(DebugPolicy.FullValue("HarmlessAlias", envelope, context)!));
        }
        var privateKey = JsonSerializer.Serialize(new Dictionary<string, object> { [Password] = "business" });
        Absent(Wire.Json(DebugPolicy.FullValue("Body", privateKey, context)!));
        // Isolation and release: values from another debugger session must not affect this one.
        var other = new DebugPolicy.PrivateValues(); other.Add("other-session-only");
        Tests.Check((string?)DebugPolicy.FullValue("Alias", Password, other) == Password && (string?)DebugPolicy.FullValue("Alias", "other-session-only", context) == "other-session-only", "private contexts crossed sessions");
        other.Clear(); Tests.Check((string?)DebugPolicy.FullValue("Alias", "other-session-only", other) == "other-session-only", "private references retained after clear");

        var dir = Path.Combine(Path.GetTempPath(), "ssam-private-values-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        try {
            var appValues = new[] { Password, Username, "PrivateCopiedType" };
            var config = new Configuration { SessionId = Guid.NewGuid().ToString("N"), Module = "Fixture", ModuleKey = Tests.ModuleKey,
                RuntimeUrl = "https://example.invalid/Fixture/", NodeKeys = [Tests.NodeKey], Token = Token, PrivateValues = appValues,
                ReceiptPath = Path.Combine(dir, "receipt.json"),
                Trace = new TraceOptions { Mode = "breakpoints", FullValues = true, Scopes = new() { [Tests.NodeKey] = ["Alias", "Message", "Record", "Body"] } } };
#if !ODC
            config.SoapUser = "fixture-soap-user"; config.SoapSecret = "opaque-soap-fixture-value";
#endif
            config.Validate();
            var fake = new FakeTransport { EvaluateAnswer = Xml() };
            var key = ObjectKey.Parse(Tests.ModuleKey); var point = new Breakpoint(key, ObjectKey.Parse(Tests.NodeKey));
            var thread = new ThreadData(key, "T-private", "Test", "", 1, false, "NOT-PUBLIC-SESSION", true,
                [new StackElement(0, "Fixture", "Action", point, "ServerAction", point, point, BreakpointType.Normal, "")], false);
            await using (var session = new DebugSession(config, fake)) {
                Tests.Check(appValues.All(string.IsNullOrEmpty) && config.PrivateValues.Length == 0, "private bootstrap array retained");
                config.AddPrivateValues(LateSecret); // Same hook the native transports call for late developer auth/session tokens.
                await session.Start(); await fake.Pause(thread);
                var status = Wire.Json(session.Status()); Absent(status);
                Tests.Check(status.Contains("42") && !status.Contains("privateValues"), "trace dropped safe values or exposed private contract");
                await session.Stop(); File.WriteAllText(config.ReceiptPath, Wire.Json(session.Status()));
            }
            Tests.Check(config.Redactor == null, "session retained private context");
            Absent(File.ReadAllText(config.ReceiptPath));
            foreach (var line in File.ReadAllLines(Path.Combine(dir, "trace.jsonl"))) Absent(line);
            foreach (var invalid in new[] { Enumerable.Repeat("private", 33).ToArray(), new[] { "" }, new[] { new string('x', 65537) } }) {
                config.PrivateValues = invalid;
                try { config.Validate(); throw new Exception("invalid private values accepted"); }
                catch (DebugFailure error) { Tests.Check(error.Message == "debug_invalid_private_values", "private input failure is not sanitized"); }
            }
        } finally { Directory.Delete(dir, true); context.Clear(); }
    }
}
