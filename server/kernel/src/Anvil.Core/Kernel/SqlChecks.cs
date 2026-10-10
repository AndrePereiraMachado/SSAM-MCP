using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Contrato SQL da spec, sem tentar substituir o parser/Verify dos verbos crus.</summary>
public static class SqlChecks
{
    private static readonly Regex Ignored = new(@"'(?:''|[^'])*'|--[^\r\n]*|/\*[\s\S]*?\*/", RegexOptions.Compiled);
    // The Studio's own reading (\@\w+): @@ROWCOUNT names a parameter ROWCOUNT and DECLARE @x names a parameter x. Its Verify
    // refuses both as InvalidSQL_UnknownParam (measured on the Service Studio 11 Verify, 2026-10-05), so they stay counted
    // here; Validate only explains them with the exact rewrite.
    private static readonly Regex Parameter = new(@"@\w+", RegexOptions.Compiled);
    private static readonly Regex SystemVariable = new(@"@@(\w+)", RegexOptions.Compiled);
    private static readonly Regex Declare = new(@"\bDECLARE\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex StatementStart = new(@"\G(SELECT|INSERT|UPDATE|DELETE|SET|IF|WHILE|BEGIN|EXEC|EXECUTE|WITH|MERGE|DECLARE|RETURN)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static bool Postgres => typeof(SqlChecks).Assembly.GetName().Name == "Anvil.Core.Odc";

    public static IReadOnlySet<string> Parameters(string statement) => Parameter.Matches(Ignored.Replace(statement, " "))
        .Select(m => m.Value[1..]).ToHashSet(StringComparer.OrdinalIgnoreCase);

    public static void Validate(string statement, IEnumerable<string> declared, string context)
    {
        var names = declared.ToArray();
        if (names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != names.Length)
            throw new InvalidOperationException($"logic: {context}: duplicate SQL parameter names (case-insensitive)");
        var used = Parameters(statement);
        var known = names.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var missing = used.Except(known, StringComparer.OrdinalIgnoreCase).OrderBy(x => x, StringComparer.Ordinal).ToArray();
        var unused = known.Except(used, StringComparer.OrdinalIgnoreCase).OrderBy(x => x, StringComparer.Ordinal).ToArray();
        if (missing.Length == 0 && unused.Length == 0) return;
        // @@X and DECLARE @x are not node parameters the job forgot: the Studio refuses them in any SQL node, so the refusal
        // names the rewrite instead of asking for a parameter that would not help.
        var code = Ignored.Replace(statement, " ");
        var system = SystemVariables(code); var locals = Locals(code);
        var reasons = new List<string>();
        foreach (var name in missing.Where(system.Contains)) reasons.Add(SystemVariableFix(name, Postgres));
        var variables = missing.Where(n => !system.Contains(n) && locals.Contains(n)).ToArray();
        if (variables.Length > 0) reasons.Add(VariableFix(variables, Postgres));
        var plain = missing.Where(n => !system.Contains(n) && !locals.Contains(n)).ToArray();
        if (plain.Length > 0 || unused.Length > 0)
            reasons.Add($"SQL parameters mismatch; used but not declared: {string.Join(", ", plain)}; declared but not used: {string.Join(", ", unused)}. Align statement @parameters and params {{type,value}}.");
        throw new InvalidOperationException($"logic: {context}: {string.Join(" ", reasons)}");
    }

    /// <summary>The fix of a @@ system function, which the Studio reads as a parameter named after it.</summary>
    public static string SystemVariableFix(string name, bool postgres)
    {
        var upper = name.ToUpperInvariant();
        var head = $"@@{upper} is read by the Studio as a node parameter named {upper} (Verify InvalidSQL_UnknownParam), so a @@ system function cannot be written in an SQL node";
        if (postgres) return head + (upper == "ROWCOUNT"
            ? "; PostgreSQL (ODC) has none either: count the changed rows with WITH changed AS (UPDATE ... RETURNING 1) SELECT COUNT(*) FROM changed."
            : "; PostgreSQL (ODC) has no such variable: compute the value in the query (RETURNING, a CTE or a function).");
        return head + upper switch
        {
            "ROWCOUNT" => ": write CAST(ROWCOUNT_BIG() AS INT), the same count as a function.",
            "IDENTITY" => ": write SCOPE_IDENTITY() (or OUTPUT INSERTED.[Id]).",
            "ERROR" => ": write ERROR_NUMBER() inside BEGIN CATCH.",
            _ =>": use the equivalent function, or pass the value as a node parameter.",
        };
    }

    /// <summary>The fix of T-SQL local variables (DECLARE @x), which the Studio reads as parameters too.</summary>
    public static string VariableFix(IReadOnlyCollection<string> names, bool postgres)
    {
        var list = string.Join(", ", names.Select(n => "@" + n));
        return postgres
            ? $"{list} {(names.Count == 1 ? "is a T-SQL variable" : "are T-SQL variables")} (DECLARE): ODC runs plain PostgreSQL SQL, without variables, and the Studio reads every @name as a node parameter (Verify InvalidSQL_UnknownParam): compute the value in a CTE (WITH x AS (...)) or pass it as a node parameter."
            : $"{list} {(names.Count == 1 ? "is a T-SQL variable" : "are T-SQL variables")} (DECLARE): the Studio reads every @name as a node parameter (Verify InvalidSQL_UnknownParam), so an SQL node cannot hold T-SQL variables or table variables: compute the value inline, in a derived table or a CTE (WITH x AS (...)), or pass it as a node parameter.";
    }

    private static HashSet<string> SystemVariables(string code)
        => SystemVariable.Matches(code).Select(m => m.Groups[1].Value).ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>Names declared by DECLARE in the statement: every top-level @name of the declaration list, up to the ';'
    /// or the next statement keyword ("@x INT = @Param" declares x, not Param).</summary>
    private static HashSet<string> Locals(string code)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match declare in Declare.Matches(code))
        {
            var start = declare.Index + declare.Length; var depth = 0; var end = start;
            for (; end < code.Length; end++)
            {
                var c = code[end];
                if (c == '(') depth++;
                else if (c == ')') depth--;
                else if (depth == 0 && c == ';') break;
                else if (depth == 0 && char.IsLetter(c) && !(char.IsLetterOrDigit(code[end - 1]) || code[end - 1] is '_' or '@' or '#' or '.' or '[')
                    && StatementStart.IsMatch(code, end))
                    break;
            }
            var list = new System.Text.StringBuilder(); depth = 0;
            foreach (var c in code[start..end]) { if (c == '(') depth++; else if (c == ')') depth--; else if (depth == 0) list.Append(c); }
            foreach (var part in list.ToString().Split(','))
                if (Regex.Match(part, @"^\s*@(\w+)") is { Success: true } name) names.Add(name.Groups[1].Value);
        }
        return names;
    }
}
