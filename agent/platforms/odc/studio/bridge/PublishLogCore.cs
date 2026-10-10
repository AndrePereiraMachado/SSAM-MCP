using System.Text.RegularExpressions;

// The Studio-free half of publish-log: turns the rows of the ODC Studio's server messages pane (one per MessageDefinition,
// in the order the person sees them) into the log the LLM reads: type, text, element and stage of every message.
//
// Native source (ODC Studio 1.7.27, decompiled read-only): the Publish command (ServiceStudio.Presenter.Commands.Publish)
// runs a ServerProcess whose BaseEspace1CPProcess posts Deployments API v1 publish-operations and then polls
// PublishService.CheckPublish -> GET publish-operations/{key} and, once Finished/FinishedWithError, GET
// publish-operations/{key}/messages. Each OperationMessage {severity, message, additionalInfo{stepId, applicationKey}}
// becomes a MessageDefinition (PublishServiceExtensions.ToMessageDefinition keeps severity and text only) and
// ProcessOrchestrationMessageHandler hands every non-finish one to ServerProcess.AddServerMessage, which adds every
// error and warning (infos only behind a feature flag) to IServerMessagesPanePresenter. The steps (upload, compile,
// deploy) are rows of the same pane added by AddStepMessage with the PresenterMessageId OneCP_* ids, so the stage of a
// message is the last step row above it. The element is not in the native message: it is read from the quoted names
// of the text and, when the bridge can, resolved to a key in the open model.
internal static class PublishLogCore {
    // MessageType of OutSystems.RuntimeCommon, as text (flags; the pane never mixes error with warning).
    internal sealed record Row(string? Id, string Type, string? Text, string? Detail);
    internal sealed record Element(string Name, string? Key, string? Kind, string Source);
    internal sealed record Message(string Type, string Text, string? Detail, string Stage, Element? Element, string? Code);
    internal sealed record Log(string[] Stages, Message[] Messages, int Errors, int Warnings, int Infos, string? LastStage);

    public const string NoStage = "unknown";

    // error | warning | info, from the native MessageType name(s) ("Error", "Warning, DevWarn", "Info", "State"...).
    public static string TypeOf(string nativeType) {
        var t = nativeType ?? "";
        if (t.Contains("Error", StringComparison.OrdinalIgnoreCase)) return "error";
        if (t.Contains("Warn", StringComparison.OrdinalIgnoreCase)) return "warning";
        return "info";
    }

    // Rows of one pane -> the log. stepStages: native step message id -> stage (upload, compilation, deploy). resolve:
    // name -> (key, kind) of an element of the open model, or null; omitted when the model is not at hand.
    public static Log Build(IEnumerable<Row> rows, IReadOnlyDictionary<string, string> stepStages, Func<string, (string Key, string Kind)?>? resolve = null) {
        var stages = new List<string>(); var messages = new List<Message>();
        var stage = NoStage;
        foreach (var row in rows) {
            if (row.Id != null && stepStages.TryGetValue(row.Id, out var step)) {
                stage = step;
                if (!stages.Contains(step)) stages.Add(step);
                continue;
            }
            var text = (row.Text ?? "").Trim();
            var detail = string.IsNullOrWhiteSpace(row.Detail) || row.Detail!.Trim() == text ? null : row.Detail!.Trim();
            if (text.Length == 0) { if (detail == null) continue; text = detail; detail = null; }
            var type = TypeOf(row.Type);
            var element = type == "info" ? null : ElementOf(text + (detail == null ? "" : "\n" + detail), resolve);
            messages.Add(new Message(type, text, detail, stage, element, CodeOf(row.Id)));
        }
        return new Log(stages.ToArray(), messages.ToArray(), messages.Count(m => m.Type == "error"), messages.Count(m => m.Type == "warning"),
            messages.Count(m => m.Type == "info"), stages.LastOrDefault());
    }

    // A server message's id is the hash code of the deserialized message (ToMessageDefinition): not a code. A Studio
    // message id (OneCP_ConcurrentPublishing...) is kept.
    public static string? CodeOf(string? id) => string.IsNullOrWhiteSpace(id) || Regex.IsMatch(id, "^-?[0-9]+$") ? null : id;

    // Quoted identifiers of a message, in order: 'Name', "Name", ‘Name’, “Name”. Only names an element can have (no
    // spaces, at most 120 characters); Entity.Attribute stays whole and is resolved part by part.
    // No whitespace inside the quotes, so an apostrophe ("module's 'X'") never pairs with the next quote.
    private static readonly Regex Quoted = new("[‘'“\"]([^\\s‘’'“”\"]{1,120})[’'”\"]", RegexOptions.Compiled);
    private static readonly Regex Identifier = new("^[\\p{L}_][\\p{L}\\p{N}_.\\-]{0,119}$", RegexOptions.Compiled);
    public static string[] Candidates(string text) {
        var found = new List<string>();
        foreach (Match m in Quoted.Matches(text ?? "")) {
            var name = m.Groups[1].Value.TrimEnd('.', ',', ':', ';');
            if (Identifier.IsMatch(name) && !found.Contains(name)) found.Add(name);
        }
        return found.ToArray();
    }

    // The first candidate the open model knows (with its key), else the first candidate by name only.
    public static Element? ElementOf(string text, Func<string, (string Key, string Kind)?>? resolve) {
        var candidates = Candidates(text);
        if (candidates.Length == 0) return null;
        if (resolve != null)
            foreach (var name in candidates)
                foreach (var part in name.Contains('.') ? new[] { name }.Concat(name.Split('.').Reverse()) : new[] { name }) {
                    if (part.Length == 0) continue;
                    var hit = resolve(part);
                    if (hit != null) return new Element(part, hit.Value.Key, hit.Value.Kind, "model");
                }
        return new Element(candidates[0], null, null, "text");
    }

    // A one-line summary for status and refusals: state plus counts and the first error.
    public static string Summary(string state, Log log) {
        var first = log.Messages.FirstOrDefault(m => m.Type == "error");
        return state + ": " + log.Errors + " error(s), " + log.Warnings + " warning(s)" + (first == null ? "" : "; first error: " + Clip(first.Text, 200));
    }
    public static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
}
