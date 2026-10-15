using ServiceStudio.Commands;
using ServiceStudio.Presenter;

namespace Anvil.Core;

/// <summary>Where a quiet command failed: the stage the body last reported and the exception it threw.</summary>
public sealed record QuietCommandFailure(string Stage, Exception Error)
{
    public string Text => Stage + ": " + Error.GetType().Name + ": " + Error.Message;
}

/// <summary>A failure of the body of a quiet command, raised by the caller after the command ended (never inside it).</summary>
public sealed class QuietCommandException(QuietCommandFailure failure)
    : InvalidOperationException("The SSAM command failed at stage " + failure.Stage + " and the Studio rolled it back: "
        + failure.Error.GetType().Name + ": " + failure.Error.Message, failure.Error)
{
    public QuietCommandFailure Failure { get; } = failure;
}

/// <summary>
/// R1 (fam-deps, 2026-10-12): no exception of SSAM leaves a Studio command. In the Studio, an exception that leaves the
/// delegate of a non-nested Command.Execute reaches Runtime.SafeExecute(ExceptionType.InsideCommand): the command is rolled
/// back, the crash dialog "Unexpected Error" opens (CrashExperience.FullyVisible, modal, waiting for a person) and the
/// exception is swallowed (ServiceStudio.Framework: Command.SafeExecute, Runtime.InnerSafeExecute). That is the dialog that
/// held the merge of VisitaCerta_UI for 30 min. Here the body runs inside the same native command; an exception is caught
/// inside it, recorded with the stage the body last reported, and the command is rolled back by the SDK itself
/// (Command.RollbackCurrentCommand: the end of the command runs UndoManager.RollbackCommand, as for an exception, without
/// the crash path). The caller gets the failure and raises it outside the command, where it is SSAM's own answer.
/// </summary>
public static class QuietCommand
{
    /// <summary>Runs <paramref name="body"/> inside one native command of <paramref name="context"/>. Null when the body
    /// completed; the failure (stage, exception) when it threw, the command rolled back by the SDK.</summary>
    public static QuietCommandFailure? Execute(PresenterContext context, string description, Action<Action<string>> body)
    {
        QuietCommandFailure? failure = null;
        var stage = "start";
        Command.Execute(context, description, () =>
        {
            try { body(s => stage = s); }
            catch (Exception ex)
            {
                failure = new QuietCommandFailure(stage, ex);
                try { Command.RollbackCurrentCommand(context.SourceTopLevelPresenter); }
                catch (Exception rollback)
                {
                    // The SDK refused the quiet rollback: the original exception goes on, so the command still rolls back
                    // (the crash path, as before this rule); the failure keeps both causes.
                    failure = new QuietCommandFailure(stage + "/rollback", new AggregateException(ex, rollback));
                    throw;
                }
            }
        });
        return failure;
    }
}
