using System.Text.Json;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class NativePerformanceCaptureTests
{
    [Fact]
    public void SetterGroupsContainTypePropertyAndRouteWithoutAcceptingInstanceValues()
    {
        using var capture = NativePerformanceCapture.Begin();
        using (NativePerformanceCapture.MeasureSet(typeof(string), "Length", "property.SetValue")) { }
        using (NativePerformanceCapture.MeasureSet(typeof(string), "Length", "property.SetValue")) { }
        using (NativePerformanceCapture.MeasureSet(typeof(string), "Length", "expression.Text")) { }
        var phases = capture.Snapshot().Phases;
        Assert.Equal(2, phases.Count);
        Assert.Equal(2, phases["set.write/System.String/Length/property.SetValue"].Calls);
        Assert.Equal(1, phases["set.write/System.String/Length/expression.Text"].Calls);
        Assert.All(phases.Values, phase => Assert.Null(phase.CpuMs));
    }

    [Fact]
    public void CaptureCountsCompletedScopesIncludingFailuresAndSerializesWithoutNativeRuntime()
    {
        using var capture = NativePerformanceCapture.Begin();
        using (NativePerformanceCapture.MeasureVerb("create")) { }
        Action fail = () =>
        {
            using var timing = NativePerformanceCapture.MeasureVerb("create");
            throw new InvalidOperationException("source operation failed");
        };
        Assert.Throws<InvalidOperationException>(fail);
        var timing = NativePerformanceCapture.MeasureVerb("set"); timing.Dispose(); timing.Dispose();
        var snapshot = capture.Snapshot();
        Assert.Equal(1, snapshot.FormatVersion);
        Assert.Equal(2, snapshot.Phases["verb.create"].Calls);
        Assert.Equal(1, snapshot.Phases["verb.set"].Calls);
        Assert.All(snapshot.Phases.Values, phase => { Assert.True(phase.WallMs >= 0); Assert.Null(phase.CpuMs); Assert.Equal(0, phase.CpuSamples); });
        var json = JsonSerializer.SerializeToNode(snapshot)!;
        Assert.Equal(2, json["Phases"]!["verb.create"]!["Calls"]!.GetValue<int>());
        Assert.Null(json["Phases"]!["verb.create"]!["CpuMs"]);
    }

    [Fact]
    public void NestedCapturesStayIsolatedAndRestoreTheirParent()
    {
        using (NativePerformanceCapture.Measure("unobserved")) { }
        using var outer = NativePerformanceCapture.Begin();
        using (NativePerformanceCapture.Measure("outer.first")) { }
        using (var inner = NativePerformanceCapture.Begin())
        {
            using (NativePerformanceCapture.Measure("inner")) { }
            Assert.Single(inner.Snapshot().Phases);
        }
        using (NativePerformanceCapture.Measure("outer.second")) { }
        Assert.Equal(new[] { "outer.first", "outer.second" }, outer.Snapshot().Phases.Keys);
        outer.Dispose();
        using (NativePerformanceCapture.Measure("after.dispose")) { }
        Assert.Equal(2, outer.Snapshot().Phases.Count);
    }

    [Fact]
    public void CommandRemainderIsExplicitlyDerivedAndCpuSamplingIsOptional()
    {
        using var capture = NativePerformanceCapture.Begin();
        using (NativePerformanceCapture.Measure("mutation.command", cpu: true))
            using (NativePerformanceCapture.Measure("mutation.callback", cpu: true)) { }
        var phases = capture.Snapshot().Phases;
        var remainder = phases["mutation.commandRemainder"];
        Assert.True(remainder.Derived);
        Assert.Equal(1, remainder.Calls);
        Assert.InRange(remainder.WallMs, 0, phases["mutation.command"].WallMs);
        Assert.Equal(phases["mutation.command"].WallMs - phases["mutation.callback"].WallMs, remainder.WallMs, 6);
        Assert.InRange(remainder.CpuSamples, 0, 1);
        if (remainder.CpuSamples == 0) Assert.Null(remainder.CpuMs);
        else Assert.True(remainder.CpuMs >= 0);
    }
}
