using ServiceStudio.Model;

namespace Anvil.Core;

// The reading of a theme's CSS (ThemeCss.cs explains its three halves). Studio types only: the ODC builder
// (platforms/odc/studio/builder) compiles this file with ScreenHtmlModule.cs, by file (C-14: the html reading prints the
// theme parts of a root).
public static partial class ThemeCss
{
    /// <summary>A folha nativa do objeto (tema, tela ou bloco), ou null se ele nao tem CSS proprio.
    /// A propriedade publica <c>StyleSheet</c> da classe concreta devolve a folha; a do Model API, com o mesmo
    /// nome, e uma implementacao explicita de interface e nao aparece por reflexao sobre o tipo.</summary>
    public static WebStyleSheet? Of(object? target)
    {
        if (target == null) return null;
        foreach (var p in target.GetType().GetProperties())
        {
            if (p.Name != "StyleSheet" || p.GetIndexParameters().Length > 0 || !typeof(AbstractStyleSheet).IsAssignableFrom(p.PropertyType)) continue;
            try { return p.GetValue(target) as WebStyleSheet; } catch { return null; }
        }
        return null;
    }

    /// <summary>True quando a efetiva e derivada, ou seja, quando ler <c>StyleSheet</c> e escrever <c>StyleSheet</c>
    /// tocam metades diferentes.</summary>
    public static bool IsSplit(WebStyleSheet sheet)
    {
        try { return sheet.IsGeneratedEffectiveValueInUse(); } catch { return false; }
    }

    /// <summary>O CSS do autor: a metade que a interface do Studio mostra e que o <c>ITheme.StyleSheet</c> escreve.
    /// Quando nao ha CSS gerado, autor e efetiva sao o mesmo texto.</summary>
    public static string Author(WebStyleSheet sheet) => (IsSplit(sheet) ? sheet.UserEffectiveValue : sheet.EffectiveValue) ?? "";
}
