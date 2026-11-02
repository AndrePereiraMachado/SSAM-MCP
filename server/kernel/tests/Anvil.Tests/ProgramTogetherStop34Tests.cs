using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.Tests;

/// <summary>F1 stops 3 and 4 (the harness is in ProgramTogetherTests.cs). Stop 3 proves the line already merges an open module
/// changed after the capture (with the intent proof of stop 1); stop 4 is the content proof's own reselection.</summary>
public partial class ProgramTogetherTests
{
    // ---- Stop 3: the module changed after the capture (the person's unsaved edits) ------------------------------------

    [Fact]
    public void Stop3_TheOpenModuleChangedAfterTheCaptureIsMergedThreeWaysNotRefused()
    {
        // A bridge without the model fingerprint cannot tell whether the open module changed: the delivery merges three ways
        // over its capture all the same, and the person's edit made after the capture stays in the module, noted.
        var studio = Studio(fingerprint: false);
        studio.AfterBaseSnapshot = live => Apply(live, Action("UnsavedInTheStudio"));
        var result = Deliver(studio, Action("Delivered3"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString() + " " + result["contentProof"]?["differences"]?.ToJsonString());
        Assert.True(Has(studio.Live, "UnsavedInTheStudio") && Has(studio.Live, "Delivered3"));
        Assert.NotEmpty(Notes(result));
    }

    // ---- Stop 4: the person selected another module tab -----------------------------------------------------------

    [Fact]
    public void Stop4_ATabThePersonSelectedAfterTheMergeIsSelectedAgainForTheProof()
    {
        var studio = Studio(fingerprint: true);
        studio.OtherTabAtSnapshot = 2; // the capture after the merge answers the person's other tab once
        var result = Deliver(studio, Action("Delivered4"));
        Assert.True(result["delivered"]?.GetValue<bool>() == true, result["error"]?.ToString());
        Assert.Contains(result["reselected"]!.AsArray(), r => r!["stage"]?.ToString() == "data-proof");
    }

}
