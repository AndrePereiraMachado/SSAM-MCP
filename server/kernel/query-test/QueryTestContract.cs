using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SSAM.QueryTesting;

public sealed class QueryTestFailure(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>A deliberately bounded SELECT-only entry, not an arbitrary SQL/Service Center gateway.</summary>
public static class QueryTestContract
{
    public const int MaxRows = 500, MaxBytes = 262144, MaxCellChars = 8192;
    public static string Required(JsonObject r, string name) => r[name]?.GetValue<string>() is { Length: > 0 } s
        ? s : throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", name + " is required");
    public static int Integer(JsonObject r, string name, int fallback, int min, int max)
    {
        var n = r[name]?.GetValue<int>() ?? fallback;
        if (n < min || n > max) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", $"{name} must be {min}..{max}");
        return n;
    }
    public static void Validate(JsonObject r)
    {
        var op = Required(r, "op");
        if (op is not ("describe" or "run" or "status" or "cancel")) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "Unknown op");
        if (op is "run" or "status" or "cancel")
            if (!Guid.TryParse(Required(r, "operationId"), out _)) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "operationId must be a UUID");
        if (op is "status" or "cancel") return;
        if (Required(r, "lane") is not ("o11" or "odc")) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "lane must be o11 or odc");
        var file = Required(r, "source");
        if (!Path.IsPathFullyQualified(file) || !file.EndsWith(".oml", StringComparison.OrdinalIgnoreCase)) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "source must be an absolute .oml capture/candidate path");
        if (!Regex.IsMatch(Required(r, "expectedSourceSha256"), "^[a-fA-F0-9]{64}$")) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "expectedSourceSha256 is required");
        Required(r, "moduleKey");
        if (!Required(r, "query").StartsWith('@') || r["query"]!.ToString().Length < 2) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "query must be @key from this capture");
        if (!Regex.IsMatch(Required(r, "environment"), @"^[a-zA-Z0-9][a-zA-Z0-9.-]*$")) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "environment must be the connected bare host");
        Integer(r, "maxRows", 100, 1, MaxRows); Integer(r, "timeoutSeconds", 30, 1, 120);
        if (r["testValues"] is not (null or JsonObject)) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "testValues must be an object of scalar values");
        if (op == "run" && r["testValues"] is null) throw new QueryTestFailure("QUERY_TEST_BAD_ARGS", "testValues is required, including {} when the query has no parameters");
        if (op == "run" && r["lane"]!.ToString() == "o11") Integer(r, "o11TenantId", -1, 0, int.MaxValue);
    }

    // Values are literals, never runtime expressions. Numeric identifiers stay lossless strings.
    public static string Literal(JsonNode? value, string type)
    {
        if (value is null || value is JsonObject or JsonArray) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Supply an explicit scalar test value for " + type);
        var text = value.ToString();
        if (text.Length > MaxCellChars) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Test value is too long");
        if (type.Contains("Identifier", StringComparison.OrdinalIgnoreCase) || type is "Integer" or "Long Integer" or "Decimal" or "Currency")
        {
            if (!Regex.IsMatch(text, @"^-?\d+(\.\d+)?$")) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Expected numeric literal for " + type);
            if ((type.Contains("Identifier", StringComparison.OrdinalIgnoreCase) || type is "Integer" or "Long Integer") && text.Contains('.')) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Expected integer literal");
            return text;
        }
        if (type == "Boolean") return text.ToLowerInvariant() switch { "true" => "True", "false" => "False", _ => throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Expected Boolean") };
        if (type is "Date" or "Date Time" or "Time")
        {
            string[] formats = type == "Date" ? ["yyyy-MM-dd"] : type == "Time" ? ["HH:mm:ss"] : ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss"];
            if (!DateTime.TryParseExact(text, formats, CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Expected ISO literal for " + type + " without timezone");
            return "#" + text.Replace('T', ' ') + "#";
        }
        if (type is "Text" or "Email" or "Phone Number") return "\"" + text.Replace("\"", "\"\"") + "\"";
        throw new QueryTestFailure("QUERY_TEST_PARAMETER_TYPE", "Test values of type " + type + " are not supported; no default or runtime expression was used");
    }

    private static readonly HashSet<string> Forbidden = new(("INSERT UPDATE DELETE MERGE UPSERT INTO CREATE ALTER DROP TRUNCATE GRANT REVOKE DENY EXEC EXECUTE CALL DO DECLARE SET COMMIT ROLLBACK SAVE COPY VACUUM ANALYZE ATTACH DETACH PRAGMA LOAD LOCK FOR OPENROWSET OPENQUERY OPENDATASOURCE NEXTVAL SETVAL PG_SLEEP PG_ADVISORY_LOCK DBLINK LO_IMPORT LO_EXPORT OUTFILE DUMPFILE XP_CMDSHELL").Split(' '), StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<string> Functions = new(("COUNT SUM MIN MAX AVG COALESCE NULLIF ISNULL CAST CONVERT TRY_CAST TRY_CONVERT ABS ROUND FLOOR CEILING CEIL POWER SQRT SIGN MOD LENGTH LEN LOWER UPPER TRIM LTRIM RTRIM SUBSTRING SUBSTR LEFT RIGHT REPLACE CONCAT CONCAT_WS CHARINDEX STRPOS POSITION EXTRACT DATE_PART DATE_TRUNC DATEADD DATEDIFF DATEPART DATENAME GETDATE GETUTCDATE NOW TO_CHAR TO_DATE TO_NUMBER FORMAT IIF ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE LAST_VALUE STRING_AGG CURRENT_TIMESTAMP GETDATE YEAR MONTH DAY EOMONTH IN EXISTS OVER AS SELECT FROM JOIN WHERE AND OR NOT ON HAVING WHEN THEN ELSE END DISTINCT ALL TOP PARTITION BY GROUP ORDER VALUES DECIMAL NUMERIC VARCHAR NVARCHAR CHAR NCHAR INT INTEGER BIGINT SMALLINT FLOAT REAL DOUBLE TIMESTAMP DATE TIME BOOLEAN TEXT").Split(' '), StringComparer.OrdinalIgnoreCase);

    /// <summary>Lex a conservative read subset. Unknown/qualified/quoted function calls and inline SQL refuse.
    /// This is an effects guard, not a SQL validity verdict; invalid SELECTs still reach native TestQuery.</summary>
    public static void RequireReadSql(string sql)
    {
        var tokens = new List<string>();
        for (var i = 0; i < sql.Length;)
        {
            var c = sql[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (i + 1 < sql.Length && sql[i..(i + 2)] == "--") { while (i < sql.Length && sql[i] != '\n') i++; continue; }
            if (i + 1 < sql.Length && sql[i..(i + 2)] == "/*")
            {
                var depth = 1; i += 2;
                while (i < sql.Length && depth > 0) { if (i + 1 < sql.Length && sql[i..(i + 2)] == "/*") { depth++; i += 2; } else if (i + 1 < sql.Length && sql[i..(i + 2)] == "*/") { depth--; i += 2; } else i++; }
                if (depth > 0) Refuse("Unclosed comment"); continue;
            }
            if (c is '\'' or '"' or '[' or '{')
            {
                var end = c == '[' ? ']' : c == '{' ? '}' : c; var closed = false; i++;
                while (i < sql.Length) { if (sql[i++] != end) continue; if (i < sql.Length && sql[i] == end && c != '{') { i++; continue; } closed = true; break; }
                if (!closed) Refuse("Unclosed literal/identifier");
                tokens.Add(c == '\'' ? "literal" : "quoted"); continue;
            }
            if (char.IsLetter(c) || c is '_' or '@') { var start = i++; while (i < sql.Length && (char.IsLetterOrDigit(sql[i]) || sql[i] is '_' or '@')) i++; tokens.Add(sql[start..i]); continue; }
            if (c is '$' or '`' or '\\' or ':' or '#') Refuse("Unsupported SQL token (dynamic/qualified SQL is not accepted)");
            tokens.Add(c.ToString()); i++;
        }
        if (tokens.Count == 0 || !tokens[0].Equals("SELECT", StringComparison.OrdinalIgnoreCase)) Refuse("Only a single SELECT is supported; CTEs and SQL with effects require a separately authorized platform workflow");
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (Forbidden.Contains(t) || t.StartsWith("@@") || t == ";" && i != tokens.Count - 1 || t == "=" && i > 0 && tokens[i - 1].StartsWith('@')) Refuse("SQL effects or multiple statements are not supported: " + t);
            if (i + 1 < tokens.Count && tokens[i + 1] == "(" && (t == "quoted" || Regex.IsMatch(t, @"^[A-Za-z_@]")) && (!Functions.Contains(t) || i > 0 && tokens[i - 1] == ".")) Refuse("Unqualified allowlisted read functions only: " + t);
        }
    }
    private static void Refuse(string message) => throw new QueryTestFailure("QUERY_TEST_EFFECTS_UNSUPPORTED", message);

    public static JsonObject Failure(Exception error, bool sent = false)
    {
        while (error is System.Reflection.TargetInvocationException { InnerException: not null } e) error = e.InnerException!;
        return new JsonObject { ["ok"] = false, ["code"] = error is QueryTestFailure q ? q.Code : sent ? "QUERY_TEST_NATIVE_ERROR" : "QUERY_TEST_PREPARATION_FAILED", ["error"] = error.Message,
            ["execution"] = sent ? "uncertain" : "not-sent", ["next"] = sent ? "Read status with this operationId; never replay an uncertain request." : "Correct the named argument/model prerequisite; describe lists the exact query parameters." };
    }
}
