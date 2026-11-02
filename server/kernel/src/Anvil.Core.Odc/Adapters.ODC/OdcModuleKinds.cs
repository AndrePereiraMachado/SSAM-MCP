using OutSystems.Model.Enumerations;

namespace Anvil.Core;

/// <summary>The one place that says which ODC module kinds are libraries and which are apps (SegmentationKind of a module
/// or of a captured producer's ModuleType). OdcAppFactory and OdcReferenceImporter both ask here.</summary>
public static class OdcModuleKinds
{
    /// <summary>An ODC library: a Library (ReactiveLibrary) or a Mobile Library, the two the Studio's NewLibrary creates.</summary>
    public static bool IsLibrary(SegmentationKind kind) => kind is SegmentationKind.ReactiveLibrary or SegmentationKind.MobileLibrary;

    /// <summary>An ODC app, by an explicit list: Reactive (CrossDevice), Mobile and Agentic (AIAgent), the kinds
    /// OdcAppFactory creates. WebResponsive is not in it: it is the default value (0) of a capture that carries no
    /// ModuleType, and ODC refuses it (OS-APPS-40015); a capture without the kind keeps the native path.</summary>
    public static bool IsApp(SegmentationKind kind) => kind is SegmentationKind.CrossDevice or SegmentationKind.Mobile or SegmentationKind.AIAgent;

    /// <summary>The product word of a kind, as the Studio names it.</summary>
    public static string Describe(SegmentationKind kind) => kind switch
    {
        SegmentationKind.CrossDevice => "Reactive app",
        SegmentationKind.Mobile => "Mobile app",
        SegmentationKind.AIAgent => "Agentic app",
        SegmentationKind.ReactiveLibrary => "Library",
        SegmentationKind.MobileLibrary => "Mobile Library",
        _ => kind.ToString(),
    };

    /// <summary>The Studio word of a public element kind of a signature (NativeReferenceSnapshot's ODC kinds).</summary>
    public static string DescribeElement(string kind) => kind switch
    {
        "service-action" => "Service Action",
        "action" => "Server Action",
        "client-action" => "Client Action",
        "entity" => "Entity",
        "structure" => "Structure",
        "block" => "Block",
        _ => kind,
    };

    /// <summary>The refusal of a reference from a library to an app, before any model change: in ODC a library depends
    /// only on Libraries and External Libraries, never on an app (the native import fails without a word,
    /// "did not create the requested producer"). The text names no AI model: the native import refuses one in a library
    /// too (review R2-B1), so the refusal promises nothing the platform refuses. Null when the reference is allowed or the
    /// producer's kind is unknown.</summary>
    public static string? LibraryReferencesApp(SegmentationKind target, string targetName, SegmentationKind producer,
        string producerName, IEnumerable<NativeReferenceElement> elements)
    {
        if (!IsLibrary(target) || !IsApp(producer)) return null;
        var selected = elements.ToArray();
        var names = string.Join(", ", selected.Select(e => DescribeElement(e.Kind) + " " + e.Name));
        var service = selected.Any(e => e.Kind == "service-action")
            ? " To use the app's Service Action, call it from an app, not from a library." : "";
        return "An ODC " + Describe(target) + " can reference only Libraries and External Libraries: " + producerName
            + " is an app (" + Describe(producer) + "), so " + targetName + " cannot reference its " + names + ". Move the shared"
            + " elements into a Library that both " + producerName + " and " + targetName + " reference." + service;
    }
}
