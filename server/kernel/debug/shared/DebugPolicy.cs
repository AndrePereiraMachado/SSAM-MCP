using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;

// Deliberately fail closed: debugger text is untrusted and may contain credentials.
// No raw mode. Structured bodies expose only diagnostic/address fields; arbitrary text stays in Studio.
internal static class DebugPolicy {
    internal const string Redacted = "[redacted]";
    // Bound to one DebugSession, never static/global or serialized. Include the debugger's text
    // encodings because a copied credential can occur in a Text literal or nested JSON string.
    internal sealed class PrivateValues {
        readonly object gate = new();
        readonly HashSet<string> patterns = new(StringComparer.Ordinal);
        internal void Add(params string?[] values) {
            lock (gate) foreach (var value in values) {
                if (string.IsNullOrEmpty(value)) continue;
                if (value.Length > 65536) throw new DebugFailure("debug_invalid_private_values");
                patterns.Add(value);
                foreach (var encoded in new[] { JsonSerializer.Serialize(value), JsonSerializer.Serialize(value, new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }) }) {
                    var literal = encoded[1..^1];
                    patterns.Add(literal);
                    patterns.Add(Regex.Replace(literal, @"\\u[0-9A-Fa-f]{4}", m => m.Value.ToLowerInvariant()));
                }
                patterns.Add(value.Replace("\"", "\"\""));
                patterns.Add(Uri.EscapeDataString(value));
            }
        }
        internal bool Contains(string? text) {
            if (string.IsNullOrEmpty(text)) return false;
            lock (gate) {
                if (patterns.Any(value => text.Contains(value, StringComparison.Ordinal))) return true;
                // A native Text can contain several JSON string envelopes. Decode only strings,
                // with a bounded budget; comparisons also cover escaped Unicode/quotes inside them.
                var inner = text.Trim();
                for (var level = 0; level < 12 && inner.Length <= 65536 && inner.StartsWith('"'); level++) {
                    try {
                        inner = JsonSerializer.Deserialize<string>(inner) ?? "";
                        if (patterns.Any(value => inner.Contains(value, StringComparison.Ordinal))) return true;
                        inner = inner.Trim();
                    } catch (JsonException) { break; }
                }
                return false;
            }
        }
        internal void Clear() { lock (gate) patterns.Clear(); }
    }
    private static readonly Regex Secret = new("password|passwd|secret|token|authorization|cookie|credential|api.?key|client.?id|username|headers", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Safe = new(StringComparer.OrdinalIgnoreCase) {
        "status", "statuscode", "httpstatuscode", "success", "code", "errorcode", "address", "address1", "address2", "street", "streetaddress",
        "city", "state", "statecode", "zip", "zipcode", "postalcode", "country", "latitude", "longitude", "drpid",
        // Rating request/response business fields (flood quote), requested by the user to diagnose the quote call.
        // Names, e-mail and phone stay withheld; the Secret pattern above still wins for tokens and credentials.
        "quotenumber", "completequotenumber", "principalresidence", "priorclaims", "buildingoverwater", "underconstruction",
        "condounitowner", "attachedgarage", "constructionyear", "numberoffloors", "buildingsquarefootage", "occupancytype",
        "foundationtype", "policyeffectivedate", "existingnfippolicy", "buildingdescription", "buildingpurpose", "replacementcost",
        "floodzone", "communitynumber", "mappanel", "mapsuffix", "zonerequest", "isfemafloodmanualdetermination",
        "buildingcoverage", "contentscoverage", "buildingdeductible", "contentsdeductible", "basementenclosure", "basementenclosureme",
        "waitingperiod", "constructiondatetype", "tenantoccupied", "numberofunits", "numberofdetachedstructures", "elevatorindicator",
        "garageareabelowelevatedfloor", "substantiallyimproved", "contentsonly", "floodproofindicator", "finishedbasementorenclosure",
        "elevationcertificateyn", "rentalproperty", "agentnumber",
        "cmpny", "brnch", "prdct", "descx", "premiumx", "company", "branch", "product", "description", "premium", "no_buttonx",
        "deductible", "totalpremium", "totalfees", "totalamount", "select", "selectedflag", "message", "errormessage", "errors", "length",
        "error", "detail", "title", "reason", "field", "path", "messagetype", "messageid", "messagedescription"
    };
    internal static bool Sensitive(string path) => Secret.IsMatch(path);
    // Development tracing (TraceOptions.FullValues): business values are the point of the map, so only
    // credentials stay hidden: private session values, secret-named paths, schemes and JWTs.
    internal static object? FullValue(string path, string? value, PrivateValues? privateValues = null) {
        if (Sensitive(path) || privateValues?.Contains(path) == true) return Redacted;
        if (value == null) return null;
        var text = value.Trim();
        // A JSON text keeps its values, except fields named like credentials (an access_token in a response body).
        if (text.Length <= 65536 && (text.StartsWith('{') || text.StartsWith('[') || text.StartsWith("\"{") || text.StartsWith("\"["))) {
            try { return Unsecret(ParseBody(text), 0, privateValues)?.ToJsonString(); } catch (System.Text.Json.JsonException) { }
        }
        if (HiddenValue(value, privateValues)) return Redacted;
        return value.Length > 4096 ? value[..4096] + "[truncated]" : value;
    }
    static bool HiddenValue(string? value, PrivateValues? privateValues) => privateValues?.Contains(value) == true ||
        value != null && Regex.IsMatch(value, @"(?i)bearer\s|basic\s|eyJ[A-Za-z0-9_-]+\.");
    private static JsonNode? Unsecret(JsonNode? node, int depth, PrivateValues? privateValues) {
        if (depth > 12) return JsonValue.Create("[depth limit]");
        if (node is JsonObject obj) {
            var result = new JsonObject();
            foreach (var field in obj.Take(200)) {
                if (privateValues?.Contains(field.Key) == true) return JsonValue.Create(Redacted);
                result[field.Key] = Sensitive(field.Key) ? JsonValue.Create(Redacted) : Unsecret(field.Value, depth + 1, privateValues);
            }
            return result;
        }
        if (node is JsonArray array) return new JsonArray(array.Take(200).Select(n => Unsecret(n, depth + 1, privateValues)).ToArray());
        if (node is JsonValue scalar && scalar.TryGetValue<string>(out var text)) {
            var trimmed = text.Trim();
            if (trimmed.Length <= 65536 && (trimmed.StartsWith('{') || trimmed.StartsWith('[') || trimmed.StartsWith("\"{") || trimmed.StartsWith("\"["))) {
                try { return JsonValue.Create(Unsecret(ParseBody(trimmed), depth + 1, privateValues)?.ToJsonString()); } catch (JsonException) { }
            }
            if (HiddenValue(text, privateValues)) return JsonValue.Create(Redacted);
        } else if (HiddenValue(node?.ToJsonString(), privateValues)) return JsonValue.Create(Redacted);
        return node?.DeepClone();
    }
    internal static object? Value(string path, string? value, PrivateValues? privateValues = null) {
        if (Sensitive(path) || privateValues?.Contains(path) == true) return Redacted;
        if (value == null) return null;
        // Native evaluation sentinels are diagnostics, never an HTTP response body.
        if (value == "-unavailable in current context-") return value;
        var leaf = path.Split('.', '/', '[', ']').LastOrDefault(s => s.Length > 0) ?? "";
        if (leaf.Equals("body", StringComparison.OrdinalIgnoreCase) || leaf.Equals("responsebody", StringComparison.OrdinalIgnoreCase)
            || leaf.Equals("responsetext", StringComparison.OrdinalIgnoreCase)) {
            if (value.Length > 65536) return "[body exceeds safe inspection limit]";
            try { return Filter(ParseBody(value), 0, "body", privateValues); } catch (System.Text.Json.JsonException) { return "[non-JSON body withheld]"; }
        }
        if (!Safe.Contains(leaf)) return Redacted;
        // Even allowed fields cannot echo authorization schemes or a JWT.
        if (HiddenValue(value, privateValues)) return Redacted;
        return value.Length > 512 ? value[..512] + "[truncated]" : value;
    }
    // Evaluate returns a debugger Text literal, not necessarily raw HTTP text. Decode JSON
    // string envelopes and the native quoted literal before filtering the actual document.
    private static JsonNode? ParseBody(string value) {
        var text = value.Trim();
        for (var level = 0; level < 3; level++) {
            JsonNode? node;
            try { node = JsonNode.Parse(text); }
            catch (System.Text.Json.JsonException) when (text.Length >= 2 && text[0] == '"' && text[^1] == '"') {
                text = text[1..^1];
                try { node = JsonNode.Parse(text); }
                catch (System.Text.Json.JsonException) { node = JsonNode.Parse(text.Replace("\"\"", "\"")); }
            }
            if (node is JsonValue scalar && scalar.TryGetValue<string>(out var decoded)) {
                var inner = decoded.Trim();
                if (inner.StartsWith('{') || inner.StartsWith('[') || inner.StartsWith('"')) { text = inner; continue; }
                return new JsonObject { ["message"] = decoded };
            }
            return node;
        }
        throw new System.Text.Json.JsonException("Debugger body envelope limit");
    }
    private static JsonNode? Filter(JsonNode? node, int depth, string fieldName, PrivateValues? privateValues) {
        if (depth > 8) return JsonValue.Create("[depth limit]");
        if (node is JsonObject obj) {
            var result = new JsonObject();
            foreach (var field in obj.Take(100)) {
                if (privateValues?.Contains(field.Key) == true) return JsonValue.Create(Redacted);
                result[field.Key] = Sensitive(field.Key) ? JsonValue.Create(Redacted)
                    : field.Value is JsonObject or JsonArray ? Filter(field.Value, depth + 1, field.Key, privateValues)
                    : JsonValue.Create(Value(field.Key, field.Value?.ToString(), privateValues)?.ToString());
            }
            return result;
        }
        if (node is JsonArray array) return new JsonArray(array.Take(50).Select(n => n is JsonObject or JsonArray ? Filter(n, depth + 1, fieldName, privateValues)
            : JsonValue.Create(fieldName.Equals("errors", StringComparison.OrdinalIgnoreCase) ? Value("message", n?.ToString(), privateValues)?.ToString() : Redacted)).ToArray());
        return JsonValue.Create(Redacted);
    }
    internal static void CheckStop(string? requestedThread, long? requestedEvent, string actualThread, long actualEvent, bool interactive, bool consumed) {
        if (string.IsNullOrEmpty(requestedThread) || requestedEvent == null || requestedThread != actualThread || requestedEvent != actualEvent || !interactive || consumed)
            throw new InvalidOperationException("debug_stale_stop: refresh debug status; thread/event must identify an unconsumed interactive stop.");
    }
}
