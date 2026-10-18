using OutSystems.Model;

// Resolves model objects by a readable path instead of stored keys, so builders survive
// save/reload and Studio rekeying. Path syntax: "Kind:Name/Kind:Name".
// Kind is the V1 interface name with or without the leading I (ServerAction, AssignNode,
// Assignment, MobileScreen...) or "*". Name matches DisplayName exactly or "*".
// Each segment searches direct children first, then all descendants. Ambiguity is an error
// that lists the candidates; nothing is ever chosen silently.
internal static class ModelPath {
    public static IModelObject Resolve(IModelObject root, string path) {
        var current = root;
        foreach (var segment in path.Split('/', StringSplitOptions.RemoveEmptyEntries)) {
            var parts = segment.Split(':', 2);
            var kind = parts.Length == 2 ? parts[0].Trim() : "*";
            var name = (parts.Length == 2 ? parts[1] : parts[0]).Trim();
            var matches = current.Children.Where(n => Matches(n, kind, name)).ToArray();
            if (matches.Length == 0) matches = Descendants(current).Where(n => Matches(n, kind, name)).ToArray();
            if (matches.Length == 0) throw new InvalidOperationException(NaoResolve(current, segment, kind, name, path));
            if (matches.Length > 1) throw new InvalidOperationException("Ambiguous model path '" + segment + "' under " + Describe(current) + ": " + string.Join("; ", matches.Select(Describe)));
            current = matches[0];
        }
        return current;
    }

    public static T Resolve<T>(IModelObject root, string path) where T : class, IModelObject =>
        Resolve(root, path) as T ?? throw new InvalidOperationException("Path '" + path + "' resolved to " + Describe(Resolve(root, path)) + ", not " + typeof(T).Name + ".");

    public static T Single<T>(IModelObject root, string displayName) where T : class, IModelObject {
        var matches = Descendants(root).OfType<T>().Where(n => n.DisplayName == displayName).ToArray();
        if (matches.Length == 1) return matches[0];
        throw new InvalidOperationException((matches.Length == 0 ? "No " : "Ambiguous ") + typeof(T).Name + " named '" + displayName + "'" + (matches.Length > 1 ? ": " + string.Join("; ", matches.Select(Describe)) : "") + ".");
    }

    public static IEnumerable<IModelObject> Descendants(IModelObject root) {
        var stack = new Stack<IModelObject>(root.Children);
        while (stack.TryPop(out var node)) { yield return node; foreach (var child in node.Children) stack.Push(child); }
    }

    // A travessia que falhou JA VIU o modelo inteiro -- so nao contava nada do que viu. Aqui diz-se: se o nome
    // existe noutro kind, quais; se nem o nome existe, os nomes mais parecidos DO KIND PEDIDO.
    //
    // Duas regras que vieram de sangue derramado (leitura integral da sessao de 2026-09-17, docs/ONDE-FORAM-AS-8-HORAS.md):
    //  1. So saem KINDS e NOMES, nunca `Describe` de um no. O DisplayName de uma expressao E o texto da expressao,
    //     e foi assim que uma mensagem de erro "generosa" despejou a consola inteira as 21h.
    //  2. Tudo cortado: no maximo 8 kinds e 6 nomes. Uma mensagem que nao cabe no ecra nao e ajuda, e outro
    //     problema.
    private static string NaoResolve(IModelObject current, string segment, string kind, string name, string path) {
        var basico = "No model object matches '" + segment + "' under " + Describe(current) + " in path '" + path + "'.";
        if (name == "*") return basico;
        try {
            var todos = Descendants(current).ToArray();
            var comEsseNome = todos.Where(n => n.DisplayName == name).Select(Kind).Distinct(StringComparer.Ordinal)
                .OrderBy(k => k, StringComparer.Ordinal).Take(8).ToArray();
            if (comEsseNome.Length > 0)
                return basico + " It exists with that name, as another kind: " + string.Join(", ", comEsseNome)
                       + (kind == "*" ? "" : " (asked for " + kind + ").");
            var doKind = todos.Where(n => kind == "*" || Matches(n, kind, "*")).Select(n => n.DisplayName)
                .Where(d => !string.IsNullOrEmpty(d)).ToArray();
            if (doKind.Length == 0) return basico + " There is no " + kind + " in here.";
            var parecidos = NameSuggestions.Closest(name, doKind, 6);
            return basico + " " + kind + " that exist, the closest: " + string.Join(", ", parecidos)
                   + (doKind.Distinct(StringComparer.Ordinal).Count() > parecidos.Count
                      ? " (and " + (doKind.Distinct(StringComparer.Ordinal).Count() - parecidos.Count) + " more)." : ".");
        } catch (Exception e) {
            // Diagnostico nunca derruba trabalho: se a segunda passagem falhar, entrega-se a mensagem simples.
            return basico + " (the suggestion failed: " + e.GetType().Name + ")";
        }
    }

    public static string Kind(IModelObject node) { var name = node.GetInterface()?.Name ?? node.GetType().Name; return name.Length > 1 && name[0] == 'I' && char.IsUpper(name[1]) ? name[1..] : name; }
    public static string Describe(IModelObject node) => Kind(node) + ":" + node.DisplayName + " [" + node.Key + "]";

    private static bool Matches(IModelObject node, string kind, string name) {
        var interfaceName = node.GetInterface().Name;
        var kindMatches = kind == "*" || interfaceName == kind || interfaceName == "I" + kind;
        return kindMatches && (name == "*" || node.DisplayName == name);
    }
}
