using System.Reflection;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R1 (fam-deps, 2026-10-12) on the Studio's own SDK, headless (MockAggregatorPresenter, the same command API the bridge
/// uses): an exception that leaves the delegate of Command.Execute escapes the command (in the Studio it reaches
/// Runtime.SafeExecute(ExceptionType.InsideCommand), which opens the modal crash report "Unexpected Error"); through
/// QuietCommand nothing escapes, the SDK rolls the command back itself (RollbackCurrentCommand) and the failure comes back
/// with the stage it happened in. The mutation is the module's Description, set inside the command and gone after it.
/// </summary>
public sealed class FamDepsQuietCommandTests
{
    private const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    [Fact]
    public void AFailureInsideAQuietCommandIsRolledBackByTheSdkAndNeverLeavesTheCommand()
    {
        var (local, context, release) = Module("quiet");
        try
        {
            var description = local.GetType().GetProperty("Description")!;
            var before = description.GetValue(local)?.ToString();
            Action<Action<string>> body = stage =>
            {
                stage("mutate");
                description.SetValue(local, "fam-deps probe");
                Assert.Equal("fam-deps probe", description.GetValue(local)?.ToString());
                stage("reference-merge");
                throw new InvalidOperationException("forced inside the command");
            };
            var failure = (QuietCommandFailure?)typeof(QuietCommand).GetMethod("Execute")!.Invoke(null, [context, "fam-deps quiet probe", body]);
            Assert.NotNull(failure);
            Assert.Equal("reference-merge", failure!.Stage);
            Assert.Equal("forced inside the command", failure.Error.Message);
            Assert.Equal("reference-merge: InvalidOperationException: forced inside the command", failure.Text);
            // Rolled back by the SDK: the module is as it was.
            Assert.Equal(before, description.GetValue(local)?.ToString());

            // A body that completes commits as before.
            var committed = (QuietCommandFailure?)typeof(QuietCommand).GetMethod("Execute")!.Invoke(null, [context, "fam-deps quiet commit", (Action<Action<string>>)(_ => description.SetValue(local, "kept"))]);
            Assert.Null(committed);
            Assert.Equal("kept", description.GetValue(local)?.ToString());
        }
        finally { release(); }
    }

    [Fact]
    public void TheSameFailureThroughThePlainCommandLeavesIt()
    {
        var (local, context, release) = Module("plain");
        try
        {
            var command = local.GetType().Assembly.GetType("ServiceStudio.Commands.Command", true)!;
            var execute = command.GetMethods().Single(m => m.Name == "Execute" && m.GetParameters().Length == 3 && m.GetParameters()[2].ParameterType == typeof(Action));
            var description = local.GetType().GetProperty("Description")!;
            var before = description.GetValue(local)?.ToString();
            Action body = () => { description.SetValue(local, "fam-deps probe"); throw new InvalidOperationException("forced inside the command"); };
            // The exception leaves Command.Execute: in the Studio this is the path to Runtime.SafeExecute and its crash dialog.
            var escaped = Assert.ThrowsAny<Exception>(() => execute.Invoke(null, [context, "fam-deps plain probe", body]));
            Assert.Contains("forced inside the command", (escaped.InnerException ?? escaped).ToString());
            Assert.Equal(before, description.GetValue(local)?.ToString());
        }
        finally { release(); }
    }

    private static (object Local, object Context, Action Release) Module(string tag)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(FamDepsQuietCommandTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "fam-deps-tests", "quiet-" + tag + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var local = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [Path.Combine(root, "tests", "fixtures", "blank-service.oml")])!;
        local.GetType().GetMethod("PrepareForSave", All, Type.EmptyTypes)?.Invoke(local, null);
        var presenterAssembly = Assembly.Load("ServiceStudio.Presenter");
        var aggregatorType = presenterAssembly.GetType("ServiceStudio.Presenter.Commands.MockAggregatorPresenter", true)!;
        var aggregator = Activator.CreateInstance(aggregatorType, [local, null, false, null, null, false])!;
        var presenterType = presenterAssembly.GetType("ServiceStudio.Presenter.Commands.MockPresenter", true)!;
        var presenter = Activator.CreateInstance(presenterType, [aggregator])!;
        var context = presenterType.GetMethod("GetPresenterContext", Type.EmptyTypes)!.Invoke(presenter, null)!;
        var undo = local.GetType().Assembly.GetType("ServiceStudio.Undo.UndoManager", true)!;
        return (local, context, () =>
        {
            try { undo.GetMethods(All).FirstOrDefault(m => m.Name == "ClearHistory" && m.GetParameters().Length == 1)?.Invoke(null, [aggregator]); } catch { }
            try { (aggregator as IDisposable)?.Dispose(); } catch { }
            try { typeof(ModelHost).GetMethod("Release", All, [local.GetType()])?.Invoke(null, [local]); } catch { }
        });
    }
}
