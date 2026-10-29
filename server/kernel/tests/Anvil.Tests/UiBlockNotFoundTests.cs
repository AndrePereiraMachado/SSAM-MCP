using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>R1 item 3: ui-block of a name the catalog does not have is UI_BLOCK_NOT_FOUND (CommandSurface.UiBlock, the
/// command the CLI's ui-block runs), with the closest block names; see ReferenceNotFoundTests.</summary>
public sealed class UiBlockNotFoundTests
{
    private static readonly string Kernel = PacoteBPolicyTests.FindRoot();

    // Reflection lets the identical regression test run on releases before this command was extracted.
    private static object Lookup(string catalog, string? name, string? find)
    {
        var method = typeof(CommandSurface).GetMethod("UiBlock");
        Assert.NotNull(method);
        try { return method.Invoke(null, [catalog, name, find])!; }
        catch (System.Reflection.TargetInvocationException error) when (error.InnerException != null)
        { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw(); throw; }
    }

    [Fact]
    public void ABlockTheCatalogDoesNotHaveIsUiBlockNotFoundWithTheClosestNames()
    {
        var catalog = Path.Combine(Kernel, "catalog", "ui", "OutSystemsUI-2.28.1.json");
        var error = Assert.ThrowsAny<Exception>(() => Lookup(catalog, "Tabz", null));
        var envelope = Errors.Envelope("ui-block", error, 0);
        Assert.Equal("UI_BLOCK_NOT_FOUND", envelope["code"]!.ToString());
        Assert.Contains("block 'Tabz' not in OutSystemsUI 2.28.1", envelope["error"]!.ToString());
        Assert.Contains("Tabs", envelope["candidates"]!.AsArray().Select(c => c!.ToString()));
        // A sentence used as a name: still not found, with the blocks that hold its words.
        var sentence = Errors.Envelope("ui-block", Assert.ThrowsAny<Exception>(() => Lookup(catalog, "html widgets popup upload select switch", null)), 0);
        Assert.Equal("UI_BLOCK_NOT_FOUND", sentence["code"]!.ToString());
        // The lookups that find something answer as before.
        Assert.Equal("Tabs", Assert.IsType<UiBlock>(Lookup(catalog, "tabs", null)).Name);
        Assert.NotEmpty(Assert.IsAssignableFrom<System.Collections.IEnumerable>(Lookup(catalog, null, "Tab")).Cast<object>());
        Assert.Throws<ArgumentException>(() => Lookup(catalog, null, null));
    }
}
