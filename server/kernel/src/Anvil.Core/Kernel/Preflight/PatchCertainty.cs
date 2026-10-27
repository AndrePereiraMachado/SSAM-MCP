using System.Collections.ObjectModel;
using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>Patch verification proves validity; these rules separately decide whether the author has a choice.</summary>
public static class PatchCertainty
{
    public sealed record Rule(bool Certain, string Reason);
    public static IReadOnlyDictionary<string, Rule> Rules { get; } = new ReadOnlyDictionary<string, Rule>(new Dictionary<string, Rule>(StringComparer.Ordinal) {
        ["TEXT_LITERAL_QUOTED"] = new(true, "Conservative prose recognition excludes expressions; quoting preserves exactly the text written. Accepted limit: a word one letter from a name of the module or its references that neither the job nor the page declares still reads as prose."),
        ["TEXT_LITERAL_CHOICE"] = new(false, "The text contains a name in expression scope, a word one letter from a name the job or the page declares, a code shape, a malformed expression or another language marker, or the job could not be read; quoting it would choose between code and prose."),
        ["REQUIRED_ARGUMENT_DEFAULT"] = new(true, "The input declares this default; passing it preserves the action's declared behavior."),
        ["REQUIRED_ARGUMENT_TYPE_DEFAULT"] = new(false, "The mandatory input has no declared default; a type default guesses the intended behavior."),
        ["BUILTIN_FUNCTION_RENAMED"] = new(true, "A documented rename of this built-in keeps its declared arguments; no action in scope has the written name."),
        ["BUILTIN_FUNCTION_NEAREST"] = new(false, "Edit distance suggests a spelling, but does not prove which operation the author intended."),
        ["BUILTIN_FUNCTION_SHADOWED"] = new(false, "An action in scope has the written or target name; the author must choose between that action and a built-in call."),
        ["ACTION_RENAMED_FREE_NAME"] = new(false, "The author chooses the free name; a public action's name is its API."),
        ["NEAREST_NAME"] = new(false, "A nearby spelling is a suggestion, not proof of the intended name."),
        ["LIST_ITEM_QUALIFIED"] = new(false, "Qualifying a list item uses a name or stem heuristic and requires the author's choice."),
        ["FLOW_TEXT_READING"] = new(false, "The flow has two possible readings; the author chooses whether the branch continues or ends."),
        ["OWNER_RULE_REWRITE"] = new(false, "A structural rewrite to satisfy an owner's rule requires the author's choice."),
        ["CREATE_USES_EXISTING"] = new(false, "The parent already has an element of this type and name, so the create never keeps its name; the patch uses that element, and the later ops of the job then write into it: the author chooses between that and another name."),
        ["DELETE_RECONNECTS"] = new(false, "The node has exactly one exit and only the connectors of its own flow reach it, so reconnect:true removes the step and keeps the flow whole; a delete is the author's own decision, so the patch is offered and never applied for them."),
        ["SECURITY_ACCEPTANCE"] = new(false, "Accepting a security warning as it is is the user's decision: replace why with the user's own words, or apply the fix the problem names instead."),
    });
    public const string UnknownReason = "The patch has no recognized certainty rule; the author must choose the correction.";

    public static bool IsCertain(JsonObject problem)
    {
        if (problem["patch"] is not JsonArray { Count: > 0 } || problem["candidates"] is JsonArray { Count: > 0 }) return false;
        if (!Rules.TryGetValue(problem["patchRule"]?.ToString() ?? "", out var own) || !own.Certain) return false;
        return problem["patchRules"] is not JsonArray members || members.Count > 0 && members.All(m => Rules.TryGetValue(m?.ToString() ?? "", out var rule) && rule.Certain);
    }

    public static string Reason(JsonObject problem)
    {
        if (problem["patchRules"] is JsonArray members)
            foreach (var member in members) {
                if (!Rules.TryGetValue(member?.ToString() ?? "", out var rule)) return UnknownReason;
                if (!rule.Certain) return rule.Reason;
            }
        return Rules.TryGetValue(problem["patchRule"]?.ToString() ?? "", out var own) ? own.Reason : UnknownReason;
    }

    public static void Publish(JsonObject problem)
    {
        if (problem["patchRule"]?.ToString() == "TEXT_LITERAL_QUOTED" && problem["patchRules"] is JsonArray members
            && members.Any(m => !Rules.TryGetValue(m?.ToString() ?? "", out var member) || !member.Certain))
            problem["patchRule"] = "TEXT_LITERAL_CHOICE";
        var certain = IsCertain(problem);
        problem["patchCertain"] = certain;
        if (certain) problem.Remove("patchChoice"); else problem["patchChoice"] = Reason(problem);
    }

    /// <summary>Every rule involved in a whole-source patch, including unclassified members.</summary>
    public static JsonArray Members(IEnumerable<JsonObject> problems) => new(problems.SelectMany(p => p["patchRules"] is JsonArray rules
        ? rules.Select(r => r?.ToString() ?? "") : new[] { p["patchRule"]?.ToString() ?? "" }).Distinct(StringComparer.Ordinal).Select(r => (JsonNode)JsonValue.Create(r)!).ToArray());
}
