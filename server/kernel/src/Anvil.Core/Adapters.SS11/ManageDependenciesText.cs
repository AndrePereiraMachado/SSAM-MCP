using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// servidor/fase4-26 a8 round 2 (review C:\t\revisoes\agent-pack-next\REVISAO.md, IP option D): the explanation and the fix of
/// each problem of the Studio's Manage Dependencies, written on the server. The thin bridge of the agent pack answers a
/// problem with its cause and its facts (producer, key, element; facts: where, count, after, published, kind), a neutral
/// message and a neutral fix, so no product text of the Manage Dependencies is compiled into the pack; the hosted kernel
/// renders the texts where the bridge's answer arrives (ThinBridge.Call) and the facade does the same for o11_studio
/// (platforms/odc/facade/manage-dependencies-text.mjs, the same table, kept equal by hosted-a8-agent.test.mjs). The
/// sentences are the ones ManageDependencies.Apply writes for the owner's full bridge. studio-dialog (review M1): a dialog the
/// Studio opened during the command, which the thin bridge closed so the command does not wait in the Studio.
/// Placeholders: {producer}, {element} (the name of the element spec, after "Type:"), {elements} (the names of a list of
/// specs), {title} (the element as it is: a dialog's title), {module}, {count}, {after}, {published}.
/// </summary>
public static class ManageDependenciesText
{
    public static readonly IReadOnlyDictionary<string, (string Message, string Fix)> Templates = new Dictionary<string, (string Message, string Fix)>(StringComparer.Ordinal)
    {
        ["catalog-unavailable"] = ("The Studio could not read the referenceable producers of {module} from its environment.", "check that the Studio is signed in to the module's environment (o11_studio status), then deliver the same job again"),
        ["not-referenceable:environment"] = ("{producer} is not a referenceable producer of the module's environment.", "check that {producer} is published and referenceable in this environment (o11_environment referenceable), then deliver the same job again"),
        ["not-referenceable:catalog"] = ("The Studio's catalog has no published signature of {producer}.", "check that {producer} is published and referenceable in this environment (o11_environment referenceable), then deliver the same job again"),
        ["signature-unavailable"] = ("The published signature of {producer} could not be loaded by the Studio.", "publish {producer} again (its published signature does not load), then deliver the same job again"),
        ["not-in-signature"] = ("{element} is not in the published signature of {producer}.", "publish {producer} with {element} public, then deliver the same job again (o11_dependencies list shows what {producer} publishes)"),
        ["ambiguous"] = ("{element} names {count} elements of {producer}.", "name it by its original key, Type:@<key> (o11_dependencies list shows the keys of {producer}), then deliver again"),
        ["not-allowed"] = ("The Studio does not let {module} reference {element} of {producer} in this module kind.", "use {element} through a form this module may reference (for a server entity in a UI module, a service or server action of {producer}), then deliver again"),
        ["not-retained"] = ("The Studio's Manage Dependencies did not keep {elements} of {producer} in {module}.", "an SSAM defect (reported); nothing was applied (the command rolled back): deliver the same job again once the bridge is updated"),
        ["not-at-published"] = ("The Studio kept {producer} at {after}; its published signature is {published}.", "an SSAM defect (reported); nothing was applied (the command rolled back)"),
        ["studio-dialog"] = ("A Studio dialog opened during the Manage Dependencies of {module}: \"{title}\". The bridge closed it (Cancel, the window's X) so the command does not wait in the Studio; nothing was applied.", "answer what the Studio asks first (for a sign-in: sign in to the module's environment in the Studio; o11_studio status shows it), then repeat the same call"),
    };

    /// <summary>The answer with the server's message and fix on every problem whose cause it knows (the facts stay); a problem
    /// of another cause keeps the bridge's texts. The same object, changed in place; no problems, nothing changes.</summary>
    public static JsonObject Render(JsonObject answer)
    {
        if (answer["problems"] is not JsonArray problems) return answer;
        var module = answer["module"]?.ToString() ?? "the module";
        foreach (var problem in problems.OfType<JsonObject>())
            if (Explain(problem, module) is { } said) { problem["message"] = said.Message; problem["fix"] = said.Fix; }
        return answer;
    }

    /// <summary>The message and the fix of one problem, or null for a cause this table does not know.</summary>
    public static (string Message, string Fix)? Explain(JsonObject problem, string module)
    {
        var cause = problem["cause"]?.ToString();
        if (cause == null) return null;
        var facts = problem["facts"] as JsonObject;
        var where = facts?["where"]?.ToString();
        if (!Templates.TryGetValue(where != null ? cause + ":" + where : cause, out var template) && !Templates.TryGetValue(cause, out template)) return null;
        var element = problem["element"]?.ToString();
        string Fill(string text) => text
            .Replace("{producer}", problem["producer"]?.ToString() ?? problem["key"]?.ToString() ?? "?", StringComparison.Ordinal)
            .Replace("{elements}", element == null ? "?" : string.Join(", ", element.Split(", ").Select(Name)), StringComparison.Ordinal)
            .Replace("{element}", element == null ? "?" : Name(element), StringComparison.Ordinal)
            .Replace("{title}", element ?? "?", StringComparison.Ordinal)
            .Replace("{module}", module, StringComparison.Ordinal)
            .Replace("{count}", facts?["count"]?.ToString() ?? "?", StringComparison.Ordinal)
            .Replace("{after}", facts?["after"]?.ToString() ?? "?", StringComparison.Ordinal)
            .Replace("{published}", facts?["published"]?.ToString() ?? "?", StringComparison.Ordinal);
        return (Fill(template.Message), Fill(template.Fix));
    }

    /// <summary>The name of an element spec: the part after "Type:" (as ManageDependencies.ElementName).</summary>
    private static string Name(string spec)
    {
        var colon = spec.IndexOf(':');
        return colon > 0 ? spec[(colon + 1)..] : spec;
    }
}
