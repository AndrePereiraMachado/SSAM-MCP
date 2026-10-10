using System.Text.Json.Nodes;

namespace Anvil.Xif;

/// <summary>The refusal of an Integration Studio installation that lacks what the engine needs (net8 side; the engine
/// answers the same shape from its own process).</summary>
public static class XifEngineCheck
{
    public const string Fix = "Install or repair Integration Studio 11 (the one of this environment's platform), or point ANVIL_INTEGRATION_STUDIO_DIR at its folder; nothing was generated or sent.";

    public static void Require(Func<string, Type?> resolve, IReadOnlyList<string> searched)
    {
        var missing = XifEngineProbe.Missing(resolve);
        if (missing.Count == 0) return;
        throw Refusal(missing, searched);
    }

    public static XifRefusal Refusal(IReadOnlyList<string> missing, IReadOnlyList<string> searched) =>
        new(XifCodes.EngineUnavailable, $"The installed Integration Studio lacks {missing.Count} member(s) the engine needs: {string.Join(", ", missing.Take(8))}{(missing.Count > 8 ? ", ..." : "")}.",
            missing.Select(m => new XifProblem(XifCodes.EngineUnavailable, m, $"Integration Studio has no {m}.", Fix)).ToList(),
            new JsonObject
            {
                ["missing"] = new JsonArray(missing.Select(m => (JsonNode)JsonValue.Create(m)!).ToArray()),
                ["searched"] = new JsonArray(searched.Select(s => (JsonNode)JsonValue.Create(s)!).ToArray()),
            });
}
