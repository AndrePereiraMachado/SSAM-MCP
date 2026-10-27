using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core.Preflight;
using Anvil.Reading;

namespace Anvil.Core.PreflightRules;

/// <summary>
/// L3c (scope-odc, 2026-10-24): the refusals the ODC apply gives on every module of a kind, decided by the job and the
/// module type alone, said by the scope phase before the first op (ScopePhase.Run, lane odc only) with the code the apply
/// would have answered in <c>predicts</c>. Measured on the real ODC deliveries of the lab and the bench a frio: each of
/// them reached the apply (verifyRan true) and was refused there, never accepted.
/// <list type="bullet">
/// <item><c>ODC_SERVER_ACTION_PUBLIC</c> (APPLY_FAILED): a server action of an ODC app made public (raw set Public, logic
/// <c>public:true</c>, the flow header <c>server action X public</c>): "ODC apps do not expose public server actions"
/// (Verbs.SetCore). Two readings (keep it private for the app's own screens, or a service action for other apps), so it is
/// refused with both, never rewritten.</item>
/// <item><c>ODC_SESSION_VARIABLE</c> (APPLY_FAILED; DDL_APPLY_FAILED in the data text): ODC has no session variable (the
/// Model API offers it, the factory refuses: "Session Variable objects can't be children of App objects"); the client
/// variable is the session state.</item>
/// <item><c>ODC_LOCALIZED_IMAGE</c> (APPLY_FAILED): a localized image is Traditional Web only ("Localized Image objects
/// can't be children of Image objects").</item>
/// <item><c>ODC_TRADITIONAL_WIDGET</c> (APPLY_FAILED): a raw create of a Traditional Web widget (IContainerWidget,
/// IExpressionWidget...) in a Reactive or Mobile module, with the patch to the widget of the module's kind (lab 110).</item>
/// <item><c>ODC_DELETE_RULE_FORCED</c>: attributes of the data text that reference the system entity User with a Delete
/// Rule written other than Ignore (the bench a frio Naval: 36 `references User on delete Protect`): ODC keeps only Ignore
/// there (Verbs.OdcExternalDeleteRules refuses it after the build); one problem for the text, one patch for every line.</item>
/// <item><c>ODC_SETTING_SIZE</c> (DDL_APPLY_FAILED): a setting of the data text with a size (`Text(250)`, `Decimal(18,2)`):
/// an ODC setting has no Length nor Decimals (labs 17 and 258); the patch drops the size.</item>
/// </list>
/// Pure over the ops and the facts (the module type; the ODC Model API for the widget kinds); a text that does not parse
/// is not judged here (its own check says it). The same lane also reads <see cref="SystemDestinations"/> in CALL_UNKNOWN
/// and moves the class of an If (IF_CLASS_MOVED, ScopePhase.Normalize): the ODC If has no Style either.
/// </summary>
internal static class OdcScopeRules
{
    public const string ServerActionPublic = "ODC_SERVER_ACTION_PUBLIC";
    public const string SessionVariable = "ODC_SESSION_VARIABLE";
    public const string LocalizedImage = "ODC_LOCALIZED_IMAGE";
    public const string DeleteRuleForced = OdcMergeNormalizationRules.DeleteRuleCode;
    public const string SettingSize = "ODC_SETTING_SIZE";
    public const string TraditionalWidget = "ODC_TRADITIONAL_WIDGET";

    /// <summary>The destinations of the System an ODC navigate reaches without the module referencing them (the apply binds
    /// the (System) element itself): `navigate RedirectToURL(URL=...)` of the accepted labs 228 and 242, which CALL_UNKNOWN
    /// refused as a screen the module does not have.</summary>
    internal static readonly IReadOnlySet<string> SystemDestinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "RedirectToURL" };

    private static readonly HashSet<string> ServerActionTypes = new(StringComparer.Ordinal) { "IServerAction", "ServerAction" };

    /// <summary>The problems of the phase on lane odc (the caller runs it only there).</summary>
    public static IEnumerable<JsonObject> Check(JsonArray ops, string? prefix, ScopeJob job, IBaseFacts facts)
    {
        var moduleType = facts.ModuleType;
        var problems = new List<JsonObject>();
        if (OdcApp(moduleType))
            problems.AddRange(PublicServerActions(ops, prefix, job));
        problems.AddRange(PlatformKinds(ops, prefix, moduleType));
        problems.AddRange(DeleteRules(ops, prefix, job));
        problems.AddRange(SettingSizes(ops, prefix));
        return problems;
    }

    /// <summary>An ODC app (not a library): the module types the ODC Studio creates as apps. A module that states no type
    /// (a synthetic one) is not judged.</summary>
    internal static bool OdcApp(string? moduleType)
        => !string.IsNullOrEmpty(moduleType) && !moduleType.Contains("Library", StringComparison.OrdinalIgnoreCase);

    private static string? Pointer(string? prefix, int op, string rest) => prefix == null ? null : $"{prefix}/{op}{rest}";

    // ---- ODC_SERVER_ACTION_PUBLIC ---------------------------------------------------------------------------------------

    private static string PublicMessage(string name) =>
        $"set Public: IServerAction '{name}' is a server action of an ODC app; ODC apps do not expose public server actions "
        + "(the live Studio raises an error the headless Verify does not)";

    private const string PublicFix = "Keep it Public No and call it from the app's own screens, use a service action to serve other apps, or move it to a library";

    private static IEnumerable<JsonObject> PublicServerActions(JsonArray ops, string? prefix, ScopeJob job)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            switch (op["op"]?.ToString())
            {
                case "set" when op["prop"]?.ToString() == "Public" && True(op["value"]) && ServerActionTarget(op["target"]?.ToString(), job, i) is { } name:
                    yield return ScopeRules.Problem(i, Pointer(prefix, i, "/value"), ServerActionPublic, "APPLY_FAILED", PublicMessage(name), PublicFix, null, "set");
                    break;
                case "logic" when op["data"] is JsonObject data:
                    if (data["actions"] is JsonArray actions)
                        for (var a = 0; a < actions.Count; a++)
                            if (actions[a] is JsonObject action && (action["kind"]?.ToString() ?? "server").Equals("server", StringComparison.OrdinalIgnoreCase) && True(action["public"]))
                                yield return ScopeRules.Problem(i, Pointer(prefix, i, $"/data/actions/{a}/public"), ServerActionPublic, "APPLY_FAILED",
                                    PublicMessage(action["name"]?.ToString() ?? "(unnamed)"), PublicFix, null, "logic");
                    foreach (var (text, at) in FlowTexts(data))
                        foreach (var name in PublicServerHeaders(text))
                            yield return ScopeRules.Problem(i, Pointer(prefix, i, at), ServerActionPublic, "APPLY_FAILED",
                                PublicMessage(name) + $" (the flow header 'server action {name} public')", PublicFix + " (drop 'public' from the header)", null, "logic");
                    break;
            }
        }
    }

    // The header of a ssam-flow/1 action: `server action <Name>[ @key][ flags]` at the start of a line.
    private static readonly Regex ServerHeader = new(@"^server action[ \t]+([A-Za-z_]\w*)([^\r\n]*)$", RegexOptions.Compiled | RegexOptions.Multiline);

    internal static IEnumerable<string> PublicServerHeaders(string text)
    {
        foreach (Match m in ServerHeader.Matches(text))
        {
            var words = m.Groups[2].Value.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
            if (words.Any(w => w == "public")) yield return m.Groups[1].Value;
        }
    }

    /// <summary>The texts of a logic op's flow form (`flow`: a text, or a list of texts and {text, basedOn}), with pointers.</summary>
    private static IEnumerable<(string Text, string At)> FlowTexts(JsonObject data)
    {
        switch (data["flow"])
        {
            case JsonValue v when v.TryGetValue<string>(out var single): yield return (single, "/data/flow"); break;
            case JsonArray list:
                for (var n = 0; n < list.Count; n++)
                {
                    if (list[n] is JsonValue item && item.TryGetValue<string>(out var text)) yield return (text, $"/data/flow/{n}");
                    else if (list[n] is JsonObject o && o["text"] is JsonValue t && t.TryGetValue<string>(out var inner)) yield return (inner, $"/data/flow/{n}/text");
                }
                break;
        }
    }

    /// <summary>The server action a `set` target names: `IServerAction:X` (its last segment) or the alias of a create of one.</summary>
    private static string? ServerActionTarget(string? target, ScopeJob job, int op)
    {
        if (string.IsNullOrEmpty(target)) return null;
        if (target.StartsWith('$') && !target.Contains('/'))
            return job.AliasAt.TryGetValue(op, out var element) && ServerActionTypes.Contains(element.Type) ? element.Name ?? target : null;
        if (target.Contains('$')) return null;
        var last = target.Split('/').Last();
        var colon = last.IndexOf(':');
        return colon > 0 && ServerActionTypes.Contains(KindNames.Normalize(last[..colon])) ? last[(colon + 1)..] : null;
    }

    // ---- ODC_SESSION_VARIABLE, ODC_LOCALIZED_IMAGE ----------------------------------------------------------------------

    private static IEnumerable<JsonObject> PlatformKinds(JsonArray ops, string? prefix, string? moduleType)
    {
        // A WebResponsive module (Traditional Web, which ODC does not publish) is the one kind that takes a session variable.
        var owner = moduleType == null || moduleType.StartsWith("WebResponsive", StringComparison.Ordinal) ? null
            : OdcApp(moduleType) ? "App" : moduleType.Contains("Library", StringComparison.OrdinalIgnoreCase) ? "Library" : null;
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var verb = op["op"]?.ToString();
            if (verb == "create")
            {
                var type = KindNames.Normalize(op["type"]?.ToString() ?? "");
                var name = op["name"]?.ToString();
                if (Reactive.Contains(moduleType ?? "") && TraditionalOnly(type) is { } traditional)
                {
                    var other = Counterpart(type);
                    var at = Pointer(prefix, i, "/type");
                    yield return ScopeRules.Problem(i, at, TraditionalWidget, "APPLY_FAILED",
                        $"create {name ?? type}: {traditional} is a Traditional Web widget; a {moduleType} module has no class for it (the apply answers \"Couldn't find any concrete class implementing {traditional}\")",
                        other != null ? $"write {other}, the same widget of this module's kind" : "create the widget of this module's kind (ssam_map lists the widgets of a screen of this module)",
                        other != null && at != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = other }) : null, "create");
                }
                else if (type is "ISessionVariable" or "SessionVariable" && owner != null)
                    yield return ScopeRules.Problem(i, Pointer(prefix, i, "/type"), SessionVariable, "APPLY_FAILED",
                        $"create {name ?? "ISessionVariable"}: Session Variable objects can't be children of {owner} objects (ODC has no session variable: the Model API offers it, the platform refuses it)",
                        "keep the session state in a client variable (create IClientVariable, or `client variable` in the data text)", null, "create");
                else if (type is "ILocalizedImage" or "LocalizedImage")
                    yield return ScopeRules.Problem(i, Pointer(prefix, i, "/type"), LocalizedImage, "APPLY_FAILED",
                        $"create {name ?? "ILocalizedImage"}: Localized Image objects can't be children of Image objects (localized images exist only in the Traditional Web runtime of O11)",
                        "keep one image (or one image per locale, chosen by an expression on the Image widget)", null, "create");
            }
            else if (verb == "spec" && owner != null && op["data"] is JsonObject data && Ddl(data) is { } document
                && document.Elements.Where(e => e.Kind == "SessionVariable" && !e.Drop).ToList() is { Count: > 0 } variables)
                yield return ScopeRules.Problem(i, Pointer(prefix, i, "/data/ddl"), SessionVariable, "DDL_APPLY_FAILED",
                    $"session variable {ScopePhase.Short(variables.Select(e => $"{e.Name} (line {e.Line})"))}: Session Variable objects can't be children of {owner} objects (ODC has no session variable)",
                    "write `client variable <Name>: <Type>` instead (the client variable is the session state of ODC)", null, "spec");
        }
    }

    // ---- ODC_TRADITIONAL_WIDGET -----------------------------------------------------------------------------------------

    /// <summary>The module types whose screens are Reactive or Mobile (every ODC app and library with a UI).</summary>
    private static readonly HashSet<string> Reactive = new(StringComparer.Ordinal) { "CrossDevice", "Mobile", "ReactiveLibrary", "MobileLibrary" };

    /// <summary>The Traditional Web interface a widget type denotes when that is all it denotes in the ODC Model API (every
    /// interface of the short name is OutSystems.Model.UI.Web.Widgets.* or the Studio's own ServiceStudio.Model.Interfaces.*,
    /// none Mobile nor NR): measured on 24/10/2026 under a screen of insurance-reactive-r8, the twelve such types
    /// (IContainerWidget, IExpressionWidget, ILinkWidget, IButtonWidget, IImageWidget, IInputWidget, ICheckBoxWidget,
    /// IComboBoxWidget, IListRecordsWidget, ITableRecordsWidget, IWebBlockInstanceWidget, IRadioButtonWidget) all answer
    /// "Couldn't find any concrete class", while ITextWidget, IIfWidget and IPlaceholderWidget (with a Mobile interface)
    /// are created. Null when the Studio is not bound (unknown: nothing is judged).</summary>
    internal static string? TraditionalOnly(string type)
    {
        if (!type.EndsWith("Widget", StringComparison.Ordinal) || ModelTypes.Of(type, "odc") is not { Interfaces.Count: > 0 } facts) return null;
        string? web = null;
        foreach (var name in facts.Interfaces)
        {
            if (name.StartsWith("OutSystems.Model.UI.Web.Widgets.", StringComparison.Ordinal)) web ??= name;
            else if (!(name.StartsWith("ServiceStudio.Model.Interfaces.", StringComparison.Ordinal) && !name.Contains('+'))) return null;
        }
        return web;
    }

    /// <summary>The widget of the same family a Reactive or Mobile module creates (the type without its Widget suffix), when
    /// the ODC Model API has it as a widget of its own.</summary>
    private static string? Counterpart(string type)
    {
        var other = type[..^"Widget".Length];
        return ModelTypes.Of(other, "odc") is { } facts && facts.Interfaces.Any(i => i.StartsWith("ServiceStudio.Plugin.NRWidgets.", StringComparison.Ordinal)) ? other : null;
    }

    // ---- ODC_DELETE_RULE_FORCED (data text) -----------------------------------------------------------------------------

    private static readonly string[] SystemEntities = ["User"];

    private static IEnumerable<JsonObject> DeleteRules(JsonArray ops, string? prefix, ScopeJob job)
    {
        // An entity the job itself declares under a system name is its own (OdcMergeNormalizationRules: the same exception).
        var declared = job.Ops.SelectMany(o => o.Declares).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (SystemEntities.Any(declared.Contains)) yield break;
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "spec" || op["data"] is not JsonObject data || Ddl(data) is not { } document) continue;
            // Only a rule the text writes: without one the kernel writes Ignore (ODC_DELETE_RULE_IGNORE), the form the lab accepted.
            var forced = new List<(DdlElement Entity, DdlElement Attribute, string Rule)>();
            foreach (var entity in document.Elements.Where(e => DdlRules.IsEntityKind(e.Kind) && !e.Drop))
                foreach (var attribute in entity.Children.Where(c => c.Kind == "EntityAttribute"))
                {
                    var referenced = attribute.References ?? IdentifierOf(attribute.Props.GetValueOrDefault("DataType"));
                    if (referenced == null || !SystemEntities.Contains(referenced.Trim(), StringComparer.OrdinalIgnoreCase)) continue;
                    if (attribute.Props.GetValueOrDefault("DeleteRule") is { } rule && !rule.Equals("Ignore", StringComparison.OrdinalIgnoreCase)) forced.Add((entity, attribute, rule));
                }
            if (forced.Count == 0) continue;
            var pointer = Pointer(prefix, i, "/data/ddl");
            var patched = IgnoreOn(data["ddl"]!.GetValue<string>(), forced.Select(f => f.Attribute.Line));
            // One problem for the op (its pointer is the text): every attribute, and one patch that writes them all Ignore.
            yield return ScopeRules.Problem(i, pointer, DeleteRuleForced, DeleteRuleForced,
                $"{forced.Count} attribute(s) of the data text reference User, an entity of the system, with a deleteRule other than Ignore: "
                + ScopePhase.Short(forced.Select(f => $"line {f.Attribute.Line} {f.Entity.Name}.{f.Attribute.Name} ({f.Rule})"))
                + "; ODC keeps only Ignore there (the Studio rewrites it at merge and the delivery would not match the candidate)",
                "write `references User on delete Ignore` on those lines (or leave the references clause out: the kernel writes Ignore)",
                patched != null && pointer != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = patched }) : null, "spec");
        }
    }

    /// <summary>The data text with `references User on delete Protect|Delete` written Ignore on these lines (1-based), or null
    /// when a line does not carry that clause as written (no certain rewrite).</summary>
    private static string? IgnoreOn(string text, IEnumerable<int> lines)
    {
        var all = text.Split('\n');
        foreach (var line in lines.Distinct())
        {
            if (line < 1 || line > all.Length) return null;
            var written = ReferenceRule.Replace(all[line - 1], m => m.Groups[1].Value + "Ignore");
            if (written == all[line - 1]) return null;
            all[line - 1] = written;
        }
        return string.Join('\n', all);
    }

    private static readonly Regex ReferenceRule = new(@"(\breferences[ \t]+User[ \t]+on[ \t]+delete[ \t]+)(?!Ignore\b)[A-Za-z]+\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // ---- ODC_SETTING_SIZE (data text) ----------------------------------------------------------------------------------

    /// <summary>`setting X: Text(250)` or `Decimal(18,2)`: an ODC setting has no Length nor Decimals (ISiteProperty writes
    /// CreatedBy, DataType, Description, Folder, IsMultiTenant, IsSecret and DefaultValue), so the compile's `set Length` is
    /// refused at apply (DDL_APPLY_FAILED, labs 17 and 258). The size says nothing the setting keeps: the patch drops it.</summary>
    private static IEnumerable<JsonObject> SettingSizes(JsonArray ops, string? prefix)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "spec" || op["data"] is not JsonObject data || Ddl(data) is not { } document) continue;
            var sized = document.Elements.Where(e => e.Kind == "SiteProperty" && !e.Drop && (e.Props.ContainsKey("Length") || e.Props.ContainsKey("Decimals"))).ToList();
            if (sized.Count == 0) continue;
            var pointer = Pointer(prefix, i, "/data/ddl");
            var patched = SizeDropped(data["ddl"]!.GetValue<string>(), sized.Select(e => e.Line));
            yield return ScopeRules.Problem(i, pointer, SettingSize, "DDL_APPLY_FAILED",
                $"{sized.Count} setting(s) of the data text write a size: "
                + ScopePhase.Short(sized.Select(e => $"line {e.Line} {e.Name} ({(e.Props.GetValueOrDefault("Length") is { } length ? "Length " + length : "Decimals " + e.Props["Decimals"])})"))
                + "; an ODC setting has no Length or Decimals (the apply answers 'ISiteProperty has no writable property or setter Length')",
                "write the type of those settings without its size (Text, Decimal): the setting keeps no size",
                patched != null && pointer != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = patched }) : null, "spec");
        }
    }

    // The type of a setting line with its size: `: Text(250)`, `: Decimal(18,2)`.
    private static readonly Regex SizedType = new(@"(:[ \t]*[A-Za-z][A-Za-z ]*?)[ \t]*\([ \t]*\d+[ \t]*(?:,[ \t]*\d+[ \t]*)?\)", RegexOptions.Compiled);

    private static string? SizeDropped(string text, IEnumerable<int> lines)
    {
        var all = text.Split('\n');
        foreach (var line in lines.Distinct())
        {
            if (line < 1 || line > all.Length) return null;
            var written = SizedType.Replace(all[line - 1], m => m.Groups[1].Value, 1);
            if (written == all[line - 1]) return null;
            all[line - 1] = written;
        }
        return string.Join('\n', all);
    }

    private static string? IdentifierOf(string? dataType)
    {
        if (dataType == null) return null;
        var trimmed = Regex.Replace(dataType.Trim(), @"\s+", " ");
        return trimmed.EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase) ? trimmed[..^" Identifier".Length] : null;
    }

    private static DdlDocument? Ddl(JsonObject data)
    {
        if (data["ddl"] is not JsonValue v || !v.TryGetValue<string>(out var text) || text.Trim().Length == 0) return null;
        try { return DdlParser.Parse(text, "odc"); } catch { return null; }
    }

    private static bool True(JsonNode? node) => node is JsonValue v && (v.TryGetValue<bool>(out var b) ? b : v.TryGetValue<string>(out var s) && s.Trim().Equals("true", StringComparison.OrdinalIgnoreCase));
}
