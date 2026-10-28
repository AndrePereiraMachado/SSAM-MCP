using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class JobRunnerCompatibilityTests
{
    [Theory]
    [InlineData("{\"jobs\":\"ignored\",\"ops\":[{\"op\":\"set\",\"target\":\"@key\"}]}", "[{\"op\":\"set\",\"target\":\"@key\"}]")]
    [InlineData("{\"jobs\":[],\"ops\":\"ignored\"}", "[]")]
    public void LegacyCompositeFieldInterpretationIsUnchanged(string source, string expected)
    {
        var actual = JobRunner.CollectOps(JsonNode.Parse(source)!, Path.GetTempPath());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected), actual), actual.ToJsonString());
    }

    [Theory]
    [InlineData("{\"jobs\":17}", "job without 'ops' or 'jobs'")]
    [InlineData("{\"jobs\":[],\"ops\":[{}]}", "composite job: use 'jobs' OR 'ops', not both")]
    public void LegacyCompositeErrorTypeAndMessageAreUnchanged(string source, string expected)
    {
        var error = Assert.Throws<InvalidOperationException>(() => JobRunner.CollectOps(JsonNode.Parse(source)!, Path.GetTempPath()));
        Assert.Equal(expected, error.Message);
    }
}
