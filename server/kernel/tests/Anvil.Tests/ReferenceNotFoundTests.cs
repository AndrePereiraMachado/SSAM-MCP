using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>R1 item 3 (2026-10-28): a name a reference lookup does not have came back as CLI_REFUSED, the code of a failure
/// of the CLI. Each "not found" of the lookups has its own code (KernelRefusalException, in the envelope of both CLIs and
/// of the worker), the closest names as the envelope's candidates, and a message without the folders of the installation.</summary>
public sealed class ReferenceNotFoundTests
{
    [Fact]
    public void AnAssemblyTheStudioFolderDoesNotHaveIsAssemblyNotFoundWithTheClosestNames()
    {
        var studio = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "anvil-types-" + Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            foreach (var name in new[] { "ServiceStudio.Framework", "ServiceStudio.Common", "OutSystems.Model.V1" }) File.WriteAllText(Path.Combine(studio, name + ".dll"), "");
            var error = Assert.ThrowsAny<Exception>(() => FrameworkProbe.Types(studio, "ServiceStudio.Framwork", "Widgets"));
            Assert.Equal("ASSEMBLY_NOT_FOUND", Errors.FindCoded(error)?.Code);
            var envelope = Errors.Envelope("types", error, 0);
            Assert.Equal("ASSEMBLY_NOT_FOUND", envelope["code"]!.ToString());
            Assert.Equal("ServiceStudio.Framework", envelope["candidates"]![0]!.ToString());
            Assert.DoesNotContain(studio, envelope["error"]!.ToString(), StringComparison.OrdinalIgnoreCase);
        }
        finally { try { Directory.Delete(studio, true); } catch (IOException) { } }
    }
}
