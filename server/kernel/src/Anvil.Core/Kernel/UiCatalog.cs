using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using OutSystems.Model;
using OutSystems.Model.Data;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Nodes;
using OutSystems.Model.UI;
using ServiceStudio.Model;

namespace Anvil.Core;

// ----------------------------------------------------------------------------------------------------------------
// Catalogo de UI: o acervo de blocos de um modulo de biblioteca (OutSystemsUI, OutSystemsUIWeb, RichWidgets, ou
// qualquer biblioteca do cliente) lido do OML pelo runtime headless. Para cada bloco: contrato (inputs, tipos,
// defaults, obrigatoriedade, descricoes), placeholders, eventos, blocos que usa por dentro, scripts exigidos,
// JavaScript (do bloco e dos nos JS das suas actions), APIs OSUI chamadas, CSS proprio (classes e variaveis).
// Do modulo: static entities (valores de configuracao), structures, actions publicas, scripts e temas (tokens).
// Nada disto e conhecimento de treino de uma LLM: e gerado do ambiente, por versao, e serve de referencia
// (JSON + markdown) para quem constroi telas com os verbos.
// ----------------------------------------------------------------------------------------------------------------

public sealed record UiParam(string Name, string Type, bool Mandatory, string? Default, string? Description);
public sealed record UiEvent(string Name, bool Mandatory, string? Description, IReadOnlyList<UiParam> Params);
public sealed record UiPlaceholder(string Name, string? Description, string Path, IReadOnlyList<string> Defaults);
public sealed record UiJs(string Action, string Node, string Code);
public sealed record UiBlock(
    string Name, string Module, string Runtime, string Flow, bool Public, string? Description,
    IReadOnlyList<UiParam> Inputs, IReadOnlyList<UiEvent> Events, IReadOnlyList<UiPlaceholder> Placeholders,
    IReadOnlyList<string> Uses, IReadOnlyList<string> RequiredScripts, IReadOnlyList<string> Lifecycle, IReadOnlyList<string> Actions, IReadOnlyList<string> Calls,
    string? Css, IReadOnlyList<string> CssClasses, IReadOnlyList<string> CssVars,
    string? JavaScript, IReadOnlyList<UiJs> JsNodes, IReadOnlyList<string> OsuiApi, int Widgets);
public sealed record UiRecord(string Id, IReadOnlyDictionary<string, string> Values);
public sealed record UiStaticEntity(string Name, string? Description, IReadOnlyList<string> Attributes, IReadOnlyList<UiRecord> Records);
public sealed record UiStructure(string Name, string? Description, IReadOnlyList<UiParam> Attributes);
public sealed record UiAction(string Name, string Kind, bool Public, bool Function, string? Description, IReadOnlyList<UiParam> Inputs, IReadOnlyList<UiParam> Outputs, IReadOnlyList<string> Calls, IReadOnlyList<string> OsuiApi);
public sealed record UiScript(string Name, bool Public, string? Description, int Bytes, string? File);
public sealed record UiTheme(string Name, string Runtime, string? BaseTheme, int CssBytes, string? File, IReadOnlyDictionary<string, string> Tokens);
public sealed record UiModule(
    string Name, string Kind, string? Version, string? Description, string Key, string GeneratedAt, string Source,
    IReadOnlyList<UiBlock> Blocks, IReadOnlyList<UiStaticEntity> StaticEntities, IReadOnlyList<UiStructure> Structures,
    IReadOnlyList<UiAction> Actions, IReadOnlyList<UiScript> Scripts, IReadOnlyList<UiTheme> Themes, IReadOnlyList<string> References);

public static class UiCatalog
{
    private static readonly Regex VersionRx = new(@"\b(\d+\.\d+\.\d+)\b", RegexOptions.Compiled);
    private static readonly Regex CssClassRx = new(@"\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)", RegexOptions.Compiled);
    private static readonly Regex CssVarRx = new(@"(--[A-Za-z0-9_-]+)", RegexOptions.Compiled);
    private static readonly Regex CssTokenRx = new(@"(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);", RegexOptions.Compiled);
    private static readonly Regex OsuiRx = new(@"\b((?:OutSystems|OSFramework)\.OSUI(?:\.[A-Za-z0-9_]+)+)", RegexOptions.Compiled);

    /// <summary>Gera o catalogo de um OML de biblioteca de UI. assetsDir recebe CSS de temas e scripts inteiros (grandes, ficam locais).</summary>
    public static UiModule Build(ModelHost host, string omlPath, string? assetsDir, Action<string>? log = null)
    {
        var espace = host.Load(File.ReadAllBytes(omlPath));
        try
        {
            var es = (IESpace)espace;
            var name = TypeResolver.Name(es) ?? Path.GetFileNameWithoutExtension(omlPath);
            var desc = Prop(es, "Description") as string;
            var version = desc == null ? null : VersionRx.Match(desc) is { Success: true } m ? m.Groups[1].Value : null;
            var kind = es.Kind.ToString();
            log?.Invoke($"{name} ({kind}) v{version ?? "?"}: lendo blocos...");
            var assets = assetsDir == null ? null : Path.Combine(assetsDir, name);
            if (assets != null) Directory.CreateDirectory(assets);

            var blocks = new List<UiBlock>();
            foreach (var flow in es.MobileFlows)
                foreach (var b in flow.Nodes.OfType<OutSystems.Model.UI.Mobile.IMobileBlock>())
                    blocks.Add(ReadBlock(b, name, "Reactive/Mobile", TypeResolver.Name(flow) ?? "", isWeb: false));
            foreach (var flow in es.WebFlows)
                foreach (var b in flow.Nodes.OfType<OutSystems.Model.UI.Web.IWebBlock>())
                    blocks.Add(ReadBlock(b, name, "Traditional", TypeResolver.Name(flow) ?? "", isWeb: true));
            log?.Invoke($"  {blocks.Count} blocos ({blocks.Count(b => b.Public)} publicos)");

            var statics = new List<UiStaticEntity>();
            var structures = new List<UiStructure>();
            foreach (var e in es.Entities.OfType<IStaticEntity>())
            {
                var attrs = e.Attributes.Select(a => TypeResolver.Name(a) ?? "").ToList();
                var records = e.Records.Select(r => new UiRecord(r.Identifier,
                    r.AttributeValues.ToDictionary(v => TypeResolver.Name(v.Attribute) ?? "", v => v.Value?.Text ?? ""))).ToList();
                statics.Add(new UiStaticEntity(TypeResolver.Name(e) ?? "", Prop(e, "Description") as string, attrs, records));
            }
            foreach (var s in es.Structures)
                structures.Add(new UiStructure(TypeResolver.Name(s) ?? "", s.Description,
                    s.Attributes.Select(a => new UiParam(TypeResolver.Name(a) ?? "", TypeName(Prop(a, "DataType")), Prop(a, "IsMandatory") is true, ExprText(Prop(a, "DefaultValue")), Prop(a, "Description") as string)).ToList()));

            var actions = new List<UiAction>();
            foreach (var a in es.ClientActions) actions.Add(ReadAction(a, "ClientAction", a.Public, a.Function));
            foreach (var a in es.ServerActions) actions.Add(ReadAction(a, "ServerAction", Prop(a, "Public") is true, Prop(a, "Function") is true));

            var scripts = new List<UiScript>();
            foreach (var s in es.Scripts)
            {
                var js = s.JavaScript ?? "";
                string? file = null;
                if (assets != null && js.Length > 0) { file = Path.Combine(assets, "scripts", Safe(TypeResolver.Name(s) ?? "script") + ".js"); Directory.CreateDirectory(Path.GetDirectoryName(file)!); File.WriteAllText(file, js); }
                scripts.Add(new UiScript(TypeResolver.Name(s) ?? "", s.Public, s.Description, Encoding.UTF8.GetByteCount(js), file));
            }

            var themes = new List<UiTheme>();
            foreach (var t in es.MobileThemes.Cast<object>().Concat(es.WebThemes.Cast<object>()))
            {
                var css = (t as ITheme)?.StyleSheet ?? Prop(t, "StyleSheet") as string ?? "";
                var tname = TypeResolver.Name(t) ?? "";
                string? file = null;
                if (assets != null && css.Length > 0) { file = Path.Combine(assets, "themes", Safe(tname) + ".css"); Directory.CreateDirectory(Path.GetDirectoryName(file)!); File.WriteAllText(file, css); }
                var tokens = new Dictionary<string, string>();
                foreach (Match tm in CssTokenRx.Matches(css)) tokens.TryAdd(tm.Groups[1].Value, tm.Groups[2].Value.Trim());
                themes.Add(new UiTheme(tname, t is OutSystems.Model.UI.Web.IWebTheme ? "Traditional" : "Reactive/Mobile", TypeResolver.Name(Prop(t, "BaseTheme")), Encoding.UTF8.GetByteCount(css), file, tokens));
            }

            var refs = es.References.Select(r => r.Name).ToList();
            blocks = CloseOsuiApis(blocks, actions);
            return new UiModule(name, kind, version, desc, es.Key.ToString() ?? "", DateTime.Now.ToString("s"), Path.GetFileName(omlPath),
                blocks, statics, structures, actions, scripts, themes, refs);
        }
        finally { try { ((IESpace)espace).Close(); } catch { } }
    }

    private static UiBlock ReadBlock(IBlock b, string module, string runtime, string flow, bool isWeb)
    {
        var sig = (IObjectSignature)b;
        var inputs = b.InputParameters.Select(ReadParam).ToList();
        var events = b.Events.Select(e => new UiEvent(TypeResolver.Name(e) ?? "", e.IsMandatory, e.Description, e.InputParameters.Select(ReadParam).ToList())).ToList();
        var placeholders = new List<UiPlaceholder>();
        if (isWeb)
            foreach (var p in sig.GetAllDescendantsOfType<OutSystems.Model.UI.Web.Widgets.IPlaceholderWidget>())
                placeholders.Add(new UiPlaceholder(p.Name ?? "", p.Description, PathOf(p, b), Defaults(p)));
        else
            foreach (var p in sig.GetAllDescendantsOfType<OutSystems.Model.UI.Mobile.Widgets.IPlaceholderWidget>())
                placeholders.Add(new UiPlaceholder(p.Name ?? "", p.Description, PathOf(p, b), Defaults(p)));
        var uses = new List<string>();
        foreach (var w in sig.GetAllDescendantsOfType<OutSystems.Model.UI.Mobile.Widgets.IMobileBlockInstanceWidget>())
            if (TypeResolver.Name(w.SourceBlock) is { } n && !uses.Contains(n)) uses.Add(n);
        foreach (var w in sig.GetAllDescendantsOfType<OutSystems.Model.UI.Web.Widgets.IWebBlockInstanceWidget>())
            if (TypeResolver.Name(w.SourceBlock) is { } n && !uses.Contains(n)) uses.Add(n);
        var required = (Prop(b, "RequiredScripts") as System.Collections.IEnumerable)?.Cast<object>().Select(s => TypeResolver.Name(s) ?? "").ToList() ?? new List<string>();
        var lifecycle = new List<string>();
        foreach (var l in new[] { "OnInitialize", "OnParametersChanged", "OnReady", "OnRender", "OnDestroy" })
            if (Prop(b, l) is { } ev && TypeResolver.Name(Prop(ev, "Destination")) is { } dest) lifecycle.Add($"{l} -> {dest}");
        var actions = (Prop(b, "ScreenActions") as System.Collections.IEnumerable)?.Cast<object>().Select(a => TypeResolver.Name(a) ?? "").ToList() ?? new List<string>();
        var css = b.StyleSheet;
        var classes = new List<string>();
        var vars = new List<string>();
        if (!string.IsNullOrEmpty(css))
        {
            foreach (Match m in CssClassRx.Matches(css)) if (!classes.Contains(m.Groups[1].Value)) classes.Add(m.Groups[1].Value);
            foreach (Match m in CssVarRx.Matches(css)) if (!vars.Contains(m.Groups[1].Value)) vars.Add(m.Groups[1].Value);
        }
        var jsNodes = new List<UiJs>();
        var api = new List<string>();
        foreach (var n in sig.GetAllDescendantsOfType<IJavaScriptNode>())
        {
            var code = n.JavaScript ?? "";
            jsNodes.Add(new UiJs(OwnerAction(n), n.Name ?? "", code));
            foreach (Match m in OsuiRx.Matches(code)) if (!api.Contains(m.Groups[1].Value)) api.Add(m.Groups[1].Value);
        }
        if (!string.IsNullOrEmpty(b.JavaScript))
            foreach (Match m in OsuiRx.Matches(b.JavaScript)) if (!api.Contains(m.Groups[1].Value)) api.Add(m.Groups[1].Value);
        var widgets = sig.GetAllDescendantsOfType<IWidget>().Count();
        var calls = Calls(sig, actions);
        return new UiBlock(TypeResolver.Name(b) ?? "", module, runtime, flow, b.Public, b.Description, inputs, events, placeholders, uses, required, lifecycle, actions, calls,
            string.IsNullOrEmpty(css) ? null : css, classes, vars, string.IsNullOrEmpty(b.JavaScript) ? null : b.JavaScript, jsNodes, api, widgets);
    }

    private static UiAction ReadAction(IAction a, string kind, bool isPublic, bool isFunction)
    {
        var api = new List<string>();
        foreach (var n in ((IObjectSignature)a).GetAllDescendantsOfType<IJavaScriptNode>())
            foreach (Match m in OsuiRx.Matches(n.JavaScript ?? "")) if (!api.Contains(m.Groups[1].Value)) api.Add(m.Groups[1].Value);
        return new UiAction(TypeResolver.Name(a) ?? "", kind, isPublic, isFunction, Prop(a, "Description") as string,
            a.InputParameters.Select(ReadParam).ToList(),
            a.OutputParameters.Select(p => new UiParam(TypeResolver.Name(p) ?? "", TypeName(Prop(p, "DataType")), false, null, p.Description)).ToList(),
            Calls((IObjectSignature)a, Array.Empty<string>()), api);
    }

    /// <summary>Actions do modulo chamadas (Execute*Action) a partir de um objeto, excluindo as proprias actions do bloco.</summary>
    private static List<string> Calls(IObjectSignature root, IReadOnlyList<string> own)
    {
        var calls = new List<string>();
        foreach (var n in root.GetAllDescendantsOfType<IObjectSignature>())
        {
            if (!n.GetType().Name.Contains("Execute")) continue;
            var target = Prop(n, "Action");
            var name = TypeResolver.Name(target);
            if (string.IsNullOrEmpty(name) || own.Contains(name) || calls.Contains(name)) continue;
            calls.Add(name);
        }
        return calls;
    }

    /// <summary>Fecho transitivo: APIs OSUI que um bloco alcanca pelas actions do modulo que chama.</summary>
    private static List<UiBlock> CloseOsuiApis(List<UiBlock> blocks, List<UiAction> actions)
    {
        var byName = actions.GroupBy(a => a.Name).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        var result = new List<UiBlock>();
        foreach (var b in blocks)
        {
            var api = new List<string>(b.OsuiApi);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var queue = new Queue<string>(b.Calls);
            while (queue.Count > 0)
            {
                var n = queue.Dequeue();
                if (!seen.Add(n) || !byName.TryGetValue(n, out var a)) continue;
                foreach (var x in a.OsuiApi) if (!api.Contains(x)) api.Add(x);
                foreach (var c in a.Calls) queue.Enqueue(c);
            }
            result.Add(b with { OsuiApi = api });
        }
        return result;
    }

    private static UiParam ReadParam(IInputParameter p) =>
        new(TypeResolver.Name(p) ?? "", TypeName(Prop(p, "DataType")), p.IsMandatory, ExprText(Prop(p, "DefaultValue")), p.Description);

    /// <summary>Widgets que o placeholder traz na definicao do bloco: e o que aparece ao instanciar (Tabs: 3 TabsHeaderItem).</summary>
    private static List<string> Defaults(IObjectSignature placeholder)
    {
        var list = new List<string>();
        foreach (var c in placeholder.Children)
        {
            if (c is not IWidget) continue;
            var src = TypeResolver.Name(Prop(c, "SourceBlock"));
            list.Add(src != null ? $"{c.GetType().Name.Replace("Widget", "")}:{src}" : c.GetType().Name.Replace("Widget", "") + (TypeResolver.Name(c) is { Length: > 0 } n ? ":" + n : ""));
        }
        return list;
    }

    private static string OwnerAction(IObjectSignature n)
    {
        var cur = n.Parent;
        while (cur != null && cur is not IAction) cur = cur.Parent;
        return cur == null ? "" : TypeResolver.Name(cur) ?? "";
    }

    private static string PathOf(IObjectSignature p, IBlock root)
    {
        var parts = new List<string>();
        var cur = p.Parent;
        while (cur != null && !ReferenceEquals(cur, root))
        {
            var n = TypeResolver.Name(cur);
            if (!string.IsNullOrEmpty(n)) parts.Add(n);
            cur = cur.Parent;
        }
        parts.Reverse();
        return string.Join("/", parts);
    }

    internal static string TypeName(object? type)
    {
        if (type == null) return "";
        if (type is OutSystems.Model.Types.IListType lt) return TypeName(lt.ElementType) + " List";
        if (type is OutSystems.Model.Types.IIdentifierType it) return (TypeResolver.Name(it.Entity) ?? "?") + " Identifier";
        return Prop(type, "DisplayName") as string ?? TypeResolver.Name(type) ?? type.GetType().Name;
    }

    private static string? ExprText(object? v) => v switch { null => null, IExpression e => e.Text, string s => s, _ => v.ToString() };
    /// <summary>Le uma propriedade pela classe concreta ou, se for implementacao explicita, por qualquer interface publica que a declare.</summary>
    internal static object? Prop(object? o, string name)
    {
        if (o == null) return null;
        try
        {
            var pi = o.GetType().GetProperty(name);
            if (pi != null && pi.GetIndexParameters().Length == 0) return pi.GetValue(o);
            foreach (var i in o.GetType().GetInterfaces())
            {
                var ip = i.GetProperty(name);
                if (ip != null && ip.GetIndexParameters().Length == 0) return ip.GetValue(o);
            }
        }
        catch { }
        return null;
    }
    private static string Safe(string s) { foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_'); return s; }

    public static void WriteJson(UiModule m, string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllText(path, JsonSerializer.Serialize(m, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
    }

    public static UiModule ReadJson(string path) => JsonSerializer.Deserialize<UiModule>(File.ReadAllText(path))!;

    /// <summary>Resumo para o terminal.</summary>
    public static object Summary(UiModule m) => new
    {
        m.Name, m.Kind, m.Version,
        Blocks = m.Blocks.Count, PublicBlocks = m.Blocks.Count(b => b.Public),
        Flows = m.Blocks.GroupBy(b => b.Flow).ToDictionary(g => g.Key, g => g.Count()),
        Inputs = m.Blocks.Sum(b => b.Inputs.Count), Events = m.Blocks.Sum(b => b.Events.Count), Placeholders = m.Blocks.Sum(b => b.Placeholders.Count),
        JsNodes = m.Blocks.Sum(b => b.JsNodes.Count), OsuiApis = m.Blocks.SelectMany(b => b.OsuiApi).Distinct().Count(),
        BlocksWithCss = m.Blocks.Count(b => b.Css != null),
        StaticEntities = m.StaticEntities.Count, Structures = m.Structures.Count, PublicActions = m.Actions.Count(a => a.Public),
        Scripts = m.Scripts.Count, Themes = m.Themes.Select(t => new { t.Name, t.CssBytes, Tokens = t.Tokens.Count }),
    };
}
