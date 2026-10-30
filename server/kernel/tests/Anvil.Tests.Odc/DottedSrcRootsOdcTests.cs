using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>R2-C: in the ODC lane a dotted src whose first name is a root of the module's values (Settings, Client, any case)
/// has the expression reading too; Site is no root here. Pure: ScreenHtmlNative.Apply with the module image NzLogo.</summary>
public class DottedSrcRootsOdcTests
{
    private static (ScreenHtml.Node Top, ScreenHtmlNative.Outcome Outcome) Native(string body)
    {
        var top = ScreenHtml.Parse("<screen name=\"NzTela\">" + body + "</screen>").Children.First(c => !c.IsText);
        return (top, ScreenHtmlNative.Apply(top, _ => true, _ => null, _ => false, null, () => ["NzLogo"], _ => null));
    }

    [Fact]
    public void ADottedSrcThroughAnOdcModuleRootHasTheExpressionReading()
    {
        foreach (var src in new[] { "settings.NzLogo", "Settings.NzLogo", "client.NzLogo" })
        {
            var (_, outcome) = Native($"<img src=\"{src}\"/>");
            Assert.Equal(ScreenDocument.NameAmbiguous, Assert.Single(outcome.Problems).Code);
        }
        var (top, site) = Native("<img src=\"Site.NzLogo\"/>");
        Assert.Empty(site.Problems);
        Assert.Contains(site.Normalized, n => n["code"]!.ToString() == "IMG_PATH_IMAGE");
        Assert.Equal("NzLogo", ScreenHtmlText.Elements(top).Select(x => x.Node).First(n => n.Tag == "img").Get("src"));
    }
}
