using Anvil.Core.Preflight;
using System.Text.Json.Nodes;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    // Tests and offline consumers receive only plain facts, never model objects before StudioAssemblies.Bind.
    internal IBaseFacts ActionNameFacts() => new ModelBaseFacts(this, _espace);
    internal IReadOnlyList<ActionNameFact> ActionNames() => new ModelBaseFacts(this, _espace).ActionNames();

    /// <summary>The offline naming oracle bypasses only the product's existing-action guard. The native Create method,
    /// its rename observation and every other check are exactly those of the verb. Caller must use a disposable module,
    /// run inside Mutate. The probe removes only the created action by its returned key, without traversing the module.
    /// No job/verb can enable this internal-only probe.</summary>
    internal (bool Renamed, string Actual) ProbeNativeActionName(string name, string kind = "server")
    {
        var result = CreateCore(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = ActionNameRules.Scope(kind) == "client" ? "IClientAction" : "IServerAction", ["name"] = name }, nativeNameProbe: true);
        var actual = result["name"]!.ToString();
        ApplyOne(new JsonObject { ["op"] = "delete", ["target"] = "@" + result["key"]!.ToString(), ["force"] = true });
        return (!string.Equals(name, actual, StringComparison.OrdinalIgnoreCase), actual);
    }
}
