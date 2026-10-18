using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// fix/no-internals round 5 (re-review round 4, LOW 3): the preflight answer is served to licensees (ssam_reference
/// check-job). Its `scope` says what the check covers in the words of the person who uses it, never with a class or a
/// namespace of the kernel (the family "kernel class" of the no-internals guard).
/// </summary>
public sealed class PreflightScopeTextTests
{
    [Fact]
    public void TheScopeOfThePreflightNamesNoKernelClass()
    {
        var scope = JobPreflight.Analyze(new JsonArray())["scope"]!.GetValue<string>();
        Assert.False(string.IsNullOrWhiteSpace(scope));
        Assert.DoesNotContain("Anvil.", scope, StringComparison.Ordinal);
        Assert.DoesNotContain("PreflightRules", scope, StringComparison.Ordinal);
        // what the sentence said stays: the job's own rules are still part of the check
        Assert.Contains("preflight rules", scope, StringComparison.Ordinal);
    }
}
