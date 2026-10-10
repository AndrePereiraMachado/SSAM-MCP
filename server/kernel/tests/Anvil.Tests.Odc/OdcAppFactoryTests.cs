using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// `anvil-odc create-app` (OdcAppFactory): a new ODC app or library built headless the way the ODC Studio builds it
/// before the upload. Libraries are ESpace.Create (no template); apps clone a template OML. The tenant's real templates
/// are downloaded by the bridge (live); here the InsuranceApp fixture, an app born from the tenant's web template, stands
/// in for the Reactive template and blank-mobile for a Mobile one, also cloned under the tenant templates' system module
/// keys, which the Model API refuses to load as it refused the real ones. Needs the ODC Studio installed; without it the
/// tests return without asserting.
/// </summary>
public class OdcAppFactoryTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work", "create-app");
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", "odc", name + ".oml");
    private static string NewDir(string name) => Path.Combine(Work, name + "-" + Guid.NewGuid().ToString("N")[..8]);

    // 1x1 PNG
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    [Theory]
    [InlineData("library", "ReactiveLibrary")]
    [InlineData("mobile-library", "MobileLibrary")]
    public void ALibraryIsCreatedLikeTheStudiosNewLibrary(string kind, string segmentation)
    {
        if (!StudioAvailable()) return;
        var dir = NewDir(kind);
        var receipt = OdcAppFactory.Create(new ModelHost(dir), new OdcAppSpec(kind, "ZZ Criar Lib", Color: "#112233", Description: "lib test", Tenant: "personal.example", Author: "a@b.c"), dir);
        Assert.Equal(segmentation, receipt["segmentationKind"]!.GetValue<string>());
        Assert.Equal(segmentation, receipt["reloadedKind"]!.GetValue<string>());
        Assert.Equal("ZZCriarLib", receipt["module"]!.GetValue<string>());
        Assert.Equal("ZZCriarLib", receipt["reloadedModule"]!.GetValue<string>());
        Assert.Equal(receipt["moduleKey"]!.GetValue<string>(), receipt["reloadedKey"]!.GetValue<string>());
        // zero messages: the "Users" provider resolves, so the blank module's ImplicitSelfUserProvider warning is gone
        Assert.Equal(0, receipt["validation"]!["errors"]!.GetValue<int>());
        Assert.Equal(0, receipt["validation"]!["warnings"]!.GetValue<int>());
        var settings = receipt["settings"]!;
        Assert.Equal("ZZ Criar Lib", settings["appName"]!.GetValue<string>());
        Assert.Equal("#112233", settings["primaryColor"]!.GetValue<string>());
        Assert.Equal("lib test", settings["description"]!.GetValue<string>());
        Assert.Equal("Users", settings["userProvider"]!.GetValue<string>());
        Assert.Equal("AgentExperience", settings["createdByTool"]!.GetValue<string>());
        Assert.Equal(["(System)"], receipt["content"]!["references"]!.AsArray().Select(r => r!.GetValue<string>()));
        AssertManifest(dir, receipt, "ZZ Criar Lib", kind);
    }

    [Fact]
    public void AReactiveAppIsACloneOfTheTemplateWithTheAppSettings()
    {
        if (!StudioAvailable()) return;
        var dir = NewDir("reactive");
        var template = Fixture("insurance-reactive-r8");
        var receipt = OdcAppFactory.Create(new ModelHost(dir), new OdcAppSpec("reactive", "ZZ Criar Web", TemplateOml: template, TemplateKey: "Wrm0V2ZyskqM7KobRok75w",
            Color: "#C0392B", Tenant: "personal.example", Author: "a@b.c"), dir);
        Assert.Equal("CrossDevice", receipt["reloadedKind"]!.GetValue<string>());
        // the app name keeps its spaces; the module name is the identifier the clone derives from it
        Assert.Equal("ZZ Criar Web", receipt["settings"]!["appName"]!.GetValue<string>());
        Assert.Equal("ZZCriarWeb", receipt["reloadedModule"]!.GetValue<string>());
        Assert.Equal("#C0392B", receipt["settings"]!["primaryColor"]!.GetValue<string>());
        Assert.NotEqual(receipt["template"]!["moduleKey"]!.GetValue<string>(), receipt["moduleKey"]!.GetValue<string>());
        Assert.Equal(receipt["moduleKey"]!.GetValue<string>(), receipt["reloadedKey"]!.GetValue<string>());
        // everything the template brings stays: references, flows, screens, themes, blocks, client variables
        Assert.Equal(receipt["template"]!["content"]!["screens"]!.GetValue<int>(), receipt["content"]!["screens"]!.GetValue<int>());
        Assert.Equal(receipt["template"]!["content"]!["blocks"]!.GetValue<int>(), receipt["content"]!["blocks"]!.GetValue<int>());
        Assert.Equal(receipt["template"]!["content"]!["themes"]!.GetValue<int>(), receipt["content"]!["themes"]!.GetValue<int>());
        Assert.Equal(receipt["template"]!["content"]!["clientVariables"]!.GetValue<int>(), receipt["content"]!["clientVariables"]!.GetValue<int>());
        Assert.Equal(Sorted(receipt["template"]!["content"]!["references"]!), Sorted(receipt["content"]!["references"]!));
        Assert.Equal(Sorted(receipt["template"]!["content"]!["flows"]!), Sorted(receipt["content"]!["flows"]!));
        Assert.Contains("MainFlow", Sorted(receipt["content"]!["flows"]!));
        // zero errors and no warning the template did not already have
        Assert.Equal(0, receipt["validation"]!["errors"]!.GetValue<int>());
        Assert.Empty(receipt["validation"]!["newWarnings"]!.AsArray());
        // the default theme takes the module name, as the Studio's ChangeESpacePrimaryColor does on creation. This stand-in
        // is a real app whose theme has 45 KB of custom CSS without the /*primary-color*/ marker, so the Studio's own command
        // leaves its color where it was (its style sheet replacement finds nothing); the fresh-template case is below.
        Assert.True(receipt["theme"]!["renamed"]!.GetValue<bool>());
        Assert.Equal("ZZCriarWeb", receipt["theme"]!["theme"]!.GetValue<string>());
        Assert.False(receipt["theme"]!["styleSheetColorMarker"]!.GetValue<bool>());
        AssertManifest(dir, receipt, "ZZ Criar Web", "reactive");
        Assert.Equal("Wrm0V2ZyskqM7KobRok75w", ReadManifest(dir)["templateKey"]!.GetValue<string>());
    }

    /// <summary>A fresh template has a theme without custom CSS: the Studio's command then writes the color into the
    /// theme values and regenerates the CSS (the theme editor path). The stand-in is the fixture with its default theme's
    /// style sheet emptied.</summary>
    [Fact]
    public void TheThemeOfAFreshTemplateTakesThePrimaryColor()
    {
        if (!StudioAvailable()) return;
        var dir = NewDir("fresh");
        var host = new ModelHost(dir);
        Directory.CreateDirectory(dir);
        var fresh = Path.Combine(dir, "fresh-template.oml");
        WriteFreshTemplate(host, Fixture("insurance-reactive-r8"), fresh);
        var outDir = Path.Combine(dir, "out");
        var receipt = OdcAppFactory.Create(host, new OdcAppSpec("reactive", "ZZCriarFresh", TemplateOml: fresh, Color: "#C0392B"), outDir);
        var theme = receipt["theme"]!;
        Assert.True(theme["colorApplied"]!.GetValue<bool>(), theme.ToJsonString());
        Assert.Equal("theme values", theme["colorIn"]!.GetValue<string>());
        Assert.Equal("#c0392b", theme["appPrimaryColor"]!.GetValue<string>());
        Assert.Equal("#c0392b", theme["primaryColor"]!.GetValue<string>());
        Assert.Equal("ZZCriarFresh", theme["theme"]!.GetValue<string>());
        Assert.Equal(0, receipt["validation"]!["errors"]!.GetValue<int>());
    }

    /// <summary>The mobile path: a Mobile template clone with an icon gets the module image and the AppIcon image.
    /// blank-mobile stands in for the tenant's Mobile UI template (no theme, so no color step).</summary>
    [Fact]
    public void AMobileAppCloneTakesTheIcon()
    {
        if (!StudioAvailable()) return;
        var dir = NewDir("mobile");
        Directory.CreateDirectory(dir);
        var icon = Path.Combine(dir, "icon.png");
        File.WriteAllBytes(icon, Png);
        var receipt = OdcAppFactory.Create(new ModelHost(dir), new OdcAppSpec("mobile", "ZZ Criar Mobile", TemplateOml: Fixture("blank-mobile"), IconPath: icon), Path.Combine(dir, "out"));
        Assert.Equal("Mobile", receipt["reloadedKind"]!.GetValue<string>());
        Assert.Equal("ZZCriarMobile", receipt["reloadedModule"]!.GetValue<string>());
        Assert.True(receipt["settings"]!["icon"]!.GetValue<bool>());
        Assert.Equal(0, receipt["validation"]!["errors"]!.GetValue<int>());
    }

    /// <summary>The tenant's templates are OutSystems system modules: Template Web App is the module key
    /// Constants.Template_Reactive and Template_MobileApp is Constants.MobileUI_Template_Phone (OutSystems.RuntimeCommon),
    /// both in Constants.ReadonlyESpaces, which the Model API refuses to load ("System modules cannot be loaded with the
    /// Model API. Consider using the Clone method instead.", CommandServicesImplementation.CheckOpenPermissions) and only
    /// clones, as the Studio's NewModule from a template does. The stand-ins are the fixtures cloned under the key the
    /// wizard asks the tenant for, so they are refused exactly as the real templates were on 2026-10-05. The app is a clone
    /// with a new key: no longer a system module, it loads, and it carries the app name, the color and the kind.</summary>
    [Theory]
    [InlineData("reactive", "web", "insurance-reactive-r8", "CrossDevice")]
    [InlineData("mobile", "mobile-ui", "blank-mobile", "Mobile")]
    public void AnAppIsCreatedFromTheTenantsSystemTemplate(string kind, string templateName, string fixture, string segmentation)
    {
        if (!StudioAvailable()) return;
        var dir = NewDir("system-" + kind);
        Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var templateKey = OdcAppFactory.Templates[templateName].Key;
        var template = Path.Combine(dir, "system-template.oml");
        WriteSystemTemplate(host, Fixture(fixture), templateKey, template);
        // the stand-in is what the tenant sends: a module the Model API refuses to load
        var refused = Assert.Throws<InvalidOperationException>(() => host.Inspect(template));
        Assert.StartsWith("System modules cannot be loaded with the Model API", refused.Message);

        var outDir = Path.Combine(dir, "out");
        var receipt = OdcAppFactory.Create(host, new OdcAppSpec(kind, "ZZ Sistema " + kind, TemplateOml: template, TemplateKey: templateKey,
            Color: "#534AB7", Tenant: "personal.example", Author: "a@b.c"), outDir);
        // the template's identity comes from its OML header, never from a load
        Assert.Equal(templateKey, receipt["template"]!["moduleKey"]!.GetValue<string>());
        Assert.Equal(segmentation, receipt["template"]!["kind"]!.GetValue<string>());
        Assert.True(receipt["template"]!["systemModule"]!.GetValue<bool>());
        // the app: a new key, the app name, the color, the kind; it loads where the template did not
        var moduleKey = receipt["moduleKey"]!.GetValue<string>();
        Assert.NotEqual(templateKey, moduleKey);
        Assert.Equal(moduleKey, receipt["reloadedKey"]!.GetValue<string>());
        Assert.Equal(segmentation, receipt["reloadedKind"]!.GetValue<string>());
        Assert.Equal("ZZSistema" + kind, receipt["reloadedModule"]!.GetValue<string>());
        Assert.Equal("ZZ Sistema " + kind, receipt["settings"]!["appName"]!.GetValue<string>());
        Assert.Equal("#534AB7", receipt["settings"]!["primaryColor"]!.GetValue<string>());
        var reloaded = host.Inspect(receipt["omlPath"]!.GetValue<string>());
        Assert.Equal(moduleKey, reloaded.Key);
        Assert.Equal(segmentation, reloaded.Kind);
        // everything the template brings stays, with no error and no warning the template did not already have
        foreach (var count in new[] { "screens", "blocks", "themes", "clientVariables" })
            Assert.Equal(receipt["template"]!["content"]![count]!.GetValue<int>(), receipt["content"]![count]!.GetValue<int>());
        Assert.Equal(Sorted(receipt["template"]!["content"]!["references"]!), Sorted(receipt["content"]!["references"]!));
        Assert.Equal(Sorted(receipt["template"]!["content"]!["flows"]!), Sorted(receipt["content"]!["flows"]!));
        Assert.Equal(0, receipt["validation"]!["errors"]!.GetValue<int>());
        Assert.Empty(receipt["validation"]!["newWarnings"]!.AsArray());
        // the template's own warnings are counted, not lost with the load: a fresh clone verifies only in a transaction
        Assert.Equal(receipt["template"]!["warnings"]!.GetValue<int>(), receipt["validation"]!["warnings"]!.GetValue<int>());
        AssertManifest(outDir, receipt, "ZZ Sistema " + kind, kind);
        Assert.Equal(templateKey, ReadManifest(outDir)["templateKey"]!.GetValue<string>());
    }

    /// <summary>The tenant's real templates, when a folder of them is given in ANVIL_ODC_TEMPLATES_DIR (the bridge's
    /// snapshots\templates, named by key as template-download names them; never committed). Each template of the wizard
    /// found there becomes an app with 0 errors and no new warning. Template_MobileApp requires the MobileUI model plugin,
    /// read from the ODC Studio's plugin cache (OdcModelPlugins). Without the folder the test returns without asserting.</summary>
    [Fact]
    public void TheTenantsRealTemplatesBecomeApps()
    {
        var folder = Environment.GetEnvironmentVariable("ANVIL_ODC_TEMPLATES_DIR");
        if (!StudioAvailable() || string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return;
        var dir = NewDir("real");
        var host = new ModelHost(dir);
        var created = 0;
        foreach (var (name, (kind, key, _)) in OdcAppFactory.Templates)
        {
            var template = Directory.EnumerateFiles(folder, key.Replace('/', '_').Replace('+', '-') + "-r*.oml").OrderBy(f => f, StringComparer.Ordinal).LastOrDefault();
            if (template == null) continue;
            var receipt = OdcAppFactory.Create(host, new OdcAppSpec(kind, "ZZ Real " + name, TemplateOml: template, TemplateKey: key, Color: "#534AB7"), Path.Combine(dir, name));
            Assert.Equal(key, receipt["template"]!["moduleKey"]!.GetValue<string>());
            Assert.True(receipt["template"]!["systemModule"]!.GetValue<bool>());
            Assert.NotEqual(key, receipt["reloadedKey"]!.GetValue<string>());
            Assert.Equal(kind == "mobile" ? "Mobile" : "CrossDevice", receipt["reloadedKind"]!.GetValue<string>());
            Assert.Equal(0, receipt["validation"]!["errors"]!.GetValue<int>());
            Assert.Empty(receipt["validation"]!["newWarnings"]!.AsArray());
            Assert.True(receipt["theme"]!["renamed"]!.GetValue<bool>());
            created++;
        }
        Assert.True(created > 0, "no template of the wizard in " + folder);
    }

    /// <summary>A template whose model plugin is in no plugin folder (Template_MobileApp on a machine whose ODC Studio never
    /// opened a Mobile UI app) is refused in one line that names the plugin, the folders and what to do, before anything
    /// is written. The folder the bridge reports (--plugins-dir, the Studio's own cache) is the first one read: a file
    /// there is the one the clone loads (a broken one fails to load instead of "not found"). Any later load of a module
    /// that requires the plugin (inspect, jobs) is refused the same way.</summary>
    [Fact]
    public void AMissingModelPluginIsRefusedInOneLineNamingItAndTheFolders()
    {
        if (!StudioAvailable()) return;
        var dir = NewDir("plugins");
        Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var template = Path.Combine(dir, "plugin-template.oml");
        WritePluginTemplate(host, Fixture("blank-mobile"), "ZZMissingPlugin", new Version(9, 9, 9, 9), template);
        var studioCache = Path.Combine(dir, "studio-plugins");
        Directory.CreateDirectory(studioCache);
        var outDir = Path.Combine(dir, "out");
        var spec = new OdcAppSpec("mobile", "ZZ Plugin", TemplateOml: template, PluginsDirectory: studioCache);

        var refused = Assert.Throws<OdcModelPluginMissingException>(() => OdcAppFactory.Create(host, spec, outDir));
        Assert.StartsWith("the template requires model plugins", refused.Message);
        Assert.Contains("ZZMissingPlugin 9.9.9.9 (Unable to locate plugin binaries)", refused.Message);
        Assert.Contains(studioCache, refused.Message);
        Assert.Contains("Mobile UI app", refused.Message);
        Assert.DoesNotContain('\n', refused.Message);
        Assert.False(Directory.Exists(outDir), "nothing is written");
        Assert.Equal(Path.GetFullPath(studioCache), OdcModelPlugins.Directories[0]);

        var load = Assert.Throws<OdcModelPluginMissingException>(() => host.Inspect(template));
        Assert.StartsWith("the module requires model plugins", load.Message);
        Assert.Contains("ZZMissingPlugin 9.9.9.9", load.Message);

        File.WriteAllBytes(Path.Combine(studioCache, "ZZMissingPlugin-9.9.9.9.xif"), [1, 2, 3]);
        refused = Assert.Throws<OdcModelPluginMissingException>(() => OdcAppFactory.Create(host, spec, outDir));
        Assert.Contains("ZZMissingPlugin 9.9.9.9 (", refused.Message);
        Assert.DoesNotContain("Unable to locate plugin binaries", refused.Message);
        Assert.False(Directory.Exists(outDir));
    }

    /// <summary>ODC3.Builder's reader serves ssam_map and studio_inspect: a Mobile UI app it reads requires MobileUI, so it
    /// resolves model plugins from the Studio's cache as the kernel does (ANVIL_ODC_PLUGINS_DIR here) and refuses a missing
    /// one in the same first line. Runs the built builder; without it the test returns without asserting.</summary>
    [Fact]
    public void TheBuildersReaderResolvesModelPluginsLikeTheKernel()
    {
        var builder = Path.GetFullPath(Path.Combine(Root, "..", "platforms", "odc", "studio", "builder", "bin", "Release", "net10.0", "ODC3.Builder.dll"));
        if (!StudioAvailable() || !File.Exists(builder)) return;
        var dir = NewDir("builder-plugins");
        Directory.CreateDirectory(dir);
        var template = Path.Combine(dir, "plugin-module.oml");
        WritePluginTemplate(new ModelHost(dir), Fixture("blank-mobile"), "ZZBuilderPlugin", new Version(9, 9, 9, 9), template);
        var cache = Path.Combine(dir, "studio-plugins");
        Directory.CreateDirectory(cache);
        string FirstErrorLine()
        {
            var start = new System.Diagnostics.ProcessStartInfo("dotnet") { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var a in new[] { builder, "inspect", template }) start.ArgumentList.Add(a);
            start.Environment["ANVIL_ODC_PLUGINS_DIR"] = cache;
            start.Environment["SSAM_MODULE_INDEX_ROOT"] = Path.Combine(dir, "module-index");
            using var process = System.Diagnostics.Process.Start(start)!;
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            _ = stdout.Result;
            Assert.NotEqual(0, process.ExitCode);
            return stderr.Split('\n').Select(l => l.Trim()).First(l => l.Length > 0);
        }
        var missing = FirstErrorLine();
        Assert.StartsWith("OdcModelPluginMissingException: the module requires model plugins", missing);
        Assert.Contains("ZZBuilderPlugin 9.9.9.9 (Unable to locate plugin binaries)", missing);
        Assert.Contains(cache, missing);
        File.WriteAllBytes(Path.Combine(cache, "ZZBuilderPlugin-9.9.9.9.xif"), [1, 2, 3]);
        var broken = FirstErrorLine();
        Assert.Contains("ZZBuilderPlugin 9.9.9.9 (", broken);
        Assert.DoesNotContain("Unable to locate plugin binaries", broken);
    }

    [Fact]
    public void TheContractRefusesBeforeTouchingAModel()
    {
        if (!StudioAvailable()) return;
        var dir = NewDir("refusals");
        var host = new ModelHost(dir);
        var template = Fixture("insurance-reactive-r8");
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("library", "ZZLib", TemplateOml: template), dir));
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("library", "ZZLib", TemplateKey: "Wrm0V2ZyskqM7KobRok75w"), dir));
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("WebResponsive", "ZZWeb", TemplateOml: template), dir));
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("traditional", "ZZWeb", TemplateOml: template), dir));
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("reactive", "ZZWeb"), dir));
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("reactive", "ZZWeb", TemplateOml: template, Color: "red"), dir));
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("reactive", "123", TemplateOml: template), dir));
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("reactive", "ZZ Web", Module: "ZZ Web", TemplateOml: template), dir));
        Assert.Throws<ArgumentException>(() => OdcAppFactory.Create(host, new OdcAppSpec("reactive", " ZZWeb", TemplateOml: template), dir));
        // a template of another kind is not a template of this app
        Assert.Throws<InvalidOperationException>(() => OdcAppFactory.Create(host, new OdcAppSpec("mobile", "ZZMob", TemplateOml: template), dir));
        Assert.False(Directory.Exists(dir) && Directory.EnumerateFiles(dir, "*.oml").Any());
        // never overwrites
        OdcAppFactory.Create(host, new OdcAppSpec("library", "ZZOnce"), dir);
        Assert.Throws<IOException>(() => OdcAppFactory.Create(host, new OdcAppSpec("library", "ZZOnce"), dir));
        Assert.Equal("EscalaViva", OdcAppFactory.ModuleNameFor("Escala Viva"));
        Assert.Equal("SSAMHybridTest", OdcAppFactory.ModuleNameFor("SSAM Hybrid Test"));
    }

    // Kept out of the test body: the Studio's model types resolve only after StudioAvailable binds the installation.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void WriteFreshTemplate(ModelHost host, string source, string output)
    {
        var espace = host.Load(File.ReadAllBytes(source));
        try
        {
            StudioAdapter.Runtime.Mutate(espace, "A theme without custom CSS nor theme editor values", e =>
            {
                var theme = e.EffectiveDefaultTheme!;
                foreach (var value in theme.ThemeStyleValues.ToList()) value.Delete();
                // the CSS the theme editor generated wins over the user CSS; a fresh template has neither
                var styleSheet = theme.StyleSheet;
                styleSheet.GetType().GetProperty("GeneratedEffectiveValue")!.SetValue(styleSheet, "");
                styleSheet.EffectiveValue = "";
            });
            File.WriteAllBytes(output, host.Save(espace));
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>A system template stand-in: the fixture cloned (never loaded) under the system module key a tenant template
    /// carries.</summary>
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void WriteSystemTemplate(ModelHost host, string source, string systemKey, string output)
    {
        StudioAdapter.Runtime.Ensure(Path.Combine(Path.GetTempPath(), "anvil-odc"));
        var key = OutSystems.ObjectKeys.ObjectKey.Parse(systemKey);
        Assert.True(OutSystems.RuntimeCommon.Constants.IsReadonlyESpace(key), systemKey + " is not a system module key");
        using var stream = new MemoryStream(File.ReadAllBytes(source));
        var espace = ServiceStudio.Model.ESpace.Clone(stream, null, null, null, forceModifiedFlag: false, null, key);
        try { File.WriteAllBytes(output, host.Save(espace)); }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>A module that requires a model plugin, as a Mobile UI app requires MobileUI: the fixture with one more
    /// RequiredModelPlugin, which the OML header lists and every load or clone then asks for.</summary>
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void WritePluginTemplate(ModelHost host, string source, string plugin, Version version, string output)
    {
        var espace = host.Load(File.ReadAllBytes(source));
        try
        {
            StudioAdapter.Runtime.Mutate(espace, "Require a model plugin",
                e => _ = new ServiceStudio.Model.RequiredModelPlugin(e, OutSystems.ObjectKeys.ObjectKey.NewKey(), plugin, version, Guid.NewGuid()));
            File.WriteAllBytes(output, host.Save(espace));
        }
        finally { ModelHost.Release(espace); }
    }

    private static string[] Sorted(JsonNode array) => array.AsArray().Select(n => n!.GetValue<string>()).Order(StringComparer.Ordinal).ToArray();

    private static JsonObject ReadManifest(string dir) => JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "manifest.json")))!.AsObject();

    /// <summary>The manifest is the bridge's creation manifest: Create, no base, the candidate with its hash.</summary>
    private static void AssertManifest(string dir, JsonObject receipt, string appName, string kind)
    {
        var m = ReadManifest(dir);
        Assert.Equal("odc3-manifest/1", m["schema"]!.GetValue<string>());
        Assert.True(m["create"]!.GetValue<bool>());
        Assert.Equal(receipt["module"]!.GetValue<string>(), m["module"]!.GetValue<string>());
        Assert.Equal(receipt["moduleKey"]!.GetValue<string>(), m["moduleKey"]!.GetValue<string>());
        Assert.Equal(appName, m["appName"]!.GetValue<string>());
        Assert.Equal(kind, m["kind"]!.GetValue<string>());
        Assert.Equal("personal.example", m["tenant"]!.GetValue<string>());
        Assert.Equal("a@b.c", m["author"]!.GetValue<string>());
        Assert.Equal("", m["basePath"]!.GetValue<string>());
        var candidate = File.ReadAllBytes(m["candidatePath"]!.GetValue<string>());
        Assert.Equal(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(candidate)), m["candidateSha256"]!.GetValue<string>());
        Assert.Null(m["createAuthorization"]);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(OdcAppFactoryTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
