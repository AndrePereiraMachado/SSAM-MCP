using System.Text.Json;
using System.Xml.Linq;

internal static class BodyPolicyTests {
    internal static void Run() {
        const string body = "{\"statusCode\":400,\"errors\":[\"BuildingCoverage is invalid\"],\"access_token\":\"DO-NOT-EXPOSE\",\"email\":\"private@example.test\"}";
        foreach (var path in new[] { "Response.Body", "Response.ResponseText" })
        foreach (var literal in new[] { body, JsonSerializer.Serialize(body), "\"" + body + "\"", "\"" + body.Replace("\"", "\"\"") + "\"", JsonSerializer.Serialize(JsonSerializer.Serialize(body)) }) {
            var xml = new XElement("vars", new XElement("local", new XAttribute("name", path), new XAttribute("value", literal))).ToString();
            var result = JsonSerializer.Serialize(Variables.Read(xml));
            Tests.Check(result.Contains("BuildingCoverage is invalid") && result.Contains("400"), "native quoted JSON body lost error diagnostics");
            Tests.Check(!result.Contains("DO-NOT-EXPOSE") && !result.Contains("private@example.test"), "body envelope bypassed redaction");
        }
        var safe = JsonSerializer.Serialize(DebugPolicy.Value("Response.Body", "{\"errors\":[\"Bearer PRIVATE-TOKEN\",\"eyJabc.def.ghi\"],\"headers\":{\"message\":\"DO-NOT-EXPOSE\"},\"unknown\":[\"DO-NOT-EXPOSE\"]}"));
        Tests.Check(!safe.Contains("PRIVATE-TOKEN") && !safe.Contains("eyJabc") && !safe.Contains("DO-NOT-EXPOSE"), "diagnostic arrays leaked secrets or unknown values");
        Tests.Check((string?)DebugPolicy.Value("Response.Body", "<html>private@example.test</html>") == "[non-JSON body withheld]", "unstructured body must fail closed");
        Tests.Check((string?)DebugPolicy.Value("Response.Body", new string('x', 65537)) == "[body exceeds safe inspection limit]", "body limit lost");
        Tests.Check((string?)DebugPolicy.Value("Response.Authorization.Body", body) == DebugPolicy.Redacted, "sensitive parent bypassed body filtering");
        Tests.Check((string?)DebugPolicy.Value("Response.Body", "-unavailable in current context-") == "-unavailable in current context-", "missing native path mislabeled as a non-JSON HTTP body");
        Tests.Check((string?)DebugPolicy.Value("Response.Headers.Body", "-unavailable in current context-") == DebugPolicy.Redacted, "native sentinel bypassed sensitive path policy");
        var diagnostic = JsonSerializer.Serialize(DebugPolicy.Value("Response.Body", "\"Invalid coverage amount\""));
        Tests.Check(diagnostic.Contains("Invalid coverage amount"), "JSON string error body lost");
        var apiError = JsonSerializer.Serialize(DebugPolicy.Value("Response.ResponseText", "{\"data\":{\"errorCode\":\"110\",\"messages\":[{\"messageType\":\"Error\",\"messageID\":\"123\",\"messageDescription\":\"Invalid occupancy\"}]}}"));
        Tests.Check(apiError.Contains("Invalid occupancy") && apiError.Contains("123") && apiError.Contains("110"), "structured API message diagnostics lost");
    }
}
