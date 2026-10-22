using System.Text.Json.Nodes;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>An explicit, audited exception to script isolation, scoped to named screen actions in one module.</summary>
public static class ScreenJavaScriptException
{
    public const string AllowKey = "allowScreenJavaScript";
    public const string AllowedCode = "FLOW_SCREEN_JAVASCRIPT_ALLOWED";
    public static bool Takes(string kind) => kind is "logic" or "create" or "duplicate" or "move";

    public static string? Validate(JsonObject op)
    {
        if (!op.ContainsKey(AllowKey)) return null;
        if (op[AllowKey] is JsonObject flag && flag.All(p => p.Key is "module" or "screen" or "actions" or "why")
            && Text(flag["module"]) is { Length: > 0 }
            && Text(flag["screen"]) is { Length: > 0 }
            && Text(flag["why"]) is { Length: >= 15 }
            && flag["actions"] is JsonArray { Count: > 0 } actions
            && actions.All(a => Text(a) is { Length: > 0 } name && FlowSyntax.IsIdentifier(name))) return null;
        return AllowKey + " requires {module, screen, actions: [explicit action names], why: <at least 15 characters>}";
    }

    // Preflight has no loaded module. It checks the declaration; apply checks the actual module too.
    public static string? Allowed(JsonObject? op, FlowItem action, string? module = null)
    {
        if (op == null || Validate(op) != null || op[AllowKey] is not JsonObject flag || action.Kind != "ScreenAction") return null;
        if (module != null && !string.Equals(Text(flag["module"]), module, StringComparison.OrdinalIgnoreCase)) return null;
        if (!string.Equals(Text(flag["screen"]), action.Owner, StringComparison.OrdinalIgnoreCase)) return null;
        if (!((JsonArray)flag["actions"]!).Any(a => string.Equals(Text(a), action.Name, StringComparison.OrdinalIgnoreCase))) return null;
        return Text(flag["why"]);
    }

    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var text) ? text.Trim() : null;
}
