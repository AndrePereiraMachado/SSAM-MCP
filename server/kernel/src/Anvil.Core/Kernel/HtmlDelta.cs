using System.Collections;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.UI;

namespace Anvil.Core;

/// <summary>
/// The html op on an existing screen: the screen keeps its identity (key, inputs, roles, navigation into it) and the variables
/// the page still declares; the presentation, the data sources and the screen logic the page regenerates are removed first and
/// created again from the source. Pre-existing variables the page no longer declares are pruned only when nothing uses them.
/// The page's CSS goes to the module's own theme, scoped under the page root, replacing the block of the same screen.
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>html {data}: compila a pagina HTML/CSS autorada e o seu manifesto (HtmlExpander) em verbos nativos e aplica-os;
    /// numa tela existente limpa a apresentacao e a logica regeneradas antes, preservando a identidade da tela e as variaveis
    /// declaradas; instala o CSS escopado no tema do modulo. Devolve o relatorio (chaves, delta, hashes, tema).</summary>
    private JsonNode Html(JsonObject op)
    {
        if (op["parent"] != null) return ApplyHtmlVisual(op); // the visual fragment form: HtmlVisual.cs
        if (Anvil.Reading.ScreenHtmlEdit.IsEdit(op)) return HtmlEdit(op); // the edit of a reading (C2): Verbs.ScreenHtml.cs
        if (ScreenDocument.IsDocumentOp(op)) return HtmlDocument(op); // the document form: <screen>/<block>, Verbs.ScreenDocument.cs
        if (op["data"]?["components"] is JsonValue componentSource)
        {
            var contract = HtmlComponents.Compile(componentSource.GetValue<string>());
            var planned = PlanModuleSpecification(contract);
            foreach (var operation in planned.OfType<JsonObject>()) ApplyOne(operation);
            var proof = CheckModuleSpecification(contract);
            if (!proof["accepted"]!.GetValue<bool>()) throw new InvalidOperationException("UI source contract differs from native model: " + proof["differences"]);
            return new JsonObject { ["contract"] = contract, ["proof"] = proof, ["expanded"] = planned.Count };
        }
        string? TryRef(string[] names)
        {
            foreach (var name in names) { try { Resolve(name); return name; } catch (KeyNotFoundException) { } }
            return null;
        }
        ScreenContract? Contract(string reference) => Resolve(reference) is IObjectSignature o ? ScreenContracts.Read(o, reference) : null;
        var data = op["data"]?.AsObject() ?? throw new InvalidOperationException("html: data is required");
        var screenName = data["screen"]?.GetValue<string>() ?? throw new InvalidOperationException("html: missing 'screen'");
        IObjectSignature? screen = null;
        try { screen = Resolve("IMobileScreen:" + screenName) as IObjectSignature; } catch (KeyNotFoundException) { }
        JsonObject? existing = null; JsonObject? delta = null; Dictionary<string, IObjectSignature>? previousVariables = null;
        var legacyScripts = new List<IObjectSignature>();
        if (screen != null)
        {
            existing = DescribeScreen(screen);
            var currentLayout = (IObjectSignature)Resolve("IMobileScreen:" + screenName + "/#IMobileBlockInstanceWidget");
            existing["layout"] = TypeResolver.Name(ModelHost.Prop(currentLayout, "SourceBlock"));
            var scripts = new JsonObject();
            foreach (var declaration in data["scripts"]?.AsArray() ?? [])
            {
                var generatedName = screenName + "_" + declaration!["name"]!.ToString();
                try { scripts[generatedName] = ModelHost.Prop(Resolve("IClientAction:" + generatedName), "Description")?.ToString(); }
                catch (KeyNotFoundException) { }
                // Upgrade the old compiler's unqualified function only when its exact implementation is still
                // used exclusively by this screen. An unrelated/shared function is left intact.
                try
                {
                    var legacy = (IObjectSignature)Resolve("IClientAction:" + declaration["name"]!.ToString());
                    var nodes = Sequence(legacy, "Children").OfType<IObjectSignature>().Where(n => n.GetInterface()?.Name == "IJavaScriptNode").ToArray();
                    var consumers = Consumers(legacy).Where(c => !IsDerived(c.Referer, c.Path)).ToArray();
                    if (ModelHost.Prop(legacy, "Public") is false && nodes.Length == 1 &&
                        ModelHost.Prop(nodes[0], "JavaScript")?.ToString() is { } stored && declaration["code"]?.ToString() is { } code &&
                        (stored == code || stored == CodeFormat.Written(CodeLanguage.JavaScript, code)) &&
                        consumers.Length > 0 && consumers.All(c => IsInside(c.Referer, screen))) legacyScripts.Add(legacy);
                }
                catch (KeyNotFoundException) { }
            }
            existing["scripts"] = scripts;
            previousVariables = Sequence(screen, "LocalVariables").OfType<IObjectSignature>().ToDictionary(v => TypeResolver.Name(v)!, v => v, StringComparer.OrdinalIgnoreCase);
        }
        // H10: the job around this op (its logic ops), so call reaches the screen actions of this screen the job declares.
        var inJob = _applyOps != null && _applyIndex < _applyOps.Count && ReferenceEquals(_applyOps[_applyIndex], op);
        var job = inJob ? HtmlJob.From(_applyOps, _applyIndex) : null;
        var compiled = HtmlExpander.Expand(data, TryRef, Contract, _espace.ESpaceType.ToString(), existing, job);
        if (screen != null) delta = ClearScreen(screen, screenName, data["layout"]?.ToString() == "blank");
        for (var i = 0; i < compiled.Ops.Count; i++)
        {
            try { ApplyOne(compiled.Ops[i]); }
            catch (Exception ex) { throw new InvalidOperationException($"html op #{i} ({compiled.Ops[i]["op"]} {compiled.Ops[i]["prop"] ?? compiled.Ops[i]["type"]}): {Unwrap(ex)}", ex); }
        }
        var report = compiled.Report.DeepClone().AsObject(); report["expanded"] = compiled.Ops.Count;
        if (inJob && compiled.Report["sameJobScreenActions"] is JsonArray shells) report["sameJobScreenActions"] = FillLater(screenName, shells);
        var migrated = new JsonArray();
        foreach (var legacy in legacyScripts)
        {
            if (Consumers(legacy).Any(c => !IsDerived(c.Referer, c.Path))) continue;
            migrated.Add(TypeResolver.Name(legacy));
            if (ModelHost.Prop(legacy, "WasDeleted") is not true) legacy.Delete();
            _byKey = null;
        }
        report["legacyScriptsMigrated"] = migrated;
        if (delta != null && previousVariables != null)
        {
            var declared = new HashSet<string>(compiled.Report["variables"]!["kept"]!.AsArray().Select(v => v!.ToString()), StringComparer.OrdinalIgnoreCase);
            var pruned = new JsonArray(); var kept = new JsonArray();
            foreach (var (variableName, variable) in previousVariables.Where(p => !declared.Contains(p.Key)))
            {
                var consumers = variable is ServiceStudio.Model.AbstractObject ao && ao.HasReferers ? Consumers(variable).Count(c => !IsDerived(c.Referer, c.Path)) : 0;
                if (consumers == 0) { variable.Delete(); pruned.Add(variableName); } else kept.Add(new JsonObject { ["name"] = variableName, ["consumers"] = consumers });
            }
            delta["variablesPruned"] = pruned; delta["variablesKeptInUse"] = kept;
            report["delta"] = delta;
        }
        if (compiled.ScopedCss != null) report["stylesheet"]!["theme"] = InstallStylesheet(screenName, compiled.ScopedCss, report["stylesheet"]!.AsObject());
        return report;
    }

    /// <summary>H10: the screen actions the page created first (name, inputs, outputs) are filled by the logic ops after this
    /// op that declare them: each declaration is marked replace, so the logic op rewrites the body in place keeping the key the
    /// widgets already point at (the stable-signature replace of Logic). Reported per action with the op that fills it.</summary>
    private JsonArray FillLater(string screenName, JsonArray shells)
    {
        var names = new HashSet<string>(shells.Select(s => s!.ToString()), StringComparer.OrdinalIgnoreCase);
        var filled = new JsonArray();
        // F5: every logic op that has not run yet (after this op as written, or written before it and run after it by the
        // composition, JobComposition).
        for (var k = 0; k < _applyOps!.Count; k++)
        {
            if (k == _applyIndex || (_ranOps.Contains(k) || _ranOps.Count == 0 && k < _applyIndex)) continue;
            if (_applyOps[k] is not JsonObject later || later["op"]?.ToString() != "logic" || later["data"]?["actions"] is not JsonArray declared) continue;
            foreach (var action in declared.OfType<JsonObject>())
            {
                if (action["name"]?.ToString() is not { } actionName || !names.Contains(actionName) || action["kind"]?.ToString() != "screen") continue;
                var owner = action["owner"]?.ToString() ?? "";
                if (!owner.Equals("IMobileScreen:" + screenName, StringComparison.OrdinalIgnoreCase) && !owner.Equals("$html." + screenName, StringComparison.OrdinalIgnoreCase)) continue;
                action["replace"] = true;
                names.Remove(actionName);
                filled.Add(new JsonObject { ["name"] = actionName, ["filledBy"] = k });
            }
        }
        foreach (var unfilled in names.Order(StringComparer.OrdinalIgnoreCase)) filled.Add(new JsonObject { ["name"] = unfilled, ["filledBy"] = null });
        return filled;
    }

    private static JsonObject DescribeScreen(IObjectSignature screen)
    {
        var variables = new JsonObject();
        foreach (var v in Sequence(screen, "LocalVariables").OfType<IObjectSignature>()) variables[TypeResolver.Name(v)!] = UiCatalog.TypeName(ModelHost.Prop(v, "DataType"));
        // The access the screen has now, kept unless data.roles replaces it and reported either way: the Roles collection, and
        // in ODC (no Anonymous role there) the AnonymousAccess flag.
        var roles = new JsonArray(Sequence(screen, "Roles").Select(r => TypeResolver.Name(r)).OfType<string>().Select(r => (JsonNode)r).ToArray());
        var description = new JsonObject { ["key"] = screen.ObjectKey?.ToString(), ["variables"] = variables, ["roles"] = roles };
        if (ModelHost.Prop(screen, "AnonymousAccess") is bool anonymous) description["anonymous"] = anonymous;
        return description;
    }

    private static readonly string[] LifecycleEvents = ["OnInitialize", "OnReady", "OnRender", "OnDestroy", "OnParametersChanged"];

    /// <summary>Removes what the page regenerates: content widgets, the title, data actions, aggregates and screen actions. Everything
    /// removed lives inside the screen, so no element outside it can reference it. A lifecycle event of the screen (the template's
    /// Login has one) whose handler is a screen action the page removes is cleared in the same op, and the report names it; a
    /// handler that lives outside the screen stays bound (the Cardapio UI was refused "screen Login has a lifecycle handler").</summary>
    private JsonObject ClearScreen(IObjectSignature screen, string screenName, bool blankLayout)
    {
        var screenActions = Sequence(screen, "ScreenActions").OfType<IObjectSignature>().ToHashSet();
        var lifecycle = new JsonArray();
        var events = LifecycleEvents.Select(name => (Name: name, Event: ModelHost.Prop(screen, name) as IObjectSignature)).Where(e => e.Event != null).ToList();
        foreach (var child in Sequence(screen, "Children").OfType<IObjectSignature>().Where(c => c.GetInterface()?.Name == "IUILifeCycleEvent"))
            if (!events.Any(e => ReferenceEquals(e.Event, child))) events.Add((TypeResolver.Name(child) is { Length: > 0 } n ? n : "lifecycle", child));
        foreach (var (eventName, handlerEvent) in events)
        {
            if (ModelHost.Prop(handlerEvent!, "Destination") is not IObjectSignature destination) continue;
            var removedWithThePage = screenActions.Contains(destination) || IsInside(destination, screen);
            if (removedWithThePage) FindProperty(handlerEvent!, "Destination")?.SetValue(handlerEvent, null);
            lifecycle.Add(new JsonObject { ["event"] = eventName, ["handler"] = TypeResolver.Name(destination), ["cleared"] = removedWithThePage });
        }
        var reference = "IMobileScreen:" + screenName + "/#IMobileBlockInstanceWidget/";
        var removed = new JsonObject();
        if (lifecycle.Count > 0) removed["lifecycle"] = lifecycle;
        JsonArray Remove(IEnumerable<object> items, string label)
        {
            var names = new JsonArray();
            foreach (var item in items.OfType<IObjectSignature>().ToArray()) { names.Add(new JsonObject { ["name"] = TypeResolver.Name(item), ["type"] = ShortType(item), ["key"] = item.ObjectKey?.ToString() }); item.Delete(); }
            removed[label] = names; return names;
        }
        var layout = (IObjectSignature)Resolve("IMobileScreen:" + screenName + "/#IMobileBlockInstanceWidget");
        var definition = (IObjectSignature)ModelHost.Prop(layout, "SourceBlock")!;
        var contract = ScreenContracts.Read(definition, "layout");
        var oldContent = contract.Placeholders.Any(p => p.Name == "MainContent") ? "MainContent" : "Content";
        var content = (IObjectSignature)Resolve(reference + oldContent);
        var titleRoot = contract.Placeholders.Any(p => p.Name == "Title") ? Resolve(reference + "Title") as IObjectSignature : null;
        var changingLayout = blankLayout != (TypeResolver.Name(definition) == "LayoutBlank");
        var contentRoots = changingLayout ? contract.Placeholders.Select(p => (IObjectSignature)Resolve(reference + p.Name)).ToArray() : new[] { content };
        var logic = new[] { "ScreenActions", "DataActions", "ScreenAggregates" }.SelectMany(p => Sequence(screen, p)).OfType<IObjectSignature>().ToArray();
        var removedRoots = logic.Concat(contentRoots.SelectMany(root => root.Children.OfType<IObjectSignature>().Where(c => c is not IExpression)))
            .Concat(titleRoot?.Children.OfType<IObjectSignature>().Where(c => c.GetInterface()?.Name == "IExpression") ?? []).ToArray();
        foreach (var target in logic)
        {
            if (target is not ServiceStudio.Model.AbstractObject ao || !ao.HasReferers) continue;
            var retained = Consumers(target).Where(c => !IsDerived(c.Referer, c.Path) &&
                !removedRoots.Any(root => ReferenceEquals(root, c.Referer) || IsInside(c.Referer, root))).ToArray();
            if (retained.Length > 0) throw new InvalidOperationException($"html: cannot replace {screenName}.{TypeResolver.Name(target)}: retained elements still use it: {string.Join(", ", retained.Select(c => c.Path))}. Preserve or migrate those consumers before replacing the screen.");
        }
        Remove(contentRoots.SelectMany(root => root.Children.OfType<IObjectSignature>().Where(c => c is not IExpression)), "widgets");
        if (titleRoot != null && !changingLayout) Remove(titleRoot.Children.OfType<IObjectSignature>().Where(c => c.GetInterface()?.Name is "IExpression"), "title");
        Remove(Sequence(screen, "ScreenActions"), "screenActions");
        Remove(Sequence(screen, "DataActions"), "dataActions");
        Remove(Sequence(screen, "ScreenAggregates"), "aggregates");
        _byKey = null;
        return new JsonObject { ["screen"] = screen.ObjectKey?.ToString(), ["removed"] = removed };
    }

    /// <summary>Writes the scoped CSS into the module's own default theme between markers named by <paramref name="blockKey"/>,
    /// the key the caller composes (docs/PROTOTIPO-NATIVO.md 4.3 item 2): the page form passes the screen (<c>Dashboard</c>), the
    /// fragment form <c>&lt;owner&gt;:&lt;class&gt;</c> (the screen or block that receives the fragment and the class its
    /// stylesheet is scoped under), so the same class in two screens is two blocks and a second compilation replaces its own
    /// block instead of appending another copy. A legacy block of a fragment (<c>/* anvil:html &lt;class&gt; */</c>, the key
    /// before the owner) is adopted once by the first owner that installs that class: the marker is renamed and the content
    /// replaced (<c>adoptedLegacy</c>); the next owners get blocks of their own. Never two copies. The @import statements the
    /// block carries go to the top of the stylesheet, once (H14, <c>cssImportsHoisted</c>).</summary>
    private string InstallStylesheet(string blockKey, string scopedCss, JsonObject report, bool format = true)
    {
        var defaultTheme = _es.DefaultMobileTheme ?? throw new InvalidOperationException("html: the module has no default theme to carry the stylesheet");
        var theme = _es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == defaultTheme.ObjectKey?.ToString())
            ?? throw new InvalidOperationException($"html: the default theme {TypeResolver.Name(defaultTheme)} belongs to another module; the page stylesheet needs a theme owned by this module");
        // The document form writes its CSS as given (format false); the page and fragment forms write the CSS they compiled.
        if (format) scopedCss = FormatCode(CodeLanguage.Css, scopedCss, TypeResolver.Name(theme) + ".StyleSheet (html " + blockKey + ")");
        var begin = Marker(blockKey); var end = EndMarker(blockKey);
        var block = begin + "\n" + scopedCss.TrimEnd() + "\n" + end;
        // O bloco vai para a metade do AUTOR do tema, nunca pela efetiva: num tema com CSS do Theme Editor a efetiva
        // e gerada + autor, e um ciclo ler-efetiva/escrever-efetiva ou perde o marcador ou duplica o bloco gerado.
        var sheet = ThemeCss.Of(theme);
        var css = sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet ?? "";
        var (i, endMarker) = (css.IndexOf(begin, StringComparison.Ordinal), end);
        var colon = blockKey.IndexOf(':');
        // A named style is independent of a root with the same name. Only the older
        // page/fragment keys may adopt that root's legacy marker.
        if (i < 0 && colon > 0 && !blockKey.StartsWith("style:", StringComparison.Ordinal))
        {
            var legacy = Marker(blockKey[(colon + 1)..]);
            if ((i = css.IndexOf(legacy, StringComparison.Ordinal)) >= 0)
            {
                endMarker = EndMarker(blockKey[(colon + 1)..]);
                report["adoptedLegacy"] = new JsonObject { ["from"] = legacy, ["to"] = begin };
            }
        }
        if (i >= 0)
        {
            var j = css.IndexOf(endMarker, i, StringComparison.Ordinal);
            if (j < 0) throw new InvalidOperationException($"html: the theme stylesheet has an unterminated block for {blockKey}");
            css = css[..i] + block + css[(j + endMarker.Length)..];
        }
        else css = css.TrimEnd().Length == 0 ? block + "\n" : css.TrimEnd() + "\n\n" + block + "\n";
        css = TopImports(css, report);
        // T18: an absolute url to an OutSystems environment host the block brings (one the theme did not have) is refused.
        var before = sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet ?? "";
        if (ThemeCss.Introduced(before, css, $"html {blockKey}: the theme {TypeResolver.Name(theme)}") is { } refusal) throw refusal;
        // The author's CSS of a reactive theme: the one write path (a theme with Theme Editor CSS also selects in the canvas).
        if (sheet != null) ThemeCss.WriteAuthor(sheet, css, canvas: true); else ThemeCss.Write(theme, css);
        report["installed"] = true; report["scopedChars"] = scopedCss.Length;
        // The basedOn of the theme now: a css op later in the same job names it.
        report["basedOn"] = ThemeCss.BasedOn(theme);
        if (sheet != null && ThemeCss.IsSplit(sheet)) report["half"] = "UserStyleSheet";
        // What the recomposition of a split theme changed in the author CSS around the block (C23, C35), said here too.
        if (sheet != null && ThemeCss.Changed(sheet) is { } changed)
            foreach (var (key, value) in changed) report[key] = value?.DeepClone();
        return TypeResolver.Name(theme) ?? "";
    }

    private static string Marker(string key) => $"/* anvil:html {key} */";
    private static string EndMarker(string key) => $"/* /anvil:html {key} */";

    /// <summary>The @import statements of the author CSS at its top, each once (a block installed again brings its @import again):
    /// the browser ignores an @import after a rule. The text itself when they already are there, once.</summary>
    private static string TopImports(string css, JsonObject report)
    {
        // T18: the import stage of the one pipeline (CssPipeline.TopImports); the theme write settles through the rest of it.
        var (written, hoisted, merged, _) = CssPipeline.TopImports(css);
        if (written == css) return css;
        report["cssImportsHoisted"] = new JsonArray(hoisted.Select(x => x.Statement).Distinct(StringComparer.Ordinal).Select(s => (JsonNode)s).ToArray());
        return written;
    }

    private static IEnumerable<object> Sequence(object? value, string property) => value != null && ModelHost.Prop(value, property) is IEnumerable sequence ? sequence.Cast<object>() : [];
}
