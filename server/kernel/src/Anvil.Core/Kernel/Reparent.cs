using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// move {target, into, first?|last?|before?|after?}: muda o PAI de um objeto, pelos dois caminhos que o proprio Studio
/// usa quando se arrasta um elemento na arvore (OverImportTargetGenericDropHandler, lido nas DLLs das duas faixas):
///  * elemento de topo listado pelo Studio (action, entidade, structure, variavel de sitio/sessao/cliente, timer, tema,
///    script, recurso, imagem, processo, role): o "mover" e trocar de PASTA. E so a propriedade Folder; a chave, o pai
///    (o modulo) e todos os consumidores ficam iguais. `into` e a pasta, ou "@espace" para sair de qualquer pasta.
///  * o resto (widget, tela, bloco, variavel local, parametro, atributo...): o move nativo da plataforma,
///    IModelServices.MoveObject (por dentro ObjectCloner.MoveObject, o mesmo do arrastar do Studio), atras do adaptador
///    de cada faixa. Ele recria o objeto no pai novo, religa cada consumidor ao objeto recriado e apaga o original. As
///    referencias seguem; a CHAVE do objeto movido (e dos descendentes com chave global) e nova, porque a plataforma gera
///    uma chave para a raiz de toda importacao (Importer.ImportObject, isRootOfImport). Nao ha API que mude a chave de um
///    objeto local. Por isso um objeto PUBLICO (que outros modulos usam pela chave) e recusado.
/// O verbo prova o que promete: antes do move guarda cada consumidor (fora da subarvore, nao derivado) de cada objeto
/// movido; depois exige que cada um aponte para o substituto, e que o Verify nao tenha erro novo (o que o objeto movido
/// usa tem de continuar ao alcance). Qualquer falha aborta o job inteiro com o caminho de cada consumidor ou erro. O
/// conjunto final de consumidores volta a ser conferido depois de gravar e recarregar (RefactorContract), como no replace.
/// </summary>
public sealed partial class ModelSession
{
    private JsonNode MoveInto(JsonObject op, object target)
    {
        if (op["x"] != null || op["y"] != null)
            throw new InvalidOperationException("move: \"into\" changes the parent; x/y only position a flow node inside its own flow. Use two ops.");
        var sig = target as IObjectSignature ?? throw new InvalidOperationException($"move into: {Describe(target)} is not a model object");
        if (sig.Parent is not IObjectSignature) throw new InvalidOperationException("move: target has no parent");
        // DL2: "folder:<Name>" is the folder of that name in the target's own branch of the module tree (created when missing):
        // the data text names a folder by its name, and the same name can be a folder of another branch.
        if (Req(op, "into") is var intoText && intoText.StartsWith("folder:", StringComparison.Ordinal) && FolderProperty(sig) is { } named)
            return MoveToFolder(op, sig, named, FolderInBranch(sig, intoText["folder:".Length..]));
        var into = Resolve(Req(op, "into"));
        if (FolderProperty(sig) is { } folder) return MoveToFolder(op, sig, folder, into);
        if (into is IFolder)
            throw new InvalidOperationException(sig is IFolder
                ? $"move into: {Describe(sig)} is a folder; the module tree has a single level of folders, so a folder never goes inside another one"
                : sig.Parent is IESpace
                ? $"move into: {Describe(sig)} lives at the module root and the Studio never lists it in a folder (only actions, entities, structures, variables, timers, themes, scripts, resources, roles... have a Folder); it has no other parent to move to"
                : $"move into: {Describe(into)} is a folder of the module tree, and {Describe(sig)} is not listed in folders " +
                  $"(it lives inside {Place((IObjectSignature)sig.Parent!)}). Folders hold top-level elements only (actions, entities, structures, variables, timers...).");
        var destination = into as IObjectSignature ?? throw new InvalidOperationException($"move into: {Describe(into)} is not a model object");
        if (sig.Parent is IObjectSignature current && ReferenceEquals(current, destination))
            return HasDirection(op) ? Reorder(op, sig, current)
                : new JsonObject { ["moved"] = "none", ["target"] = Describe(sig), ["parent"] = Place(current), ["note"] = "already inside that parent" };
        return Reparent(op, sig, destination);
    }

    /// <summary>PathOf, mas o proprio modulo (que PathOf deixa vazio) aparece pelo tipo (IESpace).</summary>
    private static string Place(IObjectSignature o) => PathOf(o) is { Length: > 0 } path ? path : ShortType(o);

    private static bool HasDirection(JsonObject op) => op["first"]?.GetValue<bool>() == true || op["last"]?.GetValue<bool>() == true || op["before"] != null || op["after"] != null;

    /// <summary>A propriedade Folder gravavel do Model API (IServerAction.Folder, IStructure.Folder...): so os elementos
    /// de topo listados em pastas a tem.</summary>
    private static PropertyInfo? FolderProperty(IObjectSignature o) =>
        AllProperties(o).FirstOrDefault(p => p.Name == "Folder" && p.CanWrite && typeof(IFolder).IsAssignableFrom(p.PropertyType));

    /// <summary>Trocar de pasta e o HandleMove do Studio: escreve Folder (null = raiz da arvore). O setter nativo nao lanca
    /// quando a pasta e de outro ramo da arvore (ValidateFolderChange troca-a por null em silencio), por isso le-se de
    /// volta e recusa-se com o ramo de cada um.</summary>
    private JsonNode MoveToFolder(JsonObject op, IObjectSignature sig, PropertyInfo property, object into)
    {
        if (HasDirection(op))
            throw new InvalidOperationException($"move into a folder: the Studio lists a folder's elements by name, so first/last/before/after have no meaning for {Describe(sig)}");
        var folder = into as IFolder;
        if (folder == null && !ReferenceEquals(into, _espace))
            throw new InvalidOperationException($"move into: {Describe(sig)} is listed by the Studio in a branch of the module tree (it has a Folder); its only move is to another folder of that branch " +
                $"(into: \"IFolder:<name>\") or out of every folder (into: \"@espace\"). {Describe(into)} is neither. " +
                "The platform does not move an action, entity, structure or variable inside another element.");
        var key = sig.ObjectKey?.ToString();
        var from = property.GetValue(sig) as IFolder;
        var before = Consumers(sig).Count(c => !IsDerived(c.Referer, c.Path));
        property.SetValue(sig, folder);
        var now = property.GetValue(sig) as IFolder;
        if (!ReferenceEquals(now, folder))
        {
            property.SetValue(sig, from);
            var ao = (ServiceStudio.Model.AbstractObject)sig;
            throw new InvalidOperationException($"move into: {Describe(folder!)} is a folder of the '{folder!.ParentFolder}' branch, and {Describe(sig)} is listed under " +
                $"'{ao.AbstractObjectKind.GetESpaceTreeFolderForObject(ao)}'. A folder only holds elements of its own branch (the Studio refuses the same drop).");
        }
        return new JsonObject
        {
            ["moved"] = "folder", ["target"] = Describe(sig), ["from"] = from == null ? null : TypeResolver.Name(from), ["to"] = folder == null ? null : TypeResolver.Name(folder),
            ["key"] = new JsonObject { ["before"] = key, ["after"] = sig.ObjectKey?.ToString(), ["preserved"] = key == sig.ObjectKey?.ToString() },
            ["consumers"] = new JsonObject { ["before"] = before, ["after"] = Consumers(sig).Count(c => !IsDerived(c.Referer, c.Path)) },
        };
    }

    private JsonNode Reparent(JsonObject op, IObjectSignature sig, IObjectSignature destination)
    {
        var source = sig as ServiceStudio.Model.AbstractObject ?? throw new InvalidOperationException($"move into: {Describe(sig)} is not a model object");
        var parent = destination as ServiceStudio.Model.AbstractObject ?? throw new InvalidOperationException($"move into: {Describe(destination)} is not a model object");
        var oldParent = (IObjectSignature)sig.Parent!;
        if (ReferenceEquals(sig, destination) || IsInside(destination, sig))
            throw new InvalidOperationException($"move into: {Describe(destination)} is inside {Describe(sig)}; an object cannot move into itself");
        if (!source.CanBeUserDeleted)
            throw new InvalidOperationException($"move into: {Describe(sig)} is kept by the platform inside {Place(oldParent)} (it cannot be deleted from there), so it cannot leave it either; the Studio refuses the same drag");
        // Elementos de um modulo referenciado vivem dentro deste modulo (IReference), mas sao copias de leitura do produtor.
        for (var p = destination; p != null; p = p.Parent as IObjectSignature)
            if (p is IReference reference)
                throw new InvalidOperationException($"move into: {Describe(destination)} belongs to the referenced module '{TypeResolver.Name(reference)}', which this module only reads; move inside this module");
        // Um contentor guarda os filhos num contentor interno sem nome (IMobileWidget 'content' no O11, IContent no ODC): o
        // `create` com parent no contentor ja cria la dentro, e o move faz o mesmo. So um filho estrutural (sem nome) e
        // tentado, nunca um widget com nome do autor. DirectChildren (o indice interno) e nao Children: o Model API do O11
        // achata o contentor interno de um widget de plugin (lista os netos como filhos), e e ele que aceita a importacao.
        var studio = StudioAdapter.Runtime;
        string? conversion = null;
        var accepting = new[] { parent }.Concat(parent.DirectChildren.Where(c => string.IsNullOrEmpty(TypeResolver.Name(c)) || TypeResolver.Name(c) == "content"))
            .FirstOrDefault(c => (conversion = studio.ImportsChild(c, source)) != null);
        if (accepting == null)
            throw new InvalidOperationException($"move into: {Describe(destination)} does not accept {ShortType(sig)} as a child (the platform's own test, CloneAllowed, says no; the Studio refuses the same drop). " +
                $"{Describe(sig)} stays inside {Place(oldParent)}.");
        if (conversion is { Length: > 0 })
            throw new InvalidOperationException($"move into: {Describe(destination)} only takes {Describe(sig)} by converting it into a {conversion}; move never converts an object into another kind");
        parent = accepting;
        if (ReferenceEquals(parent, oldParent))
            return HasDirection(op) ? Reorder(op, sig, oldParent)
                : new JsonObject { ["moved"] = "none", ["target"] = Describe(sig), ["parent"] = Place(oldParent), ["note"] = "already inside that parent" };

        // Antes: cada objeto movido (a raiz e a subarvore) e os seus consumidores de fora, nao derivados.
        var moved = new List<IObjectSignature> { sig };
        moved.AddRange(sig.GetAllDescendantsOfType<IObjectSignature>());
        // Um elemento publico e usado por OUTROS modulos pela chave; o move nativo da-lhe chave nova e esses consumidores
        // nao estao aqui para serem religados.
        if (moved.FirstOrDefault(m => UiCatalog.Prop(m, "Public") is true) is { } shared)
            throw new InvalidOperationException($"move into: {Describe(shared)} is public, so other modules use it by its key; the platform's move gives the moved objects new keys " +
                "and those consumers would break where this job cannot rewire them. Make it non-public first (and update its consumers), or leave it where it is.");
        var keysBefore = moved.Select(m => m.ObjectKey?.ToString()).ToList();
        // So os consumidores de FORA do objeto movido: os de dentro vao com ele (sao recriados junto).
        var consumersBefore = moved.Select(m => m is ServiceStudio.Model.AbstractObject a && a.HasReferers
            ? Consumers(m).Where(c => !IsDerived(c.Referer, c.Path) && !ReferenceEquals(c.Referer, sig) && !IsInside(c.Referer, sig))
                .Select(c => c.Referer).Distinct().ToList() : new()).ToList();
        var assertionsBefore = SnapshotAssertions();
        var errorsBefore = ModelHost.Messages(_espace).Where(m => m.IsError).ToList();
        var oldKey = sig.ObjectKey?.ToString();
        var oldName = TypeResolver.Name(sig);

        var result = studio.MoveObject((IObject)source, (IObject)parent) as IObjectSignature
            ?? throw new InvalidOperationException($"move into: the platform did not return the moved {Describe(sig)}");

        // Depois: o substituto de cada original (SetReplacement do proprio MoveObject) e quem ficou para tras.
        var keyMap = new Dictionary<string, string>(StringComparer.Ordinal);
        var replaced = new Dictionary<object, object>(ReferenceEqualityComparer.Instance);
        var left = new List<string>();
        var followed = new JsonArray();
        var rewired = 0; var gone = 0;
        for (var i = 0; i < moved.Count; i++)
        {
            var original = (ServiceStudio.Model.AbstractObject)moved[i];
            var now = i == 0 ? result : original.TryGetReplacement() as IObjectSignature;
            if (now == null) { if (consumersBefore[i].Count > 0) left.AddRange(consumersBefore[i].Select(c => $"{Place(c)} -> {Place(moved[i])} (no replacement)")); continue; }
            replaced[original] = now;
            if (keysBefore[i] is { } k && now.ObjectKey?.ToString() is { } nk && k != nk) keyMap[k] = nk;
            if (consumersBefore[i].Count == 0) continue;
            var after = Consumers(now).Select(c => c.Referer).ToHashSet(ReferenceEqualityComparer.Instance);
            foreach (var c in consumersBefore[i])
            {
                // Apagado pela propria plataforma (um GoTo de destino sem uso, um conector de outro fluxo): se isso
                // quebrar alguma coisa, o Verify abaixo diz o que.
                if (((IObjectSignature)c).WasDeleted) { gone++; continue; }
                if (after.Contains(c)) { rewired++; if (followed.Count < 20) followed.Add($"{Place(c)} -> {Place(now)}"); }
                else left.Add($"{Place(c)} -> {Place(now)}");
            }
        }
        if (left.Count > 0)
            throw new InvalidOperationException($"move into: {left.Count} consumer(s) of {Describe(sig)} cannot follow it into {Place(destination)} and would be left pointing at nothing " +
                $"(out of reach from the new parent): {string.Join("; ", left.Take(8))}. Change or move those consumers first; nothing was moved.");
        // O outro sentido: o que o objeto movido usa (uma variavel da action antiga, os conectores do fluxo de onde saiu)
        // so o Verify da plataforma sabe se continua ao alcance. Um erro novo aborta o job; os que ja havia nao contam
        // (com as chaves antigas trocadas pelas novas, o mesmo erro no objeto movido nao e novo).
        var known = errorsBefore.Select(m => ErrorIdentity(m, keyMap)).ToHashSet(StringComparer.Ordinal);
        var broken = ModelHost.Messages(_espace).Where(m => m.IsError && !known.Contains(ErrorIdentity(m, null))).ToList();
        if (broken.Count > 0)
            throw new InvalidOperationException($"move into: moving {Describe(sig)} into {Place(destination)} leaves {broken.Count} new Verify error(s): " +
                $"{string.Join("; ", broken.Take(6).Select(m => $"{m.Id}: {m.Detail} @ {m.Path}"))}. What it uses (or what used it) is out of reach there; nothing was moved.");

        RebindAfterMove(replaced, keyMap);
        // A fotografia de antes, com os ids das assercoes ja nas chaves novas: um valor que cita um objeto movido (a chave de
        // um atributo num indice) mudou por causa do move e e reescrita da plataforma.
        var absorbed = AbsorbPlatformRewrites(assertionsBefore.Select(a => (RemapKeys(a.Id, keyMap), a.Actual, a.Readable)).ToList(), "move", Describe(result), Place(destination));
        _replacementTargets.Add(result);
        var answer = new JsonObject
        {
            ["moved"] = "parent", ["target"] = Describe(result), ["from"] = Place(oldParent), ["to"] = Place(destination),
            ["key"] = new JsonObject { ["before"] = oldKey, ["after"] = result.ObjectKey?.ToString(), ["preserved"] = oldKey == result.ObjectKey?.ToString() },
            ["keysChanged"] = keyMap.Count, ["objects"] = moved.Count,
            // O MoveObject repoe o nome original; so muda se o pai novo ja tiver um irmao com esse nome (NameClash).
            ["name"] = new JsonObject { ["before"] = oldName, ["after"] = TypeResolver.Name(result) },
            ["consumers"] = new JsonObject { ["before"] = consumersBefore.Sum(c => c.Count), ["rewired"] = rewired, ["removedByPlatform"] = gone, ["followed"] = followed },
            ["dataContractRewrites"] = absorbed,
            ["note"] = "the platform's own move (the Studio drag): consumers follow the object; the moved object and its descendants with global keys get new keys (keysChanged)",
        };
        if (HasDirection(op) && result.Parent is IObjectSignature newParent) answer["position"] = Reorder(op, result, newParent);
        return answer;
    }

    /// <summary>O que o kernel guarda por objeto passa para o substituto: handles do job, o indice por chave e as
    /// assercoes do contrato de dados (ancoradas na chave).</summary>
    private void RebindAfterMove(Dictionary<object, object> replaced, Dictionary<string, string> keyMap)
    {
        foreach (var alias in _handles.Where(h => replaced.ContainsKey(h.Value)).Select(h => h.Key).ToList()) _handles[alias] = replaced[_handles[alias]];
        _byKey = null;
        if (keyMap.Count == 0) return;
        var byNewKey = replaced.Values.OfType<IObjectSignature>().Where(o => o.ObjectKey != null).GroupBy(o => o.ObjectKey!.ToString()!).ToDictionary(g => g.Key, g => g.First());
        foreach (var id in dataAssertions.Keys.ToList())
        {
            var a = dataAssertions[id];
            var newId = RemapKeys(id, keyMap);
            if (a["key"]?.ToString() is { } k && keyMap.TryGetValue(k, out var nk))
            {
                a["key"] = nk;
                if (byNewKey.TryGetValue(nk, out var now)) a["element"] = ModelHost.PathOf(now);
            }
            if (a["reference"]?.ToString() is { } r) a["reference"] = RemapKeys(r, keyMap);
            if (newId != id) { dataAssertions.Remove(id); dataAssertions[newId] = a; }
        }
    }

    /// <summary>Troca cada segmento "@chave" de uma referencia de assercao ("@k", "@k/@k2", "@k/Nome", "@k:Prop") pela chave
    /// nova. Chaves sao opacas e podem conter '/', por isso compara-se pelo prefixo exato de cada chave conhecida.</summary>
    private static string RemapKeys(string reference, Dictionary<string, string> keyMap)
    {
        foreach (var (oldKey, newKey) in keyMap.OrderByDescending(k => k.Key.Length))
        {
            var token = "@" + oldKey;
            var at = 0;
            while ((at = reference.IndexOf(token, at, StringComparison.Ordinal)) >= 0)
            {
                var end = at + token.Length;
                if (end == reference.Length || reference[end] is '/' or ':') { reference = reference[..at] + "@" + newKey + reference[end..]; at += newKey.Length + 1; }
                else at = end;
            }
        }
        return reference;
    }

    /// <summary>A identidade de uma mensagem do Verify para este fim: [Id, chave do objeto, propriedades] de MessageInfo.Key,
    /// com a chave trocada pela nova quando o objeto foi movido. Os parametros ficam de fora porque citam o pai pelo nome
    /// ("Solto must have 1 outgoing connector in 'MvA'" passa a "... in 'MvB'"): e o mesmo erro, no mesmo objeto.</summary>
    private static string ErrorIdentity(MessageInfo m, Dictionary<string, string>? keyMap)
    {
        if (JsonNode.Parse(m.Key) is not JsonArray parts || parts.Count < 3) return m.Key;
        if (keyMap != null && parts[1] is JsonValue v && v.TryGetValue<string>(out var key) && keyMap.TryGetValue(key, out var moved)) parts[1] = moved;
        return new JsonArray(parts[0]?.DeepClone(), parts[1]?.DeepClone(), parts[2]?.DeepClone()).ToJsonString();
    }

}
