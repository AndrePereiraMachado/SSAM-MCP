using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using Avalonia.VisualTree;

namespace Anvil.Bridge;

/// <summary>
/// Olhos para troubleshooting sem screenshot: que janelas/dialogos o Studio tem abertos e que textos mostram.
/// windows {max_texts?}: por janela, titulo, tipo, visivel/ativa/modal e os textos visiveis (TextBlock/Button/TextBox).
/// ui_alive {timeout_ms?}: a UI thread responde? (InvokeAsync com prazo) - distingue "dialogo aberto" de "thread presa".
/// So leitura; nada aqui fecha ou clica.
/// </summary>
internal static class WindowsHandler
{
    public static async Task<string> UiAlive(JsonObject? p)
    {
        var timeout = p?["timeout_ms"]?.GetValue<int>() ?? 5000;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        // The probe is withdrawn when the UI thread does not run it in time: probes never pile up behind a blocked UI.
        bool done;
        try { done = await Ui.Run(() => true, TimeSpan.FromMilliseconds(Math.Clamp(timeout, 1, 60000)), "ui_alive"); }
        catch (UiBusyException) { done = false; UiGate.Forget(); }
        return Server.Ok(new JsonObject { ["alive"] = done, ["elapsedMs"] = sw.ElapsedMilliseconds, ["timeoutMs"] = timeout });
    }

    /// <summary>close_dialog {title?, type?}: fecha os dialogos (janelas com dono) visiveis - o Cancel do humano, para o bridge
    /// seguir com login/open_module quando um dialogo modal (login web, aviso) ficou aberto no arranque. Troubleshooting apenas.</summary>
    public static async Task<string> CloseDialog(JsonObject? p)
    {
        var title = p?["title"]?.GetValue<string>();
        var type = p?["type"]?.GetValue<string>();
        JsonArray closedNow;
        try { closedNow = await Ui.Run(() =>
        {
            var closed = new JsonArray();
            var lifetime = Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime;
            foreach (var w in (lifetime?.Windows ?? new List<Window>()).Where(w => w.Owner != null && w.IsVisible).ToList())
            {
                if (title != null && !string.Equals(w.Title, title, StringComparison.OrdinalIgnoreCase)) continue;
                if (type != null && !string.Equals(w.GetType().Name, type, StringComparison.OrdinalIgnoreCase)) continue;
                try { w.Close(); closed.Add(w.GetType().Name + ":" + w.Title); } catch (Exception ex) { closed.Add("FAILED " + w.GetType().Name + ": " + ex.Message); }
            }
            return closed;
        }, TimeSpan.FromSeconds(8), "close_dialog"); }
        catch (UiBusyException) { return Server.Fail("close_dialog: UI thread did not answer in 8 s"); }
        return Server.Ok(new JsonObject { ["closed"] = closedNow });
    }

    public static async Task<string> Windows(JsonObject? p)
    {
        var maxTexts = p?["max_texts"]?.GetValue<int>() ?? 40;
        JsonArray found;
        try { found = await Ui.Run(() =>
        {
            var arr = new JsonArray();
            var lifetime = Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime;
            var windows = lifetime?.Windows ?? new List<Window>();
            foreach (var w in windows)
            {
                var texts = new JsonArray();
                foreach (var v in w.GetVisualDescendants())
                {
                    if (texts.Count >= maxTexts) break;
                    if (v is Visual vis && !vis.IsVisible) continue;
                    string? t = v switch
                    {
                        TextBlock tb => tb.Text,
                        TextBox tx => "[TextBox] " + (tx.Text ?? "") + (string.IsNullOrEmpty(tx.Watermark) ? "" : " (" + tx.Watermark + ")"),
                        Button b => "[Button] " + (b.Content as string ?? (b.Content as TextBlock)?.Text ?? b.Content?.GetType().Name),
                        _ => null,
                    };
                    if (!string.IsNullOrWhiteSpace(t) && t.Length < 400) texts.Add(t.Trim());
                }
                arr.Add(new JsonObject
                {
                    ["title"] = w.Title, ["type"] = w.GetType().Name, ["isVisible"] = w.IsVisible, ["isActive"] = w.IsActive,
                    ["isModal"] = w.Owner != null, ["contentKind"] = w.GetType().Name.Contains("DialogWindow", StringComparison.Ordinal) ? "web" : "native",
                    ["owner"] = (w.Owner as Window)?.Title, ["width"] = w.Bounds.Width, ["height"] = w.Bounds.Height, ["texts"] = texts,
                });
            }
            return arr;
        }, TimeSpan.FromSeconds(8), "windows"); }
        catch (UiBusyException) { return Server.Fail("windows: UI thread did not answer in 8 s (blocked, not just a dialog)"); }
        return Server.Ok(new JsonObject { ["count"] = found.Count, ["windows"] = found });
    }
}
