namespace Anvil.Core;

/// <summary>
/// Classificacao PURA dos dialogos/editores modais do Studio que bloqueiam `open_module` e `merge_from_oml` (plano, itens 12 e
/// 13a). A bridge so DETETA e devolve `blockedBy` em segundos (decisao do dono, 2026-09-04: nunca clica por si); quem chama
/// le o dialogo (`windows`, `cdp_pages.py`) e responde no Studio ou com `close_dialog`.
/// </summary>
public static class DialogPolicy
{
    public const string ManageDependencies = "ManageDependencies";
    public const string MergeEditor = "MergeEditor";
    public const string Recovery = "Recovery";
    public const string MessageBox = "MessageBox";
    public const string Modal = "Modal";
    /// <summary>Dialogo de progresso (abrir/carregar/transferir): transitorio, NAO bloqueia; open_module continua a esperar.</summary>
    public const string Progress = "Progress";
    /// <summary>DialogWindow com conteudo web cujo texto a arvore visual nao expoe (recuperacao, Manage Dependencies): le-se pelo CDP.</summary>
    public const string WebDialog = "WebDialog";

    private static readonly string[] ProgressWords = { "opening", "loading", "downloading", "uploading", "please wait", "connecting", "checking", "publishing", "preparing" };

    /// <summary>Um presenter modal so conta como bloqueio quando e de um tipo conhecido; os desconhecidos (login, progresso) sao
    /// transitorios e produziam falsos positivos logo apos o login (medido 2026-09-04 19:30).</summary>
    public static bool IsBlockingPresenterKind(string kind) => kind is ManageDependencies or MergeEditor;

    /// <summary>Tipo do bloqueio a partir das interfaces/tipo do presenter (nomes curtos), sem depender de namespaces do Studio.</summary>
    public static string ClassifyPresenter(IEnumerable<string> interfaceNames, string typeName)
    {
        var set = new HashSet<string>(interfaceNames, StringComparer.Ordinal);
        if (set.Contains("IAddRemoveReferencesPresenter")) return ManageDependencies;
        if (set.Contains("IMergeEditorPresenter")) return MergeEditor;
        return Modal + ":" + typeName;
    }

    /// <summary>Tipo do bloqueio a partir de uma janela com dono: titulo e textos visiveis.</summary>
    public static string ClassifyWindow(string? title, IEnumerable<string> texts)
    {
        var all = string.Join(" | ", texts.Prepend(title ?? ""));
        var hasButton = all.Contains("[Button]", StringComparison.Ordinal);
        if (!hasButton && string.Equals(title?.Trim(), "Progress", StringComparison.OrdinalIgnoreCase)) return Progress;
        if (!hasButton && (ProgressWords.Any(w => all.Contains(w, StringComparison.OrdinalIgnoreCase)) || all.Contains('%'))) return Progress;
        if (all.Contains("Discard", StringComparison.OrdinalIgnoreCase) && all.Contains("Open", StringComparison.OrdinalIgnoreCase)) return Recovery;
        // "Incompatible or missing dependencies found" (DialogWindow web com botoes Manage Dependencies | Cancel, visiveis so pelo CDP):
        // o dialogo do incidente das 15:13 depois de republicar um produtor; reproduzido em 2026-09-04 20:02 no Davitest_UI
        if (all.Contains("Manage Dependencies", StringComparison.OrdinalIgnoreCase) || all.Contains("dependencies", StringComparison.OrdinalIgnoreCase)
            || all.Contains("references", StringComparison.OrdinalIgnoreCase) || all.Contains("[Button] Apply", StringComparison.OrdinalIgnoreCase)) return ManageDependencies;
        if (all.Contains("[Button] OK", StringComparison.OrdinalIgnoreCase) || all.Contains("[Button] Cancel", StringComparison.OrdinalIgnoreCase) || all.Contains("[Button] Yes", StringComparison.OrdinalIgnoreCase)) return MessageBox;
        return Modal;
    }

    /// <summary>A frase que ensina o proximo passo, por tipo.</summary>
    public static string Hint(string kind) => kind switch
    {
        Recovery => "the Studio recovery dialog (Open | Discard) is open: `python scripts/cdp_pages.py --click Discard` (or Open) and retry",
        ManageDependencies => "the references dialog is open (a producer was republished with incompatible changes): `python scripts/cdp_pages.py` shows its buttons; `--click \"Manage Dependencies\"` then Apply updates the references, `--click Cancel` opens without updating; then retry; never restart the Studio for this",
        MergeEditor => "a merge editor is open in the Studio: finish or cancel it and retry",
        WebDialog => "a web dialog is open in the Studio (its text is not visible to the bridge): `python scripts/cdp_pages.py` lists its text and buttons; `--click <Button>` answers it (recovery after a kill: Discard or Open); then retry",
        _ => "a dialog is open in the Studio: read it with `windows` or `python scripts/cdp_pages.py`, answer it, and retry",
    };
}
