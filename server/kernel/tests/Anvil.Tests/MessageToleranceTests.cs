using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// O aviso de seguranca "server action publica numa tela anonima" e o unico que o runner tolera sem declaracao, e ele
/// chega DIFERENTE nas duas plataformas: no SS11 dentro do balde generico CustomObjectWarning, no ODC com id proprio
/// ServerActionInScreenAccessibleByEveryone e a segunda frase trocada. Os textos abaixo sao os do catalogo instalado
/// de cada plataforma, conferidos com `anvil-odc verify-catalog --id <id>`. Se um deles deixar de ser tolerado, todo
/// job daquela faixa que toque numa tela anonima passa a falhar sem motivo.
/// </summary>
public class MessageToleranceTests
{
    private const string Ss11 = "You're exposing a Server Action for public access and without authentication. "
        + "Consider removing the Anonymous Role from this Screen.";
    private const string Odc = "You're exposing a Server Action for public access and without authentication. "
        + "Consider restricting Screen accessibility to Authenticated Users.";

    private static MessageInfo Message(string id, string detail) =>
        new(id, "Warning", id + "|k", "M (ESpace) / Screen (MobileScreen)", detail);

    [Fact]
    public void TheAnonymousAccessWarningIsToleratedOnBothPlatforms()
    {
        var fresh = new[] { Message("CustomObjectWarning", Ss11), Message("ServerActionInScreenAccessibleByEveryone", Odc) };
        var result = MessageExpectations.Evaluate(fresh, Array.Empty<ExpectedMessage>());
        Assert.Equal(2, result.Tolerated.Count);
        Assert.Empty(result.Unexpected);
    }

    [Fact]
    public void TheGenericBucketIsNotToleratedByItsIdAlone()
    {
        // CustomObjectWarning carrega diagnosticos sem relacao: sem a frase, nao e tolerado como acesso anonimo. Desde A03
        // (pacote atritos 2) ele e um warning comum: nao bloqueia (nonblocking), e nunca some.
        var outro = Message("CustomObjectWarning", "Some other custom warning about something else.");
        var result = MessageExpectations.Evaluate(new[] { outro }, Array.Empty<ExpectedMessage>());
        Assert.Empty(result.Tolerated);
        Assert.Empty(result.Unexpected);
        Assert.Single(result.NonBlocking);
        Assert.False(SecurityWarnings.IsAnonymous(outro.Id, outro.Detail));
    }
}
