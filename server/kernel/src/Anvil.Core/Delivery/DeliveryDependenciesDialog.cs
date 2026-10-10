using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// MB2 (owner rule 2026-10-07): the Service Studio dialog "Incompatible or missing dependencies found" never stops a
/// delivery. Every open_module of the delivery (open, active-module, verify) asks the bridge to answer it
/// (answer_dependencies:true); a bridge with dialogs:dependencies_auto closes it as Cancel and lists it in
/// dependenciesDialog.answered, and the delivery then runs the Studio's own Refresh References for ALL producers of the
/// module (refresh_references {module_key}, no UI) and goes on. referencesRefreshed in the receipt lists each answered
/// dialog and what was refreshed. A refresh that fails stops the delivery with REFERENCES_REFRESH_FAILED, the module and
/// the next call; nothing was merged when it happens before the merge. A bridge without the capability ignores the
/// parameter: the open stops at the dialog with blockedBy, as before.
/// </summary>
public static partial class Delivery
{
    /// <summary>The bridge capability (Anvil.Bridge DialogScope.DependenciesCapability).</summary>
    public const string DependenciesAutoCapability = "dialogs:dependencies_auto";
    public const string ReferencesRefreshFailedCode = "REFERENCES_REFRESH_FAILED";

    /// <summary>The open_module parameters of a delivery: the dependencies dialog is the bridge's to answer.</summary>
    internal static JsonObject AnsweringDependencies(JsonObject parameters)
    {
        parameters["answer_dependencies"] = true;
        return parameters;
    }

    /// <summary>The dependencies dialogs the bridge answered in this open_module, or null.</summary>
    internal static JsonArray? AnsweredDependencies(JsonObject? opened) =>
        opened?["dependenciesDialog"]?["answered"] is JsonArray { Count: > 0 } answered ? answered : null;

    /// <summary>After the bridge answered the dependencies dialog: Refresh References of every producer of the module, by its
    /// key (the tab may be in the Studio's second window). Records the entry in result.referencesRefreshed; on failure sets
    /// code REFERENCES_REFRESH_FAILED and referencesRefreshFailed {module, moduleKey, error, next} and returns the error text.</summary>
    internal static string? RefreshAfterDependencies(IBridgeClient bridge, JsonObject result, string stage, JsonArray answered,
        string module, string key, string? environment, Action<string>? log)
    {
        var parameters = new JsonObject { ["module_key"] = key, ["timeout"] = 600, ["answer_dependencies"] = true };
        if (environment != null) parameters["environment"] = environment;
        JsonObject refreshed;
        try { refreshed = bridge.Call("refresh_references", parameters); }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            var text = Errors.Text(ex);
            result["code"] = ReferencesRefreshFailedCode;
            result["referencesRefreshFailed"] = new JsonObject { ["stage"] = stage, ["module"] = module, ["moduleKey"] = key,
                ["dialog"] = answered.DeepClone(), ["error"] = text, ["next"] = RefreshNext(module) };
            return "The Studio showed the dependencies dialog for " + module + " (answered: Cancel) and the Refresh References of its producers failed: "
                + text + ". Next call: o11_studio {command:\"refresh-references\", args:{module:\"" + module + "\"}}, then resume this task.";
        }
        var entry = new JsonObject
        {
            ["stage"] = stage, ["module"] = module, ["moduleKey"] = key, ["dialog"] = answered.DeepClone(),
            ["changed"] = refreshed["changed"]?.DeepClone(), ["refreshed"] = refreshed["refreshed"]?.DeepClone() ?? new JsonArray(),
            ["upToDate"] = refreshed["upToDate"]?.DeepClone() ?? new JsonArray(),
        };
        if (refreshed["newErrors"] is { } newErrors) entry["newErrors"] = newErrors.DeepClone();
        if (result["referencesRefreshed"] is JsonArray list) list.Add(entry);
        else result["referencesRefreshed"] = new JsonArray(entry);
        log?.Invoke($"deliver: dependencies dialog answered (Cancel) at {stage}; refresh_references of every producer changed={refreshed["changed"]}");
        return null;
    }

    private static JsonObject RefreshNext(string module) => new()
    {
        ["tool"] = "o11_studio", ["arguments"] = new JsonObject { ["command"] = "refresh-references", ["args"] = new JsonObject { ["module"] = module } },
        ["why"] = "o Refresh References do próprio Studio para os produtores do módulo; depois retome a entrega",
    };
}
