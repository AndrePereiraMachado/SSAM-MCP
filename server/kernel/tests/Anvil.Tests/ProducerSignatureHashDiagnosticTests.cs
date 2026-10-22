using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>Meta de 20/10/2026, item 14 (live on SSAM_DumpProbe, task ff04320e877f4a20b437b5915ef363ee): the capture of the
/// transitive producer RichWidgets stopped on "Native element payload hash differs: 0N1fxN+UvEywlV0xqy8aZw". This diagnostic
/// recomputes every element hash of the published RichWidgets OML downloaded on 19/10 (the published signature, read as
/// NativeDependencyReader.ReadProducer reads it) and writes the elements whose hash does not recompute to the audit folder.
/// It asserts nothing about the producer: it answers whether the recompute itself fails on the published payload.</summary>
public sealed class ProducerSignatureHashDiagnosticTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ProducerSignatureHashDiagnosticTests).Assembly.Location)!)!;

    [Fact]
    public void EveryElementHashOfThePublishedRichWidgetsRecomputesOrTheOnesThatDoNotAreListed()
    {
        var downloads = Path.Combine(Root, ".local", "environment", "download"); // Root is the kernel folder
        var oml = Directory.Exists(downloads) ? Directory.GetFiles(downloads, "RichWidgets.oml", SearchOption.AllDirectories).OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault() : null;
        if (oml == null) return; // no published RichWidgets at hand: nothing to diagnose
        StudioAssemblies.Bind();
        var bytes = File.ReadAllBytes(oml);
        var omlType = NativeType("Oml.Oml");
        using var loaded = (IDisposable)omlType.GetMethod("LoadWithoutUpgrades", [typeof(byte[]), typeof(string)])!.Invoke(null, [bytes, ""])!;
        var signature = (XElement)loaded.GetType().GetMethod("GetSignature", Type.EmptyTypes)!.Invoke(loaded, null)!;
        var fullType = NativeType("Oml.Signatures.FullElementSignature");
        var readerType = AppDomain.CurrentDomain.GetAssemblies().Where(a => a.GetName().Name == "OutSystems.Model.Implementation").SelectMany(a => { try { return a.GetTypes(); } catch (ReflectionTypeLoadException e) { return e.Types.Where(t => t != null)!; } }).First(t => t!.Name == "XElementReader")!;
        var mismatches = new JsonArray(); var total = 0;
        foreach (var wrapper in signature.Element("ElementSignatures")!.Elements())
        {
            total++;
            using var reader = (IDisposable)Activator.CreateInstance(readerType, new XElement(wrapper).CreateReader())!;
            var stored = Activator.CreateInstance(fullType, reader)!;
            object? P(string name) => (fullType.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance) is { } property ? property.GetValue(stored) : fullType.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(stored));
            var computed = Activator.CreateInstance(fullType, P("OriginalKey"), P("FullSignature"), P("ExternalDependencies"), P("FullSignature"), P("Hidden"), P("ParentOriginalKey"))!;
            var storedHash = P("FullSignatureHash")!.ToString();
            var computedHash = (fullType.GetProperty("FullSignatureHash", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(computed) ?? fullType.GetField("FullSignatureHash", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(computed))!.ToString();
            if (storedHash == computedHash) continue;
            var xml = (XElement)P("FullSignature")!;
            mismatches.Add(new JsonObject { ["key"] = P("OriginalKey")!.ToString(), ["tag"] = xml.Name.LocalName, ["name"] = xml.Attribute("OriginalName")?.Value,
                ["stored"] = storedHash, ["computed"] = computedHash, ["hidden"] = (bool)P("Hidden")!, ["children"] = xml.Elements().Count(),
                ["dependencies"] = ((System.Collections.IEnumerable)P("ExternalDependencies")!).Cast<object>().Count() });
        }
        var report = new JsonObject { ["oml"] = oml, ["elementsOrderVersion"] = signature.Attribute("ElementsOrderVersion")?.Value, ["elements"] = total,
            ["mismatches"] = mismatches.Count, ["items"] = mismatches, ["at"] = DateTime.UtcNow.ToString("O") };
        var audit = Path.GetFullPath(Path.Combine(Root, "..", ".local", "audit", "2026-10-20-meta-friccoes"));
        Directory.CreateDirectory(audit);
        File.WriteAllText(Path.Combine(audit, "richwidgets-hash-diagnostic.json"), report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(total > 0, "the published RichWidgets has no element signatures");
    }

    private static Type NativeType(string name) => Type.GetType("OutSystems.Model.Implementation." + name + ", OutSystems.Model.Implementation", throwOnError: true)!;
}
