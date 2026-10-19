using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12): what the html of an html op writes in a shape the engine reads one way only, normalized in place
/// before the compiler of the form sees it and listed (<c>normalizations</c>), and what stays wrong, refused in the same
/// preflight pass with every other problem. Born from the owner's FolhaPonto_UI session (6 deliveries, one problem per
/// round): the first round alone had four of these.
/// <list type="bullet">
/// <item>ICON_NAME_NORMALIZED (every form): an icon name the Studio's catalog has in another spelling (case, the class
/// prefixes fa-, fa fa-, fa-solid fa-, _ for -, the -o outline form when only it exists) is written as the catalog writes it.</item>
/// <item>ICON_WEIGHT_DROPPED (document form, O11): the O11 Icon has no Weight (the ODC one has); weight= on an &lt;i icon&gt;
/// is dropped instead of refused ("IIcon.Weight takes no expression here", 4 times in the first round).</item>
/// <item>LIST_ALIAS_REWRITTEN (document form): &lt;x list="Source" as="row"&gt; is the List of the language, whose row is
/// read as the iteration's correction reads it (ScreenDocument.AliasRow): Source.Current, and for an aggregate of the
/// document its row with the entity (GetPedidos.List.Current.Pedido.X). The alias is written so in the element's
/// expressions ({{ }}, if, os-*, bind..., the argument expressions of events, never the names of their parameters) and the
/// as= is dropped ('etapa' and 'dia', 9 times in the first round). An inner list that declares the same alias keeps its
/// own. An aggregate whose sources the document does not write is ambiguous: LIST_ALIAS_AMBIGUOUS.</item>
/// <item>SCREEN_TITLE_QUOTED (document form): the title of a &lt;screen&gt; is an expression; a title that is no expression
/// (Bater Ponto) or one plain word nothing of the page is named like (Espelho) is the text it says, written as a text
/// literal. A path (Usuario.Nome) or a word close to a declared name (a typo) is refused: SCREEN_TITLE_UNRESOLVED.</item>
/// <item>DEFAULT_MOVED_TO_INITIALIZE (document form): a &lt;var default&gt; that is not a literal (the Studio refuses it:
/// InvalidPropertyValue_DefaultValue, MesReferencia = NewDate(...)) is assigned at the start of the screen's OnInitialize (the
/// action the root names, declared by this job, or a new OnInitialize declared next to the screen's other actions), and the
/// default is dropped. Not a default that reads an aggregate or a data action of the screen: OnInitialize runs before they
/// fetch, so it is refused (DEFAULT_NOT_LITERAL, assign it in that source's OnAfterFetch).</item>
/// <item>DEFAULT_MOVED_TO_ASSIGN (logic): the same for a local variable or an output of a logic action: the first step of the
/// action assigns it.</item>
/// </list>
/// Refused (with the patch when one is certain): ICON_UNKNOWN (the patch only for a name the catalog's search words, a
/// table of Material and Font Awesome 5/6 names or an exact word give, written over the html as sent, only the icon
/// attribute changed), DEFAULT_NOT_LITERAL, NAME_COLLISION (two declarations of one name in one document, which the Studio
/// renames in silence), LIST_ALIAS_AMBIGUOUS, SCREEN_TITLE_UNRESOLVED. What a normalization inserts (a step, an action) is
/// marked for <see cref="SentJob"/>: the answer points into the job as sent.
/// </summary>
public static class HtmlDocumentRules
{
    public const string IconName = "ICON_NAME_NORMALIZED";
    public const string IconWeight = "ICON_WEIGHT_DROPPED";
    public const string ListAlias = "LIST_ALIAS_REWRITTEN";
    public const string TitleQuoted = "SCREEN_TITLE_QUOTED";
    public const string DefaultMoved = "DEFAULT_MOVED_TO_INITIALIZE";
    public const string DefaultAssigned = "DEFAULT_MOVED_TO_ASSIGN";
    public const string AliasAmbiguous = "LIST_ALIAS_AMBIGUOUS";
    public const string TitleUnresolved = "SCREEN_TITLE_UNRESOLVED";

    // ---- normalizations --------------------------------------------------------------------------------------------------

    public static void Normalize(JsonArray ops, string? prefix, string lane, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html") continue;
            foreach (var (holder, key, at) in HtmlSlots(op, prefix, i))
            {
                var path = at;
                Step(holder, key, html => Icons(html, lane, path, done));
                if (!HtmlText.IsDocument(holder[key]!.GetValue<string>()) || op["parent"] != null) continue;
                if (lane == "o11" && IconHasNoWeight(lane)) Step(holder, key, html => Weights(html, path, done));
                Step(holder, key, html => Aliases(html, path, done));
                Step(holder, key, html => Title(html, path, done));
            }
        }
        // Defaults last: they read the document and edit the logic ops too.
        for (var i = 0; i < ops.Count; i++)
            if (ops[i] is JsonObject op && ScreenDocFacts.Of(op, i) is { } doc) MoveDefaults(ops, doc, prefix, done);
        LogicDefaults(ops, prefix, done);
    }

    /// <summary>The html strings of an html op: data.html (page and document forms) and html (fragment form).</summary>
    private static IEnumerable<(JsonObject Holder, string Key, string? Path)> HtmlSlots(JsonObject op, string? prefix, int index)
    {
        if (op["data"] is JsonObject data && data["html"] is JsonValue dv && dv.TryGetValue<string>(out _)) yield return (data, "html", prefix == null ? null : $"{prefix}/{index}/data/html");
        if (op["html"] is JsonValue hv && hv.TryGetValue<string>(out _)) yield return (op, "html", prefix == null ? null : $"{prefix}/{index}/html");
    }

    private static void Step(JsonObject holder, string key, Func<string, string?> rewrite)
    {
        try
        {
            var html = holder[key]!.GetValue<string>();
            if (rewrite(html) is { } written && !string.Equals(written, html, StringComparison.Ordinal))
            {
                SentJob.HtmlBefore(holder, html);
                holder[key] = written;
            }
        }
        catch { /* a normalization never refuses: the checks and the compiler judge what stays */ }
    }

    private static bool IconHasNoWeight(string lane)
        => ModelTypes.Of("IIcon", lane) is not { } facts || !facts.Knows("Weight");

    private static string Where(HtmlText text, int offset) { var (line, column) = text.Position(offset); return $"line {line} col {column}"; }

    private static string? Icons(string html, string lane, string? path, List<JsonObject> done)
    {
        if (!html.Contains("icon", StringComparison.OrdinalIgnoreCase) || IconNames.For(lane) is not { } catalog) return null;
        var text = HtmlText.Parse(html);
        var edits = new List<HtmlText.Edit>();
        foreach (var element in text.Elements().Where(e => e.Tag.Equals("i", StringComparison.OrdinalIgnoreCase)))
        {
            if (element.Find("icon") is not { } icon || icon.Value.Length == 0 || icon.Value.Contains("{{")) continue;
            var verdict = IconNames.Judge(icon.Value, catalog, lane);
            if (verdict.Valid || verdict.Certain is not { } certain) continue;
            edits.Add(new(icon.ValueStart, icon.ValueEnd - icon.ValueStart, certain));
            done.Add(JobNormalizer.Entry(IconName, path, $"icon=\"{icon.Value}\"", $"icon=\"{certain}\"", $"{Where(text, icon.Start)}: {verdict.Rule}"));
        }
        return edits.Count == 0 ? null : HtmlText.Apply(html, edits);
    }

    /// <summary>The edit that removes an attribute with the spaces before it.</summary>
    private static HtmlText.Edit Remove(string html, HtmlText.Attribute attribute)
    {
        var start = attribute.Start;
        while (start > 0 && char.IsWhiteSpace(html[start - 1])) start--;
        return new(start, attribute.End - start, "");
    }

    private static string? Weights(string html, string? path, List<JsonObject> done)
    {
        if (!html.Contains("weight", StringComparison.OrdinalIgnoreCase)) return null;
        var text = HtmlText.Parse(html);
        var edits = new List<HtmlText.Edit>();
        foreach (var element in text.Elements().Where(e => e.Tag.Equals("i", StringComparison.OrdinalIgnoreCase) && e.Find("icon") != null))
        {
            if (element.Find("weight") is not { } weight) continue;
            edits.Add(Remove(html, weight));
            done.Add(JobNormalizer.Entry(IconWeight, path, $"<i icon=\"{element.Get("icon")}\" weight=\"{weight.Value}\">", $"<i icon=\"{element.Get("icon")}\">",
                $"{Where(text, weight.Start)}: the O11 Icon has no Weight (the ODC one has); the weight is dropped"));
        }
        return edits.Count == 0 ? null : HtmlText.Apply(html, edits);
    }

    // ---- LIST_ALIAS_REWRITTEN ---------------------------------------------------------------------------------------------

    /// <summary>The row an alias names: the current item and an item's member.</summary>
    private sealed record Row(string Text, Func<string, string> Member);

    private static readonly Regex Identifier = new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    /// <summary>The row of the List whose source is <paramref name="source"/> (outer aliases already read), or null when it is
    /// ambiguous (an aggregate of the document whose sources are not written).</summary>
    private static Row? RowOf(string source, ScreenHtml.Node? document, HtmlText text)
    {
        if (document != null)
        {
            var (row, member, certain) = ScreenDocument.AliasRow(source, document);
            return certain ? new Row(row, member) : null;
        }
        // The document did not parse (the compiler says why): an aggregate's List is not read without it.
        var name = source.EndsWith(".List", StringComparison.Ordinal) ? source[..^5] : source;
        if (text.Elements().Any(e => e.Tag.Equals("aggregate", StringComparison.OrdinalIgnoreCase) && string.Equals(e.Get("name"), name, StringComparison.Ordinal))) return null;
        return new Row(source + ".Current", m => source + ".Current." + m);
    }

    private static IEnumerable<HtmlText.Edit> Rows(string html, int start, int end, IReadOnlyDictionary<string, Row> scope)
        => scope.SelectMany(s => HtmlText.RenameRow(html, start, end, s.Key, s.Value.Text, s.Value.Member));

    private static string? Aliases(string html, string? path, List<JsonObject> done)
    {
        if (!html.Contains(" as=", StringComparison.OrdinalIgnoreCase)) return null;
        var text = HtmlText.Parse(html);
        ScreenHtml.Node? document = null;
        try { document = ScreenHtml.Parse(html); } catch { /* the compiler of the form says why */ }
        var edits = new List<HtmlText.Edit>();
        var entries = new List<JsonObject>();
        void Walk(HtmlText.Element element, IReadOnlyDictionary<string, Row> scope)
        {
            var inner = scope;
            // The source of this list is read in the scope around it; its alias names its row inside.
            if (element.Get("list") is { Length: > 0 } source && element.Find("as") is { } alias && alias.Value.Trim() is { Length: > 0 } name && Identifier.IsMatch(name))
            {
                var list = element.Find("list")!;
                edits.AddRange(Rows(html, list.ValueStart, list.ValueEnd, scope));
                var unaliased = Unalias(source.Trim(), scope);
                if (RowOf(unaliased, document, text) is { } row)
                {
                    var own = new Dictionary<string, Row>(StringComparer.OrdinalIgnoreCase) { [name] = row };
                    var uses = element.Descendants().Sum(e => HtmlText.ExpressionSpans(html, e).Sum(s => Rows(html, s.Start, s.End, own).Count()))
                        + HtmlText.ExpressionSpans(html, element, includeList: false).Sum(s => Rows(html, s.Start, s.End, own).Count());
                    // An alias nothing reads changes nothing: the document stays as written.
                    if (uses > 0)
                    {
                        inner = new Dictionary<string, Row>(scope, StringComparer.OrdinalIgnoreCase) { [name] = row };
                        edits.Add(Remove(html, alias));
                        entries.Add(JobNormalizer.Entry(ListAlias, path, $"list=\"{source}\" as=\"{name}\" ({name}.X)", $"list=\"{source}\" ({row.Member("X")})",
                            $"{Where(text, element.OpenStart)}: the row of a List is {row.Text}; '{name}' rewritten {uses} time(s) and as= dropped"));
                    }
                }
                foreach (var (start, end) in HtmlText.ExpressionSpans(html, element, includeList: false))
                    edits.AddRange(Rows(html, start, end, inner));
            }
            else if (scope.Count > 0)
                foreach (var (start, end) in HtmlText.ExpressionSpans(html, element))
                    edits.AddRange(Rows(html, start, end, scope));
            foreach (var child in element.Children) Walk(child, inner);
        }
        foreach (var top in text.Root.Children) Walk(top, new Dictionary<string, Row>(StringComparer.OrdinalIgnoreCase));
        if (entries.Count == 0) return null;
        done.AddRange(entries);
        return HtmlText.Apply(html, edits.DistinctBy(e => (e.Start, e.Length)));
    }

    /// <summary>A list source written with an outer alias (a list inside a list's row) read through the outer row.</summary>
    private static string Unalias(string source, IReadOnlyDictionary<string, Row> scope)
    {
        foreach (var (alias, row) in scope) source = HtmlText.Apply(source, HtmlText.RenameRow(source, 0, source.Length, alias, row.Text, row.Member));
        return source;
    }

    /// <summary>The lists whose alias is still read (Aliases could not tell its row): LIST_ALIAS_AMBIGUOUS.</summary>
    private static void AmbiguousAliases(ScreenDocFacts doc, string? html, List<JsonObject> problems)
    {
        var source = doc.Text.Source;
        if (!source.Contains(" as=", StringComparison.OrdinalIgnoreCase)) return;
        foreach (var element in doc.Text.Elements())
        {
            if (element.Get("list") is not { Length: > 0 } list || element.Find("as") is not { } alias || alias.Value.Trim() is not { Length: > 0 } name || !Identifier.IsMatch(name)) continue;
            var own = new Dictionary<string, Row>(StringComparer.OrdinalIgnoreCase) { [name] = new Row(name, m => m) };
            var uses = element.Descendants().Sum(e => HtmlText.ExpressionSpans(source, e).Sum(s => Rows(source, s.Start, s.End, own).Count()))
                + HtmlText.ExpressionSpans(source, element, includeList: false).Sum(s => Rows(source, s.Start, s.End, own).Count());
            if (uses == 0) continue;
            var aggregate = (list.EndsWith(".List", StringComparison.Ordinal) ? list[..^5] : list).Trim();
            problems.Add(JobPreflight.Problem(doc.Op, html, AliasAmbiguous, "error",
                $"html: {Where(doc.Text, element.OpenStart)}: list=\"{list}\" as=\"{name}\": the row of the List of an aggregate names its source first ({aggregate}.List.Current.<Source>.X), and the aggregate {aggregate} of {doc.Name} does not write its sources (from=, join=)",
                $"write from=\"<Entity>\" on <aggregate name=\"{aggregate}\">, or write the row in the expressions ({aggregate}.List.Current.<Entity>.X) and drop as=", null, "html"));
        }
    }

    // ---- SCREEN_TITLE_QUOTED ----------------------------------------------------------------------------------------------

    /// <summary>The roots an expression of the language reads by name without any declaration (qualifiers and built-in roots).</summary>
    private static readonly HashSet<string> Qualifiers = new(StringComparer.OrdinalIgnoreCase)
        { "Site", "Client", "Entities", "Settings", "Roles", "True", "False", "and", "or", "not", "Resources", "Images", "Themes" };

    /// <summary>What a screen's title is: text to quote (Quote, with why), a name the page does not have that is no plain
    /// text (Unresolved: a path or a word close to a declared name, with the closest), or nothing to say (null).</summary>
    private sealed record TitleVerdict(bool Quote, string Value, string Why, IReadOnlyList<string> Closest);

    /// <summary>A declared name a word may be a typo of: one or two letters away (two for six letters or more).</summary>
    private static bool Close(string word, string declared)
    {
        var distance = NameSuggestions.Distance(word.ToUpperInvariant(), declared.ToUpperInvariant());
        return distance > 0 && distance <= (Math.Max(word.Length, declared.Length) >= 6 ? 2 : 1);
    }

    private static TitleVerdict? JudgeTitle(HtmlText.Element root, HtmlText.Attribute title)
    {
        var value = Decode(title.Value).Trim();
        if (value.Length == 0 || value.StartsWith('"')) return null;
        var declared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var child in root.Children) if (child.Get("name") is { Length: > 0 } n && child.Tag is "var" or "input" or "aggregate") declared.Add(n);
        foreach (var n in ScreenDocFacts.List(root.Get("data-actions"))) declared.Add(n);
        if (ExpressionSyntax.Check(value) is { } syntax) return new(true, value, $"'{value}' is no expression ({syntax.Problem})", []);
        var tokens = ExpressionText.Tokens(value);
        var unknown = tokens.Select((t, k) => (t, k)).Where(x => ExpressionText.IsRoot(tokens, x.k) && x.t.Segments.Length > 0)
            .Select(x => x.t.Segments[0]).Where(r => !declared.Contains(r) && !Qualifiers.Contains(r)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (unknown.Count == 0 || !tokens.All(t => t.Kind is TokenKind.Name or TokenKind.Other)) return null;
        var plain = tokens.Count == 1 && tokens[0].Kind == TokenKind.Name && tokens[0].Segments.Length == 1;
        var typos = unknown.SelectMany(u => declared.Where(d => Close(u, d))).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        // One plain word nothing of the page is named like: the text it says (Espelho).
        if (plain && typos.Count == 0)
            return new(true, value, $"'{value}' names nothing of the page (no variable, input, aggregate or data action is named like it)", []);
        // A path (Usuario.Nome) or a word close to a declared name: a reference the page does not have, never visible text.
        var closest = typos.Count > 0 ? typos : NameSuggestions.Closest(unknown[0], declared, 3);
        return new(false, value, $"'{value}' names {string.Join(", ", unknown)}, which no variable, input, aggregate or data action of the page declares", closest);
    }

    private static string? Title(string html, string? path, List<JsonObject> done)
    {
        var text = HtmlText.Parse(html);
        if (text.Root.Children.FirstOrDefault(e => e.Tag == "screen") is not { } root || root.Find("title") is not { } title) return null;
        if (JudgeTitle(root, title) is not { Quote: true } verdict) return null;
        var literal = "\"" + verdict.Value.Replace("\"", "\"\"") + "\"";
        var quote = title.ValueEnd < html.Length ? html[title.ValueEnd] : '"';
        var written = quote == '"' ? literal.Replace("&", "&amp;").Replace("\"", "&quot;") : literal;
        done.Add(JobNormalizer.Entry(TitleQuoted, path, $"title=\"{title.Value}\"", $"title={quote}{written}{quote}",
            $"{Where(text, title.Start)}: the title of a screen is an expression and {verdict.Why}: it is the text {literal}"));
        return HtmlText.Apply(html, [new(title.ValueStart, title.ValueEnd - title.ValueStart, written)]);
    }

    internal static string Decode(string value) => value.Replace("&quot;", "\"").Replace("&apos;", "'").Replace("&#39;", "'").Replace("&lt;", "<").Replace("&gt;", ">").Replace("&amp;", "&");

    // ---- literal defaults -------------------------------------------------------------------------------------------------

    private static readonly Regex Number = new(@"^-?\d+(\.\d+)?$", RegexOptions.Compiled);
    private static readonly Regex TextLiteral = new("^\"(?:[^\"]|\"\")*\"$", RegexOptions.Compiled);
    private static readonly Regex DateLiteral = new("^#[^#]*#$", RegexOptions.Compiled);
    private static readonly Regex NullLiteral = new(@"^Null(Identifier|TextIdentifier|Date|Binary|Object)\s*\(\s*\)$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex StaticRecord = new(@"^Entities\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    /// <summary>A default the Studio keeps as written: empty, a number, a text, True/False, a date, a Null of a type, a record
    /// of a static entity (Entities.X.Y).</summary>
    public static bool IsLiteral(string value)
    {
        var v = value.Trim();
        return v.Length == 0 || Number.IsMatch(v) || TextLiteral.IsMatch(v) || DateLiteral.IsMatch(v) || NullLiteral.IsMatch(v) || StaticRecord.IsMatch(v)
            || v.Equals("True", StringComparison.OrdinalIgnoreCase) || v.Equals("False", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>A default the Studio refuses that is an expression (a call, an operator, a name), not a mistyped literal
    /// (JobPreflight.LiteralFix writes that one).</summary>
    public static bool MovableDefault(string value, string? type)
        => !IsLiteral(value) && JobPreflight.LiteralFix(type ?? "Text", value) == null && ExpressionSyntax.Check(value) == null;

    /// <summary>The aggregates and data actions of the screen a default reads (they fetch after OnInitialize), or empty.</summary>
    private static List<string> FetchedReads(string value, ScreenDocFacts doc, JsonArray ops)
    {
        var sources = doc.Declared.Where(d => d.Kind == "aggregate").Select(d => d.Name).Concat(doc.DataActions)
            .Concat(OwnedActions(ops, doc).Where(a => a.Action["kind"]?.ToString() == "data").Select(a => a.Action["name"]?.ToString() ?? ""))
            .Where(n => n.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (sources.Count == 0) return [];
        var tokens = ExpressionText.Tokens(value);
        return tokens.Select((t, k) => (t, k)).Where(x => ExpressionText.IsRoot(tokens, x.k) && x.t.Segments.Length > 0 && sources.Contains(x.t.Segments[0]))
            .Select(x => x.t.Segments[0]).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static bool Movable(ScreenDocFacts.Data v, ScreenDocFacts doc, JsonArray ops)
        => v.Default is { } d && MovableDefault(Decode(d.Value), v.Type) && FetchedReads(Decode(d.Value), doc, ops).Count == 0;

    private static void MoveDefaults(JsonArray ops, ScreenDocFacts doc, string? prefix, List<JsonObject> done)
    {
        var moving = doc.Variables.Where(v => Movable(v, doc, ops)).ToList();
        if (moving.Count == 0) return;
        var owned = OwnedActions(ops, doc);
        var pairs = new JsonObject();
        foreach (var v in moving) pairs[v.Name] = Decode(v.Default!.Value).Trim();
        var html = doc.Text.Source;
        var htmlPointer = prefix == null ? null : $"{prefix}/{doc.Op}/data/html";
        var holder = (JsonObject)ops[doc.Op]!["data"]!;
        var edits = new List<HtmlText.Edit>();
        string? actionName = doc.Root.Get("oninitialize")?.Trim();
        JsonObject? action = null;
        if (actionName is { Length: > 0 })
        {
            var found = owned.FirstOrDefault(a => string.Equals(a.Action["name"]?.ToString(), actionName, StringComparison.OrdinalIgnoreCase));
            action = found.Action;
            if (action == null) return;   // declared elsewhere (the base): refused by Check with the fix
            var steps = action["steps"] as JsonArray ?? (JsonArray)(action["steps"] = new JsonArray());
            var nodeNames = LogicScan.Of(action).Nodes.Keys.ToList();
            var label = nodeNames.Contains("SetInitialValues", StringComparer.OrdinalIgnoreCase) ? NameRules.Free("SetInitialValues", nodeNames) : "SetInitialValues";
            var step = new JsonObject { ["assign"] = pairs, ["as"] = label };
            steps.Insert(0, step);
            // The answer points into the job as sent: the step is the document's (its defaults), and a patch that writes the
            // html whole carries it.
            SentJob.Inserted(step, htmlPointer);
            if (prefix != null && SentJob.ToSent($"{prefix}/{found.Op}/data/actions/{found.Actions.IndexOf(action)}", ops, prefix).Pointer is { } at)
                SentJob.Companion(holder, "add", at + "/steps/0", step);
        }
        else
        {
            if (owned.Count == 0) return;   // no logic op of the job declares the screen's actions: refused by Check
            var first = owned[0];
            var taken = doc.Names().Select(n => n.Name).Concat(owned.Select(o => o.Action["name"]?.ToString() ?? "")).ToHashSet(StringComparer.OrdinalIgnoreCase);
            actionName = taken.Contains("OnInitialize") ? NameRules.Free("OnInitialize", taken) : "OnInitialize";
            action = new JsonObject
            {
                ["name"] = actionName, ["kind"] = "screen", ["owner"] = first.Action["owner"]?.DeepClone(),
                ["description"] = $"Sets the initial value of {string.Join(", ", moving.Select(v => v.Name))} when {doc.Name} opens (a default must be a literal).",
                ["steps"] = new JsonArray(new JsonObject { ["assign"] = pairs, ["as"] = "SetInitialValues" }),
            };
            first.Actions.Add(action);
            SentJob.Inserted(action, htmlPointer);
            if (prefix != null) SentJob.Companion(holder, "add", $"{prefix}/{first.Op}/data/actions/-", action);
            // The root names it: oninitialize= and actions= (the document declares every screen action it binds).
            var last = doc.Root.Attributes.Count > 0 ? doc.Root.Attributes[^1].End : doc.Root.OpenStart + 1 + doc.Root.Tag.Length;
            var addition = $" oninitialize=\"{actionName}\"";
            if (doc.Root.Find("actions") is { } actions)
            {
                var separator = actions.Value.Contains(", ") ? ", " : ",";
                edits.Add(new(actions.ValueStart, actions.ValueEnd - actions.ValueStart, actions.Value.Trim().Length == 0 ? actionName : actions.Value + separator + actionName));
            }
            else addition += $" actions=\"{actionName}\"";
            edits.Add(new(last, 0, addition));
        }
        foreach (var v in moving) edits.Add(Remove(html, v.Default!));
        SentJob.HtmlBefore(holder, html);
        holder["html"] = HtmlText.Apply(html, edits);
        foreach (var v in moving)
            done.Add(JobNormalizer.Entry(DefaultMoved, htmlPointer, $"<var name=\"{v.Name}\" default=\"{v.Default!.Value}\">",
                $"{actionName}: {v.Name} = {Decode(v.Default!.Value).Trim()}",
                $"{Where(doc.Text, v.Default!.Start)}: the default of a variable must be a literal; {v.Name} is assigned at the start of {doc.Name}'s OnInitialize ({actionName}), which runs when the screen opens, before it renders"));
    }

    /// <summary>The logic actions of the job whose owner is the document's root, with the array that holds them.</summary>
    private static List<(JsonObject Action, JsonArray Actions, int Op)> OwnedActions(JsonArray ops, ScreenDocFacts doc)
    {
        var owned = new List<(JsonObject, JsonArray, int)>();
        for (var i = 0; i < ops.Count; i++)
            if (ops[i] is JsonObject op && op["op"]?.ToString() == "logic" && op["data"]?["actions"] is JsonArray actions)
                foreach (var action in actions.OfType<JsonObject>())
                    if (action["owner"]?.ToString() is { } owner && doc.Owns(owner)) owned.Add((action, actions, i));
        return owned;
    }

    private static void LogicDefaults(JsonArray ops, string? prefix, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"]?["actions"] is not JsonArray actions) continue;
            for (var a = 0; a < actions.Count; a++)
            {
                if (actions[a] is not JsonObject action || action["steps"] is not JsonArray steps) continue;
                var pairs = new JsonObject();
                string? origin = null;
                foreach (var section in new[] { "vars", "outputs" })
                    for (var p = 0; p < (action[section] as JsonArray)?.Count; p++)
                    {
                        if (action[section]![p] is not JsonObject parameter || parameter["default"] is not JsonValue dv || !dv.TryGetValue<string>(out var value)
                            || parameter["name"]?.ToString() is not { Length: > 0 } name || !MovableDefault(value, parameter["type"]?.ToString())) continue;
                        parameter.Remove("default");
                        pairs[name] = value.Trim();
                        var path = prefix == null ? null : SentJob.ToSent($"{prefix}/{i}/data/actions/{a}", ops, prefix).Pointer + $"/{section}/{p}/default";
                        origin ??= path;
                        done.Add(JobNormalizer.Entry(DefaultAssigned, path, value, $"{name} = {value.Trim()} (first step)",
                            $"the default of {section[..^1]} {name} of {action["name"]} must be a literal; the first step of the action assigns it"));
                    }
                if (pairs.Count == 0) continue;
                var nodes = LogicScan.Of(action).Nodes.Keys.ToList();
                var step = new JsonObject { ["assign"] = pairs, ["as"] = nodes.Contains("SetInitialValues", StringComparer.OrdinalIgnoreCase) ? NameRules.Free("SetInitialValues", nodes) : "SetInitialValues" };
                steps.Insert(0, step);
                // The step is the defaults': a pointer into it is the first default it came from.
                SentJob.Inserted(step, origin);
            }
        }
    }

    // ---- checks ---------------------------------------------------------------------------------------------------------

    public static List<JsonObject> Check(JsonArray ops, string? prefix, string lane)
    {
        var problems = new List<JsonObject>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html") continue;
            foreach (var (holder, key, at) in HtmlSlots(op, prefix, i))
                UnknownIcons(holder, key, lane, i, at, problems);
            if (ScreenDocFacts.Of(op, i) is not { } doc) continue;
            var html = prefix == null ? null : $"{prefix}/{i}/data/html";
            foreach (var input in doc.Inputs.Where(d => d.Default is { } dv && MovableDefault(Decode(dv.Value), d.Type)))
                problems.Add(JobPreflight.Problem(i, html, "DEFAULT_NOT_LITERAL", "error",
                    $"html: {Where(doc.Text, input.Default!.Start)}: the default of input {input.Name} of {doc.Name} is '{Decode(input.Default.Value)}', and a default must be a literal (the Studio refuses it: InvalidPropertyValue_DefaultValue)",
                    $"write a literal default (a number, \"text\", True/False, #2026-01-01#, NullIdentifier(), Entities.X.Y), or drop it and assign {input.Name} in {doc.Name}'s OnInitialize when it comes empty", null, "html"));
            // A default that reads data the screen fetches: OnInitialize runs before the fetch, so it is never moved there.
            foreach (var v in doc.Variables.Where(v => v.Default is { } d && MovableDefault(Decode(d.Value), v.Type)))
            {
                var value = Decode(v.Default!.Value);
                if (FetchedReads(value, doc, ops) is not { Count: > 0 } sources) continue;
                problems.Add(JobPreflight.Problem(i, html, "DEFAULT_NOT_LITERAL", "error",
                    $"html: {Where(doc.Text, v.Default.Start)}: the default of variable {v.Name} of {doc.Name} is '{value}', a default must be a literal, and it reads {string.Join(", ", sources)}, which {doc.Name} fetches after its OnInitialize: assigned there, it would read nothing yet",
                    $"drop the default and assign {v.Name} = {value} in the On After Fetch of {sources[0]} (an action of {doc.Name} that its OnAfterFetch event names)", null, "html"));
            }
            if (doc.Variables.Any(v => Movable(v, doc, ops)))
            {
                // What MoveDefaults could not move: an OnInitialize the job does not declare, or no action of the screen in the job.
                var named = doc.Root.Get("oninitialize")?.Trim();
                var why = named is { Length: > 0 } ? $"its OnInitialize ({named}) is not declared by a logic op of this job" : "no logic op of this job declares an action of it";
                foreach (var v in doc.Variables.Where(v => Movable(v, doc, ops)))
                    problems.Add(JobPreflight.Problem(i, html, "DEFAULT_NOT_LITERAL", "error",
                        $"html: {Where(doc.Text, v.Default!.Start)}: the default of variable {v.Name} of {doc.Name} is '{Decode(v.Default.Value)}', a default must be a literal, and {why}",
                        $"drop the default and assign {v.Name} = {Decode(v.Default.Value)} at the start of {doc.Name}'s OnInitialize (oninitialize=\"OnInitialize\" on the root, declared in the logic op with the screen's actions)", null, "html"));
            }
            if (doc.Kind == "screen" && doc.Root.Find("title") is { } title && JudgeTitle(doc.Root, title) is { Quote: false } unresolved)
                problems.Add(JobPreflight.Problem(i, html, TitleUnresolved, "error",
                    $"html: {Where(doc.Text, title.Start)}: the title of a screen is an expression, and {unresolved.Why}" + (unresolved.Closest.Count > 0 ? $" (closest: {string.Join(", ", unresolved.Closest)})" : ""),
                    $"name what the page declares" + (unresolved.Closest.Count > 0 ? $" ({string.Join(", ", unresolved.Closest)})" : "") + $", or write the text in quotes: title=\"&quot;{unresolved.Value}&quot;\"", null, "html"));
            AmbiguousAliases(doc, html, problems);
            var seen = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (name, what) in doc.Names())
            {
                if (seen.TryGetValue(name, out var first))
                {
                    if (first == what && what is "screen action" or "data action") continue;
                    problems.Add(JobPreflight.Problem(i, html, "NAME_COLLISION", "error",
                        $"html: {doc.Kind} {doc.Name} declares the {what} '{name}' and the {first} '{seen.Keys.First(k => k.Equals(name, StringComparison.OrdinalIgnoreCase))}': one scope, the Studio renames the second to {NameRules.Free(name, seen.Keys)} and every expression that names it reads the first",
                        $"give one of them another name, in the document and in every expression that names it", null, "html", patchRule: "ACTION_RENAMED_FREE_NAME"));
                    continue;
                }
                seen[name] = what;
            }
        }
        return problems;
    }

    private static void UnknownIcons(JsonObject holder, string key, string lane, int op, string? path, List<JsonObject> problems)
    {
        var html = holder[key]!.GetValue<string>();
        if (!html.Contains("icon", StringComparison.OrdinalIgnoreCase) || IconNames.For(lane) is not { } catalog) return;
        var text = HtmlText.Parse(html);
        var unknown = new List<(HtmlText.Attribute Icon, IconNames.Verdict Verdict)>();
        foreach (var element in text.Elements().Where(e => e.Tag.Equals("i", StringComparison.OrdinalIgnoreCase)))
        {
            if (element.Find("icon") is not { } icon || icon.Value.Length == 0 || icon.Value.Contains("{{")) continue;
            var verdict = IconNames.Judge(icon.Value, catalog, lane);
            if (verdict.Valid || verdict.Certain != null) continue;
            unknown.Add((icon, verdict));
        }
        if (unknown.Count == 0) return;
        // One patch for the op, over the html as the author sent it (never the normalized one: a default moved to an
        // OnInitialize of another op would be lost): only the icon attributes whose name is certain change.
        JsonArray? patch = null;
        if (path != null && unknown.Any(u => u.Verdict.Suggested != null))
        {
            var sent = SentJob.HtmlAsSent(holder) ?? html;
            var sentText = HtmlText.Parse(sent);
            var edits = new List<HtmlText.Edit>();
            foreach (var element in sentText.Elements().Where(e => e.Tag.Equals("i", StringComparison.OrdinalIgnoreCase)))
                if (element.Find("icon") is { } icon && icon.Value.Length > 0 && !icon.Value.Contains("{{")
                    && IconNames.Judge(icon.Value, catalog, lane) is { Valid: false, Certain: null, Suggested: { } suggested })
                    edits.Add(new(icon.ValueStart, icon.ValueEnd - icon.ValueStart, suggested));
            if (edits.Count > 0) patch = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = path, ["value"] = HtmlText.Apply(sent, edits) });
        }
        foreach (var (icon, verdict) in unknown)
        {
            var problem = JobPreflight.Problem(op, path, "ICON_UNKNOWN", "error",
                $"html: {Where(text, icon.Start)}: icon=\"{icon.Value}\" is not an icon of {catalog.Library}"
                    + (verdict.Suggested != null ? $"; it is {verdict.Suggested} there ({verdict.SuggestedBy})" : verdict.Closest.Count > 0 ? $"; closest by spelling and search words: {string.Join(", ", verdict.Closest)}" : ""),
                verdict.Suggested != null ? $"write icon=\"{verdict.Suggested}\" (the patch)" + (verdict.Closest.Count > 1 ? $"; others: {string.Join(", ", verdict.Closest.Where(c => c != verdict.Suggested).Take(3))}" : "")
                    : verdict.Closest.Count > 0 ? $"choose the icon that means it in {catalog.Library} (no patch: none of its names or search words is '{icon.Value}'); spelled close: {string.Join(", ", verdict.Closest)}" : $"use a name of {catalog.Library}",
                patch?.DeepClone().AsArray(), "html");
            if (patch != null) problem["_sentPatch"] = true;
            problems.Add(problem);
        }
    }
}
