using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The VisitaCerta session of 2026-10-12 (docs/PROTOTIPO-NATIVO.md 3.2, 3.4, 4.2), planned offline from the fixture capture
/// visitacerta.capture.json (the facade fixture prototype/visita-certa captured by prototype/capture.mjs, its bundle beside it):
/// the side menu items are divs that navigate (an extended onclick, whose handler must be an action), the visit written with the
/// date of the day (the store keeps a text, the entity a Date Time), the space between an emoji and its label, and the modal the
/// prototype mounted on the body (a popup beside the shell instance, never inside its placeholder).
/// </summary>
public class PrototypeVisitaCertaTests
{
    private static string Capture => Path.Combine(PrototypeFakes.Fixtures, "visitacerta.capture.json");

    [Fact]
    public void ADivThatNavigatesGoesThroughAnActionOfItsOwnerNeverAScreenAsHandler()
    {
        if (!PrototypeFakes.Studio()) return;
        DivNavigation();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void DivNavigation()
    {
        var (plan, capture) = PrototypeFakes.Plan(Capture);
        const string key = "shell:click:nav-item-cadastrar-local";
        var actions = PrototypeFakes.Actions(plan, "screen").Where(a => a["description"]?.ToString()?.Contains("Event " + key + " ", StringComparison.Ordinal) == true).ToList();
        var action = Assert.Single(actions);
        Assert.StartsWith("IMobileBlock:", action["owner"]!.ToString());
        var destination = Assert.Single(PrototypeFakes.AllSteps(action), s => s["node"]?.ToString() == "IDestinationNode");
        Assert.EndsWith("CadastrarLocal", destination["properties"]!["Destination"]!.ToString());
        // the div of the side menu: an HTML element whose onclick runs that action
        var k = PrototypeFakes.Nodes(capture).Values.First(n => n["events"] is JsonArray e && e.Any(x => x?.ToString() == key))["k"]!.ToString();
        var item = PrototypeFakes.Widgets(plan).First(w => w.Node.K == k);
        Assert.Equal("IAdvancedHtml", item.Node.W);
        Assert.NotNull(item.Spec.Handler);
        Assert.True(item.Spec.Handler!.Extended);
        Assert.Equal("onclick", item.Spec.Handler.Event);
        Assert.Null(item.Spec.Handler.Screen);
        Assert.Equal(action["name"]!.ToString(), item.Spec.Handler.Action);
        // a button that navigates keeps the destination on its own OnClick (no action of its own)
        var agendar = PrototypeFakes.Widgets(plan).Where(w => w.Spec.Handler?.Screen != null).ToList();
        Assert.Contains(agendar, w => w.Node.W is "IButton" or "ILink" && w.Spec.Handler!.Event == "OnClick");
    }

    [Fact]
    public void ADateTheStoreKeepsAsTextIsWrittenAsADateTimeLiteral()
    {
        if (!PrototypeFakes.Studio()) return;
        DateLiteral();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void DateLiteral()
    {
        var (plan, _) = PrototypeFakes.Plan(Capture);
        var assignments = PrototypeFakes.Actions(plan, "server").SelectMany(PrototypeFakes.AllSteps).Where(s => s["assign"] is JsonObject)
            .SelectMany(s => s["assign"]!.AsObject()).ToList();
        var date = Assert.Single(assignments, a => a.Key.EndsWith(".Date", StringComparison.Ordinal));
        Assert.Equal("#2026-10-10 00:00:00#", date.Value!.ToString());
        // the other fields keep their own type (the collection is keyed by Score, so the key assignment wraps it)
        Assert.Contains(assignments, a => a.Key.EndsWith(".Score", StringComparison.Ordinal) && a.Value!.ToString().Contains("94", StringComparison.Ordinal));
        Assert.Equal("\"p1\"", assignments.Single(a => a.Key.EndsWith(".PlaceId", StringComparison.Ordinal)).Value!.ToString());
        // the conversions a field of another basic type needs
        Assert.Equal("TextToDateTime(X)", PrototypeExpr.Convert("X", "Text", "DateTime"));
        Assert.Equal("IntegerToText(X)", PrototypeExpr.Convert("X", "Integer", "Text"));
        Assert.Equal("X", PrototypeExpr.Convert("X", "Integer", "Decimal"));
        Assert.Equal("X", PrototypeExpr.Convert("X", null, "DateTime"));
    }

    [Fact]
    public void TheSpaceBetweenTwoTextsOfALineIsKeptAndTheBodyModalSitsBesideTheShell()
    {
        if (!PrototypeFakes.Studio()) return;
        SpaceAndPortal();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void SpaceAndPortal()
    {
        var (plan, capture) = PrototypeFakes.Plan(Capture);
        // "📦" " " "Entrega": three texts, the middle one a space
        var seg = PrototypeFakes.Nodes(capture).Values.First(n => n["c"] is JsonArray c && c.Count == 3 && c[1]?["x"]?.ToString() == " " && c[2]?["x"]?.ToString() == "Entrega");
        var button = PrototypeFakes.Widgets(plan).First(w => w.Node.K == seg["k"]!.ToString()).Node;
        Assert.Equal(["📦", " ", "Entrega"], button.Children.Where(c => c.W == "ITextWidget").Select(c => c.Text ?? ""));
        // the popup of the modal mounted on the body: a widgets job of its own, under the screen, beside the shell instance
        var jobs = plan.Steps.Select(s => s.Widgets).OfType<PrototypeWidgetsJob>().ToList();
        var portal = Assert.Single(jobs, j => j.Roots.Any(r => r.W == "IPopup"));
        Assert.Equal(portal.Owner, portal.Parent);
        Assert.Equal("m:weather-peek-modal", Assert.Single(portal.Roots).K);
        Assert.DoesNotContain(jobs.Where(j => j != portal).SelectMany(j => j.Roots), r => r.W == "IPopup");
    }
}
