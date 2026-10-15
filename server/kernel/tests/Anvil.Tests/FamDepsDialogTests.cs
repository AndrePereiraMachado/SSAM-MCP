using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Bridge;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Family D (fam-deps, 2026-10-12): a dialog the Studio opens during an SSAM operation is the operation's. The decision
/// policy (OperationDialogPolicy) on the reads of the incident and of the other dialogs, the watch of one operation
/// (OperationDialogLoop) with a fake dialog surface, the classification of the Studio's crash report (DialogPolicy), and
/// F2: the client's socket deadline of each verb is the bridge's own bound (BridgeDeadlines, BridgeClient against a fake
/// bridge that answers late). Nothing live.
/// </summary>
public sealed class FamDepsDialogTests
{
    // The read of 21:48:16 (o11_studio status): title and the close glyph only; the page text through the WebView.
    private static DialogRead UnexpectedError(string? web = "An unexpected error occurred. InvalidOperationException: Native merge did not retain ... Report | Close")
        => new("w1", "DialogWindow", "Unexpected Error", ["[Button] Viewbox", "Unexpected Error"], web, Web: true);

    [Fact]
    public void TheStudiosCrashReportIsClassifiedByItsTitleNotAsAnUnreadableWebDialog()
    {
        Assert.Equal("UnexpectedError", DialogPolicy.ClassifyWindow("Unexpected Error", ["[Button] Viewbox", "Unexpected Error"]));
        Assert.Contains("closes it", OperationDialogPolicy.Hint(DialogPolicy.UnexpectedError));
        Assert.Contains(DialogPolicy.UnexpectedError, DialogScope.PublishBlocking);
    }

    [Fact]
    public void TheCrashReportIsClosedForCertainEvenWhenItsPageCannotBeRead()
    {
        foreach (var read in new[] { UnexpectedError(), UnexpectedError(web: null) })
        {
            var decision = OperationDialogPolicy.Decide(read);
            Assert.Equal(OperationDialogPolicy.UnexpectedError, decision.Kind);
            Assert.True(decision.Certain);
            Assert.Equal("close", decision.Answer);
            Assert.Null(decision.Question);
        }
        Assert.Contains("InvalidOperationException", OperationDialogPolicy.Decide(UnexpectedError()).Text);
    }

    [Fact]
    public void EveryOtherDialogIsDecidedByRuleAndTheUncertainOnesCarryOneQuestionWithTheExactText()
    {
        var dependencies = OperationDialogPolicy.Decide(new("w", "DialogWindow", "", ["[Button] Viewbox"], "Incompatible or missing dependencies found. Manage Dependencies Cancel", true));
        Assert.Equal((OperationDialogPolicy.Dependencies, true), (dependencies.Kind, dependencies.Certain));

        var ok = OperationDialogPolicy.Decide(new("w", "MessageBox", "Information", ["The module was saved.", "[Button] OK"], null, false));
        Assert.Equal((DialogPolicy.MessageBox, true, "close"), (ok.Kind, ok.Certain, ok.Answer));

        var recovery = OperationDialogPolicy.Decide(new("w", "DialogWindow", "Recover", ["[Button] Viewbox"], "Recover unsaved changes? Open Discard", true));
        Assert.Equal(DialogPolicy.Recovery, recovery.Kind);
        Assert.False(recovery.Certain);
        Assert.Contains("Recover unsaved changes?", recovery.Question);
        Assert.Contains("Open ou Discard", recovery.Question);

        var question = OperationDialogPolicy.Decide(new("w", "MessageBox", "Save changes", ["Do you want to save?", "[Button] Yes", "[Button] No"], null, false));
        Assert.Equal(OperationDialogPolicy.Question, question.Kind);
        Assert.False(question.Certain);
        Assert.Contains("Yes | No", question.Question);

        var signIn = OperationDialogPolicy.Decide(new("w", "DialogWindow", "Sign in", ["[Button] Viewbox"], "Sign in to personal-2qqw9srv. Password", true));
        Assert.Equal((OperationDialogPolicy.SignIn, false), (signIn.Kind, signIn.Certain));
        Assert.Contains("nunca digita senha", signIn.Question);

        var unreadable = OperationDialogPolicy.Decide(new("w", "DialogWindow", "Something", ["[Button] Viewbox"], null, true));
        Assert.Equal((OperationDialogPolicy.Unreadable, false), (unreadable.Kind, unreadable.Certain));

        var progress = OperationDialogPolicy.Decide(new("w", "Window", "Progress", ["Publishing 40%"], null, false));
        Assert.True(progress.Transient);
    }

    /// <summary>A fake Studio: windows appear at given polls; Close removes them (or refuses).</summary>
    private sealed class FakeSurface : IStudioDialogSurface
    {
        public readonly Dictionary<string, DialogRead> Open = new(StringComparer.Ordinal);
        public readonly List<string> Closed = [];
        public bool RefuseClose;
        public Action<FakeSurface>? OnList;
        public Task<IReadOnlyList<string>> List() { OnList?.Invoke(this); return Task.FromResult<IReadOnlyList<string>>(Open.Keys.ToArray()); }
        public Task<DialogRead?> Read(string id) => Task.FromResult(Open.TryGetValue(id, out var r) ? r : null);
        public Task<bool> Close(string id, DialogDecision decision)
        {
            if (RefuseClose) return Task.FromResult(false);
            Closed.Add(id); Open.Remove(id); return Task.FromResult(true);
        }
    }

    [Fact]
    public async Task ACrashReportTheMergeOpensIsClosedAndRecordedAndTheMergeEndsWithoutThePerson()
    {
        var surface = new FakeSurface();
        var merge = new TaskCompletionSource<string>();
        var lists = 0;
        // The merge's crash report appears on the second poll; once it is closed the merge ends (the Studio rolled it back).
        surface.OnList = s => { if (++lists == 2) s.Open["crash"] = UnexpectedError(); };
        var recorded = new List<JsonObject>();
        var watch = OperationDialogLoop.Watch(merge.Task, surface, TimeSpan.FromSeconds(20), TimeSpan.FromMilliseconds(20), e => { recorded.Add(e); }, new HashSet<string>());
        while (surface.Closed.Count == 0 && !watch.IsCompleted) await Task.Delay(10);
        merge.SetResult("rolled back");
        var outcome = await watch;
        Assert.Equal("done", outcome.State);
        Assert.Equal("rolled back", outcome.Result);
        Assert.Equal(["crash"], surface.Closed);
        // The entry reached the receipt before the window closed, with the text read from the page.
        var entry = Assert.Single(recorded);
        Assert.Equal(OperationDialogPolicy.UnexpectedError, entry["kind"]!.ToString());
        Assert.Contains("unexpected error", entry["text"]!.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.True(Assert.Single(outcome.Answered)!["closed"]!.GetValue<bool>());
    }

    [Fact]
    public async Task ADialogOnlyThePersonAnswersEndsTheWatchAtOnceWithTheQuestionWhileTheMergeWaits()
    {
        var surface = new FakeSurface();
        surface.OnList = s => s.Open["recovery"] = new("recovery", "DialogWindow", "Recover", ["[Button] Viewbox"], "Recover unsaved changes? Open Discard", true);
        var merge = new TaskCompletionSource<string>();
        var outcome = await OperationDialogLoop.Watch(merge.Task, surface, TimeSpan.FromSeconds(20), TimeSpan.FromMilliseconds(20), before: new HashSet<string>());
        Assert.Equal("blocked", outcome.State);
        Assert.Equal("Recover", outcome.Blocked!["title"]!.ToString());
        Assert.Contains("Open ou Discard", outcome.Blocked["question"]!.ToString());
        Assert.Empty(surface.Closed);
        Assert.False(merge.Task.IsCompleted);
        Assert.True(outcome.ElapsedMs < 5000, "blockedBy in seconds, never at the end of the bound: " + outcome.ElapsedMs);
    }

    [Fact]
    public async Task ADialogThatWasOpenBeforeTheOperationIsThePersonsAndIsNeverTouched()
    {
        var surface = new FakeSurface();
        surface.Open["old"] = UnexpectedError();
        var before = new HashSet<string>(await surface.List(), StringComparer.Ordinal);
        var merge = new TaskCompletionSource<string>();
        var watch = OperationDialogLoop.Watch(merge.Task, surface, TimeSpan.FromSeconds(20), TimeSpan.FromMilliseconds(20), before: before);
        await Task.Delay(150);
        merge.SetResult("applied");
        var outcome = await watch;
        Assert.Equal("done", outcome.State);
        Assert.Empty(surface.Closed);
        Assert.Empty(outcome.Answered);
    }

    [Fact]
    public async Task ACertainDialogThatDoesNotCloseBecomesTheOneQuestion()
    {
        var surface = new FakeSurface { RefuseClose = true };
        surface.OnList = s => s.Open["crash"] = UnexpectedError();
        var outcome = await OperationDialogLoop.Watch(new TaskCompletionSource<string>().Task, surface, TimeSpan.FromSeconds(20), TimeSpan.FromMilliseconds(20), before: new HashSet<string>());
        Assert.Equal("blocked", outcome.State);
        Assert.Contains("Feche-o no Studio", outcome.Blocked!["question"]!.ToString());
    }

    [Fact]
    public async Task TheWatchIsBoundedAndAnswersTimedOut()
    {
        var outcome = await OperationDialogLoop.Watch(new TaskCompletionSource<string>().Task, new FakeSurface(), TimeSpan.FromMilliseconds(120), TimeSpan.FromMilliseconds(20), before: new HashSet<string>());
        Assert.Equal("timed-out", outcome.State);
    }

    // ---- F2: client deadline >= bridge bound ----------------------------------------------------------------------------

    [Fact]
    public void TheSocketDeadlineOfEachVerbCoversTheBridgesOwnBound()
    {
        Assert.Equal((int)UiGate.Heavy.TotalSeconds, BridgeDeadlines.Heavy);
        Assert.Equal((int)UiGate.Model.TotalSeconds, BridgeDeadlines.Model);
        Assert.Equal((int)UiGate.Read.TotalSeconds, BridgeDeadlines.Read);
        Assert.True(BridgeDeadlines.Seconds("merge_from_oml", null, 120) > (UiGate.Read + UiGate.Heavy).TotalSeconds);
        Assert.True(BridgeDeadlines.Seconds("refresh_references", new JsonObject { ["timeout"] = 600 }, 120) > 600 + 2 * UiGate.Model.TotalSeconds);
        Assert.True(BridgeDeadlines.Seconds("publish", new JsonObject { ["timeout"] = 300 }, 120) > 300);
        Assert.Equal(120, BridgeDeadlines.Seconds("ping", null, 120));
        Assert.Equal(330, BridgeDeadlines.Seconds("get_active_module", null, 330));
    }

    [Fact]
    public void TheClientWaitsForALateMergeAnswerAndStillGivesUpOnAQuickVerbAtItsOwnDeadline()
    {
        var before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "fam-deps-client-" + Guid.NewGuid().ToString("N")));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        using var stop = new CancellationTokenSource();
        // A fake bridge that answers every request after 2.5 s (the merge that waits for the Studio).
        var server = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await listener.AcceptTcpClientAsync(stop.Token); } catch (OperationCanceledException) { return; } catch (SocketException) { return; }
                _ = Task.Run(async () =>
                {
                    using (client)
                    {
                        var stream = client.GetStream();
                        var reader = new StreamReader(stream, new UTF8Encoding(false));
                        var line = await reader.ReadLineAsync();
                        await Task.Delay(2500);
                        try
                        {
                            var bytes = Encoding.UTF8.GetBytes(new JsonObject { ["success"] = true, ["data"] = new JsonObject { ["merged"] = true, ["echo"] = JsonNode.Parse(line!)!["method"]!.ToString() } }.ToJsonString() + "\n");
                            await stream.WriteAsync(bytes);
                        }
                        catch (IOException) { }
                    }
                });
            }
        });
        try
        {
            var bridge = new BridgeClient(port, timeoutSeconds: 1);
            var merged = bridge.Call("merge_from_oml", new JsonObject { ["operation_id"] = "x" });
            Assert.Equal("merge_from_oml", merged["echo"]!.ToString());
            Assert.ThrowsAny<IOException>(() => bridge.Call("ping"));
        }
        finally
        {
            stop.Cancel(); listener.Stop();
            Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before));
        }
    }
}
