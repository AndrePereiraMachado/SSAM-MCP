using System.Reflection;

// A mensagem util de uma excepcao, em vez do envelope que a embrulha.
//
// Uma falha do modelo chega embrulhada em varias camadas -- a de cima costuma ser da ESpaceTransactionsManager ou
// uma TargetInvocationException da reflexao, e nenhuma delas diz o que correu mal. Descer sempre ate a raiz
// tambem nao serve: perde-se o contexto que as camadas do meio acrescentam. Escolhe-se a mensagem mais EXTERIOR
// que ainda CONTEM a da raiz, que e a que tem as duas coisas.
//
// Trazido de C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Errors.cs (Describe/Text). COPIADO e nao ligado por
// caminho: acoplar este repositorio a uma pasta fora dele partia-o assim que o Anvil mudasse de sitio.
internal static class ExceptionText {
    public static (string Type, string Message, string? Stack) Describe(Exception ex) {
        var cadeia = new List<Exception>();
        for (var e = ex; e != null; e = e.InnerException) cadeia.Add(e);
        var raiz = cadeia[^1];
        var melhor = cadeia.FirstOrDefault(e => e is not TargetInvocationException && !string.IsNullOrEmpty(e.Message)
                                                && e.Message.Contains(raiz.Message, StringComparison.Ordinal)) ?? raiz;
        return (raiz.GetType().Name, melhor.Message, raiz.StackTrace);
    }

    public static string Text(Exception ex) {
        var (tipo, mensagem, _) = Describe(ex);
        return mensagem.StartsWith(tipo + ":", StringComparison.Ordinal) || mensagem.Contains(tipo + ": ", StringComparison.Ordinal)
            ? mensagem : tipo + ": " + mensagem;
    }

    // A primeira frame que e NOSSA. O stack de uma falha do modelo comeca com dezenas de frames do
    // OutSystems.Model; a linha que interessa a quem vai consertar e a primeira dentro de studio\.
    public static string? PrimeiraFrameNossa(Exception ex) {
        var stack = Describe(ex).Stack ?? ex.StackTrace;
        if (stack == null) return null;
        foreach (var linha in stack.Split('\n'))
            if (linha.Contains(@"\studio\", StringComparison.OrdinalIgnoreCase)) return linha.Trim();
        return null;
    }
}
