using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane F8 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md, A16): create-app {blank:true} made the UI and the
/// back office as empty modules (no theme, no layouts, no LayoutBlank), the description printed "CrossDevice" and the
/// receipt said nothing about it (session of 06/10, 12:57: three DELIVERY_FAILED of LayoutBlank, then delete and
/// recreate). The kernel now refuses blank for UI modules before anything reaches the environment, names the module type
/// as the Studio does and the receipt lists, per module, the template and whether LayoutBlank and Content exist.</summary>
public sealed class Pa2F8AppFactoryTests
{
    // AppFactory's module kinds and the model come from the Studio's assemblies (resolved by StudioAssemblies).
    public Pa2F8AppFactoryTests() => StudioAssemblies.Bind(null);

    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F8AppFactoryTests).Assembly.Location)!)!;

    [Fact]
    public void ThePlatformLabelIsTheStudioOneNeverTheEnumName()
    {
        Assert.Equal("Reactive Web App", AppFactory.KindLabel("Reactive"));
        Assert.Equal("Reactive Web App", AppFactory.KindLabel("CrossDevice"));
        Assert.Equal("Traditional Web App", AppFactory.KindLabel("Traditional"));
        Assert.Equal("Mobile App", AppFactory.KindLabel("Mobile"));
        Assert.Equal("Service", AppFactory.KindLabel("Service"));
        Assert.Equal("Library", AppFactory.KindLabel("Library"));
        foreach (var kind in new[] { "Reactive", "Traditional", "Mobile", "Service", "Library" })
            Assert.DoesNotContain("CrossDevice", AppFactory.KindLabel(kind));
    }

    [Fact]
    public void BlankWithAUiModuleIsRefusedWithBlankUiModuleOneProblemPerModule()
    {
        // The real request of 06/10 12:57: the UI and the back office as Reactive, with blank:true.
        var specs = new[] { new ModuleSpec("Cardapio_UI", "Reactive"), new ModuleSpec("Cardapio_BackOffice", "Reactive"), new ModuleSpec("Cardapio_CS", "Service") };
        Assert.Equal(new[] { "Cardapio_UI", "Cardapio_BackOffice" }, AppFactory.BlankUiModules(specs, blankModules: true));
        var refused = Assert.Throws<KernelRefusalException>(() => AppFactory.RefuseBlankUi(specs, blankModules: true));
        Assert.Equal("BLANK_UI_MODULE", refused.Code);
        Assert.Contains("omit blank", refused.Message);
        Assert.Equal(new[] { "Cardapio_UI", "Cardapio_BackOffice" }, refused.Problems!.Select(p => p!["module"]!.ToString()));
        Assert.All(refused.Problems!, p => { Assert.Equal("BLANK_UI_MODULE", p!["code"]!.ToString()); Assert.Equal("omit blank", p["fix"]!.ToString()); Assert.Equal("Reactive Web App", p["kind"]!.ToString()); });
        // The CLI envelope carries the code (Errors.Envelope), so the facade answers it as is.
        var envelope = Errors.Envelope("create-app", refused, 1);
        Assert.Equal("BLANK_UI_MODULE", envelope["code"]!.ToString());
        foreach (var kind in new[] { "Traditional", "Mobile" })
            Assert.Equal("BLANK_UI_MODULE", Assert.Throws<KernelRefusalException>(() => AppFactory.RefuseBlankUi([new ModuleSpec("X_UI", kind)], true)).Code);
    }

    [Fact]
    public void BlankStaysValidForServiceAndLibraryAndWithoutBlankNothingIsRefused()
    {
        AppFactory.RefuseBlankUi([new ModuleSpec("Demo_CS", "Service"), new ModuleSpec("Demo_Lib", "Library")], blankModules: true);
        AppFactory.RefuseBlankUi([new ModuleSpec("Demo_UI", "Reactive")], blankModules: false);
        Assert.Empty(AppFactory.BlankUiModules([new ModuleSpec("Demo_UI", "Reactive")], blankModules: false));
    }

    [Fact]
    public void AddModulesAndCreateAppRefuseBeforeAnyEnvironmentCall()
    {
        var specs = new[] { new ModuleSpec("Demo_UI", "Reactive") };
        var bridge = new Stub();
        using (var session = HeadlessSession.ConnectStudio(bridge, "lab.example", null, readOnly: false))
        {
            Assert.Equal("BLANK_UI_MODULE", Assert.Throws<KernelRefusalException>(() =>
                AppFactory.AddModulesToApplication(session, null!, "app-key", "tpl", specs, Path.Combine(Root, ".local", "pa2-f8", "add"), blankModules: true)).Code);
            Assert.Equal("BLANK_UI_MODULE", Assert.Throws<KernelRefusalException>(() =>
                AppFactory.CreateApplicationWithModules(session, null!, "Demo", "Reactive", specs, Path.Combine(Root, ".local", "pa2-f8", "create"), blankModules: true)).Code);
        }
        // Only the lease itself (connect and its close): no application-save, no listing, no template download.
        Assert.DoesNotContain(bridge.Requests, r => r["operation"]!.ToString() is not ("connect" or "close"));
    }

    [Fact]
    public void TheReceiptListsTemplateLayoutBlankAndContentPerModule()
    {
        var outcome = new ModuleCreationOutcome("Demo_UI", "CrossDevice", "k", 10, null, true, 1, "x.oml", null, null, null,
            Template: "Wrm0V2ZyskqM7KobRok75w", LayoutBlank: true, Content: true);
        var json = JsonNode.Parse(JsonSerializer.Serialize(outcome))!;
        Assert.Equal("Wrm0V2ZyskqM7KobRok75w", json["Template"]!.ToString());
        Assert.True(json["LayoutBlank"]!.GetValue<bool>());
        Assert.True(json["Content"]!.GetValue<bool>());
        var blank = new ModuleCreationOutcome("Demo_CS", "Service", "k2", 3, null, true, 1, "y.oml", null, null, null,
            Template: ModuleLayout.Blank, LayoutBlank: false, Content: false);
        Assert.Equal("blank", JsonNode.Parse(JsonSerializer.Serialize(blank))!["Template"]!.ToString());
    }

    [Fact]
    public void LayoutBlankAndContentAreReadFromTheSavedModule()
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local", "pa2-f8", "layout"); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        // A Reactive module from the application template has LayoutBlank and its Content placeholder.
        Assert.Equal((true, true), ModuleLayout.InspectOml(host, Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml")));
        // A blank Service module has neither (a blank UI module would be the same: the reason of BLANK_UI_MODULE).
        Assert.Equal((false, false), ModuleLayout.InspectOml(host, Path.Combine(Root, "tests", "fixtures", "blank-service.oml")));
    }

    private sealed class Stub : IBridgeClient
    {
        public readonly List<JsonObject> Requests = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            var request = parameters!.DeepClone().AsObject(); Requests.Add(request);
            return request["operation"]!.ToString() == "connect"
                ? new JsonObject { ["lease"] = "l", ["host"] = "lab.example", ["username"] = "u", ["ideVersion"] = "11.55.69", ["serverVersion"] = "11.41.0.1" }
                : new JsonObject { ["value"] = null };
        }
    }
}
