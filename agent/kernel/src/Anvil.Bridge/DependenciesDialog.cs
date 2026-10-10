using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ServiceStudio.Presenter;
using WebViewControl;

namespace Anvil.Bridge;

/// <summary>
/// MB2 (owner rule 2026-10-07, capability dialogs:dependencies_auto): the Studio's "Incompatible or missing dependencies
/// found" dialog never stops a call. Answer() closes every visible one as Cancel (Close() of that DialogWindow, the X of the
/// person; never Manage Dependencies) and nothing else: each visible DialogWindow's text is read through its own WebView
/// (document.body.innerText, read only) and DialogScope.DependenciesToClose picks the ones to close. The caller then runs
/// refresh_references {module_key} for every producer of its module.
///   answer_dependencies_dialog {}   {answered:[{kind, title, answer:"Cancel", text}], count, module?, moduleKey?}
/// module/moduleKey: the selected tab of the window that owns the dialog, when the dialog has an owner window.
/// </summary>
internal static class DependenciesDialog
{
    public static async Task<string> Handle(JsonObject? p)
    {
        var (answered, owner) = await Answer(p?["title"]?.ToString());
        return Server.Ok(new JsonObject { ["answered"] = answered, ["count"] = answered.Count,
            ["module"] = owner?.ActiveESpace?.Name, ["moduleKey"] = owner?.ActiveESpace?.Key.ToString() });
    }

    /// <summary>Closes the visible dependencies dialogs (only the one titled <paramref name="title"/> when given). Never
    /// throws: a UI thread that does not answer, or a page that does not, closes nothing.</summary>
    public static async Task<(JsonArray Answered, IAggregatorPresenter? Owner)> Answer(string? title = null)
    {
        var answered = new JsonArray();
        List<(Window Window, string? Title, string Type, WebView? View)> windows;
        try
        {
            // Bounded and withdrawn when the UI thread does not run it (UiGate.cs).
            windows = await Ui.Run(() =>
            {
                var lifetime = Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime;
                return (lifetime?.Windows ?? new List<Window>())
                    .Where(w => w.IsVisible && w.GetType().Name.Contains("DialogWindow", StringComparison.Ordinal))
                    .Select(w => (w, w.Title, w.GetType().Name, w.GetVisualDescendants().OfType<WebView>().FirstOrDefault()))
                    .ToList();
            }, TimeSpan.FromSeconds(8), "answer_dependencies_dialog: list");
        }
        catch (UiBusyException) { UiGate.Forget(); return (answered, null); }
        catch (Exception) { return (answered, null); }
        if (windows.Count == 0) return (answered, null);

        var texts = new List<string?>();
        foreach (var w in windows) texts.Add(w.View == null ? null : await ReadText(w.View));
        var close = DialogScope.DependenciesToClose(windows.Select((w, i) => ((string?)w.Type, w.Title, texts[i])).ToList(), title);
        if (close.Count == 0) return (answered, null);

        IAggregatorPresenter? owner = null;
        try
        {
            await Ui.Run(() =>
            {
                foreach (var i in close)
                {
                    var w = windows[i].Window;
                    if (!w.IsVisible) continue;
                    owner ??= OwnerTab(w);
                    try { w.Close(); answered.Add(DialogScope.Answered(windows[i].Title, texts[i])); }
                    catch (Exception) { /* a window that refuses to close stays for the person; the caller sees it next read */ }
                }
            }, TimeSpan.FromSeconds(8), "answer_dependencies_dialog: close");
        }
        catch (UiBusyException) { UiGate.Forget(); /* withdrawn, or still closing: the caller reads the dialogs again */ }
        catch (Exception) { /* nothing more was closed */ }
        return (answered, owner);
    }

    // The selected tab of the Studio window that owns the dialog (the module whose producers changed), when it has one.
    private static IAggregatorPresenter? OwnerTab(Window dialog)
    {
        try
        {
            if (dialog.Owner is not Window ownerWindow) return null;
            if (ServiceStudio.Runtime.Instance is not RuntimeImplementation runtime) return null;
            foreach (var w in runtime.AggregatorWindows)
                if (Studio.Prop(w, "View") is { } view && ReferenceEquals(view, ownerWindow)
                    && w.SelectedTopLevelPresenter is IAggregatorPresenter tab && tab.ActiveESpace != null)
                    return tab;
        }
        catch (Exception) { /* no owner tab: the caller names its module */ }
        return null;
    }

    // Read only; null when the page does not answer in time.
    private static async Task<string?> ReadText(WebView view)
    {
        try
        {
            var task = view.EvaluateScript<string>("document.body ? document.body.innerText : ''", null, TimeSpan.FromSeconds(5));
            if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(6))) != task) return null;
            var text = task.Result;
            return text == null ? null : text.Length > 4000 ? text[..4000] : text;
        }
        catch (Exception) { return null; }
    }
}
