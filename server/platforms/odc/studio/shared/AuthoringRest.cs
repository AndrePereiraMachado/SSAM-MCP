using OutSystems.Model;
using OutSystems.Model.Types;
using R = ServiceStudio.Plugin.REST;

// REST consumido. Faltava por inteiro: a biblioteca partilhada cobria dados, logica e interface, e nao tinha uma
// unica primitiva de integracao -- descoberto ao tentar construir uma app a serio que consome tres servicos.
//
// A receita vem de um job PROVADO do kernel do Anvil (tests/jobs-odc/rest-consume-post.json), que ja tinha medido
// contra o ODC quais as propriedades que existem e quais o Verify recusa. Duas licoes desse job estao aqui
// dentro:
//  * as CREDENCIAIS nao entram no modelo. AuthenticationType e ClientAuthentication sim (o MODO), Username e
//    Password nao -- a API aceita a escrita e o Verify recusa depois com "Password is not supported, please
//    remove it using Model API". Por isso este ficheiro nem expoe como as gravar.
//  * NameInJSON existe para o nome do fio ser diferente do nome OutSystems, e OriginalName para o mesmo nos
//    headers e query params: "X-Api-Key" nao e um identificador valido, "precipitation_probability_max" tambem
//    nao.
//
// Os ENUMS (HTTPMethod, InputPlacement, OutputPlacement, ResponseFormat) vivem dentro do DLL do plugin e NAO no
// namespace `ServiceStudio.Plugin.REST`; o plugin nao esta no dump decompilado, por isso o namespace deles nao se
// sabe de antemao. Em vez de adivinhar, pergunta-se ao valor actual da propriedade qual e o tipo dele e faz-se
// Enum.Parse -- que resolve hoje e continua a resolver se o produto lhes mudar o namespace.
internal static partial class Authoring {
    public static R.IRestClient RestClient(IESpace space, string name, string baseUrl, string description) {
        Require(!Walk(space).OfType<R.IRestClient>().Any(c => c.Name == name), "REST client ja existe: " + name);
        var client = space.CreateIntegration<R.IRestClient>(name);
        client.BaseURL = baseUrl;
        client.Description = description;
        return client;
    }

    public static R.IRestStructure RestStructure(R.IRestClient client, string name) => client.CreateStructure(name);

    // `nameInJson` so se preenche quando o nome do fio difere do nome OutSystems; deixa-lo a null e o caso comum.
    public static R.IRestStructureAttribute RestAttribute(R.IRestStructure structure, string name, ITypeSignature type, string? nameInJson = null) {
        var attribute = structure.CreateAttribute(name);
        attribute.DataType = type;
        if (nameInJson != null) attribute.NameInJSON = nameInJson;
        return attribute;
    }

    // method: GET | POST | PUT | DELETE | PATCH
    public static R.IRestAction RestAction(R.IRestClient client, string name, string method, string urlPath,
                                           string? description = null, int? timeoutSeconds = 30) {
        var action = client.CreateAction(name);
        SetEnum(action, "HTTPMethod", action.HTTPMethod, method);
        action.URLPath = urlPath;
        SetEnum(action, "ResponseFormat", action.ResponseFormat, "JSON");
        if (timeoutSeconds != null) action.TimeoutinSeconds = timeoutSeconds;
        if (description != null) action.Description = description;
        return action;
    }

    // placement: UrlPlacement | QueryPlacement | HeaderPlacement | BodyPlacement (os nomes do enum do produto)
    public static R.IRestActionInput RestInput(R.IRestAction action, string name, ITypeSignature type,
                                               string placement, string? originalName = null, bool mandatory = true) {
        var input = action.CreateInputParameter(name);
        input.DataType = type;
        SetEnum(input, "InputPlacement", input.InputPlacement, placement);
        input.IsMandatory = mandatory;
        if (originalName != null) input.OriginalName = originalName;
        return input;
    }

    public static R.IRestActionOutput RestOutput(R.IRestAction action, string name, ITypeSignature type,
                                                 string placement = "BodyPlacement", string? originalName = null) {
        var output = action.CreateOutputParameter(name);
        output.DataType = type;
        SetEnum(output, "OutputPlacement", output.OutputPlacement, placement);
        if (originalName != null) output.OriginalName = originalName;
        return output;
    }

    // O valor actual serve so para revelar o TIPO do enum; o nome pedido e que decide o valor. Quando o nome nao
    // existe, a mensagem lista os que existem -- a mesma regra do resto da biblioteca: um erro que obriga a sondar
    // nao e um erro util.
    private static void SetEnum(IModelObject target, string property, object current, string name) {
        var type = current.GetType();
        if (!Enum.TryParse(type, name, ignoreCase: true, out var value) || value == null)
            throw new InvalidOperationException(
                ModelPath.Describe(target) + ": '" + name + "' nao e um valor de " + type.Name
                + ". Valores: " + string.Join(", ", Enum.GetNames(type)));
        Set(target, property, value);
    }
}
