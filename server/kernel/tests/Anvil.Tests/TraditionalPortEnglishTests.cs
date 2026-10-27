using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Review of 3ab12209, finding 8: what the Traditional port serves and tests is English and names no customer (owner rule
/// 15/10/2026: every text SSAM emits is English). The suite jobs the port added are served examples: their texts and the
/// names they give (screen actions, variables, widgets) are English words. The kernel tests name no customer module: a
/// replay that binds a producer reads its name from the environment.
/// </summary>
public sealed class TraditionalPortEnglishTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalPortEnglishTests).Assembly.Location)!)!;

    // Portuguese words (accent-free, lower case) the port's texts and names used, and common Portuguese prose words that are
    // neither English nor code.
    private static readonly HashSet<string> PortugueseWords = new(StringComparer.Ordinal) {
        "confirmar", "nome", "mensagem", "nota", "digite", "testar", "evento", "nativo", "resultado", "aparece", "apos", "ola",
        "funcionando", "auditoria", "novo", "conteudo", "carregar", "atualizar", "para", "uma", "com", "que", "nao", "tela",
        "acao", "valor", "dados", "lista", "salvar", "voltar",
    };
    private static readonly Regex Accent = new("[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ]", RegexOptions.CultureInvariant);
    // A word of a text, or a part of a PascalCase/camelCase name (ConfirmarButton -> Confirmar, Button).
    private static readonly Regex Word = new("[A-Z]?[a-z]+|[A-Z]+(?![a-z])", RegexOptions.CultureInvariant);

    private static string Plain(string word) => new(word.Normalize(NormalizationForm.FormD)
        .Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark).ToArray());

    // The Portuguese words of a text (accented words and listed words), in the order they come.
    internal static List<string> PortugueseIn(string text)
    {
        var found = new List<string>();
        foreach (Match run in Regex.Matches(text, @"[\p{L}]+"))
        {
            if (Accent.IsMatch(run.Value)) { found.Add(run.Value); continue; }
            foreach (Match part in Word.Matches(run.Value))
                if (PortugueseWords.Contains(Plain(part.Value).ToLowerInvariant())) found.Add(part.Value);
        }
        return found;
    }

    private static IEnumerable<string> Strings(JsonNode? node) => node switch
    {
        JsonObject o => o.SelectMany(p => Strings(p.Value)),
        JsonArray a => a.SelectMany(Strings),
        JsonValue v when v.TryGetValue<string>(out var s) => [s],
        _ => [],
    };

    [Fact]
    public void TheDetectorSeesThePortugueseOfThePortAndPassesItsEnglish()
    {
        Assert.Equal(["Confirmar", "Nome", "Olá"], PortugueseIn("<button id=\"ConfirmarButton\" bind=\"NomeInput\">Olá</button>"));
        Assert.Empty(PortugueseIn("<button id=\"ConfirmButton\" bind=\"Name\" class=\"audit-button\">Hello, the Traditional frontend works.</button>"));
    }

    [Theory]
    [InlineData("traditional-html-frontend.json")]
    [InlineData("traditional-ajax-navigation.json")]
    public void TheServedTraditionalExamplesAreEnglish(string job)
    {
        var json = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "jobs", job)));
        var portuguese = Strings(json).SelectMany(PortugueseIn).Distinct().ToList();
        Assert.True(portuguese.Count == 0, job + " serves Portuguese: " + string.Join(", ", portuguese));
    }

    [Fact]
    public void TheNativeContentMergeTestsAreEnglishAndNameNoCustomerModule()
    {
        var source = File.ReadAllText(Path.Combine(Root, "tests", "Anvil.Tests", "NativeContentMergeTests.cs"));
        Assert.Empty(PortugueseIn(source));
        // No kernel test hard-codes the customer module of a replay (the name is built here so this file does not hold it).
        var customer = "Hotel" + "_";
        var named = Directory.EnumerateFiles(Path.Combine(Root, "tests"), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar) && !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar))
            .Where(f => File.ReadAllText(f).Contains(customer, StringComparison.Ordinal))
            .Select(f => Path.GetRelativePath(Root, f)).ToList();
        Assert.True(named.Count == 0, "tests that name the customer module: " + string.Join(", ", named));
    }
}
