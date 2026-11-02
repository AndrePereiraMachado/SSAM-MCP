using Anvil.Core;
using OutSystems.Model;
using OutSystems.Model.Data;
using Xunit;

namespace Anvil.Tests;

/// <summary>Linked into both test projects. F10 (round 8bc99ec2 of 2026-10-25, "SSAMCoverageSoapWire.Cliente List" written to tell
/// the entity from records of the same name): a type qualified with its producer is no form of the type language (the texts read
/// a type back by its name alone), so the type text refuses it with the exact name the module has for that element; a qualifier
/// that names no producer is read as before. Needs the Studio of the lane (skipped without it).</summary>
public sealed class QualifiedTypeTests
{
    private static string? FixturePath()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(QualifiedTypeTests).Assembly.Location)!);
        if (root == null) return null;
        var odc = typeof(ModelHost).Assembly.GetName().Name == "Anvil.Core.Odc";
        var path = Path.Combine(root, odc ? "tests/fixtures/odc/insurance-reactive-r8.oml" : "tests/fixtures/reactive-ui.oml");
        return File.Exists(path) ? path : null;
    }

    [Fact]
    public void ATypeQualifiedWithItsProducerIsRefusedWithTheNameTheModuleHas()
    {
        var fixture = FixturePath();
        Assert.True(fixture != null, "the fixture of the lane is missing");
        ServiceStudio.Model.ESpace model;
        try { model = new ModelHost(Path.Combine(Path.GetTempPath(), "ssam-qualified-type-" + Guid.NewGuid().ToString("N"))).Load(File.ReadAllBytes(fixture)); }
        catch (Exception) { return; }   // no Studio of the lane
        try
        {
            var es = (IESpace)(object)model;
            // An entity of the module qualified with the module, else one of a reference qualified with its producer, chosen the same
            // way whatever ran before (review W3-EDIT round 3, R3-2: the order of the references picked the producer "(System)", no
            // name of the type language): names that are identifiers only, the first by name.
            static bool Identifier(string? text) => text != null && System.Text.RegularExpressions.Regex.IsMatch(text, @"^[A-Za-z_]\w*$");
            string name, module;
            var owns = es.GetAllDescendantsOfType<IEntity>().Select(e => TypeResolver.Name(e)).Where(Identifier).Order(StringComparer.Ordinal).ToList();
            if (owns.Count > 0 && Identifier(TypeResolver.Name(es))) { name = owns[0]!; module = TypeResolver.Name(es)!; }
            else
            {
                var producer = es.References.Where(r => Identifier(TypeResolver.Name(r)) && r.Entities.Any(e => Identifier(TypeResolver.Name(e))))
                    .OrderBy(r => TypeResolver.Name(r), StringComparer.Ordinal).First();
                name = producer.Entities.Select(e => TypeResolver.Name(e)).Where(Identifier).Order(StringComparer.Ordinal).First()!;
                module = TypeResolver.Name(producer)!;
            }
            var refused = Assert.ThrowsAny<KeyNotFoundException>(() => TypeResolver.Resolve(es, module + "." + name + " Identifier"));
            Assert.Contains("write '" + name + " Identifier'", refused.Message);
            Assert.Contains("a type is named without its producer", refused.Message);
            // The name alone is the type; a qualifier that names no producer is read as before (not this refusal).
            Assert.NotNull(TypeResolver.Resolve(es, name + " Identifier"));
            var other = Assert.ThrowsAny<Exception>(() => TypeResolver.Resolve(es, "NoSuchProducer." + name + " Identifier"));
            Assert.DoesNotContain("without its producer", other.Message);
        }
        finally { ModelHost.Release(model); }
    }
}
