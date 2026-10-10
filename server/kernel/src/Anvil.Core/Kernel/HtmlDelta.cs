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
        var compiled = HtmlExpander.Expand(data, TryRef, Contract, _espace.ESpaceType.ToString(), existing);
        if (screen != null) delta = ClearScreen(screen, screenName, data["layout"]?.ToString() == "blank");
        for (var i = 0; i < compiled.Ops.Count; i++)
        {
            try { ApplyOne(compiled.Ops[i]); }
            catch (Exception ex) { throw new InvalidOperationException($"html op #{i} ({compiled.Ops[i]["op"]} {compiled.Ops[i]["prop"] ?? compiled.Ops[i]["type"]}): {Unwrap(ex)}", ex); }
        }
        var report = compiled.Report.DeepClone().AsObject(); report["expanded"] = compiled.Ops.Count;
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

    /// <summary>Writes the scoped CSS into the module's own default theme between markers named after the screen, so a second
    /// compilation replaces the block instead of appending another copy.</summary>
    private string InstallStylesheet(string screenName, string scopedCss, JsonObject report)
    {
        var defaultTheme = _es.DefaultMobileTheme ?? throw new InvalidOperationException("html: the module has no default theme to carry the stylesheet");
        var theme = _es.MobileThemes.FirstOrDefault(t => t.ObjectKey?.ToString() == defaultTheme.ObjectKey?.ToString())
            ?? throw new InvalidOperationException($"html: the default theme {TypeResolver.Name(defaultTheme)} belongs to another module; the page stylesheet needs a theme owned by this module");
        scopedCss = FormatCode(CodeLanguage.Css, scopedCss, TypeResolver.Name(theme) + ".StyleSheet (html " + screenName + ")");
        var begin = $"/* anvil:html {screenName} */"; var end = $"/* /anvil:html {screenName} */";
        var block = begin + "\n" + scopedCss.TrimEnd() + "\n" + end;
        // O bloco vai para a metade do AUTOR do tema, nunca pela efetiva: num tema com CSS do Theme Editor a efetiva
        // e gerada + autor, e um ciclo ler-efetiva/escrever-efetiva ou perde o marcador ou duplica o bloco gerado.
        var sheet = ThemeCss.Of(theme);
        var css = sheet != null ? ThemeCss.Author(sheet) : theme.StyleSheet ?? "";
        var i = css.IndexOf(begin, StringComparison.Ordinal);
        if (i >= 0)
        {
            var j = css.IndexOf(end, i, StringComparison.Ordinal);
            if (j < 0) throw new InvalidOperationException($"html: the theme stylesheet has an unterminated block for {screenName}");
            css = css[..i] + block + css[(j + end.Length)..];
        }
        else css = css.TrimEnd().Length == 0 ? block + "\n" : css.TrimEnd() + "\n\n" + block + "\n";
        if (sheet != null) ThemeCss.WriteAuthor(sheet, css); else theme.StyleSheet = css;
        report["installed"] = true; report["scopedChars"] = scopedCss.Length;
        if (sheet != null && ThemeCss.IsSplit(sheet)) report["half"] = "UserStyleSheet";
        // What the recomposition of a split theme changed in the author CSS around the block (C23, C35), said here too.
        if (sheet != null && ThemeCss.Changed(sheet) is { } changed)
            foreach (var (key, value) in changed) report[key] = value?.DeepClone();
        return TypeResolver.Name(theme) ?? "";
    }

    private static IEnumerable<object> Sequence(object? value, string property) => value != null && ModelHost.Prop(value, property) is IEnumerable sequence ? sequence.Cast<object>() : [];
}
