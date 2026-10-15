using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The Verify of the batteries (BatteryVerify, review of the third junction: the batteries judged only the text). A value the
/// platform keeps as text it does not parse reads back as the text written, so the text alone calls it exact; the Verify of the
/// sampled case finds the parser error it brought under the action. The engine's own write of the same value (parsed, after
/// this correction) brings none.
/// </summary>
public sealed class BatteryVerifyOdcTests
{
    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(BatteryVerifyOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    [Fact]
    public void AValueKeptUnparsedIsANewVerifyErrorUnderTheAction()
    {
        if (!StudioAvailable()) return;
        Body();
    }

    private const string Records = """
        {"op":"spec","data":{"structures":[
          {"name":"DstRow","attributes":[{"name":"Key","type":"Text","length":50},{"name":"Total","type":"Decimal"}]}]}}
        """;

    private static IEnumerable<IObjectSignature> Walk(IObjectSignature o) { yield return o; foreach (var c in o.Children.OfType<IObjectSignature>()) foreach (var d in Walk(c)) yield return d; }
    private static bool Is(object o, string iface) => o.GetType().GetInterfaces().Any(i => i.Name == iface);

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void Body()
    {
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "battery-verify-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var flow = "server action FaVerify\n  in Code: Text\n  local Rows: DstRow List\n  local Row: DstRow\n  (System).ListAppend(List=Rows, Element=Row)\n  end\n";
        var job = new JsonObject { ["base"] = "tests/fixtures/odc/blank-mobile.oml",
            ["ops"] = new JsonArray(JsonNode.Parse(Records), new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(flow) } }) };
        File.WriteAllText(Path.Combine(dir, "base.json"), job.ToJsonString());
        var host = new ModelHost(Path.Combine(dir, "work"));
        JobRunner.Run(host, null, Path.Combine(dir, "base.json"), Path.Combine(dir, "base.oml"));
        foreach (var engine in new[] { false, true }) {
            var espace = host.Load(File.ReadAllBytes(Path.Combine(dir, "base.oml")));
            try {
                var action = Walk((IObjectSignature)espace).First(n => Is(n, "IServerAction") && ModelHost.Prop(n, "Name")?.ToString() == "FaVerify");
                var argument = Walk(action).First(n => Is(n, "IArgument") && ModelHost.Prop(n, "Parameter") is { } p && ModelHost.Prop(p, "Name")?.ToString() == "Element");
                var call = (IObjectSignature)argument.Parent!;
                var verify = new BatteryVerify { Module = espace };
                verify.Before(action);
                var session = new ModelSession(espace);
                if (engine)
                    session.Apply(new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@" + call.ObjectKey + "/arg:Element", ["prop"] = "Value", ["value"] = "{ Key: Code, Total: 1 }" }));
                else
                    // The write before this correction: the literal as the text of the value, which the parser does not read.
                    session.Mutate("battery verify", () => ((OutSystems.Model.Expressions.IExpression)ModelHost.Prop(argument, "Value")!).Text = "{ Key: Code, Total: 1 }");
                Assert.Equal("{ Key: Code, Total: 1 }", ((OutSystems.Model.Expressions.IExpression)ModelHost.Prop(argument, "Value")!).Text);
                var added = verify.Added(action);
                if (engine) Assert.Empty(added);
                else Assert.Contains(added, e => e.StartsWith("Parser", StringComparison.Ordinal));
            } finally { ModelHost.Release(espace); }
        }
    }
}
