using System.Collections;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.VisualTree;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>
/// Detecao (nunca fecho) do que bloqueia `open_module` e `merge_from_oml`: presenters modais do aggregator (Manage
/// Dependencies, merge editor) e janelas Avalonia com dono (dialogo de recuperacao, message boxes, DialogWindow web).
/// Tem de correr na UI thread. Plano, itens 12 e 13a; decisao do dono: so detetar, quem chama responde.
/// </summary>
internal static class Dialogs
{
    public static JsonArray BlockedBy(IAggregatorPresenter? agg)
    {
        var arr = new JsonArray();
        if (agg != null)
        {
            foreach (var pres in Modal(agg))
            {
                var kind = BridgeKit.ClassifyPresenter(pres.GetType().GetInterfaces().Select(i => i.Name), pres.GetType().Name);
                if (!BridgeKit.IsBlockingPresenterKind(kind)) continue;   // presenters modais desconhecidos (login, progresso) sao transitorios
                arr.Add(new JsonObject { ["kind"] = kind, ["type"] = pres.GetType().Name, ["source"] = "presenter", ["hint"] = BridgeKit.DialogHint(kind) });
            }
        }
        var lifetime = Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime;
        // janelas com dono (message boxes, dialogos nativos) e DialogWindow (webview: recuperacao, Manage Dependencies), que
        // pode nao ter Owner; nunca a janela principal
        foreach (var w in (lifetime?.Windows ?? new List<Window>()).Where(w => w.IsVisible && (w.Owner != null || w.GetType().Name.Contains("DialogWindow", StringComparison.Ordinal))))
        {
            var texts = Texts(w, 12);
            var kind = BridgeKit.ClassifyWindow(w.Title, texts);
            if (kind == BridgeKit.Progress) continue;   // abrir/carregar: transitorio, open_module continua a esperar
            var web = w.GetType().Name.Contains("DialogWindow", StringComparison.Ordinal);
            if (web && kind == BridgeKit.Modal) kind = BridgeKit.WebDialog;   // texto so pelo CDP (recuperacao, Manage Dependencies)
            arr.Add(new JsonObject { ["kind"] = kind, ["type"] = w.GetType().Name, ["title"] = w.Title, ["source"] = "window",
                ["contentKind"] = web ? "web" : "native",
                ["texts"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()), ["hint"] = BridgeKit.DialogHint(kind) });
        }
        return arr;
    }

    /// <summary>C10: what blocks anywhere in the Studio: every tab's modal presenters (tagged with its module) and the owned
    /// windows once (DialogScope.Union). UI thread.</summary>
    public static JsonArray AllBlocking()
    {
        var aggregators = Studio.Aggregators();
        return aggregators.Count == 0 ? BlockedBy(null)
            : DialogScope.Union(aggregators.Select(a => (a.ActiveESpace?.Name, BlockedBy(a))));
    }

    /// <summary>C10: what blocks a publication of the module of <paramref name="agg"/>: its own presenters, the presenters of
    /// any other tab of the same module (the second window), and the owned windows. UI thread.</summary>
    public static JsonArray BlockingModule(IAggregatorPresenter agg)
    {
        var key = agg.ActiveESpace?.Key.ToString();
        var same = Studio.Aggregators().Where(a => ReferenceEquals(a, agg) || key != null && a.ActiveESpace?.Key.ToString() == key);
        return DialogScope.Union(same.Select(a => (a.ActiveESpace?.Name, BlockedBy(a))));
    }

    /// <summary>Presenters modais do aggregator (IAggregatorPresenter.ModalStandaloneEditorPresenters, implementacao explicita) mais
    /// os filhos que sao dialogos de referencias/merge.</summary>
    private static IEnumerable<object> Modal(IAggregatorPresenter agg)
    {
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        if (BridgeKit.InterfaceProp(agg, "ModalStandaloneEditorPresenters") is IEnumerable modal)
            foreach (var m in modal) if (m != null && seen.Add(m)) yield return m;
        if (BridgeKit.InterfaceProp(agg, "ChildPresenters") is IEnumerable children)
            foreach (var c in children)
            {
                if (c == null || !seen.Add(c)) continue;
                var names = c.GetType().GetInterfaces().Select(i => i.Name).ToList();
                if (names.Contains("IAddRemoveReferencesPresenter") || names.Contains("IMergeEditorPresenter")) yield return c;
            }
    }

    public static List<string> Texts(Window w, int max)
    {
        var texts = new List<string>();
        foreach (var v in w.GetVisualDescendants())
        {
            if (texts.Count >= max) break;
            if (v is Visual vis && !vis.IsVisible) continue;
            string? t = v switch
            {
                TextBlock tb => tb.Text,
                Button b => "[Button] " + (b.Content as string ?? (b.Content as TextBlock)?.Text ?? b.Content?.GetType().Name),
                _ => null,
            };
            if (!string.IsNullOrWhiteSpace(t) && t.Length < 200) texts.Add(t.Trim());
        }
        return texts;
    }

    public static string Summary(JsonArray blockedBy) =>
        string.Join("; ", blockedBy.Select(b => b!["kind"]!.GetValue<string>() + (b["title"] is { } t ? " (" + t.GetValue<string>() + ")" : "")));
}
