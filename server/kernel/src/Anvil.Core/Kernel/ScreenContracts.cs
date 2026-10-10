using System.Collections;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>Only public signatures needed by screen compilation; no CSS/JS or external catalog.</summary>
public sealed record ScreenContract(string Reference, IReadOnlyList<UiParam> Inputs, IReadOnlyList<UiParam> Outputs,
    IReadOnlyList<UiParam> Fields, IReadOnlyList<UiEvent> Events, IReadOnlyList<UiPlaceholder> Placeholders,
    IReadOnlyDictionary<string, IReadOnlyList<UiParam>> OutputFields,
    IReadOnlyDictionary<string, IReadOnlyList<string>> ListChildren);

internal static class ScreenContracts
{
    public static ScreenContract Read(IObjectSignature element, string reference)
    {
        var inputs = Sequence(element, "InputParameters").Select(Parameter).ToArray();
        var outputs = Sequence(element, "OutputParameters").ToArray();
        var events = Sequence(element, "Events").Select(e => new UiEvent(Name(e), ModelHost.Prop(e, "IsMandatory") is true,
            null, Sequence(e, "InputParameters").Select(Parameter).ToArray())).ToArray();
        var placeholders = element.GetAllDescendantsOfType<IObjectSignature>()
            .Where(o => o.GetType().GetInterfaces().Any(i => i.Name is "IPlaceholderWidgetSignature" or "IPlaceholderWidget"))
            .Select(o => new UiPlaceholder(Name(o), null, Name(o), Sequence(o, "Widgets").Select(w =>
                w.GetType().GetInterfaces().Any(i => i.Name is "IList" or "IListSignature" or "IListWidgetSignature") ? "List" : w is IObjectSignature signature ? signature.GetInterface()?.Name ?? w.GetType().Name : w.GetType().Name).ToArray()))
            .GroupBy(p => p.Name).Select(g => g.First()).ToArray();
        var listChildren = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var placeholder in element.GetAllDescendantsOfType<IObjectSignature>().Where(o => o.GetType().GetInterfaces().Any(i => i.Name is "IPlaceholderWidgetSignature" or "IPlaceholderWidget")))
        {
            var lists = Sequence(placeholder, "Widgets").OfType<IObjectSignature>().Where(w => w.GetType().GetInterfaces().Any(i => i.Name is "IList" or "IListSignature" or "IListWidgetSignature")).ToArray();
            if (lists.Length == 1)
                listChildren[Name(placeholder)] = lists[0].Children.Where(w => w.GetType().GetInterfaces().Any(i => i.Name is "IWidget" or "IWidgetSignature" or "IMobileWidget" or "IMobileWidgetSignature"))
                    .Select(w =>
                    {
                        var nr = w.GetType().GetInterfaces().FirstOrDefault(i => i.Namespace == "ServiceStudio.Plugin.NRWidgets" && i.Name.EndsWith("Signature", StringComparison.Ordinal));
                        return nr != null ? nr.FullName![..^"Signature".Length] : w.GetInterface()?.FullName ?? throw new InvalidOperationException("screen: default widget interface is unavailable");
                    }).ToArray();
        }
        return new(reference, inputs, outputs.Select(Parameter).ToArray(), Fields(element), events, placeholders,
            outputs.ToDictionary(Name, o => (IReadOnlyList<UiParam>)Fields(ElementType(ModelHost.Prop(o, "DataType"))), StringComparer.OrdinalIgnoreCase), listChildren);
    }
    private static object? ElementType(object? type) => type is OutSystems.Model.Types.IListType list ? list.ElementType : type;
    private static UiParam[] Fields(object? type) => Sequence(type, "Attributes").Select(Parameter).ToArray();
    private static UiParam Parameter(object p) => new(Name(p), UiCatalog.TypeName(ModelHost.Prop(p, "DataType")),
        ModelHost.Prop(p, "IsMandatory") is true, ModelHost.Prop(p, "DefaultValue") is IExpression e ? e.Text : null, null);
    private static string Name(object p) => ModelHost.Prop(p, "Name") as string ?? "";
    private static IEnumerable<object> Sequence(object? value, string property) => value != null && ModelHost.Prop(value, property) is IEnumerable sequence ? sequence.Cast<object>() : [];
}
