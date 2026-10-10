using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// O CSS de um tema tem tres metades no modelo e o Model API expoe so a efetiva, que e DERIVADA: ler StyleSheet da
/// a efetiva, escrever StyleSheet grava a metade do autor. Num tema com CSS do Theme Editor as duas deixavam de
/// concordar e o resultado era a pior forma de erro que esta ferramenta pode ter: o set apagava 44 434 caracteres de
/// CSS do autor, devolvia sucesso, e o get seguinte mostrava o texto antigo como se nada tivesse acontecido
/// (bloqueio 2 da frente R). Estes testes prendem o conserto pelos numeros.
///
/// A fixture do tenant pessoal serve porque o tema dela TEM CSS do Theme Editor; a fixture da faixa O11 nao tem, e
/// por isso o caminho do op html passava verde la e mentia aqui. O codigo aferido e comum as duas faixas
/// (ServiceStudio.Model.WebStyleSheet e identico no O11 e no ODC).
/// </summary>
public class ThemeCssTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work");
    private const string Marker = "/* anvil:theme-css-halves */";
    private const string Written = Marker + "\n.anvil-halves { color: #0066db; }";

    /// <summary>A invariante da plataforma: a efetiva e gerada + CRLF + autor. E o que o Studio recalcula em
    /// CalculateFinalCssSource e o que o kernel repoe depois de escrever.</summary>
    [Fact]
    public void TheThemeCssHasThreeHalvesAndTheEffectiveOneIsGeneratedPlusAuthor()
    {
        if (!StudioAvailable()) return;
        var (before, after) = RunTheJob();

        var generated = before["GeneratedStyleSheet"]!.GetValue<string>();
        var author = before["UserStyleSheet"]!.GetValue<string>();
        var effective = before["StyleSheet"]!.GetValue<string>();
        Assert.True(generated.Length > 0, "a fixture tem de ter CSS do Theme Editor para este teste valer");
        Assert.Equal(generated + "\r\n" + author, effective);

        // Depois do set: o texto novo e o CSS do AUTOR, e a efetiva foi recomposta com ele (antes ficava congelada).
        Assert.Equal(Written, after["UserStyleSheet"]!.GetValue<string>());
        Assert.Equal(generated, after["GeneratedStyleSheet"]!.GetValue<string>());
        Assert.Equal(generated + "\r\n" + after["UserStyleSheet"]!.GetValue<string>(), after["StyleSheet"]!.GetValue<string>());
        Assert.Contains(Marker, after["StyleSheet"]!.GetValue<string>(), StringComparison.Ordinal);
        Assert.NotEqual(effective, after["StyleSheet"]!.GetValue<string>());
    }

    /// <summary>O set nao pode ficar calado sobre o facto de escrever uma metade diferente da que devolve na
    /// leitura: o resultado tem de nomear onde caiu e o tamanho de cada metade.</summary>
    [Fact]
    public void TheSetSaysWhereTheTextLanded()
    {
        if (!StudioAvailable()) return;
        var result = Result();
        var set = result["results"]!.AsArray().First(o => o!["op"]!.ToString() == "set")!["result"]!;
        var landing = set["styleSheet"];
        Assert.NotNull(landing);
        Assert.Equal("UserStyleSheet", landing!["wroteInto"]!.GetValue<string>());
        Assert.Contains("Theme Editor", landing["note"]!.GetValue<string>(), StringComparison.Ordinal);
        Assert.True(landing["generatedChars"]!.GetValue<int>() > 0);
        Assert.Equal(Written.Length, landing["userChars"]!.GetValue<int>());
    }

    /// <summary>E o OML gravado tem de carregar as tres metades coerentes: se a efetiva ficasse congelada, o modulo
    /// entregue levaria um CSS que contradiz as suas proprias partes e ninguem veria ate publicar. O job de recarga
    /// tem o anterior como `base`, ou seja o runner reconstroi, grava e volta a ler do disco.</summary>
    [Fact]
    public void TheSavedOmlKeepsTheThreeHalvesCoherent()
    {
        if (!StudioAvailable()) return;
        var reloaded = Result("theme-css-reload");
        var theme = reloaded["results"]!.AsArray().Single(o => o!["op"]!.ToString() == "get")!["result"]!["properties"]!.AsObject();
        Assert.Equal(Written, theme["UserStyleSheet"]!.GetValue<string>());
        Assert.Equal(theme["GeneratedStyleSheet"]!.GetValue<string>() + "\r\n" + theme["UserStyleSheet"]!.GetValue<string>(),
            theme["StyleSheet"]!.GetValue<string>());
    }

    private static (JsonObject Before, JsonObject After) RunTheJob()
    {
        var result = Result();
        var gets = result["results"]!.AsArray().Where(o => o!["op"]!.ToString() == "get").ToArray();
        Assert.Equal(2, gets.Length);
        return (gets[0]!["result"]!["properties"]!.AsObject(), gets[1]!["result"]!["properties"]!.AsObject());
    }

    private static JsonObject Result(string job = "theme-css-halves")
    {
        var jobPath = Path.Combine(Root, "tests", "jobs-odc", job + ".json");
        var outPath = Path.Combine(Work, job + ".oml");
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), null, jobPath, outPath))!.AsObject();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ThemeCssTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}

