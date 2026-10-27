using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using OutSystems.Model;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects (F2, review round): the property model and the reading agree. Every property fact a reading of
// the lane's fixtures writes on a widget is one the model lets an edit write with that value (the one rule of CheckProperties,
// ScreenHtmlModule.Refusal), and the model of a property is its type's: the same type of fact and the same writability on every
// node of a kind whatever value one holds (the first node of a kind decided it before: Input.MaxLength was an expression on one
// input and a value on another). Needs the lane's Studio.
public sealed class ScreenHtmlPropertyModelTests(ITestOutputHelper output)
{
    [Fact]
    public void EveryFactAReadingWritesIsOneTheModelLetsAnEditWriteAndTheModelIsTheTypes()
    {
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        try {
            var bind = binder.GetMethods().First(m => m.Name == "Bind");
            bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        } catch (Exception) { output.WriteLine("WARNING: no Studio of this lane: skipped."); return; }
        var kernel = Path.GetDirectoryName(typeof(ScreenHtmlPropertyModelTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(kernel, "MANIFESTO.md"))) kernel = Directory.GetParent(kernel)!.FullName;
        var fixtures = odc != null ? new[] { Path.Combine(kernel, "tests", "fixtures", "odc", "insurance-reactive-r8.oml") }
            : new[] { Path.Combine(kernel, "tests", "fixtures", "reactive-ui.oml"), Path.Combine(kernel, "tests", "fixtures", "mobile-ui.oml") };
        var work = Path.Combine(kernel, ".local", odc != null ? "lane-odc" : "", "property-model-tests");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        foreach (var fixture in fixtures) {
            var module = host.Load(File.ReadAllBytes(fixture));
            try {
                var reading = ScreenHtml.Module((IObjectSignature)module, new KernelModelReader());
                var refused = new List<string>(); var facts = 0; var nodes = 0;
                var models = new Dictionary<(string, Type, string), HashSet<string>>();
                foreach (var (name, kind, key) in reading.Roots) {
                    if (kind is "WebScreen" or "WebBlock") continue;
                    var document = reading.Read("@" + key);
                    foreach (var (k, element) in document.Canon.Elements) {
                        // The widgets: what CheckProperties judges (a data element is the logic text's).
                        if (k.Length == 0 || k.Contains('/') || !(ScreenHtml.WidgetTags.ContainsKey(element.Kind) || element.Kind is "List" or "AdvancedHtml")) continue;
                        if (reading.NodeOf(document, k) is not { } node) continue;
                        nodes++;
                        var model = reading.PropertiesOf(node);
                        foreach (var (fact, value) in element.Facts) {
                            if (!fact.StartsWith("p:", StringComparison.Ordinal) || fact is "p:Name" or "p:Tag" or "p:SourceBlock") continue;
                            facts++;
                            if (ScreenHtmlModule<IObjectSignature>.Refusal(model, fact[2..], value, reading.ListsEveryProperty) is { } why)
                                refused.Add(name + " k=" + k + " " + element.Kind + "." + fact[2..] + "=" + (value.Length > 60 ? value[..60] : value) + ": " + why.Why);
                        }
                        foreach (var p in model.Values.Where(p => p.NotOfThePage == null)) {
                            var slot = (element.Kind, node.GetType(), p.Name);
                            if (!models.TryGetValue(slot, out var seen)) models[slot] = seen = [];
                            seen.Add(p.Type + (p.Writable ? "w" : "r"));
                        }
                    }
                }
                var varying = models.Where(m => m.Value.Count > 1).Select(m => m.Key.Item1 + "." + m.Key.Item3 + ": " + string.Join(" / ", m.Value)).ToList();
                output.WriteLine(Path.GetFileName(fixture) + ": " + facts + " facts on " + nodes + " widgets, " + refused.Count + " refused; " + models.Count + " kind.property models, " + varying.Count + " vary by node");
                Assert.True(facts > 50, Path.GetFileName(fixture) + ": too few facts read (" + facts + ")");
                Assert.True(refused.Count == 0, Path.GetFileName(fixture) + ": facts the reading writes that the model refuses: " + string.Join("; ", refused.Take(10)));
                Assert.True(varying.Count == 0, Path.GetFileName(fixture) + ": models that depend on the node: " + string.Join("; ", varying.Take(10)));
            }
            finally { ModelHost.Release(module); }
        }
    }

    // The class of an element is its list of class names (F1's stylesheet touch toggles a trailing space in a Traditional Style and
    // + "" on a reactive Style Classes; ScreenHtmlModule.EditPlan.ClassTokens is what the Verify compares).
    [Theory]
    [InlineData("t:btn btn-primary", "t:btn btn-primary ")]
    [InlineData("t:btn  btn-primary", "t:btn btn-primary")]
    [InlineData("e:\"btn btn-primary\"", "e:\"btn btn-primary\" + \"\"")]
    [InlineData("e:\"btn btn-primary \"", "t:btn btn-primary")]
    [InlineData("e:\"\"", null)]
    public void AClassIsComparedByItsClassNames(string a, string? b) =>
        Assert.Equal(ScreenHtmlModule<IObjectSignature>.EditPlan.ClassTokens(a), ScreenHtmlModule<IObjectSignature>.EditPlan.ClassTokens(b));

    [Theory]
    [InlineData("e:\"btn\" + Extra")]
    [InlineData("e:If(A, \"x\", \"y\")")]
    public void AClassThatIsAnExpressionIsComparedAsItIs(string fact) => Assert.Null(ScreenHtmlModule<IObjectSignature>.EditPlan.ClassTokens(fact));
}
