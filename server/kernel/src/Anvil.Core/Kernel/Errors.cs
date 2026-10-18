using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Referencia `Tipo:Nome` (ou `$alias`) que nao resolve no modelo NESTE ponto do job: nao existe no modulo, nem nas
/// referencias, nem foi criada por um op anterior. Verbs.Apply completa a mensagem com os forward-refs do job (ForwardRefs).</summary>
public sealed class UnresolvedReferenceException : KeyNotFoundException
{
    public string Reference { get; }
    public string Type { get; }
    public string Name { get; }

    public UnresolvedReferenceException(string reference, string type, string name, string message) : base(message)
    {
        Reference = reference; Type = type; Name = name;
    }
}

/// <summary>An error that carries a specific UPPER_SNAKE code and, when it has them, the structured problems (I2). The CLI
/// envelope (Errors.Envelope) adds both next to the error text, in the cold CLI and in the worker alike.</summary>
public interface ICodedError
{
    string Code { get; }
    JsonArray? Problems { get; }
}

/// <summary>A refusal the kernel decides before anything is saved, with its own code (SIGNATURE_CHANGE_BREAKS_CONSUMERS, ...).</summary>
public class KernelRefusalException : InvalidOperationException, ICodedError
{
    public string Code { get; }
    public JsonArray? Problems { get; }
    public KernelRefusalException(string code, string message, JsonArray? problems = null) : base(message)
    {
        Code = code; Problems = problems;
    }
}

/// <summary>Texto de erro que o CLI e o worker devolvem: a mensagem mais EXTERIOR que ainda contem a mensagem da raiz (e a que
/// traz o prefixo `op #i (verbo ...)` de Verbs.Apply), saltando wrappers de reflexao; o tipo e o da raiz. Antes o envelope
/// descia ate a raiz e descartava o indice do op, e uma LLM recebia um nome solto num job de 300 ops (plano, item 14).</summary>
public static class Errors
{
    /// <summary>The first coded error of the chain (outermost first), or null.</summary>
    public static ICodedError? FindCoded(Exception ex)
    {
        // An empty code is no code (SignatureCaptureException: coded only for an unknown or ambiguous producer name).
        for (var e = ex; e != null; e = e.InnerException)
            if (e is ICodedError coded && !string.IsNullOrEmpty(coded.Code)) return coded;
        return null;
    }

    /// <summary>The error envelope of both CLIs (O11 and ODC) and of the worker: {ok:false, command, elapsedMs, error, stack},
    /// plus `code` and `problems` when the exception carries them (JobPreflightException: PREFLIGHT_REFUSED with every problem).</summary>
    public static JsonObject Envelope(string command, Exception ex, long ms)
    {
        var (type, message, stack) = Describe(ex);
        var envelope = new JsonObject { ["ok"] = false, ["command"] = command, ["elapsedMs"] = ms,
            ["error"] = message.Contains(type + ": ", StringComparison.Ordinal) ? message : type + ": " + message };
        if (FindCoded(ex) is { } coded)
        {
            envelope["code"] = coded.Code;
            if (coded.Problems is { } problems) envelope["problems"] = problems.DeepClone();
        }
        // primeira-certa A2/A7: whether the Verify ran before the refusal (and why not), its phases and, for a refusal of
        // one phase alone that keeps its own exception, the problems in the same form.
        if (Diagnosis(ex) is { } diagnosis)
            foreach (var (key, value) in diagnosis)
                if (key != "problems" || envelope["problems"] == null) envelope[key] = value?.DeepClone();
        // lentidao 2026-10-12: what the kernel rewrote instead of refusing comes with the refusal of what stayed.
        if (Normalizations(ex) is { } normalizations) envelope["normalizations"] = normalizations;
        envelope["stack"] = stack;
        return envelope;
    }

    /// <summary>Where a refusal keeps the normalizations of its job (JobNormalizer): {rule, path, from, to, message}.</summary>
    public const string NormalizationsKey = "anvil.normalizations";

    /// <summary>Keeps the normalizations of the job with its refusal (only when there are some, and only once).</summary>
    public static void AttachNormalizations(Exception ex, JsonArray? normalizations)
    {
        if (normalizations is not { Count: > 0 } || ex.Data.Contains(NormalizationsKey)) return;
        ex.Data[NormalizationsKey] = normalizations.DeepClone();
    }

    /// <summary>The normalizations a refusal carries (outermost first), or null.</summary>
    public static JsonArray? Normalizations(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
            if (e.Data.Contains(NormalizationsKey) && e.Data[NormalizationsKey] is JsonArray list) return list.DeepClone().AsArray();
        return null;
    }

    /// <summary>Where <see cref="Annotate"/> keeps the fields of a refusal whose exception is not a JobPreflightException.</summary>
    public const string DiagnosisKey = "anvil.diagnosis";

    /// <summary>primeira-certa A7: a refusal of one phase alone (a lone apply failure such as DELETE_HAS_CONSUMERS, a lone
    /// database-upgrade refusal) keeps its own exception and code, and still says whether the Verify ran, its phases and
    /// its problems in the format of the single refusal.</summary>
    public static void Annotate(Exception ex, bool verifyRan, string? verifyReason, IReadOnlyList<string> phases, JsonArray? problems)
    {
        if (ex is JobPreflightException refusal)
        {
            refusal.VerifyRan = verifyRan; refusal.VerifyReason = verifyReason; refusal.Phases = phases;
            return;
        }
        var fields = new JsonObject { ["verifyRan"] = verifyRan };
        if (verifyReason != null) fields["verifyReason"] = verifyReason;
        fields["phases"] = new JsonArray(phases.Select(p => (JsonNode)p).ToArray());
        if (problems != null) fields["problems"] = problems.DeepClone();
        ex.Data[DiagnosisKey] = fields;
    }

    /// <summary>The diagnosis fields of a refusal (verifyRan, verifyReason, phases and, from <see cref="Annotate"/>,
    /// problems), outermost first; null when the refusal says none.</summary>
    public static JsonObject? Diagnosis(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e.Data.Contains(DiagnosisKey) && e.Data[DiagnosisKey] is JsonObject annotated) return annotated.DeepClone().AsObject();
            if (e is JobPreflightException { VerifyRan: { } ran } refusal)
            {
                var fields = new JsonObject { ["verifyRan"] = ran };
                if (refusal.VerifyReason != null) fields["verifyReason"] = refusal.VerifyReason;
                if (refusal.Phases != null) fields["phases"] = new JsonArray(refusal.Phases.Select(p => (JsonNode)p).ToArray());
                return fields;
            }
        }
        return null;
    }

    public static (string Type, string Message, string? Stack) Describe(Exception ex)
    {
        var chain = new List<Exception>();
        for (var e = ex; e != null; e = e.InnerException) chain.Add(e);
        var root = chain[^1];
        var best = chain.FirstOrDefault(e => e is not TargetInvocationException && !string.IsNullOrEmpty(e.Message)
                                             && e.Message.Contains(root.Message, StringComparison.Ordinal)) ?? root;
        return (root.GetType().Name, best.Message, root.StackTrace);
    }

    public static string Text(Exception ex)
    {
        var (type, message, _) = Describe(ex);
        return message.StartsWith(type + ":", StringComparison.Ordinal) || message.Contains(type + ": ", StringComparison.Ordinal) ? message : type + ": " + message;
    }

    public static UnresolvedReferenceException? FindUnresolved(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
            if (e is UnresolvedReferenceException u) return u;
        return null;
    }
}

/// <summary>Referencias usadas ANTES de o alvo ser criado no mesmo job (o job e uma sequencia: um `set Destination` a uma tela
/// que so nasce dez ops depois falha). Nao reordena nada (delete+recreate legitimo, plano item 14): so explica, listando TODOS os
/// casos de uma vez, para a correcao ser uma edicao e nao uma sondagem.</summary>
public static class ForwardRefs
{
    private static readonly Regex TypeName = new(@"(?<![\w$@/])(I[A-Z][A-Za-z0-9]*):([A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);
    private static readonly Regex Alias = new(@"\$([A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);

    public sealed record ForwardRef(int UsedAt, string Reference, int CreatedAt, string CreatedAs);

    /// <summary>Todos os forward-refs do job: (op onde e usado, referencia, op onde e criado, descricao do create).</summary>
    public static List<ForwardRef> Find(JsonArray ops)
    {
        var byName = new Dictionary<string, (int Index, string Type, string Name)>(StringComparer.OrdinalIgnoreCase);
        var byAlias = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var j = 0; j < ops.Count; j++)
        {
            if (ops[j] is not JsonObject o) continue;
            var kind = o["op"]?.GetValue<string>();
            var name = o["name"]?.GetValue<string>();
            var type = o["type"]?.GetValue<string>();
            if (kind is "create" or "spec" or "logic" && name != null && !byName.ContainsKey(name)) byName[name] = (j, type ?? kind, name);
            if (o["as"]?.GetValue<string>() is { } a && a.StartsWith('$') && !byAlias.ContainsKey(a[1..])) byAlias[a[1..]] = j;
        }
        var found = new List<ForwardRef>();
        for (var k = 0; k < ops.Count; k++)
        {
            if (ops[k] is not JsonObject o) continue;
            foreach (var (prop, text) in Strings(o))
            {
                if (prop is "name" or "as" or "description") continue;
                foreach (Match m in TypeName.Matches(text))
                {
                    var name = m.Groups[2].Value;
                    if (byName.TryGetValue(name, out var c) && c.Index > k)
                        found.Add(new ForwardRef(k, m.Value, c.Index, $"create {c.Type} {c.Name}"));
                }
                foreach (Match m in Alias.Matches(text))
                {
                    var alias = m.Groups[1].Value;
                    if (byAlias.TryGetValue(alias, out var j) && j > k)
                        found.Add(new ForwardRef(k, "$" + alias, j, $"op #{j} defines $" + alias));
                }
            }
        }
        return found.DistinctBy(f => (f.UsedAt, f.Reference)).OrderBy(f => f.UsedAt).ToList();
    }

    /// <summary>Complemento da mensagem de erro do op `failedIndex`: onde o alvo e criado e os outros forward-refs do job.</summary>
    public static string Explain(JsonArray ops, int failedIndex, string? failedName)
    {
        var all = Find(ops);
        var mine = all.Where(f => f.UsedAt == failedIndex && (failedName == null || f.Reference.EndsWith(":" + failedName, StringComparison.OrdinalIgnoreCase) || f.Reference == "$" + failedName)).ToList();
        var others = all.Where(f => !mine.Contains(f)).Take(8).ToList();
        if (mine.Count == 0 && others.Count == 0) return "";
        var parts = new List<string>();
        foreach (var f in mine)
            parts.Add($"{f.Reference} does not exist yet at this point of the job: it is created at op #{f.CreatedAt} ({f.CreatedAs}). Create it before op #{failedIndex}, or move op #{failedIndex} after op #{f.CreatedAt}");
        if (others.Count > 0)
            parts.Add("Also out of order: " + string.Join("; ", others.Select(f => $"{f.Reference} (created at op #{f.CreatedAt}, used at op #{f.UsedAt})")));
        return " | " + string.Join(". ", parts);
    }

    private static IEnumerable<(string Prop, string Text)> Strings(JsonNode? node, string prop = "")
    {
        switch (node)
        {
            case JsonValue v:
                if (v.TryGetValue<string>(out var s)) yield return (prop, s);
                break;
            case JsonObject o:
                foreach (var kv in o) foreach (var x in Strings(kv.Value, kv.Key)) yield return x;
                break;
            case JsonArray a:
                foreach (var e in a) foreach (var x in Strings(e, prop)) yield return x;
                break;
        }
    }
}
