using System.Text.Json.Nodes;

namespace Anvil.Core;

// B4 (the proto line's lote 4, frente F2: 0abbad00, 9daca5c2): the chain of themes a page shows and where the CSS of a set
// StyleSheet lands and what serves it at runtime (Verbs.CssPlacement.cs reads it at the end of the apply).
public static partial class ThemeCss
{
    /// <summary>A theme of the chain a page shows: the object, the name, the producer module (null when it is of this module; the
    /// name of the Reference its signature hangs from) and the CSS the capture has of it (the effective one; in the signature of a
    /// referenced theme, the producer's CSS at the reference's version), null when there is no readable CSS.</summary>
    public sealed record ChainTheme(OutSystems.Model.IObjectSignature Theme, string? Name, string? Producer, string? Css);

    /// <summary>The chain of themes from <paramref name="start"/> through <c>BaseTheme</c>, the shown theme first and the base
    /// last, each theme once. A theme of another module does NOT end the chain: the signature the consumer keeps has the producer's
    /// <c>StyleSheet</c> and its <c>BaseTheme</c> (relato 90a697c3: PMAI_Operations shows PMAI_Theme, whose classes the warning
    /// gave as without a rule).</summary>
    public static List<ChainTheme> Chain(OutSystems.Model.IObjectSignature? start)
    {
        var chain = new List<ChainTheme>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var at = start; at != null && seen.Add(at.ObjectKey?.ToString() ?? System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(at).ToString(System.Globalization.CultureInfo.InvariantCulture)); )
        {
            string? css;
            // The signature of a referenced theme may have an empty native sheet and the CSS only in the Model API's StyleSheet.
            try { css = Of(at) is { EffectiveValue: { Length: > 0 } effective } ? effective : ApiText(at, "StyleSheet"); }
            catch { css = null; }
            chain.Add(new(at, TypeResolver.Name(at), ProducerOf(at), string.IsNullOrEmpty(css) ? null : css));
            OutSystems.Model.IObjectSignature? next;
            try { next = ModelHost.Prop(at, "BaseTheme") as OutSystems.Model.IObjectSignature; } catch { next = null; }
            at = next;
        }
        return chain;
    }

    public const string TargetUnserved = "CSS_TARGET_UNSERVED";

    private static bool Implements(object o, params string[] names) => o.GetType().GetInterfaces().Any(i => names.Contains(i.Name));
    private static string Key(OutSystems.Model.IObjectSignature o) => o.ObjectKey?.ToString() ?? "";
    private static bool Same(object? a, OutSystems.Model.IObjectSignature b) => a is OutSystems.Model.IObjectSignature o && (ReferenceEquals(o, b) || Key(o).Length > 0 && Key(o) == Key(b));

    /// <summary>Where the CSS of a <c>set StyleSheet</c> landed and what serves it at runtime (relatos 8ea13c21, 31a4b527,
    /// 0e627037: the delivery said success and the runtime did not show the CSS). Reads the model as the job leaves it:
    /// <list type="bullet">
    /// <item>theme: the half written, whether it is the module's default theme, the flows that show it (the flow's <c>Theme</c>,
    /// or the default one when the flow has none; also as the <c>BaseTheme</c> of a shown theme), whether it is public (consumers
    /// show it through their own themes, once they refresh the reference and are published);</item>
    /// <item>block: the screens and blocks that place it, whether it is public, and the resource the runtime loads
    /// (<c>Module.Flow.Block.css</c>, regenerated only when a widget of the block changes: the kernel's touch, StyleSheetTouch);</item>
    /// <item>screen: the chain of themes it shows, with the module of each.</item>
    /// </list>
    /// <c>served</c> false: no page of this module and no consumer reaches that CSS.</summary>
    public static JsonObject Placement(OutSystems.Model.IObjectSignature target, OutSystems.Model.IObjectSignature module)
    {
        var placement = new JsonObject();
        var flows = module.Children.OfType<OutSystems.Model.IObjectSignature>().Where(c => Implements(c, "IMobileFlow", "IWebFlow")).ToList();
        var defaultTheme = (ModelHost.Prop(module, "EffectiveDefaultTheme") ?? ModelHost.Prop(module, "DefaultMobileTheme") ?? ModelHost.Prop(module, "DefaultTheme")) as OutSystems.Model.IObjectSignature;
        OutSystems.Model.IObjectSignature? Shown(OutSystems.Model.IObjectSignature flow) => ModelHost.Prop(flow, "Theme") as OutSystems.Model.IObjectSignature ?? defaultTheme;
        JsonArray Names(IEnumerable<ChainTheme> chain) => new(chain.Select(t => (JsonNode)JsonValue.Create((t.Producer != null ? t.Producer + "." : "") + t.Name)!).ToArray());
        var isPublic = ModelHost.Prop(target, "Public") is true;
        if (Implements(target, "IMobileTheme", "IWebTheme", "ITheme"))
        {
            placement["object"] = "theme";
            placement["name"] = TypeResolver.Name(target);
            if (Of(target) is { } sheet) placement["half"] = IsSplit(sheet) ? "UserStyleSheet" : "StyleSheet";
            var isDefault = defaultTheme != null && Same(defaultTheme, target);
            placement["moduleDefault"] = isDefault;
            var served = new JsonArray();
            foreach (var flow in flows)
            {
                if (Shown(flow) is not { } shown) continue;
                var chain = Chain(shown);
                var at = chain.FindIndex(t => Same(t.Theme, target));
                if (at < 0) continue;
                var own = ModelHost.Prop(flow, "Theme") is not null;
                served.Add(new JsonObject
                {
                    ["flow"] = TypeResolver.Name(flow), ["theme"] = TypeResolver.Name(shown),
                    ["via"] = at > 0 ? "BaseTheme of " + TypeResolver.Name(shown) : own ? "the flow's Theme" : "the module's default theme",
                    ["pages"] = flow.Children.OfType<OutSystems.Model.IObjectSignature>().Count(c => Implements(c, "IMobileScreen", "IWebScreen")),
                });
            }
            placement["servedBy"] = served;
            placement["public"] = isPublic;
            placement["served"] = isDefault || served.Count > 0 || isPublic;
            if (isPublic) placement["consumers"] = "public: a consumer shows it through its own themes once it refreshes the reference and is published";
            if (placement["served"]!.GetValue<bool>() == false)
            {
                var shownThemes = flows.Select(Shown).OfType<OutSystems.Model.IObjectSignature>().Concat(defaultTheme != null ? [defaultTheme] : [])
                    .GroupBy(Key).Select(g => TypeResolver.Name(g.First())).Where(n => n != null).Distinct().ToList();
                placement["why"] = "no page of this module shows this theme: it is not the module's default theme, no UI flow has it as Theme "
                    + "and it is the BaseTheme of no theme a flow shows; it is not public, so no consumer shows it either";
                placement["shownThemes"] = new JsonArray(shownThemes.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray());
            }
            return placement;
        }
        var flowOf = target.Parent as OutSystems.Model.IObjectSignature;
        if (Implements(target, "IMobileBlock", "IWebBlock"))
        {
            placement["object"] = "block";
            placement["name"] = TypeResolver.Name(target);
            var placedIn = new List<string>();
            foreach (var flow in flows)
                foreach (var root in flow.Children.OfType<OutSystems.Model.IObjectSignature>().Where(c => Implements(c, "IMobileScreen", "IWebScreen", "IMobileBlock", "IWebBlock")))
                    if (!ReferenceEquals(root, target) && root.GetAllDescendantsOfType<OutSystems.Model.IObjectSignature>()
                        .Any(d => Implements(d, "IMobileBlockInstanceWidget", "IWebBlockInstanceWidget") && Same(ModelHost.Prop(d, "SourceBlock"), target)))
                        placedIn.Add(TypeResolver.Name(root) ?? Key(root));
            placement["placedIn"] = new JsonArray(placedIn.Take(10).Select(n => (JsonNode)JsonValue.Create(n)!).ToArray());
            placement["placements"] = placedIn.Count;
            placement["public"] = isPublic;
            placement["resource"] = $"{TypeResolver.Name(module)}.{(flowOf != null ? TypeResolver.Name(flowOf) : "?")}.{TypeResolver.Name(target)}.css";
            placement["served"] = placedIn.Count > 0 || isPublic;
            if (!placement["served"]!.GetValue<bool>())
                placement["why"] = "no screen or block of this module places this block and it is not public: its style sheet is loaded by no page";
            return placement;
        }
        placement["object"] = Implements(target, "IMobileScreen", "IWebScreen") ? "screen" : "other";
        placement["name"] = TypeResolver.Name(target);
        if (flowOf != null && Implements(flowOf, "IMobileFlow", "IWebFlow") && Shown(flowOf) is { } theme)
        {
            placement["resource"] = $"{TypeResolver.Name(module)}.{TypeResolver.Name(flowOf)}.{TypeResolver.Name(target)}.css";
            placement["themes"] = Names(Chain(theme));
        }
        placement["served"] = true;
        return placement;
    }

    // The text value of a Model API property: the interface first, because the concrete class has a StyleSheet of the same name
    // that returns the sheet (WebStyleSheet), not the text.
    private static string? ApiText(object target, string name)
    {
        foreach (var i in target.GetType().GetInterfaces())
            if (i.GetProperty(name) is { PropertyType: var type } p && type == typeof(string)) return p.GetValue(target) as string;
        return target.GetType().GetProperty(name)?.GetValue(target) as string;
    }

    /// <summary>The producer module of a referenced element: the name of the Reference it hangs from (null for an element of this
    /// module).</summary>
    public static string? ProducerOf(OutSystems.Model.IObjectSignature element)
    {
        for (var up = element.Parent as OutSystems.Model.IObjectSignature; up != null; up = up.Parent as OutSystems.Model.IObjectSignature)
            if (up.GetType().Name.StartsWith("Reference", StringComparison.Ordinal) || up.GetType().GetInterfaces().Any(i => i.Name == "IReference"))
                return TypeResolver.Name(up);
        return null;
    }
}
