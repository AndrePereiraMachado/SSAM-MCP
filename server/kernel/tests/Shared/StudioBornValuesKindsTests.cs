using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>Review of 3ab12209, finding 6 and the cache names, without a Studio (linked into both test projects): the widget
/// kinds a measurement of the Studio's defaults creates follow the runtime of the page (StudioBornValues.WidgetKinds), and the
/// kept file of a measurement names the schema and the recipe (StudioDefaults.Generation).</summary>
public class StudioBornValuesKindsTests
{
    [Fact]
    public void AReactivePageTriesNoTraditionalKindAndATraditionalPageTriesItsOwn()
    {
        var reactive = StudioBornValues.WidgetKinds(traditional: false);
        var web = StudioBornValues.WidgetKinds(traditional: true);
        // Reactive, Mobile and ODC: never a Traditional-only kind.
        Assert.Empty(reactive.Intersect(ScreenHtmlTables.TraditionalOnly));
        Assert.Contains("Container", reactive);
        Assert.Contains("TableRecords", reactive);
        // Traditional Web: every Traditional-only kind but the block instance (measured with its block), the kinds the writer
        // creates as they are (no Traditional counterpart), never a Reactive kind it writes as its counterpart.
        Assert.Empty(ScreenHtmlTables.TraditionalOnly.Where(k => k != "WebBlockInstanceWidget").Except(web));
        Assert.Empty(web.Where(k => ScreenHtmlTables.TraditionalKind(k) != k));
        foreach (var kind in new[] { "Container", "Button", "Link", "Input", "Checkbox", "Dropdown", "Expression", "Image", "Upload" }) Assert.DoesNotContain(kind, web);
        foreach (var kind in new[] { "IfWidget", "TextWidget", "Label", "Form" }) { Assert.Contains(kind, web); Assert.Contains(kind, reactive); }
        // Neither list holds a block instance or a placeholder (measured apart).
        foreach (var kind in new[] { "MobileBlockInstanceWidget", "WebBlockInstanceWidget", "PlaceholderWidget" }) { Assert.DoesNotContain(kind, web); Assert.DoesNotContain(kind, reactive); }
        Assert.True(StudioBornValues.IsTraditionalPage("WebScreen") && StudioBornValues.IsTraditionalPage("WebBlock"));
        Assert.False(StudioBornValues.IsTraditionalPage("MobileScreen") || StudioBornValues.IsTraditionalPage("MobileBlock"));
    }

    [Fact]
    public void TheKeptFileNameCarriesTheSchemaAndTheRecipe()
    {
        Assert.True(StudioBornValues.Recipe >= 7);
        Assert.Equal("s3-r" + StudioBornValues.Recipe, StudioDefaults.Generation);
        var name = StudioDefaults.CacheFileName(StudioDefaults.Generation, "0123456789abcdef0123456789abcdef", "0123456789abcdef");
        Assert.Equal("studio-defaults.s3-r" + StudioBornValues.Recipe + ".0123456789abcdef0123456789abcdef.0123456789abcdef.json", name);
        // Two recipes (two releases) name two files for the same Studio and context.
        Assert.NotEqual(StudioDefaults.CacheFileName("s3-r6", "id", "context"), StudioDefaults.CacheFileName("s3-r7", "id", "context"));
    }
}
