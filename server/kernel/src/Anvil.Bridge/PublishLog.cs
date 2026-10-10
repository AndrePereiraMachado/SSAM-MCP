using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.RuntimeCommon;

namespace Anvil.Bridge;

/// <summary>
/// Pure projection of the result of one 1-Click Publish as the Service Studio shows it in its server messages pane
/// (PublishLogHandler reads the pane; this file has no Studio type besides MessageDefinition, so the tests build the
/// same native rows). Each row is the MessageDefinition the Studio put in the pane: the server's compilation/deployment
/// messages (ProcessOrchestrationMessageHandler -> ServerProcess.AddServerMessage) and the step lines of
/// ServerProcess.AddStep (OneCP_Save/Upload/Compile/NRCompile/Publish/PublishWithoutDeploy). A step line opens a stage;
/// every other row belongs to the stage open when it arrived ("prepare" before the first step).
/// </summary>
internal static class PublishLog
{
    internal const string Prepare = "prepare", Save = "save", Upload = "upload", Compile = "compile", Deploy = "deploy";

    /// <summary>One row of the pane: the native message and the time the pane shows for it (Message.DateTime).</summary>
    internal sealed record Row(MessageDefinition Definition, string? ShownAt);

    /// <summary>One server operation of the pane. State/InnerState/OperationType are the names of the native enums
    /// (ServerOperationState, ServerOperationInnerState, ServerOperationType); null when the pane has no process.</summary>
    internal sealed record Operation(int ServerOperationId, string? OperationType, string? State, string? InnerState,
        string? Module, string? ModuleKey, string? Environment, string? LastUploadDateTime, string? TriggeredBy, IReadOnlyList<Row> Rows);

    internal static string? StageOfInner(string? inner) => inner switch
    {
        "Uploading" => Upload, "Compiling" => Compile, "Deploying" => Deploy, _ => null,
    };

    internal static string Status(string? state, bool hasErrors) => state switch
    {
        "Running" => "running",
        "CompletedWithSuccessNotOpenedInBrowser" or "CompletedWithSuccessOpenedInBrowserOrClosed" => "succeeded",
        "CompletedWithFailure" => "failed",
        _ => hasErrors ? "failed" : "unknown",
    };

    /// <summary>Error, Warning (DevWarn included), Info, Ok or Question; the flags of MessageType otherwise.</summary>
    internal static string TypeOf(MessageType type)
    {
        if (type.HasFlag(MessageType.Error)) return "Error";
        if (type.HasFlag(MessageType.Warning) || type.HasFlag(MessageType.DevWarn)) return "Warning";
        if (type.HasFlag(MessageType.Info)) return "Info";
        if (type.HasFlag(MessageType.Ok)) return "Ok";
        if (type.HasFlag(MessageType.Question)) return "Question";
        return type.ToString();
    }

    private static readonly Regex Quoted = new("'([^'\\r\\n]{1,120})'|\"([^\"\\r\\n]{1,120})\"|‘([^’\\r\\n]{1,120})’|“([^”\\r\\n]{1,120})”", RegexOptions.Compiled);
    private static readonly Regex Identifier = new(@"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$", RegexOptions.Compiled);
    private static readonly Regex KeyText = new(@"^[A-Za-z0-9+/=*_\-]{8,}$", RegexOptions.Compiled);

    /// <summary>Names a message quotes ('Horse', "GetMatches"), identifiers only, in order, at most 5.</summary>
    internal static IReadOnlyList<string> QuotedNames(params string?[] texts)
    {
        var names = new List<string>();
        foreach (var text in texts)
        {
            if (string.IsNullOrEmpty(text)) continue;
            foreach (Match m in Quoted.Matches(text))
            {
                var value = (m.Groups[1].Success ? m.Groups[1] : m.Groups[2].Success ? m.Groups[2] : m.Groups[3].Success ? m.Groups[3] : m.Groups[4]).Value.Trim();
                if (Identifier.IsMatch(value) && !names.Contains(value, StringComparer.OrdinalIgnoreCase)) names.Add(value);
                if (names.Count == 5) return names;
            }
        }
        return names;
    }

    /// <summary>The element a message names in ExtraInfo as "Name;Key" (the Studio's own form for a module to open).</summary>
    internal static JsonObject? ElementFromExtraInfo(string? extraInfo)
    {
        if (string.IsNullOrWhiteSpace(extraInfo)) return null;
        var parts = extraInfo.Split(';');
        if (parts.Length != 2 || parts[0].Trim().Length == 0 || !KeyText.IsMatch(parts[1].Trim())) return null;
        return new JsonObject { ["name"] = parts[0].Trim(), ["key"] = parts[1].Trim(), ["source"] = "extraInfo" };
    }

    private static string Clip(string? text, int max)
    {
        var t = (text ?? "").Replace("\r\n", "\n").Trim();
        return t.Length <= max ? t : t[..max] + "...";
    }

    /// <summary>
    /// The answer of publish_log for one operation. stepStages: native step message ids -> stage (resolved by the handler
    /// from PresenterMessageId). resolve(name): the module element a quoted name denotes, or null. Errors are never cut;
    /// warnings and the other rows fill up to max.
    /// </summary>
    internal static JsonObject Project(Operation op, IReadOnlyDictionary<string, string> stepStages, int max, Func<string, JsonObject?>? resolve = null)
    {
        var stage = Prepare;
        var steps = new JsonArray();
        var rows = new List<(JsonObject Json, string Type, string Stage)>();
        foreach (var row in op.Rows)
        {
            var d = row.Definition;
            var id = d.Id ?? "";
            var isStep = stepStages.TryGetValue(id, out var opened) || d.Type.HasFlag(MessageType.StepX) || d.Type.HasFlag(MessageType.StepSub);
            if (isStep)
            {
                if (opened != null) stage = opened;
                steps.Add(new JsonObject { ["stage"] = stage, ["text"] = Clip(d.Message, 300), ["shownAt"] = row.ShownAt });
                continue;
            }
            var type = TypeOf(d.Type);
            var json = new JsonObject { ["type"] = type, ["stage"] = stage, ["text"] = Clip(d.Message, 1000) };
            if (!string.IsNullOrWhiteSpace(d.Detail) && Clip(d.Detail, 4000) != json["text"]!.GetValue<string>()) json["detail"] = Clip(d.Detail, 4000);
            if (!string.IsNullOrEmpty(id)) json["id"] = id;
            if (row.ShownAt != null) json["shownAt"] = row.ShownAt;
            var element = ElementFromExtraInfo(d.ExtraInfo);
            if (element == null && resolve != null && type is "Error" or "Warning")
                foreach (var name in QuotedNames(d.Message, d.Detail))
                    if ((element = resolve(name)) != null) break;
            if (element != null) json["element"] = element;
            else if (!string.IsNullOrWhiteSpace(d.ExtraInfo)) json["extraInfo"] = Clip(d.ExtraInfo, 300);
            rows.Add((json, type, stage));
        }

        var errors = rows.Count(r => r.Type == "Error");
        var warnings = rows.Count(r => r.Type == "Warning");
        var room = Math.Max(0, max - errors);
        var kept = new HashSet<int>(rows.Select((r, i) => (r, i)).Where(x => x.r.Type == "Error").Select(x => x.i));
        foreach (var i in rows.Select((r, i) => (r, i)).Where(x => x.r.Type == "Warning").Select(x => x.i).Take(room)) kept.Add(i);
        room = Math.Max(0, max - kept.Count);
        foreach (var i in rows.Select((r, i) => (r, i)).Where(x => x.r.Type is not ("Error" or "Warning")).Select(x => x.i).Take(room)) kept.Add(i);
        var messages = new JsonArray(rows.Select((r, i) => (r, i)).Where(x => kept.Contains(x.i)).Select(x => (JsonNode)x.r.Json).ToArray());

        var status = Status(op.State, errors > 0);
        var firstError = rows.FirstOrDefault(r => r.Type == "Error");
        var result = new JsonObject
        {
            ["found"] = true, ["module"] = op.Module, ["moduleKey"] = op.ModuleKey, ["environment"] = op.Environment,
            ["serverOperationId"] = op.ServerOperationId, ["operation"] = op.OperationType, ["status"] = status, ["state"] = op.State,
            ["stage"] = StageOfInner(op.InnerState) ?? (steps.Count > 0 ? stage : null),
        };
        if (status == "failed") result["failedStage"] = firstError.Json != null ? firstError.Stage : StageOfInner(op.InnerState) ?? stage;
        result["startedAt"] = op.Rows.FirstOrDefault()?.ShownAt;
        result["endedAt"] = status == "running" ? null : op.Rows.LastOrDefault()?.ShownAt;
        result["lastUploadDateTime"] = op.LastUploadDateTime;
        result["triggeredBy"] = op.TriggeredBy;
        result["errors"] = errors;
        result["warnings"] = warnings;
        result["steps"] = steps;
        result["messages"] = messages;
        result["omitted"] = rows.Count - kept.Count;
        return result;
    }

    /// <summary>The answer when the module has no publication pane to read.</summary>
    internal static JsonObject NotFound(string? module, string? moduleKey, string? environment, string reason) => new()
    {
        ["found"] = false, ["module"] = module, ["moduleKey"] = moduleKey, ["environment"] = environment, ["reason"] = reason,
    };
}
