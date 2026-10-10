using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class PublicationBatchTests
{
    private static PublishOutcome Started(int i) => new(true, false, false, i + 1, 100 + i, "key" + i,
        Array.Empty<PublishMessage>(), 0, 0);

    [Fact]
    public void StartsAllModulesBeforePollingAndTracksOutOfOrderCompletion()
    {
        var events = new List<string>();
        var polls = new int[3];
        var results = PublicationBatch.Run(3, i => { events.Add("start" + i); return Started(i); },
            (i, p) => { events.Add("poll" + i); return p with { Completed = ++polls[i] >= (i == 0 ? 2 : 1) }; },
            interval: TimeSpan.Zero);
        Assert.Equal(new[] { "start0", "start1", "start2" }, events.Take(3));
        Assert.Equal(new[] { 2, 1, 1 }, polls);
        Assert.All(results, r => { Assert.True(r.Outcome.Completed); Assert.Null(r.Error); });
        Assert.Equal(new[] { 100, 101, 102 }, results.Select(r => r.Outcome.VersionId));
    }

    [Fact]
    public void SubmissionFailureDoesNotReplayOrHideOtherPublications()
    {
        var starts = new int[3];
        var results = PublicationBatch.Run(3, i => {
            starts[i]++;
            if (i == 1) throw new IOException("connection lost");
            return Started(i);
        }, (_, p) => p with { Completed = true }, interval: TimeSpan.Zero);
        Assert.Equal(new[] { 1, 1, 1 }, starts);
        Assert.True(results[0].Outcome.Completed);
        Assert.Contains("unknown", results[1].Error);
        Assert.True(results[2].Outcome.Completed);
    }

    [Fact]
    public void PollFailurePreservesReceiptAndContinuesOtherModules()
    {
        var results = PublicationBatch.Run(2, Started, (i, p) =>
            i == 0 ? throw new IOException("connection lost") : p with { Completed = true }, interval: TimeSpan.Zero);
        Assert.True(results[0].Outcome.Started);
        Assert.Equal(100, results[0].Outcome.VersionId);
        Assert.False(results[0].Outcome.Completed);
        Assert.Contains("inspect version 100", results[0].Error);
        Assert.True(results[1].Outcome.Completed);
    }

    [Fact]
    public void RejectedSubmissionIsNotPolledAndCompilationErrorsAreRetained()
    {
        var results = PublicationBatch.Run(2, i => i == 0 ? Started(i) with { Started = false, HasErrors = true } : Started(i),
            (i, p) => {
                Assert.Equal(1, i);
                return p with { Completed = true, HasErrors = true,
                    Messages = new[] { new PublishMessage("compile", "Error", "invalid reference", null) } };
            }, interval: TimeSpan.Zero);
        Assert.All(results, r => Assert.True(r.Outcome.HasErrors));
        Assert.Single(results[1].Outcome.Messages);
    }

    [Fact]
    public void TimeoutPreservesAllSubmittedVersionsWithoutRetry()
    {
        var results = PublicationBatch.Run(2, Started, (_, _) => throw new Exception("must not poll expired jobs"),
            timeout: TimeSpan.Zero, interval: TimeSpan.Zero);
        Assert.All(results, r => {
            Assert.True(r.Outcome.Started);
            Assert.False(r.Outcome.Completed);
            Assert.Contains("TimeoutException", r.Error);
        });
        Assert.Equal(new[] { 100, 101 }, results.Select(r => r.Outcome.VersionId));
    }

    [Fact]
    public void ModuleSuccessRequiresConfirmedPublicationAndMatchingInventory()
    {
        var server = new ModuleSummary("A", "key0", "eSpace", "Service", 100, 1, "App", "app",
            DateTime.UnixEpoch, null, true, true, null);
        var module = new ModuleCreationOutcome("A", "Service", "key0", 1, null, true, 1, "A.oml",
            Started(0), server, null);
        Assert.False(module.Succeeded);
        module = module with { Publish = module.Publish! with { Completed = true } };
        Assert.True(module.Succeeded);
        Assert.False((module with { Error = "completion unknown" }).Succeeded);
        Assert.False((module with { ServerModuleAfter = server with { Key = "other" } }).Succeeded);
        Assert.False((module with { Publish = module.Publish! with { HasErrors = true } }).Succeeded);
        Assert.True((module with { Publish = null, Skipped = true }).Succeeded);
    }

    [Fact]
    public void ApplicationSuccessAndSerializedStatusReflectFailedModules()
    {
        var failed = new ModuleCreationOutcome("A", "Service", null, 0, null, false, 0, null, null, null, "invalid");
        var app = new ApplicationCreationOutcome("App", "app", true, null, false, "Reactive", null, new[] { failed });
        Assert.False(app.Succeeded);
        Assert.False(Json.Project(app)!["Succeeded"]!.GetValue<bool>());
        Assert.False((app with { ApplicationOk = false, Modules = Array.Empty<ModuleCreationOutcome>() }).Succeeded);
    }
}
