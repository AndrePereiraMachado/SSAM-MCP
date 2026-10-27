using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12), class C18 of the refusals found only at apply (FolhaPonto_UI 13:58:43: "Nodes of type IDownloadNode
/// are not allowed in IScreenAction or eSpaces of type Mobile"): a node the module type does not have is refused before the
/// apply, with every other problem, by a table of the platform (module type, node):
/// <list type="bullet">
/// <item>IDownloadNode in a Mobile module (any action). The patch is the platform's way that delivered in the same session
/// (FolhaPonto_UI 13:59:56, the JavaScript node with the file's inputs), isolated in a named client action as the owner's
/// rules want JavaScript (L5): a client action DownloadFile(FileContent, FileName, MimeType) whose JavaScript node decodes the
/// Binary Data (a Base64 text in client logic) into a Blob and downloads it, and the Download step written as a call of it
/// with the same three expressions.</item>
/// <item>IAjaxRefreshNode outside a Traditional Web module: the Reactive and Mobile screens refresh what they bind on their
/// own (a Refresh Data node refreshes an aggregate or a data action); no patch, the fix says it.</item>
/// </list>
/// Needs the module type (the base), never the names of the base: it runs for a job that imports producers too.
/// </summary>
public static class NodeRules
{
    public const string Code = "NODE_NOT_ALLOWED";

    /// <summary>The JavaScript of the download (Binary Data reaches client JavaScript as Base64 text).</summary>
    public const string DownloadScript =
        "var binary = atob($parameters.FileContent || \"\");\n"
        + "var bytes = new Uint8Array(binary.length);\n"
        + "for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);\n"
        + "var blob = new Blob([bytes], { type: $parameters.MimeType || \"application/octet-stream\" });\n"
        + "var url = URL.createObjectURL(blob);\n"
        + "var link = document.createElement(\"a\");\n"
        + "link.href = url;\n"
        + "link.download = $parameters.FileName || \"download\";\n"
        + "document.body.appendChild(link);\n"
        + "link.click();\n"
        + "link.remove();\n"
        + "setTimeout(function () { URL.revokeObjectURL(url); }, 30000);";

    public static List<JsonObject> Check(JsonArray ops, string? prefix, JobFacts job, string? moduleType)
    {
        var problems = new List<JsonObject>();
        if (moduleType is not { Length: > 0 }) return problems;
        // ESpaceType: Mobile/MobileLibrary, CrossDevice/ReactiveLibrary (Reactive), WebResponsive/WebResponsiveLibrary (Traditional).
        var mobile = moduleType is "Mobile" or "MobileLibrary";
        var clientRuntime = moduleType is "Mobile" or "MobileLibrary" or "CrossDevice" or "ReactiveLibrary";
        if (moduleType is "WebResponsive" or "WebResponsiveLibrary")
            for (var i = 0; i < ops.Count; i++)
                if (ops[i] is JsonObject op && op["op"]?.ToString() == "set" && op["prop"]?.ToString() == "DefaultScreen"
                    && !string.IsNullOrEmpty(op["value"]?.ToString()))
                    problems.Add(JobPreflight.Problem(i, prefix == null ? null : $"{prefix}/{i}/value",
                        "TRADITIONAL_DEFAULT_SCREEN_NOT_MERGEABLE", "error",
                        "The native Traditional merge drops ESpace.DefaultScreen even when Verify accepts it.",
                        "Use the Traditional IEntry: link it to the requested Web Screen and set IsDefault=true. Preserve existing entries and select the intended entry explicitly. This is a proven merge limitation, not a diagnosis of ESpace.Dump.",
                        null, "model"));
        var taken = new HashSet<string>(job.Actions.Select(a => a.Name), StringComparer.OrdinalIgnoreCase);
        string? helper = null; var helperAdded = false;
        foreach (var action in job.Actions)
        {
            var at = prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}";
            foreach (var (step, pointer) in LogicScan.Of(action.Declaration).Steps)
            {
                var node = step["node"]?.ToString();
                if (node == "IDownloadNode" && mobile)
                {
                    helper ??= taken.Contains("DownloadFile") ? NameRules.Free("DownloadFile", taken) : "DownloadFile";
                    var patch = at == null ? null : DownloadPatch(step, at + pointer, prefix!, action.Op, helper, action.IsClientSide, !helperAdded);
                    helperAdded |= patch != null;
                    problems.Add(JobPreflight.Problem(action.Op, at == null ? null : at + pointer, Code, "error",
                        $"{action.Name} downloads a file with a Download node, and this is a Mobile module: the Studio refuses the node (\"Nodes of type IDownloadNode are not allowed in IScreenAction or eSpaces of type Mobile\")",
                        $"download it in client JavaScript, isolated in a client action: the patch adds {helper}(FileContent, FileName, MimeType) with the JavaScript node and calls it here with the same expressions",
                        patch, "logic"));
                }
                else if (node == "IAjaxRefreshNode" && clientRuntime)
                    problems.Add(JobPreflight.Problem(action.Op, at == null ? null : at + pointer, Code, "error",
                        $"{action.Name} has an Ajax Refresh node, which exists only in Traditional Web; this is a {moduleType} module",
                        "drop it: a Reactive or Mobile screen shows what its variables hold as they change; to fetch again, use a Refresh Data node on the aggregate or data action", null, "logic"));
            }
        }
        return problems;
    }

    /// <summary>motor2 review (the Download of FolhaPonto's first round: its op was skipped whole, three sets with it, and the
    /// patch went out unproven): the problems of this rule with a patch are applied to the ops as the patch writes it, for the
    /// apply and the Verify of the refused round only (the job is refused for them, nothing is saved), so the same round proves
    /// the patch and judges the rest of the op. Each patch is applied whole or not at all; what it writes is marked for
    /// <see cref="SentJob"/> (its place is the problem's pointer). The problems applied carry <c>_diagnosisPatch</c>.</summary>
    public static void ApplyForDiagnosis(JsonArray ops, IEnumerable<JsonObject> problems, string? prefix, Action<string>? log = null)
    {
        if (prefix == null) return;
        foreach (var problem in problems.Where(p => p["code"]?.ToString() == Code && p["patch"] is JsonArray { Count: > 0 }).ToList())
        {
            var origin = SentJob.ToSent(problem["pointer"]?.ToString(), ops, prefix).Pointer;
            var steps = problem["patch"]!.AsArray().OfType<JsonObject>().ToList();
            var places = steps.Select(s => Place(ops, prefix, s)).ToList();
            if (places.Any(p => p == null)) continue;
            for (var k = 0; k < steps.Count; k++)
            {
                var (holder, key) = places[k]!.Value;
                var value = steps[k]["value"]!.DeepClone();
                var replace = steps[k]["op"]?.ToString() == "replace";
                switch (holder)
                {
                    case JsonArray array when key == "-": array.Add(value); break;
                    case JsonArray array: if (replace) array[int.Parse(key)] = value; else array.Insert(int.Parse(key), value); break;
                    case JsonObject obj: obj[key] = value; break;
                }
                if (replace) SentJob.Replaced(value, origin); else SentJob.Inserted(value, origin);
            }
            problem["_diagnosisPatch"] = true;
            log?.Invoke($"  {Code} at {origin}: this round's apply runs the op as its patch writes it (never saved)");
        }
    }

    /// <summary>Where a patch step of the normalized ops writes: the array or object that holds it and the key (null when the
    /// path does not resolve, or a replace has nothing there).</summary>
    private static (JsonNode Holder, string Key)? Place(JsonArray ops, string prefix, JsonObject step)
    {
        if (step["path"]?.ToString() is not { } path || !path.StartsWith(prefix + "/", StringComparison.Ordinal) || step["value"] is null) return null;
        var segments = path[(prefix.Length + 1)..].Split('/').Select(s => s.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal)).ToArray();
        JsonNode? node = ops;
        for (var k = 0; k < segments.Length - 1 && node != null; k++)
            node = node switch
            {
                JsonObject o => o[segments[k]],
                JsonArray a when int.TryParse(segments[k], out var i) && i >= 0 && i < a.Count => a[i],
                _ => null,
            };
        var last = segments[^1];
        var replace = step["op"]?.ToString() == "replace";
        return node switch
        {
            JsonArray a when last == "-" && !replace => (a, last),
            JsonArray a when int.TryParse(last, out var i) && i >= 0 && (replace ? i < a.Count : i <= a.Count) => (a, last),
            JsonObject o when !replace || o.ContainsKey(last) => (o, last),
            _ => null,
        };
    }

    /// <summary>After the apply and the Verify of a round that ran these patches: a patch is proven when nothing of the apply
    /// failed at its place or at its op as a whole, and the Verify found nothing there (what the patch wrote is that place:
    /// <see cref="SentJob"/>). Says so on the problem (<c>patchProven</c>, and in its fix).</summary>
    public static void Proven(IEnumerable<JsonObject> problems, IEnumerable<JsonObject> applied, IEnumerable<JsonObject> verify, string? prefix)
    {
        var later = applied.Concat(verify).ToList();
        foreach (var problem in problems.Where(p => p["_diagnosisPatch"] is JsonValue))
        {
            var at = problem["pointer"]?.ToString();
            var op = problem["op"]?.ToJsonString();
            var opLevel = prefix != null && op != null ? $"{prefix}/{op}" : null;
            var found = later.Where(p => p["pointer"]?.ToString() is { } q && at != null && (q == at || q.StartsWith(at + "/", StringComparison.Ordinal) || q == opLevel && p["op"]?.ToJsonString() == op)).ToList();
            problem["patchProven"] = found.Count == 0;
            problem["fix"] = problem["fix"] + (found.Count == 0
                ? " (proven in this round: its apply ran the op as the patch writes it, and neither the apply nor the Verify found anything in it)"
                : $" (this round's apply ran the op as the patch writes it: {found.Count} problem(s) at this place come with it)");
        }
    }

    private static JsonArray? DownloadPatch(JsonObject step, string stepPointer, string prefix, int op, string helper, bool clientCaller, bool withHelper)
    {
        if (!clientCaller || step["properties"] is not JsonObject properties) return null;
        string Arg(string key) => properties[key]?.ToString() ?? "\"\"";
        var call = new JsonObject
        {
            ["call"] = helper,
            ["as"] = step["as"]?.DeepClone() ?? "DownloadFile",
            ["args"] = new JsonObject { ["FileContent"] = Arg("FileContent"), ["FileName"] = Arg("FileName"), ["MimeType"] = properties.ContainsKey("MimeType") ? Arg("MimeType") : "\"application/octet-stream\"" },
        };
        var client = new JsonObject
        {
            ["name"] = helper, ["kind"] = "client",
            ["description"] = "Downloads a file in the browser: the Download node does not exist in a Mobile module (FileContent is decoded from Base64).",
            ["inputs"] = new JsonArray(
                new JsonObject { ["name"] = "FileContent", ["type"] = "Binary Data", ["description"] = "The content of the file." },
                new JsonObject { ["name"] = "FileName", ["type"] = "Text", ["description"] = "The name the file is saved with." },
                new JsonObject { ["name"] = "MimeType", ["type"] = "Text", ["mandatory"] = false, ["description"] = "The type of the content (application/pdf, ...)." }),
            ["steps"] = new JsonArray(new JsonObject
            {
                ["node"] = "IJavaScriptNode", ["as"] = "SaveFile",
                ["properties"] = new JsonObject { ["JavaScript"] = DownloadScript },
                ["inputs"] = new JsonArray(
                    new JsonObject { ["name"] = "FileContent", ["type"] = "Binary Data" },
                    new JsonObject { ["name"] = "FileName", ["type"] = "Text" },
                    new JsonObject { ["name"] = "MimeType", ["type"] = "Text" }),
                ["args"] = new JsonObject { ["FileContent"] = "FileContent", ["FileName"] = "FileName", ["MimeType"] = "MimeType" },
            }),
        };
        var patch = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = stepPointer, ["value"] = call });
        if (withHelper) patch.Add(new JsonObject { ["op"] = "add", ["path"] = $"{prefix}/{op}/data/actions/-", ["value"] = client });
        return patch;
    }
}
