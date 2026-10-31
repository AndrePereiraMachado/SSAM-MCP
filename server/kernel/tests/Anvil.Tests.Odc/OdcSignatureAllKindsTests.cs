using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;
using ServiceStudio.Framework.ReferencesManager;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>The one reader names everything a signature holds: the kinds SSAM binds in Elements, any other (a role, a flow, an event, a
/// tag no Studio had yet) in Others, never dropped. Measured on what the installed Studio publishes for each kind of producer.</summary>
public sealed class OdcSignatureAllKindsTests
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static OdcPublicSignature.Catalog Catalog(SegmentationKind kind, string ops)
    {
        _ = new ModelHost(Path.Combine(Path.GetTempPath(), "capture-bytes", Guid.NewGuid().ToString("N")));
        using var module = Loader.ModelServicesInstance.CreateESpace(kind, "Kinds", targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        new ModelSession((ESpace)module).Apply(JsonNode.Parse(ops)!.AsArray());
        module.Save();
        return OdcPublicSignature.Read(ReferenceInfo.ConvertToReferenceInfo(module).SignatureBinary);
    }

    [Fact]
    public void AnAppSignatureHoldsItsServiceActionsAndNamesItsRoles()
    {
        StudioAssembliesOdc.Bind();
        App();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void App()
    {
        var catalog = Catalog(SegmentationKind.CrossDevice, """
        [{"op":"create","parent":"@espace","type":"IRole","name":"RoleA","as":"$r"},{"op":"set","target":"$r","prop":"Public","value":true},
         {"op":"logic","data":{"actions":[{"name":"Sa","kind":"service","public":true,"steps":[]}]}}]
        """);
        Assert.Contains(catalog.Elements, e => e.Kind == "service-action" && e.Name == "Sa");
        Assert.Contains(catalog.Others, o => o.Tag == "ReferenceRole" && o.Name == "RoleA");
    }

    [Fact]
    public void ALibrarySignatureHoldsItsFourKindsAndNamesItsFlow()
    {
        StudioAssembliesOdc.Bind();
        Library();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Library()
    {
        var catalog = Catalog(SegmentationKind.ReactiveLibrary, """
        [{"op":"create","parent":"@espace","type":"IStructure","name":"St","as":"$s"},{"op":"set","target":"$s","prop":"Public","value":true},
         {"op":"create","parent":"$s","type":"IStructureAttribute","name":"V","as":"$v"},{"op":"set","target":"$v","prop":"DataType","value":"Text"},
         {"op":"create","parent":"@espace","type":"IMobileFlow","name":"Fl","as":"$f"},{"op":"create","parent":"$f","type":"IMobileBlock","name":"Bl","as":"$b"},{"op":"set","target":"$b","prop":"Public","value":true},
         {"op":"logic","data":{"actions":[{"name":"Ca","kind":"client","public":true,"steps":[]},{"name":"Sr","kind":"server","public":true,"steps":[]}]}}]
        """);
        Assert.Equal(["action:Sr", "block:Bl", "client-action:Ca", "structure:St"], catalog.Elements.Select(e => e.Kind + ":" + e.Name).Order(StringComparer.Ordinal));
        Assert.Contains(catalog.Others, o => o.Tag == "NewRuntime.ReferenceWebFlow" && o.Name == "Fl");
    }

    [Fact]
    public void ACaptureIsAnsweredFromItsBytesAndAFileThatIsNoCaptureIsRefused()
    {
        StudioAssembliesOdc.Bind();
        var dir = Path.Combine(Path.GetTempPath(), "capture-bytes", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var not = Path.Combine(dir, "not.avsig"); File.WriteAllText(not, "{\"Elements\":[]}");
        Assert.Throws<ArgumentException>(() => OdcPublicSignature.ReadCapture(not));
        var fixture = Path.Combine(FindRoot(), "tests", "contracts", "native-reference", "text-primitives.avsig");
        var read = OdcPublicSignature.ReadCapture(fixture);
        Assert.Equal("ssam-signature-elements/1", read["schema"]?.ToString());
        Assert.NotEmpty(read["elements"]!.AsArray());
    }

    private static string FindRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Directory.GetParent(dir)!.FullName;
        return dir;
    }
}
