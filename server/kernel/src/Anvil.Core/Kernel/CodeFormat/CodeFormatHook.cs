using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// Onde o kernel escreve codigo como texto no modelo (os dois pontos de entrada, nas duas faixas):
/// <list type="bullet">
/// <item>o verbo <c>set</c> de <c>StyleSheet</c>, <c>Statement</c> (no SQL) e <c>JavaScript</c>: e por ele que passam os ops
/// crus e tudo o que os expansores geram (<c>logic</c> com <c>sql:true</c> ou no JavaScript, <c>scripts</c> do op
/// <c>html</c>, propriedades de tela/bloco do op <c>screen</c>);</item>
/// <item>o bloco de CSS que o op <c>html</c> instala no tema (<see cref="InstallStylesheet"/>).</item>
/// </list>
/// O texto passa por <see cref="CodeFormat.Apply"/> antes de chegar ao modelo e ao contrato de dados; o recibo leva
/// <c>formatted: [{element, language, linesBefore, linesAfter}]</c> e, quando a prova recusa, a nota FORMAT_SKIPPED.
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>O op <c>set</c> com o codigo ja formatado (o mesmo op quando nada muda).</summary>
    private JsonObject CodeFormatRule(object target, JsonObject op)
    {
        var prop = op["prop"]?.ToString();
        // A flow text is the source: its SQL and JavaScript are written line by line as the text has them (Verbs.Flow.cs).
        if (_verbatim) return op;
        if (prop is not ("StyleSheet" or "Statement" or "JavaScript") || op["value"] is not JsonValue v || !v.TryGetValue<string>(out var text)) return op;
        if (CodeFormat.LanguageOf(prop, name => Implements(target, name)) is not { } language) return op;
        var element = (target is IObjectSignature sig ? PathOf(sig) : null) is { Length: > 0 } path ? path : op["target"]?.ToString() ?? Describe(target);
        var written = FormatCode(language, text, element + "." + prop);
        if (written == text) return op;
        var copy = op.DeepClone().AsObject();
        copy["value"] = written;
        return copy;
    }

    /// <summary>O texto a escrever, com o registo no recibo do que a formatacao fez.</summary>
    internal string FormatCode(CodeLanguage language, string text, string element)
    {
        var outcome = CodeFormat.Apply(language, text);
        if (outcome.Skipped != null)
            Note("FORMAT_SKIPPED", $"{element} ({CodeFormat.Name(language)}): written as given, not reformatted: {outcome.Skipped}");
        else if (outcome.Formatted)
            Report("formatted", new JsonObject
            {
                ["element"] = element, ["language"] = CodeFormat.Name(language),
                ["linesBefore"] = outcome.LinesBefore, ["linesAfter"] = outcome.LinesAfter,
            });
        return outcome.Text;
    }
}
