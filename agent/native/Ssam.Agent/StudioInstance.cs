using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

internal static class StudioInstance
{
    internal static string? Start(string? value)
    {
        if (string.IsNullOrEmpty(value)) return null;
        var m = Regex.Match(value, @"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?(?:Z|\+00:00)$");
        return m.Success ? m.Groups[1].Value + "." + m.Groups[2].Value.PadRight(6, '0')[..6] + "Z" : value;
    }
    internal static bool Same(JsonNode? a, JsonNode? b) => StudioKinds.Integer(a?["pid"]) == StudioKinds.Integer(b?["pid"])
        && Start(StudioKinds.Text(a?["startedUtc"])) is { } started && started == Start(StudioKinds.Text(b?["startedUtc"]));
    internal static bool Complete(JsonArray? rows) => rows != null && rows.All(p => StudioKinds.Integer(p?["pid"]) > 0 && Start(StudioKinds.Text(p?["startedUtc"])) != null);
    internal static JsonObject Snapshot()
    {
        var rows = new JsonArray(); var complete = true;
        try
        {
            foreach (var image in new[] { "ODCStudio", "ServiceStudio" }) foreach (var process in Process.GetProcessesByName(image))
            {
                using (process) try { rows.Add((JsonNode)new JsonObject { ["pid"] = process.Id, ["startedUtc"] = process.StartTime.ToUniversalTime().ToString("O") }); }
                catch { complete = false; }
            }
        }
        catch { complete = false; }
        return new() { ["complete"] = complete, ["processes"] = rows };
    }
}
