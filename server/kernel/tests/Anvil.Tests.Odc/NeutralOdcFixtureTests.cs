using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The ODC lane fixture (tests/fixtures/odc/insurance-reactive-r8.oml) ships in the hosted image, so no element of it may
/// name a client. It was made from a client capture by scripts/anonymize-odc-fixture.mjs with the kernel's own rename and
/// set ops. This test opens it with the model and reads every readable text property of every object -- including the
/// ones the reader omits as noise (CreatedBy, LastModifiedBy...) -- against the terms of docker/ssam-server/client-denylist.json
/// (the publisher's file; a checkout without it skips). Its sidecar is checked as text too. Needs the ODC Studio installed.
/// </summary>
public class NeutralOdcFixtureTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "neutral-fixture-tests");

    [Fact]
    public void NoElementOfTheLaneFixtureNamesAClient()
    {
        var terms = Terms();
        if (terms.Count == 0 || !StudioAvailable()) return;
        Assert.True(File.Exists(Fixture), Fixture);
        var hits = new List<string>();
        var sidecar = File.ReadAllText(Fixture + ".json");
        foreach (var t in terms) if (t.IsMatch(sidecar)) hits.Add("sidecar: " + t);
        ReadModel(terms, hits);
        Assert.True(hits.Count == 0, string.Join("\n", hits.Take(40)));
    }

    // The model types load only after StudioAssembliesOdc.Bind: they live in a method of their own (not inlined).
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void ReadModel(List<Regex> terms, List<string> hits)
    {
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(Fixture));
        try
        {
            var objects = 0;
            // The reader's graph (children, references) and every native descendant, as the kernel resolves @keys (Verbs).
            var es = (IESpace)espace;
            var all = new KernelModelReader().Walk(es).Concat(((IObjectSignature)es).GetAllDescendantsOfType<IObjectSignature>())
                .Distinct(ReferenceEqualityComparer.Instance).Cast<IObjectSignature>();
            foreach (var node in all)
            {
                objects++;
                foreach (var p in Readable(node.GetType()))
                {
                    string? text;
                    try { text = p.GetValue(node) switch { string s => s, OutSystems.Model.Expressions.IExpression e => e.Text, _ => null }; }
                    catch { continue; }
                    if (string.IsNullOrEmpty(text)) continue;
                    foreach (var t in terms)
                        if (t.Match(text) is { Success: true } m)
                            hits.Add($"{node.GetType().Name} {node.ObjectKey} {p.Name}: ...{text.Substring(Math.Max(0, m.Index - 30), Math.Min(text.Length - Math.Max(0, m.Index - 30), 80))}...");
                }
            }
            // 35 534 objects through the reader alone on 2026-10-07 (the save counts 59 281 model objects, expressions included,
            // which are read here as properties of their owners): a walk that reads far fewer has lost part of the module.
            Assert.True(objects > 30000, $"the walk read only {objects} objects");
        }
        finally { ModelHost.Release(espace); }
    }

    private static readonly Dictionary<Type, PropertyInfo[]> Properties = new();
    private static PropertyInfo[] Readable(Type type)
    {
        if (Properties.TryGetValue(type, out var known)) return known;
        var found = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.CanRead && p.GetIndexParameters().Length == 0
                && (p.PropertyType == typeof(string) || typeof(OutSystems.Model.Expressions.IExpression).IsAssignableFrom(p.PropertyType)))
            .ToArray();
        Properties[type] = found;
        return found;
    }

    /// <summary>The denylist terms (docker/ssam-server/client-denylist.json at the repository root), case-insensitive.</summary>
    private static List<Regex> Terms()
    {
        var file = Path.Combine(Path.GetDirectoryName(Root)!, "docker", "ssam-server", "client-denylist.json");
        if (!File.Exists(file)) return [];
        return JsonNode.Parse(File.ReadAllText(file))!["terms"]!.AsArray()
            .Select(t => new Regex(t!["pattern"]!.GetValue<string>(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).ToList();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(NeutralOdcFixtureTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
