using System.Text.Json.Nodes;
using OutSystems.Model;
namespace Anvil.Core;

/// <summary>Seams between the prototype compiler lanes (docs/PROTOTIPO-NATIVO.md, section 7.3). The html lane owns the
/// element-to-widget map, the compile lane builds the module, the css lane composes the theme stylesheet and renders the
/// built model back to DOM for the fidelity measure.</summary>
public sealed record PrototypeCssRequest(
    JsonObject Capture,
    string BundleRoot,
    string Platform,
    string ModuleName,
    IReadOnlyDictionary<string, string> AssetUrls,
    IReadOnlyDictionary<string, string> IdClasses,
    IReadOnlyList<string> SubstitutedTags,
    IReadOnlyDictionary<string, WidgetNode> Roots);

public sealed record PrototypeCssResult(string StyleSheet, IReadOnlyDictionary<string, string> IconClasses, JsonObject Report);

/// <summary>One compiled widget: W is the Model API widget type, K the source node key of the capture, Children in order.
/// Attributes as [name, value] pairs; Expr/If/List carry the capture annotations unchanged.</summary>
public sealed record WidgetNode(
    string W,
    string? K,
    string? Tag,
    string? Style,
    IReadOnlyList<(string Name, string Value)> Attributes,
    string? Text,
    JsonNode? Expr,
    JsonNode? If,
    JsonNode? List,
    IReadOnlyList<WidgetNode> Children,
    IReadOnlyList<WidgetNode>? Else = null,
    string? Role = null);

/// <summary>One source element to map. Platform is "o11" or "odc".</summary>
public sealed record ElementRequest(
    string Platform,
    string Tag,
    IReadOnlyList<(string Name, string Value)> Attributes,
    bool Clickable,
    bool Icon,
    bool InsideForm,
    bool HasElementChildren);

/// <summary>The single element-to-widget decision shared by the html op and the prototype importer.</summary>
public sealed record ElementMapping(
    string Widget,
    string? Tag,
    string? Name,
    IReadOnlyList<(string Property, string Value)> Properties,
    IReadOnlyList<(string Name, string Value)> ExtendedProperties,
    IReadOnlyList<string> Classes,
    string? SubstitutedFrom,
    string? Problem);

/// <summary>Roots of the built module read back after the Verify: "shell", "v:&lt;view&gt;", "m:&lt;modal&gt;".</summary>
public sealed record PrototypeRenderRequest(
    JsonObject Capture,
    string Platform,
    IReadOnlyDictionary<string, IObjectSignature> Roots);

public static class PrototypeSeams
{
    public static Func<ElementRequest, ElementMapping>? Element { get; set; }
    public static Func<PrototypeCssRequest, PrototypeCssResult>? Css { get; set; }
    public static Func<PrototypeRenderRequest, JsonObject>? Render { get; set; }
    public static Func<JsonObject, int, IEnumerable<JsonObject>>? Preflight { get; set; }
}
