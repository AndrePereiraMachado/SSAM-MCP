using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// A16 receipt of create-app/add-modules: whether a saved module has the LayoutBlank block (its own, or referenced from
/// the theme module) and the Content placeholder inside it. A UI module from the application template has both; a blank
/// UI module has neither, and every screen job on it then fails at LayoutBlank (session of 06/10: three DELIVERY_FAILED).
/// Read from the model only, by interface names (Reactive blocks are IMobileBlock, Traditional ones IWebBlock).
/// </summary>
public static class ModuleLayout
{
    /// <summary>The template value of a module created without the application template.</summary>
    public const string Blank = "blank";
    public const string LayoutBlankName = "LayoutBlank";
    public const string ContentName = "Content";

    public static (bool LayoutBlank, bool Content) Inspect(IESpace espace)
    {
        var blocks = espace.GetAllDescendantsOfType<IObjectSignature>().Where(IsBlock)
            .Concat(espace.References.SelectMany(r => ((IObjectSignature)r).GetAllDescendantsOfType<IObjectSignature>().Where(IsBlock)));
        var layout = blocks.FirstOrDefault(b => string.Equals(TypeResolver.Name(b), LayoutBlankName, StringComparison.Ordinal));
        if (layout == null) return (false, false);
        var content = layout.GetAllDescendantsOfType<IObjectSignature>()
            .Any(o => IsPlaceholder(o) && string.Equals(TypeResolver.Name(o), ContentName, StringComparison.Ordinal));
        return (true, content);
    }

    /// <summary>Inspect over a saved OML, released after the read.</summary>
    public static (bool LayoutBlank, bool Content) InspectOml(ModelHost host, string oml)
    {
        var model = host.Load(oml);
        try { return Inspect((IESpace)model); }
        finally { ModelHost.Release(model); }
    }

    private static bool Implements(object o, params string[] names) => o.GetType().GetInterfaces().Any(i => names.Contains(i.Name));
    private static bool IsBlock(IObjectSignature o) => Implements(o, "IMobileBlock", "IWebBlock", "IMobileBlockSignature", "IWebBlockSignature");
    private static bool IsPlaceholder(IObjectSignature o) => Implements(o, "IPlaceholderWidget", "IPlaceholderWidgetSignature");
}
