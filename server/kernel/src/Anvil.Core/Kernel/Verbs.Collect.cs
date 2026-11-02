using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// A02 item 6: the apply that collects every failure. ModelSession.Apply keeps going after a failing op, skips what depends
/// on it and refuses once at the end; this file holds the bookkeeping (what a failed op would have created, which later op
/// uses it) and the refusal (the problems of every failure, phase "apply", I6).
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>One failed op. <paramref name="Problems"/>: the problems already mapped to the job (primeira-certa A6: the
    /// actions of a logic op that failed alone, with their pointers in the op as the job wrote it).</summary>
    private sealed record ApplyFailure(int Op, string Kind, JsonObject Source, Exception Error, List<JsonObject>? Problems = null);

    /// <summary>The aliases and names a failed (or skipped) op would have created. A later op that writes one of them, as a
    /// reference or as a word of any of its texts, depends on it and is skipped instead of failing again.</summary>
    private sealed class Blocked
    {
        private static readonly Regex Word = new(@"[\p{L}_][\p{L}\p{N}_]*", RegexOptions.Compiled);
        private readonly Dictionary<string, int> _aliases = new(StringComparer.Ordinal);
        private readonly Dictionary<string, int> _names = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, (string Owner, string Name, int Origin)> _scopedNames = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<(int Origin, string Text)> _texts = [];
        // R2-B (review A2): the part of the job that declares each blocked name, alias or Owner.Name (the text in data/flow/<i>,
        // the action in data/actions/<j>, the data text, the document, the op): what a skip waits for is that part's problem.
        private readonly Dictionary<string, string> _at = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>The pointer of the job's ops (the parts' pointers are under it); null: no pointers are kept.</summary>
        public string? OpsPointer { get; init; }

        /// <summary>The pointer of the part that declares a name UsedBy returned, or null.</summary>
        public string? PointerOf(string name) => _at.TryGetValue(name, out var at) ? at : null;

        private string? OpAt(int origin) => OpsPointer == null ? null : $"{OpsPointer}/{origin}";

        private void At(string key, string? at) { if (at != null) _at.TryAdd(key, at); }

        /// <summary>The failed op (or the failed op behind a skipped one) whose JSON writes this name as a word: an html
        /// fragment, a screen or a spec creates names no alias announces.</summary>
        public int? Mentioned(string name)
        {
            if (_names.TryGetValue(name, out var named)) return named;
            foreach (var (_, scoped) in _scopedNames)
                if (name.Equals(scoped.Owner + "." + scoped.Name, StringComparison.OrdinalIgnoreCase)) return scoped.Origin;
            var word = new Regex(@"(?<![\p{L}\p{N}_])" + Regex.Escape(name) + @"(?![\p{L}\p{N}_])", RegexOptions.IgnoreCase);
            foreach (var (origin, text) in _texts) if (word.IsMatch(text)) return origin;
            return null;
        }

        /// <summary>The name an apply failure could not find: an unresolved Type:Name, a missing child, a missing reference.</summary>
        public static string? MissingName(Exception error, string message)
        {
            if (Errors.FindUnresolved(error) is { } unresolved && unresolved.Name.Length > 0) return unresolved.Name;
            var type = Regex.Match(message, @"unknown type\s*:?\s*['""\[]?([\p{L}_][\p{L}\p{N}_]*)", RegexOptions.IgnoreCase);
            if (type.Success) return type.Groups[1].Value;
            var child = Regex.Match(message, @"has no child '(?:I[A-Za-z0-9_]*:)?([^'/]+)'");
            if (child.Success) return child.Groups[1].Value.Trim();
            var reference = Regex.Match(message, @"reference not found: (?:I[A-Za-z0-9_]*:)?([\p{L}\p{N}_]+)");
            if (reference.Success) return reference.Groups[1].Value;
            var named = Regex.Match(message, @"no I[A-Za-z0-9_]* named ([\p{L}\p{N}_]+)");
            return named.Success ? named.Groups[1].Value : null;
        }

        /// <summary>Blocks what <paramref name="op"/> declares, for the failure of op <paramref name="origin"/>; <paramref name="at"/>:
        /// the part that failed when it is not the op itself (an op skipped for a failed one keeps that one's part).</summary>
        public void Mark(JsonObject op, int origin) => MarkAt(op, origin, null);

        public void MarkAt(JsonObject op, int origin, string? at)
        {
            var kind = op["op"]?.ToString();
            if (kind == "html" && ScreenDocument.IsDocumentOp(op)) {
                MarkDocument(op["data"]!.AsObject(), origin, at ?? (OpAt(origin) is { } documentAt ? documentAt + "/data/html" : null));
                return;
            }
            if (kind == "logic") {
                var actions = op["data"]?["actions"] as JsonArray ?? new JsonArray();
                for (var j = 0; j < actions.Count; j++)
                    if (actions[j] is JsonObject action && action["name"]?.ToString() is { Length: > 0 } actionName)
                        MarkName(actionName, action["owner"]?.ToString() ?? "", origin, at ?? (OpAt(origin) is { } actionAt ? $"{actionAt}/data/actions/{j}" : null));
                if (op["data"] is JsonObject flowData && flowData["flow"] != null) {
                    try { foreach (var text in FlowTextForm.Texts(flowData)) MarkFlowAt(text.Text, origin, at ?? (OpAt(origin) is { } textAt ? textAt + "/data" + text.Pointer : null)); }
                    catch (KernelRefusalException) { /* The invalid container is already the primary refusal. */ }
                }
                return;
            }
            // H13: an html page op names exactly the widgets its compiler creates (data-av keys, ids of elements without one, the
            // screen and its variables): those names, never every word of its JSON (the 2026-10-10 session read "it uses
            // FvAvailable of failed op #202" while the page form did not name widgets by id). The fragment form names its
            // widgets by their ids, which its text carries.
            if (kind == "html" && op["parent"] == null && op["data"] is JsonObject page && page["components"] == null && !Anvil.Reading.ScreenHtmlEdit.IsEdit(op) && !ScreenDocument.IsDocumentOp(op))
            {
                foreach (var createdName in HtmlExpander.CreatedNames(page)) MarkName(createdName, "", origin, at ?? OpAt(origin));
                return;
            }
            var part = at ?? (kind == "spec" && op["data"]?["ddl"] is JsonValue && OpAt(origin) is { } ddlAt ? ddlAt + "/data/ddl" : OpAt(origin));
            // The op's own texts, unescaped: ToJsonString escapes the quote of id="Pa2Botao" as a backslash-u0022 sequence, whose
            // digits glued to the name hid every widget an html fragment names (the Cardapio UI replay: 92 REFERENCE_UNRESOLVED
            // behind one failure).
            _texts.Add((origin, string.Join("\n", Texts(op))));
            if (op["as"]?.ToString() is { Length: > 0 } alias) { _aliases.TryAdd(alias, origin); At(alias, part); }
            if (kind is "create" or "rename" && op["name"]?.ToString() is { Length: > 0 } name) { _names.TryAdd(name, origin); At(name, part); }
            if (kind == "spec")
            {
                foreach (var section in new[] { "entities", "clientEntities", "static", "structures" })
                    foreach (var record in (SpecExpander.Sections(op["data"] as JsonObject)[section] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                        if (record["name"]?.ToString() is { Length: > 0 } recordName)
                        { _names.TryAdd(recordName, origin); _aliases.TryAdd("$" + recordName, origin); At(recordName, part); At("$" + recordName, part); }
                // DL2: what a data text names. R2-B (review A5): its top-level elements (an entity, a structure, a static entity)
                // by their names and aliases; a part of one (an attribute, an index, a record) only qualified, Owner.Name or
                // Owner/Name: a bare attribute name (Id, Name) is a word of any text, never a use of the failed data.
                if (op["data"] is JsonObject data)
                    foreach (var (written, owner) in SpecExpander.DdlDeclarations(data))
                        if (owner == null) { _names.TryAdd(written, origin); _aliases.TryAdd("$" + written, origin); At(written, part); At("$" + written, part); }
                        else MarkName(written, owner, origin, part);
            }
            if (kind == "reference")
                foreach (var element in (op["elements"] as JsonArray ?? new JsonArray()).OfType<JsonValue>())
                    if (element.TryGetValue<string>(out var typed) && typed.Split(':', 2) is [_, var elementName] && elementName.Length > 0)
                    { _names.TryAdd(elementName, origin); At(elementName, part); }
        }

        // A skipped text blocks only the action it would declare, not the independent texts of the same logic op.
        public void MarkFlow(string text, int origin) => MarkFlowAt(text, origin, null);

        public void MarkFlowAt(string text, int origin, string? at)
        {
            if (FlowTextForm.Header(text) is not { Name.Length: > 0 } header) return;
            MarkName(header.Name, header.Owner, origin, at);
        }

        private void MarkName(string name, string owner, int origin, string? at = null)
        {
            if (owner.Length == 0) {
                _names.TryAdd(name, origin);
                _aliases.TryAdd("$" + name, origin);
                _texts.Add((origin, name));
                At(name, at); At("$" + name, at);
                return;
            }
            if (owner.StartsWith("$html.", StringComparison.Ordinal)) owner = owner[6..];
            if (owner.IndexOf(':') is var colon && colon >= 0) owner = owner[(colon + 1)..];
            _scopedNames.TryAdd(owner + "." + name, (owner, name, origin));
            At(owner + "." + name, at);
        }

        /// <summary>C-21: a document whose shell stayed (root, data, placeholders and action shells exist) blocks only the
        /// widgets its content would have written, the evidence of a later missing-reference failure.</summary>
        public void MarkDocumentWidgets(JsonObject op, int origin)
        {
            if (op["data"]?["html"] is not JsonValue v || !v.TryGetValue<string>(out var html)) return;
            Anvil.Reading.ScreenHtml.Node document;
            try { document = Anvil.Reading.ScreenHtml.Parse(html); } catch (FormatException) { return; }
            void Widgets(Anvil.Reading.ScreenHtml.Node node)
            {
                if (!node.IsText && node.Tag is not ("screen" or "block" or "var" or "input" or "aggregate" or "event" or "style" or "slot" or "placeholder"))
                {
                    if (node.Get("id") is { Length: > 0 } id) _texts.Add((origin, id));
                    var kind = Anvil.Reading.ScreenHtmlTables.KindOf(node, out _);
                    var attribute = Anvil.Reading.ScreenHtmlTables.AttributeOf(kind, "Name", Anvil.Reading.ScreenHtmlModuleMode.Widget, false);
                    if (attribute != "id" && node.Get(attribute) is { Length: > 0 } widgetName) _texts.Add((origin, widgetName));
                }
                foreach (var child in node.Children) Widgets(child);
            }
            Widgets(document);
        }

        private void MarkDocument(JsonObject data, int origin, string? at = null)
        {
            var html = data["html"]!.GetValue<string>();
            Anvil.Reading.ScreenHtml.Node document;
            try { document = Anvil.Reading.ScreenHtml.Parse(html); }
            catch (FormatException) {
                // A malformed child must not hide a valid root declaration; read only its actual opening tag.
                var opening = Regex.Match(html, "^\\s*(?:<!--.*?-->\\s*)*(?<tag><(?<kind>screen|block)\\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>)", RegexOptions.Singleline);
                if (!opening.Success) return;
                try { document = Anvil.Reading.ScreenHtml.Parse(opening.Groups["tag"].Value + "</" + opening.Groups["kind"].Value + ">"); }
                catch (FormatException) { return; }
            }
            var root = document.Children.FirstOrDefault(n => !n.IsText && n.Tag is "screen" or "block");
            if (root?.Get("name") is not { Length: > 0 } name) return;
            MarkName(name, "", origin, at);
            foreach (var attribute in new[] { "actions", "data-actions" })
                foreach (var action in (root.Get(attribute) ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
                    MarkName(action, name, origin, at);
            void Members(Anvil.Reading.ScreenHtml.Node node) {
                if (node.Tag is "var" or "input" or "aggregate" or "event" && node.Get("name") is { Length: > 0 } member) MarkName(member, name, origin, at);
                if (!node.IsText && node.Tag is not ("screen" or "block" or "var" or "aggregate" or "event" or "style" or "slot")) {
                    // Widget names are only evidence for a concrete missing-reference error. A homonymous local
                    // variable in another action must not make that action a dependency of this failed document.
                    if (node.Get("id") is { Length: > 0 } id) _texts.Add((origin, id));
                    var kind = Anvil.Reading.ScreenHtmlTables.KindOf(node, out _);
                    var attribute = Anvil.Reading.ScreenHtmlTables.AttributeOf(kind, "Name", Anvil.Reading.ScreenHtmlModuleMode.Widget, false);
                    if (attribute != "id" && node.Get(attribute) is { Length: > 0 } widgetName) _texts.Add((origin, widgetName));
                }
                foreach (var child in node.Children) Members(child);
            }
            Members(root);
        }

        /// <summary>The first blocked alias or name this op uses (and the op that blocked it), or null. R2-B (review A5): in the
        /// markup of an html op only its expressions and bindings use a name ({{ }}, bind=, source=, on...=, actions=, ...),
        /// never the name of a tag or of an attribute.</summary>
        public (string Name, int Op)? UsedBy(JsonObject op) => UsedBy(Texts(op, null, op["op"]?.ToString() == "html"));

        private static readonly Regex Mustache = new(@"\{\{(.*?)\}\}", RegexOptions.Compiled | RegexOptions.Singleline);
        private static readonly Regex MarkupAttribute = new(@"\s([:@]?[A-Za-z][\w-]*)\s*=\s*(?:""([^""]*)""|'([^']*)')", RegexOptions.Compiled);
        private static readonly HashSet<string> BindingAttributes = new(StringComparer.OrdinalIgnoreCase)
            { "bind", "source", "actions", "data-actions", "if", "list", "options", "value", "values", "destination", "handler" };

        /// <summary>The expressions and bindings of a piece of markup: the only text of it a dependency is read in.</summary>
        internal static IEnumerable<string> MarkupUses(string html)
        {
            foreach (Match m in Mustache.Matches(html)) yield return m.Groups[1].Value;
            foreach (Match m in MarkupAttribute.Matches(html))
            {
                var attribute = m.Groups[1].Value;
                if (BindingAttributes.Contains(attribute) || attribute.StartsWith("on", StringComparison.OrdinalIgnoreCase) || attribute[0] is ':' or '@')
                    yield return m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value;
            }
        }

        public (string Name, int Op)? UsedByText(string text)
        {
            var owner = FlowTextForm.Header(text)?.Owner;
            // Literal strings, descriptions and labels do not reference a declaration.
            var code = Regex.Replace(text, "\"(?:[^\"\\r\\n]|\"\")*\"|(?m)^\\s*///[^\\r\\n]*|(?m)\\s+# [^\\r\\n]*", " ");
            var locals = Regex.Matches(code, @"(?m)^\s*(?:in|out|local)\s+([\p{L}_][\p{L}\p{N}_]*)\s*:")
                .Cast<Match>().Select(m => m.Groups[1].Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
            // A local can share a name with a failed type or action. Its declaration and value uses do not depend on
            // that element; a datatype after ':' and an actual callee still do.
            code = Word.Replace(code, m => {
                if (!locals.Contains(m.Value)) return m.Value;
                var lineAt = code.LastIndexOf('\n', Math.Max(0, m.Index - 1));
                var before = code[(lineAt + 1)..m.Index];
                var header = Regex.IsMatch(before, @"^\s*(?:server action|service action|client action|data action|action)\s+");
                var type = Regex.IsMatch(before, @"^\s*(?:in|out|local)\s+[\p{L}_][\p{L}\p{N}_]*\s*:\s*(?:[\p{L}_][\p{L}\p{N}_]*\.)?\[?$");
                var call = Regex.IsMatch(code[(m.Index + m.Length)..], @"^\s*\(");
                return header || type || call ? m.Value : new string(' ', m.Length);
            });
            return UsedBy([code], owner);
        }

        private (string Name, int Op)? UsedBy(IEnumerable<string> texts, string? owner = null)
        {
            if (_aliases.Count == 0 && _names.Count == 0 && _scopedNames.Count == 0) return null;
            foreach (var text in texts)
            {
                foreach (var (alias, origin) in _aliases)
                    if (text == alias || text.StartsWith(alias + "/", StringComparison.Ordinal) || text.StartsWith(alias + ".", StringComparison.Ordinal)) return (alias, origin);
                if (_names.Count > 0)
                    foreach (Match w in Word.Matches(text))
                        if (_names.TryGetValue(w.Value, out var origin)) return (w.Value, origin);
                foreach (var (_, scoped) in _scopedNames) {
                    var sameOwner = owner != null && (owner.Equals(scoped.Owner, StringComparison.OrdinalIgnoreCase)
                        || !owner.Contains('/') && scoped.Owner.EndsWith("/" + owner, StringComparison.OrdinalIgnoreCase)
                        || !scoped.Owner.Contains('/') && owner.EndsWith("/" + scoped.Owner, StringComparison.OrdinalIgnoreCase));
                    var reference = "(?<![\\p{L}\\p{N}_/])" + Regex.Escape(scoped.Owner) + "[./]" + Regex.Escape(scoped.Name) + "(?![\\p{L}\\p{N}_])";
                    if (Regex.IsMatch(text, reference, RegexOptions.IgnoreCase)
                        || sameOwner && Word.Matches(text).Cast<Match>().Any(w => w.Value.Equals(scoped.Name, StringComparison.OrdinalIgnoreCase)))
                        return (scoped.Owner + "." + scoped.Name, scoped.Origin);
                }
            }
            return null;
        }

        private static IEnumerable<string> Texts(JsonNode? node, string? key = null, bool markup = false)
        {
            switch (node)
            {
                case JsonValue v when v.TryGetValue<string>(out var s):
                    // A description or a label is no use of a name; the markup of an html op is read for its expressions only.
                    if (markup && key is "html" or "edit" or "edits" or "with" or "find") { foreach (var use in MarkupUses(s)) yield return use; }
                    else if (key is not ("description" or "label" or "_why")) yield return s;
                    break;
                case JsonObject o:
                    foreach (var (k, child) in o)
                    {
                        if (k is "args" or "assign" && child is JsonObject pairs) foreach (var (name, _) in pairs) yield return name;
                        foreach (var s in Texts(child, k, markup)) yield return s;
                    }
                    break;
                case JsonArray a:
                    foreach (var child in a) foreach (var s in Texts(child, key, markup)) yield return s;
                    break;
            }
        }
    }

    /// <summary>The refusal of an apply with failures. One failure keeps its own exception when it is coded (its code and
    /// problems, e.g. DELETE_HAS_CONSUMERS, with phase "apply" added), and keeps its code in the single refusal when other
    /// phases add problems to it (JobRunner.Diagnosis); otherwise, and with several, PREFLIGHT_REFUSED with every problem.
    /// The message keeps each failure's own text (`op #i (verb name): ...`), the first failure is the inner exception (the
    /// error text keeps the type of its root).</summary>
    private static Exception ApplyRefusal(List<ApplyFailure> failures, List<(int Op, int Because, string Uses, string? At)> skipped, string? opsPointer)
    {
        var problems = new List<JsonObject>();
        foreach (var failure in failures) problems.AddRange(ApplyProblems(failure, opsPointer));
        var notes = skipped.Select(s => $"op #{s.Op} skipped: it uses {s.Uses} of failed op #{s.Because}").ToList();
        if (failures.Count == 1 && Errors.FindCoded(failures[0].Error) is { } coded)
        {
            // The coded refusal stays the exception other tools already read (its code, its problems), now with the phase. A
            // JSON pointer relative to the op (or to its data) becomes the job's (I4, atritos 3: ICON_UNKNOWN, EXPRESSION_SYNTAX,
            // ODC_DELETE_RULE_FORCED); a model path (DELETE_HAS_CONSUMERS) stays as written.
            var rebased = ApplyProblems(failures[0], opsPointer).ToList();
            var own = coded.Problems?.OfType<JsonObject>().ToList() ?? [];
            for (var n = 0; n < own.Count; n++)
            {
                var p = own[n];
                p["phase"] ??= "apply";
                if (p["op"] == null) p["op"] = failures[0].Op;
                if (n < rebased.Count && p["pointer"] is JsonValue pv && pv.TryGetValue<string>(out var relative) && relative.StartsWith('/'))
                {
                    p["pointer"] = rebased[n]["pointer"]?.DeepClone();
                    if (p["patch"] is JsonArray) p["patch"] = rebased[n]["patch"]?.DeepClone();
                    Preflight.PatchCertainty.Publish(p);
                }
            }
            // R2-H: a coded failure raised without problems of its own (KernelRefusalException(code, message):
            // ROLE_ACTION_REQUIRES_SERVER) still says its problem: its code, op, pointer and phase, as several failures do.
            if (own.Count == 0)
                Errors.AttachProblems(failures[0].Error, rebased.Select(p =>
                {
                    p["phase"] ??= "apply";
                    if (p["op"] == null) p["op"] = failures[0].Op;
                    return JobPreflight.PublicProblem(p);
                }));
            return failures[0].Error;
        }
        // R2-B (rule 2): each skipped op says the problem of this refusal it waits for (dependsOn).
        var skips = skipped.Select(s => Skipped(s.Op, opsPointer == null ? null : $"{opsPointer}/{s.Op}", s.Uses, s.Because, s.At, $"fix op #{s.Because}; this op runs with it")).ToList();
        JobRunner.ResolveDependsOn(skips, problems.Select(JobPreflight.PublicProblem).ToList(), null, null);
        var warnings = new JsonArray(skips.Select(w => (JsonNode)w).ToArray());
        var lines = failures.Select(f => f.Error.Message).Concat(notes).ToList();
        return new JobPreflightException(string.Join(Environment.NewLine, lines),
            new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()), warnings, failures[0].Error);
    }

    /// <summary>The problems of one failed op: the coded ones it carries, rebased onto the job (I4: logic answers relative to
    /// op.data, an html fragment relative to the op), or one problem with the code its message names.</summary>
    private static IEnumerable<JsonObject> ApplyProblems(ApplyFailure failure, string? opsPointer)
    {
        if (failure.Problems != null) return failure.Problems.Select(p => p.DeepClone().AsObject());
        var at = opsPointer == null ? null : $"{opsPointer}/{failure.Op}";
        // An integration problem's path is relative to the op (/data/methods/0/path), the others' to the op's data.
        var relative = failure.Kind switch
        {
            "rest" or "rest-consume" or "rest-expose" or "soap" => at,
            "logic" or "spec" or "screen" or "prototype" or "entity-actions" => at == null ? null : at + "/data",
            "html" when failure.Source["parent"] == null => at == null ? null : at + "/data",
            _ => at,
        };
        if (Preflight.CodedProblems.From(failure.Error, failure.Op, failure.Kind, relative, phase: "apply") is { } coded) return coded;
        var message = failure.Error.Message;
        var prefix = Regex.Match(message, @"^op #\d+ \([^)]*\):\s*");
        var text = prefix.Success ? message[prefix.Length..] : message;
        var code = Errors.FindCoded(failure.Error)?.Code ?? ApplyCode(failure.Error, text);
        // A missing child names the children there are: the fix is one of them (primeira-certa A2, every problem with its fix).
        var children = code == "CHILD_NOT_FOUND" ? Regex.Match(text, @"has no child '([^']+)' \(children: ([^)]*)\)") : Match.Empty;
        var fix = children.Success
            ? $"use one of the children: {string.Join(", ", NameSuggestions.Closest(children.Groups[1].Value, children.Groups[2].Value.Split(", ").Select(c => c[(c.IndexOf(':') + 1)..])) is { Count: > 0 } close ? close : children.Groups[2].Value.Split(", "))}; or create '{children.Groups[1].Value}' earlier in this job"
            : JobPreflight.FixFor(code, failure.Kind, text);
        var problem = JobPreflight.Problem(failure.Op, at, code, "error", text, fix, null, failure.Kind);
        problem["phase"] = "apply";
        return [problem];
    }

    /// <summary>The code an uncoded apply failure names by its own text (A02 items 2, 3 and 5 at apply).</summary>
    private static string ApplyCode(Exception error, string text)
    {
        if (text.Contains("has no writable property or setter", StringComparison.Ordinal)) return "PROPERTY_NOT_WRITABLE";
        if (Regex.IsMatch(text, @"Invalid \w+ value '[^']*'; allowed:")) return "ENUM_VALUE_INVALID";
        if (text.Contains("has no child", StringComparison.Ordinal)) return "CHILD_NOT_FOUND";
        if (text.Contains("collides with", StringComparison.Ordinal) && text.Contains("renamed it to", StringComparison.Ordinal)) return "NAME_COLLISION";
        if (text.Contains("unknown type", StringComparison.OrdinalIgnoreCase)) return "TYPE_UNRESOLVED";
        if (Errors.FindUnresolved(error) != null || error.GetBaseException() is KeyNotFoundException) return "REFERENCE_UNRESOLVED";
        return "APPLY_FAILED";
    }
}
