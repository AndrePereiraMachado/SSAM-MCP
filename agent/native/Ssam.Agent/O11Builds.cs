using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Ssam.Agent.StudioKinds;

namespace Ssam.Agent;

// The O11 thin bridges of one pack, one per Service Studio version (pack.json o11Builds, 0.4.4-native; the Node agent's
// o11-builds.mjs). A bridge binds to the exact ServiceStudio.* assembly versions it was compiled against, so the agent picks
// the build of the Studio the customer has: in the hello (pack.o11BuiltFor) and in o11.connect (the bridge file and the
// sha256 of the handshake). The first build is the pack's default (o11BuiltFor and o11Bridge name it too). A build whose
// file is not in the integrity list with the same sha256, or whose path is outside bin/o11/, is ignored.
internal static class O11Builds
{
    internal const string DefaultBridge = "bin/o11/bridge/Anvil.Bridge.dll";
    private static readonly Regex BridgePath = new(@"^bin/o11/(?:bridge|bridges/\d+\.\d+\.\d+)/Anvil\.Bridge\.dll$", RegexOptions.CultureInvariant);
    private static readonly Regex VersionText = new(@"^\d+\.\d+\.\d+$", RegexOptions.CultureInvariant);
    private static readonly Regex Sha = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);

    internal static List<JsonObject> All(JsonObject? pack)
    {
        var listed = (pack?["files"] as JsonArray)?.OfType<JsonObject>().GroupBy(f => (Text(f["path"]) ?? "").Replace('\\', '/')).ToDictionary(g => g.Key, g => Text(g.First()["sha256"])) ?? [];
        var seen = new HashSet<string>(); var builds = new List<JsonObject>();
        foreach (var build in (pack?["o11Builds"] as JsonArray)?.OfType<JsonObject>() ?? [])
        {
            var version = Text(build["version"]) ?? ""; var file = Text(build["path"]) ?? ""; var sha = Text(build["sha256"]) ?? "";
            if (!VersionText.IsMatch(version) || !BridgePath.IsMatch(file) || !Sha.IsMatch(sha) || !seen.Add(version)) continue;
            if (listed.Count > 0 && (!listed.TryGetValue(file, out var recorded) || recorded != sha)) continue;
            var entry = new JsonObject { ["version"] = version, ["path"] = file, ["sha256"] = sha };
            if (Text(build["runtime"]) is { } runtime) entry["runtime"] = runtime;
            builds.Add(entry);
        }
        return builds;
    }

    internal static JsonObject? For(JsonObject? pack, string? studioVersion)
    {
        var wanted = Three(studioVersion);
        return wanted == null ? null : All(pack).FirstOrDefault(b => Three(Text(b["version"])) == wanted);
    }

    // The pack as this Service Studio sees it (o11BuiltFor, o11Runtime, o11Bridge of its build), or the pack itself.
    internal static JsonObject PackFor(JsonObject pack, string? studioVersion)
    {
        if (Text(pack["o11Hook"]) == "h1" || For(pack, studioVersion) is not { } build) return pack;
        var view = (JsonObject)pack.DeepClone();
        view["o11BuiltFor"] = build["version"]!.DeepClone();
        if (build["runtime"] != null) view["o11Runtime"] = build["runtime"]!.DeepClone();
        var bridge = view["o11Bridge"] as JsonObject ?? new JsonObject();
        bridge["path"] = build["path"]!.DeepClone(); bridge["sha256"] = build["sha256"]!.DeepClone();
        view["o11Bridge"] = bridge;
        return view;
    }

    internal static JsonArray Versions(JsonObject? pack) => new(All(pack).Select(b => b["version"]!.DeepClone()).ToArray());

    // The bundled bridge file of the dev hook: the build's path, or the default one.
    internal static string BridgeFile(string runtime, JsonObject pack)
    {
        var relative = Text(pack["o11Bridge"]?["path"]) is { } path && BridgePath.IsMatch(path) ? path : DefaultBridge;
        return Path.Combine(runtime, relative);
    }
}
