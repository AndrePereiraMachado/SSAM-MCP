using System.Globalization;
using System.Text.Json.Nodes;
using OutSystems.Model;
namespace Anvil.Core;

public sealed partial class ModelSession
{
    private readonly Dictionary<string, JsonObject> dataAssertions = new();
    private static readonly HashSet<string> DataKinds = new() { "IServerEntity", "IStaticEntity", "IClientEntity", "IEntity",
        "IEntityAttribute", "IStructure", "IStructureAttribute", "IRecord", "IRecordAttributeValue", "EntityIndex" };
    private static bool TracksData(object target) => target is IObjectSignature &&
        (target.GetType().GetInterfaces().Any(t => DataKinds.Contains(t.Name)) || DataKinds.Contains(ShortType(target)));
    /// <summary>
    /// Propriedades que NAO devolvem o que se escreveu, estando a escrita correcta. Lembrar estas e compara-las no
    /// fim daria falso positivo -- gritar lobo e pior do que nao vigiar. Cada uma esta medida, nao suposta:
    ///  * StyleSheet de tema: escreve-se a metade do AUTOR e le-se a DERIVADA (gerada + CRLF + autor). Medido:
    ///    escrever 53 caracteres devolve 45 320 (ver ThemeCss).
    ///  * Label de atributo: e derivado do nome pela plataforma e nunca esta vazio; escrever muda-o, renomear
    ///    tambem, e o valor lido nao e necessariamente o escrito.
    ///  * Value/Text de expressao: escreve-se texto e le-se um ExpressionDefinition (e por isso que existe o
    ///    Remembered()); a comparacao certa e a do texto, nao a do objecto.
    ///  * URLPath de um metodo REST exposto e RuntimePath de script, imagem ou recurso: sao DERIVADOS DO NOME.
    ///    Renomear o metodo reescreve a URL publica sozinha -- medido em rename-logic-propagation.json, onde
    ///    `/GetSlug/{Text}` virou `/SlugOf/{Term}` depois de renomear metodo e input. Aferir o valor escrito
    ///    atraves de um rename e comparar o pedido com o que a plataforma legitimamente reescreveu.
    /// </summary>
    private static readonly HashSet<string> AssimetricasNaLeitura = new(StringComparer.Ordinal)
    { "StyleSheet", "UserStyleSheet", "GeneratedStyleSheet", "Label", "URLPath", "RuntimePath" };

    /// <summary>
    /// Alem dos tipos de dados, so se vigia o que tem IDENTIDADE ESTAVEL: elementos nomeados de topo, que
    /// sobrevivem a corrida inteira com a mesma chave.
    ///
    /// O que NAO entra, e porque: a plataforma RECRIA a maquinaria interna quando o contrato muda -- argumentos de
    /// um ITriggerNode, IContent dentro de um botao, IEventHandler de uma instancia de bloco, widgets. Lembrar
    /// esses por chave e garantir falso positivo: medido ao alargar o contrato sem esta lista, o job
    /// block-events-types encheu-se de "KeyNotFoundException: no object with key ..." sobre escritas correctas.
    /// O proprio kernel ja avisava disto para o IRecordAttributeValue (ver DataAssertionReference).
    ///
    /// E aqui que vive a classe de falha que interessa: o `set` de StyleSheet num tema, que apagava 44 434
    /// caracteres e reportava sucesso, era num IMobileTheme -- elemento nomeado de topo.
    /// </summary>
    private static readonly HashSet<string> IdentidadeEstavel = new(StringComparer.Ordinal)
    {
        "ITheme", "IMobileTheme", "IWebTheme", "IScript", "ITimer", "ISiteProperty", "IImage", "IResource",
        "IServerAction", "IClientAction", "IServiceAction", "IScreenAction", "IDataAction",
        "IMobileScreen", "IWebScreen", "IMobileBlock", "IWebBlock",
        "IRestService", "IRestServiceAction", "IRestClient", "IRestAction", "IStructureSignature",
    };

    private static bool VigiaEstavel(object target) => target is IObjectSignature &&
        (IdentidadeEstavel.Contains(ShortType(target))
         || target.GetType().GetInterfaces().Any(t => IdentidadeEstavel.Contains(t.Name)));

    /// <summary>Chaves que o PROPRIO job apagou. Uma assercao sobre um objecto apagado de proposito nao e prova
    /// perdida, e prova cumprida: o job escreveu, leu, e depois apagou. Sem isto um job de ciclo de vida
    /// (editar -> refatorar -> apagar) reprova sempre, com `KeyNotFoundException` sobre a sua propria delecao.
    /// O `DataContract` ja saltava objectos com WasDeleted, mas isso exige resolve-los primeiro, e apagado a
    /// serio nem resolve.</summary>
    private readonly HashSet<string> _apagados = new(StringComparer.Ordinal);

    internal void EsquecerApagado(object target)
    {
        if (target is not IObjectSignature { ObjectKey: not null } sig) return;
        _apagados.Add(sig.ObjectKey.ToString()!);
        // Os filhos vao com o pai: os atributos, registos e indices de uma entidade que este job criou e depois apagou
        // (com ou sem force) deixam de resolver por chave, e uma assercao sobre eles seria prova cumprida, nao perdida
        // (fase 3, 2026-09-23: entity-refactor cria DcScratch e apaga-a com force).
        try { foreach (var child in EntityIndexes.IncludeNative(sig.GetAllDescendantsOfType<IObjectSignature>())) if (child.ObjectKey != null) _apagados.Add(child.ObjectKey.ToString()!); }
        catch { /* esquecer nunca pode derrubar o delete */ }
    }

    /// <summary>
    /// O que o job escreveu, aferido UMA VEZ no fim (DataContract), nao a cada op.
    ///
    /// Porque no fim e nao a cada `set`: um job grande faz milhares de escritas -- hire-data-model.json tem 2 694
    /// ops, 1 979 delas `set`. Verificar cada uma multiplicaria o trabalho sem apanhar nada que a passagem final
    /// nao apanhe, e daria falso positivo em toda propriedade assimetrica. E o desenho que o proprio Mentor usa:
    /// ele nao confere passo a passo, corre num clone sombra e faz CompareAndMerge de tres vias no fim.
    ///
    /// Porque alem dos tipos de DADOS: ate aqui so entidades, atributos, estruturas, registos e indices eram
    /// lembrados. Tema, tela, bloco, action, script e timer nao eram -- e foi exactamente por esse buraco que
    /// passou o `set` de StyleSheet que apagava 44 434 caracteres e reportava sucesso. Agora lembra-se qualquer
    /// objecto do modelo, menos as propriedades que se leem de outra forma.
    /// </summary>
    private void RememberValue(object target, string property, object? value, string sourceReference)
    {
        if (TracksData(target)) { RememberData(target, property, Normal(value), sourceReference); return; }
        if (AssimetricasNaLeitura.Contains(property) || !VigiaEstavel(target)) return;
        if (target is IObjectSignature { ObjectKey: not null }) RememberOther(target, property, Normal(value), sourceReference);
    }

    /// <summary>Assercao sobre um objecto que nao e de dados. Mesma forma e mesma aferição do contrato de dados,
    /// mas nunca lanca: um tipo cuja propriedade nao se consiga ler de volta e uma lacuna de vigilancia, nao um
    /// motivo para reprovar um job correcto.</summary>
    private void RememberOther(object target, string property, JsonNode? expected, string sourceReference)
    {
        try
        {
            var sig = (IObjectSignature)target;
            dataAssertions["@" + sig.ObjectKey + ":" + property] = new JsonObject
            {
                ["key"] = sig.ObjectKey!.ToString(), ["reference"] = "@" + sig.ObjectKey,
                ["element"] = ModelHost.PathOf(target), ["property"] = property, ["expected"] = expected?.DeepClone(),
            };
        }
        catch { /* vigiar nunca pode derrubar quem e vigiado */ }
    }
    private void RememberData(object target, string property, JsonNode? expected, string? sourceReference = null)
    {
        if (target is not IObjectSignature sig || !TracksData(target)) return;
        var key = sig.ObjectKey?.ToString();
        // Do not create a partial key index: Resolve must still be able to index pre-existing module objects.
        if (key != null && _byKey != null) _byKey[key] = sig;
        var reference = DataAssertionReference(sig, sourceReference);
        if (reference == null && sourceReference != null)
        {
            var slash = sourceReference.IndexOf('/');
            if (slash > 0 && Resolve(sourceReference[..slash]) is IObjectSignature owner && owner.ObjectKey != null)
                reference = "@" + owner.ObjectKey + sourceReference[slash..];
        }
        if (reference == null) throw new InvalidOperationException("Cannot record data assertion for " + Describe(target));
        var id = reference + ":" + property;
        // Uma escrita posterior substitui a expectativa; o historico do que a plataforma reescreveu entretanto fica.
        var history = dataAssertions.TryGetValue(id, out var previous) ? previous["platformRewrites"]?.DeepClone() : null;
        dataAssertions[id] = new JsonObject { ["key"] = key, ["reference"] = reference, ["element"] = ModelHost.PathOf(target),
            ["property"] = property, ["expected"] = expected?.DeepClone(), ["platformRewrites"] = history };
    }
    private string? DataAssertionReference(IObjectSignature target, string? sourceReference)
    {
        // Static record value wrappers are recreated by reload/merge. Their parent record and attribute
        // are stable; asserting a transient wrapper key can incorrectly reject an identical delivered value.
        if (Implements(target, "IRecordAttributeValue"))
        {
            // Por IDENTIDADE, nao por nome (fase 3, 2026-09-23): o registo e o atributo sao ancorados pela chave, por isso
            // um `set Identifier` do registo (ou um rename do atributo) no mesmo job ja nao deixa a assercao sem alvo
            // ("has no child <nome antigo>": a armadilha do contrato de dados da fase 2). O segmento "/@chave" e
            // resolvido por ResolveAssertion: o filho do registo cujo Attribute tem essa chave.
            if (target.Parent is IObjectSignature { ObjectKey: not null } record && UiCatalog.Prop(target, "Attribute") is IObjectSignature { ObjectKey: not null } attribute)
                return "@" + record.ObjectKey + "/@" + attribute.ObjectKey;
            var slash = sourceReference?.IndexOf('/') ?? -1;
            if (slash > 0 && Resolve(sourceReference![..slash]) is IObjectSignature root && root.ObjectKey != null)
                return "@" + root.ObjectKey + sourceReference[slash..];
            if (target.Parent is IObjectSignature { ObjectKey: not null } owner && TypeResolver.Name(UiCatalog.Prop(target, "Attribute")) is { } attributeName)
                return "@" + owner.ObjectKey + "/" + attributeName;
            throw new InvalidOperationException("Static record value has no stable assertion address");
        }
        return target.ObjectKey == null ? null : "@" + target.ObjectKey;
    }

    /// <summary>Resolve a referencia de uma assercao: "@chave" (o proprio objecto), "@chave/Nome/..." (filhos por nome,
    /// a forma antiga) ou "@chave/@chave" (filho por identidade: o valor de registo cujo Attribute tem essa chave, ou o
    /// filho com essa chave). Um segmento por chave sobrevive a renomeacoes; um segmento por nome nao.</summary>
    private object ResolveAssertion(string reference)
    {
        var at = reference.IndexOf("/@", StringComparison.Ordinal);
        if (at < 0) return Resolve(reference);
        var current = Resolve(reference[..at]) as IObjectSignature ?? throw new InvalidOperationException($"'{reference}': the owner is not a model object");
        foreach (var segment in reference[(at + 1)..].Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!segment.StartsWith('@')) { current = (IObjectSignature)ResolveChild(current, segment); continue; }
            var key = segment[1..];
            current = current.Children.OfType<IObjectSignature>().FirstOrDefault(c => c.ObjectKey?.ToString() == key)
                ?? current.Children.OfType<IObjectSignature>().FirstOrDefault(c => (UiCatalog.Prop(c, "Attribute") as IObjectSignature)?.ObjectKey?.ToString() == key)
                ?? throw new KeyNotFoundException($"{Describe(current)} has no child with key {key} (the attribute or record it belonged to was deleted)");
        }
        return current;
    }

    /// <summary>O valor ACTUAL de uma assercao, lido do modelo como o contrato o le no fim (mesma leitura, um so sitio).</summary>
    private JsonNode? ReadActual(JsonObject a)
    {
        var target = ResolveAssertion(a["reference"]?.ToString() ?? "@" + a["key"]!.ToString());
        if (UiCatalog.Prop(target, "WasDeleted") is true) throw new InvalidOperationException("element deleted");
        var prop = a["property"]!.ToString();
        if (prop == "$exists") return JsonValue.Create(true);
        if (prop == "Name") return JsonValue.Create(TypeResolver.Name(target));
        if (EntityIndexes.Read(target)?["properties"] is JsonObject index && index[prop] is { } native)
            return native is JsonArray ? native.DeepClone() : Normal(native is JsonValue j && j.TryGetValue<bool>(out var b) ? b : native.ToString());
        var property = FindProperty(target, prop) ?? throw new InvalidOperationException("property not readable: " + prop);
        return Normal(property.GetValue(target));
    }

    /// <summary>
    /// A fotografia do que cada assercao le AGORA, tirada imediatamente antes de um verbo que renomeia ou reaponta
    /// (rename, set Identifier, replace). Depois do verbo, AbsorbPlatformRewrites compara: o que mudou DURANTE o verbo
    /// foi reescrito pela plataforma em consequencia dele (expressoes que citam o objecto, statements de SQL, o Label
    /// igual ao nome antigo, o proprio Name) e passa a ser o valor esperado, com o registo da reescrita na assercao.
    /// Uma assercao que JA nao batia antes do verbo (o job escreveu A e o modelo tinha B) fica como estava: a
    /// divergencia continua a ser cobrada no fim. Nao se desliga nenhuma verificacao: muda-se so a expectativa das
    /// escritas que a plataforma reescreveu por causa deste job, e diz-se quais.
    /// </summary>
    private List<(string Id, JsonNode? Actual, bool Readable)> SnapshotAssertions()
    {
        var snapshot = new List<(string, JsonNode?, bool)>(dataAssertions.Count);
        foreach (var (id, a) in dataAssertions)
        {
            try { snapshot.Add((id, ReadActual(a), true)); }
            catch { snapshot.Add((id, null, false)); }
        }
        return snapshot;
    }

    private int AbsorbPlatformRewrites(List<(string Id, JsonNode? Actual, bool Readable)> before, string verb, string? from, string? to)
    {
        var absorbed = 0;
        foreach (var (id, was, readable) in before)
        {
            if (!readable || !dataAssertions.TryGetValue(id, out var a)) continue;
            JsonNode? now;
            try { now = ReadActual(a); } catch { continue; }
            if (SameValue(was, now)) continue;                 // o verbo nao lhe tocou
            if (!SameValue(was, a["expected"])) continue;     // ja divergia antes: nao se absorve uma escrita errada
            var rewrites = a["platformRewrites"] as JsonArray ?? (JsonArray)(a["platformRewrites"] = new JsonArray());
            rewrites.Add(new JsonObject { ["verb"] = verb, ["from"] = from, ["to"] = to, ["before"] = was?.DeepClone(), ["after"] = now?.DeepClone() });
            a["expected"] = now?.DeepClone();
            absorbed++;
        }
        return absorbed;
    }
    private void RememberCreate(JsonObject op, JsonNode? result)
    {
        if (!DataKinds.Contains(op["type"]?.ToString() ?? "") || result?["key"] == null) return;
        var target = Resolve("@" + result["key"]!.ToString());
        RememberData(target, "$exists", JsonValue.Create(true));
        if (op["name"] != null) RememberData(target, "Name", op["name"]!.DeepClone());
        if (op["type"]?.ToString() == "EntityIndex")
        {
            RememberData(target, "Unique", Normal(op["args"]?["unique"]?.GetValue<bool>() ?? false));
            // Por CHAVE, nao por nome: o indice segue o rename de um atributo seu, e uma foto do nome faria a
            // entrega ser recusada com isValid=True e o indice certo no modelo (bloqueio da frente R).
            RememberData(target, "AttributeKeys", new JsonArray(op["args"]!["attributes"]!.AsArray()
                .Select(a => (JsonNode?)JsonValue.Create((Resolve(a!.ToString()) as IObjectSignature)?.ObjectKey?.ToString())).ToArray()));
        }
    }
    /// <summary>Igualdade do contrato: DeepEquals, e um texto vazio vale o mesmo que a ausencia de expressao (uma
    /// expressao escrita como "" le-se como null na plataforma: DefaultValue limpo, medido em 2026-09-23). A12: uma
    /// referencia a um elemento de producer vale pelo alvo resolvido (DataProofSameTarget), nao pela chave local.</summary>
    private static bool SameValue(JsonNode? a, JsonNode? b)
    {
        if (JsonNode.DeepEquals(a, b)) return true;
        if (a is JsonObject x && b is JsonObject y && x.ContainsKey("key") && y.ContainsKey("key"))
            return x["key"]?.ToString() == y["key"]?.ToString() || DataProofSameTarget(x, y);
        static bool Empty(JsonNode? n) => n == null || (n is JsonValue v && v.TryGetValue<string>(out var s) && s.Length == 0);
        // C21 (atritos 3): a boolean literal is the same in any case ("true" written, "True" stored by the platform).
        static string? Flag(JsonNode? n) => n is JsonValue v && (v.TryGetValue<bool>(out var b) ? b.ToString() : v.TryGetValue<string>(out var s) && bool.TryParse(s.Trim(), out var p) ? p.ToString() : null) is { } t ? t : null;
        if (Flag(a) is { } x2 && Flag(b) is { } y2) return x2 == y2;
        return Empty(a) && Empty(b);
    }
    private JsonNode? Normal(object? value) => value switch {
        null => null,
        // Um texto vazio escrito numa expressao le-se como null na plataforma: o mesmo valor (fase 3, 2026-09-23).
        IExpression expression => JsonValue.Create(expression.Text ?? ""),
        OutSystems.Model.Types.ITypeSignature type => SemanticTypes.Describe(_es, type),
        IObjectSignature sig => DataProofReference(sig),
        bool b => JsonValue.Create(b ? "true" : "false"),
        IFormattable number => JsonValue.Create(number.ToString(null, CultureInfo.InvariantCulture)),
        _ => JsonValue.Create(value.ToString())
    };

    /// <summary>A12: the value of a reference property. The element's own key and, for an element of a producer (a child of a
    /// module reference: a theme, a block, an entity of another module), the resolved target {producer, producerKey,
    /// originalKey, name}. The Studio re-keys such a reference in the consumer when it merges (BaseTheme expected
    /// {key 80Fv..} actual {key 6P+q..} on SS360_Portal, 2026-10-06): the target is what the job meant, and stays the same.</summary>
    private static JsonObject DataProofReference(IObjectSignature sig)
    {
        var value = new JsonObject { ["key"] = sig.ObjectKey?.ToString() };
        if (DataProofTarget(sig) is { } target) value["target"] = target;
        return value;
    }

    /// <summary>The producer element a reference resolves to: the original key of the element in its producer and the
    /// producer (key and name), from the module reference that holds it; null for an element of the module itself.</summary>
    private static JsonObject? DataProofTarget(IObjectSignature sig)
    {
        try
        {
            var owner = sig.Parent as IObjectSignature;
            var producerKey = owner == null ? null : ModelHost.Prop(owner, "ReferenceKey")?.ToString();
            var originalKey = ModelHost.Prop(sig, "OriginalKey")?.ToString();
            if (string.IsNullOrEmpty(producerKey)) return null;   // not under a module reference: an element of this module
            return new JsonObject { ["producer"] = TypeResolver.Name(owner), ["producerKey"] = producerKey,
                ["originalKey"] = string.IsNullOrEmpty(originalKey) ? null : originalKey, ["name"] = TypeResolver.Name(sig) };
        }
        catch { return null; }   // reading the target never fails the proof: the key comparison stays
    }

    /// <summary>A12: two reference values name the same producer element: same producer (key, else name) and the same
    /// original key, or, when either side has no original key, the same element name in that producer. Values without a
    /// target (an element of the module, a receipt of an earlier version) compare by key only.</summary>
    private static bool DataProofSameTarget(JsonObject expected, JsonObject actual)
    {
        if (expected["target"] is not JsonObject a || actual["target"] is not JsonObject b) return false;
        static string? Text(JsonObject o, string name) => o[name]?.ToString() is { Length: > 0 } text ? text : null;
        var sameProducer = Text(a, "producerKey") is { } ka && Text(b, "producerKey") is { } kb
            ? ka == kb
            : Text(a, "producer") is { } na && string.Equals(na, Text(b, "producer"), StringComparison.OrdinalIgnoreCase);
        if (!sameProducer) return false;
        if (Text(a, "originalKey") is { } oa && Text(b, "originalKey") is { } ob) return oa == ob;
        return Text(a, "name") is { } ea && string.Equals(ea, Text(b, "name"), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>A12: the platform re-keyed a reference to the same producer element (equal by target, different keys).</summary>
    private static bool DataProofRewritten(JsonNode? expected, JsonNode? actual)
        => expected is JsonObject x && actual is JsonObject y && x.ContainsKey("key") && y.ContainsKey("key")
           && x["key"]?.ToString() != y["key"]?.ToString() && DataProofSameTarget(x, y);
    public JsonObject DataContract()
    {
        var assertions = new JsonArray();
        foreach (var a in dataAssertions.Values)
        {
            if (a["key"]?.ToString() is { } chave && _apagados.Contains(chave)) continue;   // o job apagou-o de proposito
            try {
                var target = ResolveAssertion(a["reference"]?.ToString() ?? "@" + a["key"]!.ToString());
                if (UiCatalog.Prop(target, "WasDeleted") is true) continue;
            } catch { /* Keep unresolved assertions: absence must fail rather than silently dropping proof. */ }
            assertions.Add(a.DeepClone());
        }
        return CheckDataContract(assertions);
    }
    public JsonObject CheckDataContract(JsonArray assertions)
    {
        var differences = new JsonArray();
        var rewritten = 0;
        // The assertions answered are copies: a rewrite recorded here never changes the caller's array (a delivery passes the
        // task's own assertions).
        var answered = assertions.DeepClone().AsArray();
        var rekeyed = new JsonArray();
        foreach (var a in answered.OfType<JsonObject>())
        {
            var wasRewritten = a["platformRewrites"] is JsonArray r && r.Count > 0;
            JsonNode? actual = null;
            try {
                actual = ReadActual(a);
                if (SameValue(actual, a["expected"]))
                {
                    // A12: the Studio re-keyed a reference to the same producer element (a theme reference the merge rewrote
                    // to the consumer's key): the same value, recorded as a platform rewrite.
                    if (DataProofRewritten(a["expected"], actual))
                    {
                        var rewrites = a["platformRewrites"] as JsonArray ?? (JsonArray)(a["platformRewrites"] = new JsonArray());
                        var rewrite = new JsonObject { ["verb"] = "merge", ["rule"] = "same producer element, re-keyed in the consumer",
                            ["from"] = a["expected"]?["key"]?.DeepClone(), ["to"] = actual?["key"]?.DeepClone(),
                            ["before"] = a["expected"]?.DeepClone(), ["after"] = actual?.DeepClone() };
                        rewrites.Add(rewrite);
                        rekeyed.Add(new JsonObject { ["element"] = a["element"]?.DeepClone(), ["property"] = a["property"]?.DeepClone(),
                            ["expected"] = a["expected"]?.DeepClone(), ["actual"] = actual?.DeepClone() });
                        wasRewritten = true;
                    }
                    if (wasRewritten) rewritten++;
                    continue;
                }
            } catch (Exception ex) { actual = JsonValue.Create("unavailable: " + Errors.Text(ex)); }
            if (wasRewritten) rewritten++;
            differences.Add(new JsonObject { ["element"] = a["element"]!.DeepClone(), ["property"] = a["property"]!.DeepClone(),
                ["expected"] = a["expected"]?.DeepClone(), ["actual"] = actual,
                ["platformRewrites"] = a["platformRewrites"]?.DeepClone() });
        }
        var proof = new JsonObject { ["accepted"] = differences.Count == 0, ["count"] = assertions.Count, ["rewrittenByPlatform"] = rewritten,
            ["identity"] = "every assertion is anchored on the element's ObjectKey (record values on record key + attribute key); a value the platform rewrote during a rename/set Identifier/replace of this job is expected as rewritten and listed in platformRewrites; a reference to a producer element compares by its resolved target (producer, original key), so the merge re-keying it in the consumer is equal and listed in platformRewrites; a write that already differed before that verb stays a difference",
            ["assertions"] = answered, ["differences"] = differences, ["dataSummary"] = DataSummary(assertions) };
        if (rekeyed.Count > 0) proof["platformRewrites"] = rekeyed;
        return proof;
    }

    private JsonArray DataSummary(JsonArray assertions)
    {
        var result = new JsonArray();
        foreach (var a in assertions.OfType<JsonObject>().Where(a => a["property"]?.ToString() == "$exists"))
        {
            object root;
            try { root = ResolveAssertion(a["reference"]?.ToString() ?? "@" + a["key"]!.ToString()); } catch { continue; }
            if (root is not IObjectSignature owner || !new[] { "IServerEntity", "IStaticEntity", "IClientEntity", "IStructure" }.Any(t => Implements(root,t))) continue;
            var fields = new JsonArray();
            foreach (var field in owner.Children.Where(c => Implements(c,"IEntityAttribute") || Implements(c,"IStructureAttribute")))
                fields.Add(new JsonObject { ["name"] = TypeResolver.Name(field), ["type"] = TypeLabel(FindProperty(field,"DataType")?.GetValue(field)),
                    ["length"] = System.Text.Json.JsonSerializer.SerializeToNode(FindProperty(field,"Length")?.GetValue(field)),
                    ["mandatory"] = System.Text.Json.JsonSerializer.SerializeToNode(FindProperty(field,"IsMandatory")?.GetValue(field)),
                    ["default"] = (FindProperty(field,"DefaultValue")?.GetValue(field) as IExpression)?.Text });
            var records = new JsonArray();
            foreach (var record in owner.Children.Where(c => Implements(c,"IRecord")))
            {
                var values = new JsonObject();
                foreach (var value in record.Children)
                    if (TypeResolver.Name(UiCatalog.Prop(value,"Attribute")) is { } field && UiCatalog.Prop(value,"Value") is IExpression expression)
                        values[field] = Literal(expression.Text);
                records.Add(new JsonObject { ["name"] = TypeResolver.Name(record), ["values"] = values });
            }
            var indexes = new JsonArray();
            foreach (var index in EntityIndexes.IncludeNative(new[] { owner }).Where(o => EntityIndexes.TypeName(o) == "EntityIndex"))
            {
                var data = EntityIndexes.Read(index)!;
                indexes.Add(new JsonObject { ["name"] = data["name"]!.DeepClone(), ["unique"] = data["properties"]!["Unique"]!.DeepClone(),
                    ["attributes"] = data["properties"]!["Attributes"]!.DeepClone() });
            }
            result.Add(new JsonObject { ["name"] = TypeResolver.Name(root), ["kind"] = ShortType(root),
                ["public"] = System.Text.Json.JsonSerializer.SerializeToNode(UiCatalog.Prop(root,"Public")),
                ["updateBehavior"] = UiCatalog.Prop(root,"UpdateBehavior")?.ToString(),
                ["attributes"] = fields, ["records"] = records, ["indexes"] = indexes });
        }
        return result;
    }
    private string? TypeLabel(object? value)
    {
        if (value is OutSystems.Model.Types.IIdentifierType identifier) return TypeResolver.Name(identifier.Entity) + " Identifier";
        foreach (var name in new[] { "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time", "Date Time", "Currency", "Email", "Phone Number", "Binary Data" })
            if (ReferenceEquals(TypeResolver.Basic(_es,name), value)) return name;
        return TypeResolver.Name(value);
    }
    private static JsonNode? Literal(string? text)
    {
        if (text == null) return null;
        if (text.Length >= 2 && text[0] == '"' && text[^1] == '"') return JsonValue.Create(text[1..^1].Replace("\"\"", "\""));
        if (bool.TryParse(text,out var boolean)) return JsonValue.Create(boolean);
        if (decimal.TryParse(text,NumberStyles.Number,CultureInfo.InvariantCulture,out var number)) return JsonValue.Create(number);
        return JsonValue.Create(text);
    }
}
