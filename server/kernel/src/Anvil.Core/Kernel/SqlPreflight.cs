using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// Headless SQL preflight: every SQL a job carries (logic "get" with sql:true, a raw ISQLNode created by the job, a raw
/// `set ... Statement` on an existing node) is read before any model is loaded. It refuses, with op index, SQL line and
/// reason, what the Studio's TrueChange lets through and only the server compilation or the database refuses, plus what
/// the job itself contradicts (entities, attributes and parameters it declares). Names the job cannot decide alone
/// (entities/attributes of the base, parameters of an SQL node that already exists) go to `unresolved`, which
/// <see cref="CheckBase"/> resolves against the loaded base before the first mutation.
/// The lexical, entity, parameter, type and grammar checks run in both lanes; the SQL Server rules (dialect of O11 in the
/// cloud) run only in the O11 lane and the PostgreSQL rules (dialect of ODC) only in the ODC lane.
/// </summary>
public static class SqlPreflight
{
    public enum Kind { Word, Entity, Bracket, Quoted, Text, Param, Number, Symbol }
    /// <summary>A token; <paramref name="Value"/> is the content of a string literal (Text), null otherwise.</summary>
    public readonly record struct Token(Kind Kind, string Text, int Line, string? Value = null);
    /// <summary>Declared type of an attribute (null: unknown here); Base: the attribute belongs to the base module.</summary>
    private readonly record struct AttributeInfo(string? Type, bool Base);

    private sealed class Param { public required string Name; public string? Type; public bool ExpandInline; }
    private sealed class Entity
    {
        public required string Name; public required string Type;
        // null: the attribute set is not known here (referenced or renamed entity).
        public Dictionary<string, string?>? Attributes = new(StringComparer.OrdinalIgnoreCase);
    }
    private sealed class SqlUse
    {
        public int Op; public required string Where; public string? Statement;
        public Dictionary<string, Param> Params = new(StringComparer.OrdinalIgnoreCase);
        public bool ParamsChecked = true;   // false: the logic compiler already compares used/declared (SqlChecks)
        public bool ParamsUnknown;          // copied from a source node: parameters are not visible here
        public string? Existing;            // reference of an SQL node that is not created by this job
        public HashSet<string> Removed = new(StringComparer.OrdinalIgnoreCase);
    }

    private static readonly HashSet<string> Starters = new(StringComparer.OrdinalIgnoreCase) {
        "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "DECLARE", "SET", "IF", "WHILE", "BEGIN", "EXEC", "EXECUTE",
        "TRUNCATE", "CREATE", "DROP", "ALTER", "PRINT", "RETURN", "THROW", "RAISERROR", "GRANT", "REVOKE", "DENY", "OPEN", "FETCH",
        "CLOSE", "DEALLOCATE", "COMMIT", "ROLLBACK", "SAVE", "WAITFOR", "GOTO", "BREAK", "CONTINUE" };
    private static readonly Dictionary<string, string> Foreign = new(StringComparer.OrdinalIgnoreCase) {
        ["NOW"] = "GETDATE()", ["CURDATE"] = "CAST(GETDATE() AS date)", ["CURTIME"] = "CAST(GETDATE() AS time)",
        ["IFNULL"] = "ISNULL or COALESCE", ["NVL"] = "ISNULL or COALESCE", ["LENGTH"] = "LEN", ["CHAR_LENGTH"] = "LEN",
        ["SUBSTR"] = "SUBSTRING", ["INSTR"] = "CHARINDEX", ["LOCATE"] = "CHARINDEX", ["UCASE"] = "UPPER", ["LCASE"] = "LOWER",
        ["GROUP_CONCAT"] = "STRING_AGG", ["LISTAGG"] = "STRING_AGG", ["TO_CHAR"] = "FORMAT or CONVERT", ["TO_DATE"] = "CONVERT or TRY_CONVERT",
        ["TO_NUMBER"] = "CAST or TRY_CAST", ["DATE_FORMAT"] = "FORMAT", ["STR_TO_DATE"] = "CONVERT", ["DATE_ADD"] = "DATEADD",
        ["DATE_SUB"] = "DATEADD with a negative number", ["ADDDATE"] = "DATEADD", ["DATE_TRUNC"] = "DATETRUNC (SQL Server 2022) or CAST",
        ["RANDOM"] = "NEWID() or RAND()", ["REGEXP_LIKE"] = "LIKE or PATINDEX" };
    private static readonly HashSet<string> PgTypes = new(StringComparer.OrdinalIgnoreCase) {
        "int", "int4", "int8", "integer", "bigint", "smallint", "text", "varchar", "char", "date", "timestamp", "timestamptz",
        "numeric", "decimal", "boolean", "bool", "float", "float8", "real", "uuid", "json", "jsonb", "interval", "time" };
    // SQL Server functions PostgreSQL does not have (none of these names is a PostgreSQL built-in), with the replacement.
    private static readonly Dictionary<string, string> SqlServerOnly = new(StringComparer.OrdinalIgnoreCase) {
        ["ISNULL"] = "COALESCE(x, fallback)", ["GETDATE"] = "NOW() or CURRENT_TIMESTAMP", ["GETUTCDATE"] = "NOW() AT TIME ZONE 'UTC'",
        ["SYSDATETIME"] = "CLOCK_TIMESTAMP() or NOW()", ["SYSUTCDATETIME"] = "NOW() AT TIME ZONE 'UTC'", ["SYSDATETIMEOFFSET"] = "NOW()",
        ["LEN"] = "LENGTH", ["DATALENGTH"] = "OCTET_LENGTH", ["DATEADD"] = "x + INTERVAL '1 day' or x + MAKE_INTERVAL(days => n)",
        ["DATEDIFF"] = "a subtraction (b - a), DATE_PART or EXTRACT(EPOCH FROM b - a)", ["DATEPART"] = "EXTRACT(field FROM x) or DATE_PART('field', x)",
        ["DATENAME"] = "TO_CHAR(x, 'Month')", ["EOMONTH"] = "(DATE_TRUNC('month', x) + INTERVAL '1 month - 1 day')::date",
        ["DATEFROMPARTS"] = "MAKE_DATE(y, m, d)", ["DATETIMEFROMPARTS"] = "MAKE_TIMESTAMP(y, m, d, h, mi, s)",
        ["YEAR"] = "EXTRACT(YEAR FROM x)", ["MONTH"] = "EXTRACT(MONTH FROM x)", ["DAY"] = "EXTRACT(DAY FROM x)",
        ["NEWID"] = "GEN_RANDOM_UUID()", ["CHARINDEX"] = "STRPOS(text, part) or POSITION(part IN text)",
        ["PATINDEX"] = "a regular expression (~ or SUBSTRING(x FROM pattern))", ["IIF"] = "CASE WHEN ... THEN ... ELSE ... END", ["CHOOSE"] = "CASE",
        ["TRY_CAST"] = "CAST (PostgreSQL has no TRY_ form; validate the input first)", ["TRY_CONVERT"] = "CAST (PostgreSQL has no TRY_ form; validate the input first)",
        ["TRY_PARSE"] = "CAST (PostgreSQL has no TRY_ form; validate the input first)", ["PARSE"] = "CAST or TO_DATE/TO_NUMBER",
        ["STUFF"] = "OVERLAY(x PLACING y FROM start FOR length)", ["REPLICATE"] = "REPEAT", ["SPACE"] = "REPEAT(' ', n)",
        ["ISDATE"] = "a regular expression test (~) before the cast", ["ISNUMERIC"] = "a regular expression test (x ~ '^[0-9]+$')",
        ["SCOPE_IDENTITY"] = "INSERT ... RETURNING the identifier", ["SQUARE"] = "POWER(x, 2)", ["RAND"] = "RANDOM()",
        ["STRING_SPLIT"] = "STRING_TO_ARRAY or REGEXP_SPLIT_TO_TABLE" };
    // SQL Server types PostgreSQL does not have (a cast to them fails with "type ... does not exist").
    private static readonly Dictionary<string, string> SqlServerTypes = new(StringComparer.OrdinalIgnoreCase) {
        ["NVARCHAR"] = "VARCHAR or TEXT", ["NTEXT"] = "TEXT", ["DATETIME"] = "TIMESTAMP", ["DATETIME2"] = "TIMESTAMP", ["SMALLDATETIME"] = "TIMESTAMP",
        ["DATETIMEOFFSET"] = "TIMESTAMPTZ", ["TINYINT"] = "SMALLINT", ["UNIQUEIDENTIFIER"] = "UUID", ["VARBINARY"] = "BYTEA", ["IMAGE"] = "BYTEA" };
    // First argument of the T-SQL CONVERT(type, x); PostgreSQL's convert(bytea, name, name) never takes a type there.
    private static readonly HashSet<string> ConvertTypes = new(SqlServerTypes.Keys.Concat(new[] {
        "VARCHAR", "CHAR", "NCHAR", "INT", "INTEGER", "BIGINT", "SMALLINT", "DECIMAL", "NUMERIC", "FLOAT", "REAL", "BIT", "MONEY", "DATE", "TIME", "TEXT" }),
        StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<string> TableHints = new(StringComparer.OrdinalIgnoreCase) {
        "NOLOCK", "READUNCOMMITTED", "READCOMMITTED", "REPEATABLEREAD", "SERIALIZABLE", "UPDLOCK", "ROWLOCK", "PAGLOCK", "TABLOCK",
        "TABLOCKX", "HOLDLOCK", "XLOCK", "READPAST", "NOEXPAND", "INDEX", "FORCESEEK", "FORCESCAN" };
    private static readonly HashSet<string> QueryHints = new(StringComparer.OrdinalIgnoreCase) {
        "RECOMPILE", "MAXDOP", "OPTIMIZE", "FAST", "FORCE", "HASH", "LOOP", "KEEPFIXED", "KEEP", "MAXRECURSION", "ROBUST", "EXPAND", "USE", "QUERYTRACEON" };
    // Words after which '[' cannot open a PostgreSQL array subscript: a bracket there is SQL Server identifier quoting.
    private static readonly HashSet<string> NoSubscriptAfter = new(StringComparer.OrdinalIgnoreCase) {
        "SELECT", "DISTINCT", "ALL", "AS", "SET", "BY", "ON", "WHERE", "AND", "OR", "NOT", "FROM", "JOIN", "WHEN", "THEN", "ELSE",
        "RETURNING", "INTO", "VALUES", "HAVING", "UPDATE", "IN", "LIKE", "ILIKE", "IS", "BETWEEN", "CASE", "USING", "TABLE" };
    private static readonly System.Text.RegularExpressions.Regex DollarTag = new(@"\G\$([A-Za-z_][A-Za-z0-9_]*)?\$");
    private static readonly HashSet<string> Comparisons = new() { "=", "<>", "!=", "<", ">", "<=", ">=", "!<", "!>" };
    // SQL Server @@ system functions; in PostgreSQL '@@' is also the text search operator, so only these names are refused there.
    private static readonly HashSet<string> SqlServerSystemVariables = new(StringComparer.OrdinalIgnoreCase) {
        "ROWCOUNT", "IDENTITY", "ERROR", "TRANCOUNT", "FETCH_STATUS", "SPID", "VERSION", "SERVERNAME", "SERVICENAME", "DATEFIRST",
        "LANGUAGE", "LANGID", "NESTLEVEL", "PROCID", "OPTIONS", "LOCK_TIMEOUT", "TEXTSIZE", "DBTS", "CURSOR_ROWS", "MAX_PRECISION",
        "MAX_CONNECTIONS", "REMSERVER", "CONNECTIONS", "CPU_BUSY", "IDLE", "IO_BUSY", "TIMETICKS", "TOTAL_ERRORS", "TOTAL_READ",
        "TOTAL_WRITE", "PACKET_ERRORS", "PACK_RECEIVED", "PACK_SENT", "MICROSOFTVERSION" };
    private static readonly string[] ClauseEnds = ["FROM", "WHERE", "GROUP", "ORDER", "HAVING", "UNION", "EXCEPT", "INTERSECT"];

    public static string Dialect => MessageExpectations.Lane == "odc" ? "odc" : "sqlserver";

    /// <summary>Errors (op #, line, reason) and the names left for <see cref="CheckBase"/>.</summary>
    public static JsonObject Analyze(JsonArray source, string? dialect = null)
    {
        dialect ??= Dialect;
        var errors = new JsonArray(); var unresolved = new JsonArray();
        var ops = new List<(JsonObject Op, int Source)>();
        var uses = new List<SqlUse>();
        for (var i = 0; i < source.Count; i++)
        {
            if (source[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString();
            try
            {
                if (kind == "spec") ops.AddRange(SpecExpander.Expand(op["data"]!.AsObject()).Select(o => (o, i)));
                else if (kind == "logic") Logic(op["data"] as JsonObject, i, uses);
                else ops.Add((op, i));
            }
            catch { /* JobPreflight reports shape errors. */ }
        }

        var entities = new Dictionary<string, Entity>(StringComparer.OrdinalIgnoreCase);
        var entityAlias = new Dictionary<string, Entity>(StringComparer.Ordinal);
        var attributeAlias = new Dictionary<string, (Entity? Owner, string? BaseEntity, string Name)>(StringComparer.Ordinal);
        var baseAdditions = new Dictionary<string, Dictionary<string, string?>>(StringComparer.OrdinalIgnoreCase);
        var renamed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var nodes = new Dictionary<string, SqlUse>(StringComparer.Ordinal);
        var paramAlias = new Dictionary<string, (SqlUse Node, string Name)>(StringComparer.Ordinal);
        var existing = new Dictionary<string, SqlUse>(StringComparer.Ordinal);
        // `duplicate` names its copy with the platform suffix, unknown here: names absent from the job are then not sent
        // to the base check (the copy is not in the base either), and Verify judges them after the apply.
        var duplicates = ops.Any(o => o.Op["op"]?.ToString() == "duplicate");

        string? BaseEntityOf(string reference)
        {
            var colon = reference.IndexOf(':');
            if (colon <= 0 || !reference[..colon].Contains("Entity", StringComparison.Ordinal) || reference.Contains('/')) return null;
            return reference[(colon + 1)..];
        }
        SqlUse Existing(string target)
        {
            if (!existing.TryGetValue(target, out var use))
                existing[target] = use = new SqlUse { Where = target, Existing = target };
            return use;
        }
        SqlUse? Node(string reference) => nodes.GetValueOrDefault(reference);
        (SqlUse Node, string Name)? ParamOf(string reference)
        {
            if (paramAlias.TryGetValue(reference, out var p)) return p;
            var slash = reference.LastIndexOf('/');
            if (slash <= 0) return null;
            var owner = reference[..slash]; var name = reference[(slash + 1)..];
            if (Node(owner) is { } node) return (node, name);
            return null;
        }

        foreach (var (op, origin) in ops)
        {
            var verb = op["op"]?.ToString();
            if (verb == "create")
            {
                var type = op["type"]?.ToString() ?? ""; var name = op["name"]?.ToString(); var alias = op["as"]?.ToString();
                var parent = op["parent"]?.ToString() ?? "";
                if (type is "IServerEntity" or "IStaticEntity" or "IClientEntity" && name != null)
                {
                    // A copy (source) brings attributes this reading does not see.
                    var e = new Entity { Name = name, Type = type, Attributes = op["source"] != null ? null : new(StringComparer.OrdinalIgnoreCase) };
                    entities[name] = e;
                    if (alias != null) entityAlias[alias] = e;
                }
                else if (type.EndsWith("Attribute", StringComparison.Ordinal) && name != null && (entityAlias.TryGetValue(parent, out var owner) || BaseEntityOf(parent) != null))
                {
                    var baseEntity = owner == null ? BaseEntityOf(parent) : null;
                    if (owner?.Attributes != null) owner.Attributes[name] = null;
                    if (baseEntity != null)
                    {
                        if (entities.TryGetValue(baseEntity, out var known)) { known.Attributes?.TryAdd(name, null); owner = known; baseEntity = null; }
                        else { if (!baseAdditions.TryGetValue(baseEntity, out var added)) baseAdditions[baseEntity] = added = new(StringComparer.OrdinalIgnoreCase); added[name] = null; }
                    }
                    if (alias != null) attributeAlias[alias] = (owner, baseEntity, name);
                }
                else if (type == "ISQLNode")
                {
                    var use = new SqlUse { Op = origin, Where = $"ISQLNode '{name ?? alias ?? "?"}'", ParamsUnknown = op["source"] != null };
                    if (alias != null) nodes[alias] = use;
                    if (name != null && parent != "") nodes[parent + "/" + name] = use;
                    uses.Add(use);
                }
                else if (type == "ISQLInputParameter" && name != null)
                {
                    var use = Node(parent) ?? Existing(parent);
                    use.Params[name] = new Param { Name = name };
                    use.Removed.Remove(name);
                    if (alias != null) paramAlias[alias] = (use, name);
                    else if (use.Existing != null) paramAlias[parent + "/" + name] = (use, name);
                }
            }
            else if (verb == "set")
            {
                var target = op["target"]?.ToString() ?? ""; var prop = op["prop"]?.ToString() ?? ""; var value = op["value"];
                if (prop.Equals("Statement", StringComparison.OrdinalIgnoreCase) && value is JsonValue v && v.TryGetValue<string>(out var statement))
                {
                    var use = Node(target) ?? Existing(target);
                    use.Statement = statement; use.Op = origin;
                }
                else if (prop == "DataType" && value != null)
                {
                    if (attributeAlias.TryGetValue(target, out var attribute))
                    {
                        if (attribute.Owner?.Attributes != null) attribute.Owner.Attributes[attribute.Name] = value.ToString();
                        else if (attribute.BaseEntity != null) baseAdditions[attribute.BaseEntity][attribute.Name] = value.ToString();
                    }
                    else if ((paramAlias.TryGetValue(target, out var p) ? p : ParamOf(target)) is { } param && param.Node.Params.TryGetValue(param.Name, out var declared))
                        declared.Type = value.ToString();
                }
                else if (prop == "ExpandInline" && ((paramAlias.TryGetValue(target, out var p) ? p : ParamOf(target)) is { } param) && param.Node.Params.TryGetValue(param.Name, out var declared))
                    declared.ExpandInline = value?.ToString().Equals("true", StringComparison.OrdinalIgnoreCase) == true;
            }
            else if (verb == "delete")
            {
                var target = op["target"]?.ToString() ?? "";
                if ((paramAlias.TryGetValue(target, out var p) ? p : ParamOf(target)) is { } param) { param.Node.Params.Remove(param.Name); paramAlias.Remove(target); }
                else
                {
                    var slash = target.LastIndexOf('/');
                    if (slash > 0) Existing(target[..slash]).Removed.Add(target[(slash + 1)..]);
                }
            }
            else if (verb == "rename" && op["name"]?.ToString() is { } newName)
            {
                // The platform rewrites the SQL that consumes a renamed element, so a statement may carry the old name
                // (set before the rename) or the new one (set after): both stay valid for this reading.
                var target = op["target"]?.ToString() ?? "";
                if (entityAlias.TryGetValue(target, out var e) || BaseEntityOf(target) is { } byName && entities.TryGetValue(byName, out e)) entities[newName] = e;
                else if (attributeAlias.TryGetValue(target, out var a) && a.Owner?.Attributes != null)
                {
                    a.Owner.Attributes[newName] = a.Owner.Attributes.GetValueOrDefault(a.Name); attributeAlias[target] = (a.Owner, null, newName);
                }
                else if (paramAlias.TryGetValue(target, out var p) && p.Node.Params.TryGetValue(p.Name, out var declared))
                {
                    p.Node.Params[newName] = declared; paramAlias[target] = (p.Node, newName);
                }
                else renamed.Add(newName);   // a base element renamed by the job: the new name is not in the base yet
            }
            else if (verb == "reference")
                foreach (var element in op["elements"]?.AsArray() ?? new JsonArray())
                    if (BaseEntityOf(element?.ToString() ?? "") is { } referenced && !entities.ContainsKey(referenced))
                        entities[referenced] = new Entity { Name = referenced, Type = "reference", Attributes = null };
        }
        foreach (var use in existing.Values.Where(u => u.Statement != null)) uses.Add(use);

        var families = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in entities.Values)
            if (e.Attributes?.GetValueOrDefault("Id") is { } idType) families[e.Name] = Family(idType, null);
        string? IdentifierFamily(string entity) => families.TryGetValue(entity, out var f) ? f : null;
        AttributeInfo AttributeOf(string entity, string attribute)
        {
            if (entities.TryGetValue(entity, out var e))
                return e.Type == "IStaticEntity" && attribute.Equals("Is_Active", StringComparison.OrdinalIgnoreCase)
                    ? new("Boolean", false) : new(e.Attributes?.GetValueOrDefault(attribute), false);
            if (renamed.Contains(entity) || renamed.Contains(attribute) || duplicates) return new(null, false);
            if (baseAdditions.TryGetValue(entity, out var added) && added.TryGetValue(attribute, out var type)) return new(type, false);
            return new(null, true);
        }

        foreach (var use in uses.Where(u => u.Statement != null))
        {
            void Error(int line, string reason) => errors.Add($"op #{use.Op} (SQL {use.Where}, line {line}): {reason}");
            var tokens = Tokenize(use.Statement!, Error, postgres: dialect == "odc");
            if (tokens == null) continue;
            if (tokens.Count == 0) { Error(1, "the SQL statement is empty"); continue; }

            // Entities and attributes: {Entity} and {Entity}.[Attribute].
            var reported = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var t = 0; t < tokens.Count; t++)
            {
                if (tokens[t].Kind != Kind.Entity) continue;
                var name = tokens[t].Text; var line = tokens[t].Line;
                string? attribute = t + 2 < tokens.Count && tokens[t + 1].Text == "." && tokens[t + 2].Kind == Kind.Bracket ? tokens[t + 2].Text : null;
                if (attribute != null && t + 4 < tokens.Count && tokens[t + 3].Text == "." && tokens[t + 4].Kind == Kind.Entity)
                    Error(line, $"{{{name}}}.[{attribute}].{{{tokens[t + 4].Text}}} reads like an OutSystems expression; SQL cannot see node outputs or variables: pass the value as an @parameter");
                if (entities.TryGetValue(name, out var e))
                {
                    if (e.Type == "IClientEntity") { if (reported.Add(name)) Error(line, $"{{{name}}} is a Local Storage (client) entity; SQL runs on the server database and cannot read it"); continue; }
                    if (attribute == null || e.Attributes == null || renamed.Contains(attribute)) continue;
                    if (!e.Attributes.ContainsKey(attribute) && !Implicit(e, attribute))
                        Error(line, $"[{attribute}] is not an attribute of {{{name}}}; declared: {string.Join(", ", e.Attributes.Keys.OrderBy(x => x, StringComparer.Ordinal))}");
                    continue;
                }
                if (renamed.Contains(name) || duplicates) continue;
                if (reported.Add(name)) unresolved.Add(new JsonObject { ["kind"] = "entity", ["op"] = use.Op, ["line"] = line, ["where"] = use.Where, ["entity"] = name });
                if (attribute != null && !renamed.Contains(attribute) && !(baseAdditions.TryGetValue(name, out var added) && added.ContainsKey(attribute)))
                    unresolved.Add(new JsonObject { ["kind"] = "attribute", ["op"] = use.Op, ["line"] = line, ["where"] = use.Where, ["entity"] = name, ["attribute"] = attribute });
            }

            // Parameters: @Name used and declared (raw nodes; the logic compiler already compares both sides).
            var locals = Variables(tokens);
            var used = tokens.Where(x => x.Kind == Kind.Param && !locals.Contains(x.Text)).GroupBy(x => x.Text, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Line, StringComparer.OrdinalIgnoreCase);
            if (use.ParamsChecked && !use.ParamsUnknown)
            {
                if (use.Existing == null)
                {
                    foreach (var (name, line) in used)
                        if (!use.Params.ContainsKey(name))
                            Error(line, $"@{name} is used but the SQL node declares no parameter '{name}'" + (use.Params.Count == 0 ? "" : $" (declared: {string.Join(", ", use.Params.Keys)})") + "; create the ISQLInputParameter or fix the name");
                }
                else
                {
                    var missing = used.Where(u => !use.Params.ContainsKey(u.Key)).ToArray();
                    if (missing.Length > 0)
                        unresolved.Add(new JsonObject
                        {
                            ["kind"] = "parameters", ["op"] = use.Op, ["line"] = missing[0].Value, ["where"] = use.Where, ["target"] = use.Existing,
                            ["parameters"] = new JsonArray(missing.Select(m => (JsonNode)new JsonObject { ["name"] = m.Key, ["line"] = m.Value }).ToArray()),
                            ["removed"] = new JsonArray(use.Removed.Select(r => (JsonNode)r).ToArray())
                        });
                }
            }
            foreach (var p in use.Params.Values.Distinct().Where(p => p.ExpandInline && p.Type != null && Family(p.Type, null) != "text"))
                Error(used.GetValueOrDefault(p.Name, 1), $"@{p.Name} has Expand Inline but DataType '{p.Type}'; an inline parameter is SQL text, declare it as Text");

            // T-SQL the Studio itself refuses in an SQL node: it reads every @name as a node parameter, @@ROWCOUNT included
            // (Verify InvalidSQL_UnknownParam 'ROWCOUNT'), and so are DECLARE @x and DECLARE @t TABLE. Refused here, before
            // any model change, with the rewrite. A name the node declares as a parameter (the Expand Inline "SqlSymbol"
            // pattern of a variable) is the node's own and passes.
            foreach (var system in tokens.Where(x => x.Kind == Kind.Word && x.Text.StartsWith("@@", StringComparison.Ordinal))
                         .GroupBy(x => x.Text[2..], StringComparer.OrdinalIgnoreCase).Select(g => g.First()))
            {
                var name = system.Text[2..];
                if (use.Params.ContainsKey(name) || dialect == "odc" && !SqlServerSystemVariables.Contains(name)) continue;
                Error(system.Line, SqlChecks.SystemVariableFix(name, dialect == "odc"));
            }
            if (dialect == "sqlserver" && use.Existing == null && !use.ParamsUnknown
                && tokens.Where(x => x.Kind == Kind.Param && locals.Contains(x.Text) && !use.Params.ContainsKey(x.Text)).Select(x => x.Text)
                    .Distinct(StringComparer.OrdinalIgnoreCase).ToArray() is { Length: > 0 } variables)
                Error(tokens.First(x => x.Kind == Kind.Word && x.Text.Equals("DECLARE", StringComparison.OrdinalIgnoreCase)).Line, SqlChecks.VariableFix(variables, postgres: false));

            // Types: {Entity}.[Attribute] <comparison> @Param (either side), when both types are declared.
            for (var t = 0; t < tokens.Count; t++)
            {
                if (!Comparison(tokens, t, out var attributeAt, out var paramAt)) continue;
                var entityName = tokens[attributeAt - 2].Text; var attribute = tokens[attributeAt].Text; var param = tokens[paramAt].Text;
                if (!use.Params.TryGetValue(param, out var declared) || declared.Type == null) continue;
                var paramFamily = Family(declared.Type, IdentifierFamily);
                if (paramFamily == null) continue;
                if (entities.TryGetValue(entityName, out var e) && e.Attributes?.GetValueOrDefault(attribute) is { } attributeType)
                {
                    var attributeFamily = Family(attributeType, IdentifierFamily);
                    if (Incompatible(attributeFamily, paramFamily))
                        Error(tokens[paramAt].Line, TypeReason(entityName, attribute, attributeType, param, declared.Type));
                }
                else if (!entities.ContainsKey(entityName) && !renamed.Contains(entityName) && !duplicates)
                    unresolved.Add(new JsonObject { ["kind"] = "comparison", ["op"] = use.Op, ["line"] = tokens[paramAt].Line, ["where"] = use.Where,
                        ["entity"] = entityName, ["attribute"] = attribute, ["param"] = param, ["paramType"] = declared.Type, ["paramFamily"] = paramFamily });
            }

            // An Expand Inline parameter completes the statement at run time: no grammar guesses on it.
            var grammar = !use.Params.Values.Any(p => p.ExpandInline);
            if (dialect == "sqlserver")
                SqlServer(tokens, Error, grammar);
            else if (dialect == "odc")
                Postgres(tokens, Error, AttributeOf, name => use.Params.TryGetValue(name, out var p) ? p.Type : null, item =>
                {
                    item["op"] = use.Op; item["where"] = use.Where;
                    unresolved.Add(item);
                });
            if (grammar) Grammar(tokens, Error, postgres: dialect == "odc");
        }
        return new JsonObject { ["errors"] = errors, ["unresolved"] = unresolved, ["sqlStatements"] = uses.Count(u => u.Statement != null), ["dialect"] = dialect };
    }

    /// <summary>T-SQL local variables (DECLARE @x ..., @y ...): declared by the statement itself, not node parameters.</summary>
    private static HashSet<string> Variables(List<Token> tokens)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var declaring = false; var depth = 0;
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t.Kind == Kind.Word && t.Text.Equals("DECLARE", StringComparison.OrdinalIgnoreCase)) { declaring = true; depth = 0; continue; }
            if (!declaring) continue;
            if (t.Kind == Kind.Symbol && t.Text == "(") depth++;
            else if (t.Kind == Kind.Symbol && t.Text == ")") depth--;
            else if (t.Kind == Kind.Symbol && t.Text == ";" || t.Kind == Kind.Word && Starters.Contains(t.Text) && depth == 0) declaring = false;
            else if (t.Kind == Kind.Param && depth == 0 && i > 0 && (tokens[i - 1].Text == "," || tokens[i - 1].Text.Equals("DECLARE", StringComparison.OrdinalIgnoreCase)))
                names.Add(t.Text);
        }
        return names;
    }

    private static bool Implicit(Entity e, string attribute) =>
        attribute.Equals("TenantId", StringComparison.OrdinalIgnoreCase) ||
        e.Type == "IStaticEntity" && attribute.Equals("Is_Active", StringComparison.OrdinalIgnoreCase);

    /// <summary>{E}.[A] op @P or @P op {E}.[A], with the comparison at <paramref name="t"/>.</summary>
    private static bool Comparison(List<Token> tokens, int t, out int attributeAt, out int paramAt)
    {
        attributeAt = paramAt = -1;
        if (t >= tokens.Count || !(tokens[t].Kind == Kind.Symbol && Comparisons.Contains(tokens[t].Text) || tokens[t].Kind == Kind.Word && tokens[t].Text.Equals("LIKE", StringComparison.OrdinalIgnoreCase))) return false;
        bool AttributeEndsAt(int i) => i >= 2 && tokens[i].Kind == Kind.Bracket && tokens[i - 1].Text == "." && tokens[i - 2].Kind == Kind.Entity;
        if (t >= 1 && AttributeEndsAt(t - 1) && !(t >= 5 && IsArithmetic(tokens[t - 4])) && t + 1 < tokens.Count && tokens[t + 1].Kind == Kind.Param && !(t + 2 < tokens.Count && IsArithmetic(tokens[t + 2])))
        { attributeAt = t - 1; paramAt = t + 1; return true; }
        if (t >= 1 && tokens[t - 1].Kind == Kind.Param && !(t >= 2 && IsArithmetic(tokens[t - 2])) && t + 3 < tokens.Count && AttributeEndsAt(t + 3) && !(t + 4 < tokens.Count && IsArithmetic(tokens[t + 4])))
        { attributeAt = t + 3; paramAt = t - 1; return true; }
        return false;
    }
    private static bool IsArithmetic(Token t) => t.Kind == Kind.Symbol && t.Text is "+" or "-" or "*" or "/" or "%" or "||" or "&" or "|" or "^";

    /// <summary>OutSystems type family: text, number, boolean, datetime, binary; null when not decidable here.</summary>
    public static string? Family(string type, Func<string, string?>? identifier)
    {
        var t = type.Trim();
        if (t.EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase))
        {
            var entity = t[..^" Identifier".Length].Trim();
            if (entity.Equals("User", StringComparison.OrdinalIgnoreCase)) return "number";
            return identifier?.Invoke(entity);
        }
        return t.Replace(" ", "").ToLowerInvariant() switch
        {
            "text" or "string" or "email" or "phonenumber" or "phone" => "text",
            "integer" or "int" or "longinteger" or "long" or "decimal" or "currency" => "number",
            "boolean" or "bool" => "boolean",
            "date" or "time" or "datetime" => "datetime",
            "binarydata" or "binary" => "binary",
            _ => null,
        };
    }

    /// <summary>Pairs that only "work" by an implicit conversion that fails or compares wrongly at run time
    /// (SQL Server) or is refused outright (PostgreSQL in ODC). Number and Boolean (bit) mix legitimately.</summary>
    public static bool Incompatible(string? a, string? b)
    {
        if (a == null || b == null || a == b) return false;
        var pair = new[] { a, b }.OrderBy(x => x, StringComparer.Ordinal).ToArray();
        return !(pair[0] == "boolean" && pair[1] == "number") && !(pair[0] == "datetime" && pair[1] == "text");
    }

    public static string TypeReason(string entity, string attribute, string attributeType, string param, string paramType) =>
        $"{{{entity}}}.[{attribute}] is {attributeType} but @{param} is declared {paramType}; the database converts one side implicitly and fails or compares wrongly at run time. Declare @{param} with the attribute's type, or convert explicitly (CAST/CONVERT).";

    /// <summary>Lexer: OutSystems placeholders ({Entity}, @Param) and the SQL lexical layer. Null after a lexical error.
    /// <paramref name="postgres"/> adds the PostgreSQL literals: E'...' (backslash escapes) and $tag$...$tag$.</summary>
    public static List<Token>? Tokenize(string sql, Action<int, string> error, bool postgres = false)
    {
        var tokens = new List<Token>(); var line = 1; var i = 0; var ok = true;
        var parens = new Stack<(int Line, int At)>();
        while (i < sql.Length)
        {
            var c = sql[i];
            if (c == '\n') { line++; i++; continue; }
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '-' && Peek(1) == '-') { while (i < sql.Length && sql[i] != '\n') i++; continue; }
            if (c == '/' && Peek(1) == '*')
            {
                // SQL Server nests block comments.
                var start = line; var depth = 0;
                while (i < sql.Length)
                {
                    if (sql[i] == '/' && Peek(1) == '*') { depth++; i += 2; continue; }
                    if (sql[i] == '*' && Peek(1) == '/') { depth--; i += 2; if (depth == 0) break; continue; }
                    if (sql[i] == '\n') line++;
                    i++;
                }
                if (depth > 0) { error(start, "unterminated /* comment"); return null; }
                continue;
            }
            if (c == '\'' || (c is 'N' or 'n') && Peek(1) == '\'' || postgres && (c is 'E' or 'e') && Peek(1) == '\'')
            {
                var start = line; var escapes = c is 'E' or 'e'; if (c != '\'') i++; i++;
                var closed = false; var from = i;
                while (i < sql.Length)
                {
                    if (escapes && sql[i] == '\\' && i + 1 < sql.Length) { if (sql[i + 1] == '\n') line++; i += 2; continue; }
                    if (sql[i] == '\'') { if (Peek(1) == '\'') { i += 2; continue; } i++; closed = true; break; }
                    if (sql[i] == '\n') line++;
                    i++;
                }
                if (!closed) { error(start, "unterminated string literal (a ' is not closed; write '' for a quote inside a literal)"); return null; }
                tokens.Add(new Token(Kind.Text, "'", start, sql[from..(i - 1)])); continue;
            }
            if (postgres && c == '$' && DollarTag.Match(sql, i) is { Success: true } tag)
            {
                var start = line; var end = sql.IndexOf(tag.Value, i + tag.Length, StringComparison.Ordinal);
                if (end < 0) { error(start, $"unterminated dollar-quoted string (missing the closing {tag.Value})"); return null; }
                var body = sql[(i + tag.Length)..end];
                line += body.Count(ch => ch == '\n');
                tokens.Add(new Token(Kind.Text, "'", start, body)); i = end + tag.Length; continue;
            }
            if (c is '[' or '"')
            {
                var close = c == '[' ? ']' : '"'; var start = line; var text = new System.Text.StringBuilder(); i++;
                var closed = false;
                while (i < sql.Length)
                {
                    if (sql[i] == close) { if (Peek(1) == close) { text.Append(close); i += 2; continue; } i++; closed = true; break; }
                    if (sql[i] == '\n') line++;
                    text.Append(sql[i]); i++;
                }
                if (!closed) { error(start, c == '[' ? "unterminated [identifier] (missing ])" : "unterminated \"quoted identifier\" (missing \")"); return null; }
                tokens.Add(new Token(c == '[' ? Kind.Bracket : Kind.Quoted, text.ToString(), start)); continue;
            }
            if (c == '{')
            {
                var end = sql.IndexOf('}', i + 1); var newline = sql.IndexOf('\n', i + 1); var reopen = sql.IndexOf('{', i + 1);
                if (end < 0 || newline >= 0 && newline < end || reopen >= 0 && reopen < end) { error(line, "unterminated {Entity} reference (missing })"); return null; }
                var name = sql[(i + 1)..end].Trim();
                if (name.Length == 0 || !name.All(ch => char.IsLetterOrDigit(ch) || ch == '_'))
                { error(line, $"'{{{sql[(i + 1)..end]}}}' is not an entity reference; OutSystems reads {{Name}} as an entity of the module or of its references"); ok = false; }
                tokens.Add(new Token(Kind.Entity, name, line)); i = end + 1; continue;
            }
            if (c == '}') { error(line, "'}' without a matching '{'"); ok = false; i++; continue; }
            if (c == '@')
            {
                var system = Peek(1) == '@';
                var j = i + 1; if (system) j++;
                var start = j; while (j < sql.Length && (char.IsLetterOrDigit(sql[j]) || sql[j] == '_')) j++;
                // @@X is a system function (a word here, with its own rule): the Studio reads it as a parameter named X and its
                // Verify refuses it (InvalidSQL_UnknownParam), so it never counts as a parameter the node forgot.
                if (j > start) { tokens.Add(system ? new Token(Kind.Word, "@@" + sql[start..j], line) : new Token(Kind.Param, sql[start..j], line)); i = j; continue; }
                tokens.Add(new Token(Kind.Symbol, "@", line)); i++; continue;
            }
            if (char.IsDigit(c) || c == '.' && char.IsDigit(Peek(1)))
            {
                var j = i; while (j < sql.Length && (char.IsLetterOrDigit(sql[j]) || sql[j] == '.')) j++;
                tokens.Add(new Token(Kind.Number, sql[i..j], line)); i = j; continue;
            }
            if (char.IsLetter(c) || c is '_' or '#')
            {
                var j = i; while (j < sql.Length && (char.IsLetterOrDigit(sql[j]) || sql[j] is '_' or '#' or '$')) j++;
                tokens.Add(new Token(Kind.Word, sql[i..j], line)); i = j; continue;
            }
            var two = i + 1 < sql.Length ? sql.Substring(i, 2) : "";
            if (two is "<>" or "!=" or "<=" or ">=" or "==" or "&&" or "||" or "::" or "!<" or "!>" or "+=" or "-=" or "*=" or "/=")
            { tokens.Add(new Token(Kind.Symbol, two, line)); i += 2; continue; }
            if (c == '(') parens.Push((line, i));
            if (c == ')' && !parens.TryPop(out _)) { error(line, $"')' without a matching '(' near \"{Near(i)}\""); ok = false; }
            tokens.Add(new Token(Kind.Symbol, c.ToString(), line)); i++;
        }
        foreach (var open in parens.Reverse()) { error(open.Line, $"'(' is never closed near \"{Near(open.At)}\""); ok = false; }
        return ok ? tokens : null;

        char Peek(int offset) => i + offset < sql.Length ? sql[i + offset] : '\0';
        string Near(int at) => System.Text.RegularExpressions.Regex.Replace(sql.Substring(at, Math.Min(40, sql.Length - at)), @"\s+", " ");
    }

    /// <summary>SQL Server (O11 cloud) rules that the Studio does not check; each one is a certain refusal of the database.</summary>
    private static void SqlServer(List<Token> tokens, Action<int, string> error, bool grammar)
    {
        bool Word(int i, params string[] words) => IsWord(tokens, i, words);
        bool Symbol(int i, params string[] symbols) => IsSymbol(tokens, i, symbols);

        var first = tokens.FindIndex(t => !(t.Kind == Kind.Symbol && t.Text is ";" or "("));
        // A statement that starts with a parameter is an inline (Expand Inline) statement of an existing node.
        if (grammar && first >= 0 && tokens[first].Kind != Kind.Param && !(tokens[first].Kind == Kind.Word && Starters.Contains(tokens[first].Text)))
            error(tokens[first].Line, $"the statement starts with '{tokens[first].Text}'; SQL Server expects SELECT, WITH, INSERT, UPDATE, DELETE, MERGE, DECLARE, SET, IF, EXEC...");

        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t.Kind == Kind.Word)
            {
                if (Foreign.TryGetValue(t.Text, out var instead) && Symbol(i + 1, "(") && !Symbol(i - 1, "."))
                    error(t.Line, $"{t.Text.ToUpperInvariant()}() is not a SQL Server function; use {instead}");
                else if (Word(i, "LIMIT") && i + 1 < tokens.Count && tokens[i + 1].Kind is Kind.Number or Kind.Param)
                    error(t.Line, "LIMIT does not exist in SQL Server; use SELECT TOP (n) or ORDER BY ... OFFSET 0 ROWS FETCH NEXT n ROWS ONLY");
                else if (Word(i, "ILIKE"))
                    error(t.Line, "ILIKE does not exist in SQL Server; LIKE already follows the database collation (case-insensitive by default)");
                else if (Word(i, "TRUE", "FALSE") && !Symbol(i - 1, ".") && !Word(i - 1, "AS"))
                    error(t.Line, $"{t.Text.ToUpperInvariant()} is not a literal in SQL Server (it reads as a column name); use 1 or 0 for Boolean (bit) values");
            }
            else if (t.Kind == Kind.Symbol)
            {
                if (t.Text == "::" && i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word && PgTypes.Contains(tokens[i + 1].Text))
                    error(t.Line, $"'::{tokens[i + 1].Text}' is a PostgreSQL cast; SQL Server uses CAST(x AS type) or CONVERT(type, x)");
                else if (t.Text is "==" or "&&")
                    error(t.Line, $"'{t.Text}' is not a SQL operator; use {(t.Text == "==" ? "=" : "AND")}");
                else if (t.Text == "`" && tokens.FindIndex(x => x.Kind == Kind.Symbol && x.Text == "`") == i)
                    error(t.Line, "backticks quote identifiers in MySQL; SQL Server uses [name] (and {Entity}.[Attribute] for the module's data)");
            }
            else if (t.Kind == Kind.Quoted && (Symbol(i - 1, "=", "<>", "!=", "<", ">", "<=", ">=") || Word(i - 1, "LIKE")))
                error(t.Line, $"\"{t.Text}\" is a quoted identifier in SQL Server, not a text literal; use single quotes: '{t.Text}'");
        }

        // ORDER BY inside a subquery, derived table or CTE needs TOP, OFFSET or FOR XML/JSON (SQL Server error 1033).
        var frames = new Stack<(bool Query, bool Limited, int OrderLine)>();
        for (var i = 0; i < tokens.Count; i++)
        {
            if (Symbol(i, "("))
            {
                var window = Word(i - 1, "OVER") || Word(i - 1, "GROUP") && Word(i - 2, "WITHIN");
                frames.Push((!window && Word(i + 1, "SELECT"), false, 0));
                continue;
            }
            if (Symbol(i, ")"))
            {
                if (frames.TryPop(out var frame) && frame.Query && frame.OrderLine > 0 && !frame.Limited)
                    error(frame.OrderLine, "ORDER BY inside a subquery, derived table or CTE is refused by SQL Server (error 1033) unless TOP, OFFSET or FOR XML/JSON is also there; order the outer SELECT instead");
                continue;
            }
            if (frames.Count == 0) continue;
            var top = frames.Pop();
            if (Word(i, "TOP", "OFFSET") || Word(i, "FOR") && Word(i + 1, "XML", "JSON")) top.Limited = true;
            if (Word(i, "ORDER") && Word(i + 1, "BY") && top.OrderLine == 0) top.OrderLine = tokens[i].Line;
            frames.Push(top);
        }

        AggregateArguments(tokens, error, postgres: false);
    }

    private static readonly HashSet<string> Aggregates = new(StringComparer.OrdinalIgnoreCase) { "COUNT", "COUNT_BIG", "SUM", "AVG", "MIN", "MAX", "STRING_AGG" };

    /// <summary>
    /// An aggregate whose argument holds a subquery or another aggregate. SQL Server refuses both when the query runs (error 130,
    /// "Cannot perform an aggregate function on an expression containing an aggregate or a subquery"); the Studio lets it
    /// through. PostgreSQL (ODC) accepts a subquery there (its aggregates belong to the subquery) and refuses only an aggregate
    /// nested at the same query level ("aggregate function calls cannot be nested"). A window aggregate (SUM(COUNT(*)) OVER ())
    /// is valid in both and is left alone. One error per outermost aggregate.
    /// </summary>
    private static void AggregateArguments(List<Token> tokens, Action<int, string> error, bool postgres)
    {
        var close = new Dictionary<int, int>(); var open = new Stack<int>();
        for (var i = 0; i < tokens.Count; i++)
        {
            if (IsSymbol(tokens, i, "(")) open.Push(i);
            else if (IsSymbol(tokens, i, ")") && open.TryPop(out var from)) close[from] = i;
        }
        bool Call(int i, out int end)
        {
            end = -1;
            return tokens[i].Kind == Kind.Word && Aggregates.Contains(tokens[i].Text) && IsSymbol(tokens, i + 1, "(") && !IsSymbol(tokens, i - 1, ".")
                && close.TryGetValue(i + 1, out end) && !IsWord(tokens, end + 1, "OVER");
        }
        for (var i = 0; i < tokens.Count; i++)
        {
            if (!Call(i, out var end)) continue;
            string? inner = null;
            for (var j = i + 2; j < end && inner == null; j++)
            {
                if (IsWord(tokens, j, "SELECT"))
                {
                    if (!postgres) { inner = "a subquery"; break; }
                    // PostgreSQL: the subquery's aggregates are its own; skip to the ')' that closes it.
                    if (IsSymbol(tokens, j - 1, "(") && close.TryGetValue(j - 1, out var subquery)) j = subquery;
                    continue;
                }
                if (Call(j, out _)) inner = "another aggregate (" + tokens[j].Text.ToUpperInvariant() + ")";
            }
            if (inner == null) continue;
            var outer = tokens[i].Text.ToUpperInvariant();
            error(tokens[i].Line, postgres
                ? $"{outer}(...) contains {inner} at the same query level: PostgreSQL (ODC) refuses nested aggregates when the query runs (\"aggregate function calls cannot be nested\"). Compute the inner aggregate in a derived table or CTE (WITH x AS (SELECT key, COUNT(...) AS N FROM ... GROUP BY key)) and aggregate x.N outside"
                : $"SQL Server error 130: {outer}(...) aggregates an expression containing {inner}; SQL Server refuses it when the query runs (\"Cannot perform an aggregate function on an expression containing an aggregate or a subquery\"). Compute the inner value in a derived table or CTE (LEFT JOIN (SELECT key, MAX(...) AS V FROM ... GROUP BY key) x ON x.key = ..., or WITH x AS (...)) and aggregate x.V outside");
            i = end;
        }
    }

    private static bool IsWord(List<Token> tokens, int i, params string[] words) =>
        i >= 0 && i < tokens.Count && tokens[i].Kind == Kind.Word && words.Any(w => w.Equals(tokens[i].Text, StringComparison.OrdinalIgnoreCase));
    private static bool IsSymbol(List<Token> tokens, int i, params string[] symbols) =>
        i >= 0 && i < tokens.Count && tokens[i].Kind == Kind.Symbol && symbols.Contains(tokens[i].Text);

    /// <summary>Grammar gaps refused by SQL Server and by PostgreSQL alike (dangling comma, condition or operand).</summary>
    private static void Grammar(List<Token> tokens, Action<int, string> error, bool postgres)
    {
        bool Word(int i, params string[] words) => IsWord(tokens, i, words);
        bool Symbol(int i, params string[] symbols) => IsSymbol(tokens, i, symbols);
        int Line(int i) => tokens[Math.Clamp(i, 0, tokens.Count - 1)].Line;

        // A trailing ';' does not complete a statement: the end is the last other token.
        var last = tokens.FindLastIndex(t => !(t.Kind == Kind.Symbol && t.Text == ";"));
        var n = last + 1;
        string Describe(int i) => i >= n ? "the end of the statement" : $"'{tokens[i].Text}'";
        for (var i = 0; i < n; i++)
        {
            if (Symbol(i, ",") && (i + 1 >= n || Word(i + 1, ClauseEnds) || Symbol(i + 1, ")", ",")))
                error(Line(i), $"a comma is followed by {Describe(i + 1)}; remove the extra comma");
            else if (Word(i, "SELECT") && Symbol(i + 1, ","))
                error(Line(i), "SELECT is followed by a comma; the first column is missing");
            else if (Word(i, "AND", "OR") && (i + 1 >= n || Word(i + 1, "AND", "OR", "WHERE", "GROUP", "ORDER", "HAVING", "FROM") || Symbol(i + 1, ")")))
                error(Line(i), $"{tokens[i].Text.ToUpperInvariant()} is followed by {Describe(i + 1)}; a condition is missing");
            // ON also ends option statements (SET NOCOUNT ON): only a following AND/OR/clause/')' proves the gap.
            else if (Word(i, "WHERE", "HAVING") && (i + 1 >= n || Word(i + 1, "AND", "OR", "ORDER", "GROUP") || Symbol(i + 1, ")"))
                     || Word(i, "ON") && (Word(i + 1, "AND", "OR", "WHERE", "ORDER", "GROUP") || Symbol(i + 1, ")")))
                error(Line(i), $"{tokens[i].Text.ToUpperInvariant()} is followed by {Describe(i + 1)}; a condition is missing");
            else if (Symbol(i, "(") && Word(i + 1, "AND", "OR"))
                error(Line(i), $"'(' is followed by {tokens[i + 1].Text.ToUpperInvariant()}; a condition is missing");
            // PostgreSQL's ORDER BY x USING > names a sort operator, not a comparison.
            else if (tokens[i].Kind == Kind.Symbol && Comparisons.Contains(tokens[i].Text) && !Word(i - 1, "USING")
                     && (i + 1 >= n || Word(i + 1, "AND", "OR", "WHERE", "ORDER", "GROUP", "FROM", "THEN") || Symbol(i + 1, ")", ",")
                         || Word(i - 1, "WHERE", "AND", "OR", "ON", "HAVING", "SELECT") || Symbol(i - 1, "(", ",")))
                error(Line(i), $"'{tokens[i].Text}' is missing an operand");
        }
        // A bare SELECT is a valid PostgreSQL query (one row, no columns).
        if (Word(last, "FROM", "JOIN", "BY", "SET", "VALUES", "NOT") || !postgres && Word(last, "SELECT"))
            error(tokens[last].Line, $"the statement ends with {tokens[last].Text.ToUpperInvariant()}; it is incomplete");
    }

    /// <summary>
    /// PostgreSQL (ODC) rules: SQL Server constructs the ODC Studio lets through (its SQL check knows entities, attributes
    /// and parameters, not the dialect) and PostgreSQL refuses when the query runs. Only certain refusals: a construct that
    /// may still be valid PostgreSQL (a '[' that can be an array subscript, a '+' between operands of unknown type) is left
    /// alone, and a rule decided by the type of a base attribute goes to `unresolved` for <see cref="CheckBase"/>.
    /// </summary>
    private static void Postgres(List<Token> tokens, Action<int, string> error, Func<string, string, AttributeInfo> attribute,
        Func<string, string?> paramType, Action<JsonObject> open)
    {
        bool Word(int i, params string[] words) => IsWord(tokens, i, words);
        bool Symbol(int i, params string[] symbols) => IsSymbol(tokens, i, symbols);
        bool AttributeEndsAt(int i) => i >= 2 && i < tokens.Count && tokens[i].Kind == Kind.Bracket && tokens[i - 1].Text == "." && tokens[i - 2].Kind == Kind.Entity;
        bool AttributeStartsAt(int i) => i >= 0 && i + 2 < tokens.Count && tokens[i].Kind == Kind.Entity && tokens[i + 1].Text == "." && tokens[i + 2].Kind == Kind.Bracket;
        bool StatementStart(int i) => i == 0 || Symbol(i - 1, ";");
        // Family of {E}.[A] starting at entityAt; a base attribute opens an item that CheckBase decides by its type.
        string? FamilyOf(int entityAt, string kind, string? literal = null)
        {
            var info = attribute(tokens[entityAt].Text, tokens[entityAt + 2].Text);
            if (info.Type != null) return Family(info.Type, null);
            if (info.Base)
            {
                var item = new JsonObject { ["kind"] = kind, ["line"] = tokens[entityAt].Line, ["entity"] = tokens[entityAt].Text, ["attribute"] = tokens[entityAt + 2].Text };
                if (literal != null) item["literal"] = literal;
                open(item);
            }
            return null;
        }
        bool TextParam(int i) => i >= 0 && i < tokens.Count && tokens[i].Kind == Kind.Param && paramType(tokens[i].Text) is { } type && Family(type, null) == "text";
        static bool NotANumberNorInterval(Token t) => t.Kind == Kind.Text && !(t.Value ?? "").Any(char.IsLetterOrDigit);

        var bracketReported = false; var plusReported = false; var declareReported = false;
        var casts = new Stack<bool>();
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (Symbol(i, "(")) casts.Push(Word(i - 1, "CAST"));
            else if (Symbol(i, ")")) casts.TryPop(out _);

            if (t.Kind == Kind.Word)
            {
                if (SqlServerOnly.TryGetValue(t.Text, out var instead) && Symbol(i + 1, "(") && !Symbol(i - 1, "."))
                    error(t.Line, $"{t.Text.ToUpperInvariant()}() is SQL Server; ODC runs SQL on PostgreSQL, which has no such function: use {instead}");
                else if (Word(i, "TOP") && Word(i - 1, "SELECT", "DISTINCT", "ALL", "DELETE", "UPDATE") && (Symbol(i + 1, "(") || i + 1 < tokens.Count && tokens[i + 1].Kind is Kind.Number or Kind.Param))
                    error(t.Line, "TOP does not exist in PostgreSQL (ODC); remove it and end the query with LIMIT n (or FETCH FIRST n ROWS ONLY)");
                else if (Word(i, "CONVERT") && Symbol(i + 1, "(") && i + 2 < tokens.Count && tokens[i + 2].Kind == Kind.Word && ConvertTypes.Contains(tokens[i + 2].Text) && Symbol(i + 3, ",", "("))
                    error(t.Line, $"CONVERT({tokens[i + 2].Text}, x) is SQL Server; PostgreSQL (ODC) uses CAST(x AS type) or x::type");
                else if (Word(i, "AS") && casts.Count > 0 && casts.Peek() && i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word && SqlServerTypes.TryGetValue(tokens[i + 1].Text, out var pgType))
                    error(t.Line, $"{tokens[i + 1].Text.ToUpperInvariant()} is a SQL Server type; PostgreSQL (ODC) has no such type: use {pgType}");
                else if (Word(i, "WITH") && Symbol(i + 1, "(") && i + 2 < tokens.Count && tokens[i + 2].Kind == Kind.Word && TableHints.Contains(tokens[i + 2].Text)
                         || Symbol(i - 1, "(") && TableHints.Contains(t.Text) && Symbol(i + 1, ")") && i >= 2 && tokens[i - 2].Kind == Kind.Entity)
                    error(t.Line, $"table hints (WITH ({(Word(i, "WITH") ? tokens[i + 2].Text : t.Text).ToUpperInvariant()})) are SQL Server; PostgreSQL (ODC) has none (readers do not block writers there): remove it");
                else if (Word(i, "OPTION") && Symbol(i + 1, "(") && i + 2 < tokens.Count && tokens[i + 2].Kind == Kind.Word && QueryHints.Contains(tokens[i + 2].Text))
                    error(t.Line, "OPTION (...) query hints are SQL Server; PostgreSQL (ODC) has none: remove it");
                else if (Word(i, "OUTPUT") && Word(i + 1, "INSERTED", "DELETED") && Symbol(i + 2, "."))
                    error(t.Line, "OUTPUT INSERTED/DELETED is SQL Server; PostgreSQL (ODC) returns rows with RETURNING at the end of INSERT, UPDATE or DELETE");
                else if (Word(i, "CROSS", "OUTER") && Word(i + 1, "APPLY"))
                    error(t.Line, $"{t.Text.ToUpperInvariant()} APPLY is SQL Server; PostgreSQL (ODC) uses {(Word(i, "CROSS") ? "CROSS JOIN LATERAL (...)" : "LEFT JOIN LATERAL (...) ON TRUE")}");
                else if (Word(i, "FOR") && Word(i + 1, "XML", "JSON"))
                    error(t.Line, $"FOR {tokens[i + 1].Text.ToUpperInvariant()} is SQL Server; PostgreSQL (ODC) builds it with {(Word(i + 1, "JSON") ? "JSON_AGG / JSON_BUILD_OBJECT" : "XMLAGG / XMLELEMENT")}");
                else if (Word(i, "WITHIN") && Word(i + 1, "GROUP") && i >= 1 && Symbol(i - 1, ")") && CallNameBefore(tokens, i - 1) is { } aggregate && aggregate.Equals("STRING_AGG", StringComparison.OrdinalIgnoreCase))
                    error(t.Line, "STRING_AGG(...) WITHIN GROUP (ORDER BY ...) is SQL Server; PostgreSQL (ODC) orders inside the call: STRING_AGG(x, ', ' ORDER BY y)");
                else if (Word(i, "DECLARE") && i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Param && !declareReported)
                {
                    declareReported = true;
                    error(t.Line, $"DECLARE @{tokens[i + 1].Text} is a T-SQL variable; ODC runs plain PostgreSQL SQL, without variables: pass the value as a parameter of the node or compute it in a CTE (WITH ... AS)");
                }
                else if (Word(i, "SET") && Word(i + 1, "NOCOUNT"))
                    error(t.Line, "SET NOCOUNT is SQL Server; PostgreSQL (ODC) has no such setting: remove it");
                else if (StatementStart(i) && Word(i, "EXEC", "IF", "WHILE", "PRINT", "RAISERROR", "THROW"))
                    error(t.Line, $"{t.Text.ToUpperInvariant()} is a T-SQL statement; ODC runs plain PostgreSQL SQL (no procedural statements): use CASE, WHERE or a CTE");
                else if (t.Text.StartsWith('#') && t.Text.Length > 1 && Word(i - 1, "FROM", "JOIN", "INTO", "TABLE", "UPDATE"))
                    error(t.Line, $"{t.Text} is a SQL Server temporary table; ODC SQL cannot use it: use a CTE (WITH name AS (...))");
            }
            else if (t.Kind == Kind.Symbol)
            {
                if (t.Text == "::" && i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word && SqlServerTypes.TryGetValue(tokens[i + 1].Text, out var pgType))
                    error(t.Line, $"{tokens[i + 1].Text.ToUpperInvariant()} is a SQL Server type; PostgreSQL (ODC) has no such type: use {pgType}");
                else if (t.Text == "==")
                    error(t.Line, "'==' is not a SQL operator; use =");
                else if (t.Text is "!<" or "!>")
                    error(t.Line, $"'{t.Text}' is a SQL Server operator; PostgreSQL (ODC) uses {(t.Text == "!<" ? ">=" : "<=")}");
                else if (t.Text == "`" && tokens.FindIndex(x => x.Kind == Kind.Symbol && x.Text == "`") == i)
                    error(t.Line, "backticks quote identifiers in MySQL; PostgreSQL (ODC) uses \"name\" (and {Entity}.[Attribute] for the app's data)");
                else if (t.Text == "+" && !plusReported && i >= 1 && i + 1 < tokens.Count && Operand(tokens[i - 1]))
                {
                    // '+' has no text operand in PostgreSQL: a Text column, two literals, or a literal that cannot be read as
                    // a number or an interval make the query fail ("operator does not exist" / "is not unique" / bad input).
                    string? reason = null;
                    var left = tokens[i - 1]; var right = tokens[i + 1];
                    if (AttributeEndsAt(i - 1) && FamilyOf(i - 3, "odc-text-plus") == "text") reason = $" ({{{tokens[i - 3].Text}}}.[{left.Text}] is Text)";
                    else if (AttributeStartsAt(i + 1) && FamilyOf(i + 1, "odc-text-plus") == "text") reason = $" ({{{right.Text}}}.[{tokens[i + 3].Text}] is Text)";
                    else if (left.Kind == Kind.Text && right.Kind == Kind.Text || NotANumberNorInterval(left) || NotANumberNorInterval(right))
                        reason = " (a text literal is an operand)";
                    else if (TextParam(i - 1) && (right.Kind == Kind.Text || TextParam(i + 1)) || TextParam(i + 1) && left.Kind == Kind.Text)
                        reason = " (Text parameter and text operand)";
                    if (reason != null) { plusReported = true; error(t.Line, PlusReason(reason)); }
                }
                else if (t.Text is "=" or "<>" or "!=")
                {
                    // {E}.[Boolean] = 1: PostgreSQL has no boolean = integer operator (SQL Server's bit took 0/1).
                    if (AttributeEndsAt(i - 1) && !(i >= 4 && IsArithmetic(tokens[i - 4])) && i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Number && !(i + 2 < tokens.Count && IsArithmetic(tokens[i + 2]))
                        && FamilyOf(i - 3, "odc-boolean-literal", tokens[i + 1].Text) == "boolean")
                        error(tokens[i + 1].Line, BooleanReason(tokens[i - 3].Text, tokens[i - 1].Text, tokens[i + 1].Text));
                    else if (i >= 1 && tokens[i - 1].Kind == Kind.Number && !(i >= 2 && IsArithmetic(tokens[i - 2])) && AttributeStartsAt(i + 1) && !(i + 4 < tokens.Count && IsArithmetic(tokens[i + 4]))
                        && FamilyOf(i + 1, "odc-boolean-literal", tokens[i - 1].Text) == "boolean")
                        error(tokens[i - 1].Line, BooleanReason(tokens[i + 1].Text, tokens[i + 3].Text, tokens[i - 1].Text));
                }
            }
            else if (t.Kind == Kind.Quoted && (Symbol(i - 1, "=", "<>", "!=", "<", ">", "<=", ">=") || Word(i - 1, "LIKE", "ILIKE")))
                error(t.Line, $"\"{t.Text}\" is a quoted identifier (a column name) in PostgreSQL, not a text literal; use single quotes: '{t.Text}'");
            else if (t.Kind == Kind.Bracket && !bracketReported && !AttributeEndsAt(i) && IdentifierLike(t.Text)
                     && (i == 0 || Symbol(i - 1, ",", "(", ";", "=", "<>", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "||")
                         || i >= 1 && tokens[i - 1].Kind == Kind.Word && NoSubscriptAfter.Contains(tokens[i - 1].Text)
                         || Symbol(i - 1, ".") && !(i >= 2 && tokens[i - 2].Kind == Kind.Entity)
                         || AttributeEndsAt(i - 1)))
            {
                // '[' is only an array subscript in PostgreSQL; ODC rewrites the brackets of {Entity}.[Attribute] alone.
                bracketReported = true;
                error(t.Line, $"[{t.Text}] is SQL Server identifier quoting; PostgreSQL (ODC) has no [name] syntax and ODC rewrites only {{Entity}}.[Attribute]: write an attribute as {{Entity}}.[{t.Text}] and quote an alias as \"{t.Text}\"");
            }
        }

        AggregateArguments(tokens, error, postgres: true);
    }

    private static bool Operand(Token t) => t.Kind is Kind.Text or Kind.Number or Kind.Param or Kind.Bracket or Kind.Quoted or Kind.Word || t.Kind == Kind.Symbol && t.Text == ")";
    private static bool IdentifierLike(string text) => text.Length > 0 && (char.IsLetter(text[0]) || text[0] == '_') && text.All(ch => char.IsLetterOrDigit(ch) || ch is '_' or ' ');
    /// <summary>Name of the function whose call ends at the ')' in <paramref name="close"/>; null when it is not a call.</summary>
    private static string? CallNameBefore(List<Token> tokens, int close)
    {
        var depth = 0;
        for (var i = close; i >= 0; i--)
        {
            if (IsSymbol(tokens, i, ")")) depth++;
            else if (IsSymbol(tokens, i, "(") && --depth == 0) return i >= 1 && tokens[i - 1].Kind == Kind.Word ? tokens[i - 1].Text : null;
        }
        return null;
    }

    public static string BooleanReason(string entity, string attribute, string literal) =>
        $"{{{entity}}}.[{attribute}] is Boolean and is compared with the number {literal}; PostgreSQL (ODC) has no boolean = integer operator and refuses the query: compare with TRUE or FALSE";

    public static string PlusReason(string detail) =>
        $"'+' does not concatenate text in PostgreSQL (ODC){detail}; use || or CONCAT(...)";

    // ---- logic spec ----------------------------------------------------------------------------

    private static void Logic(JsonObject? data, int origin, List<SqlUse> uses)
    {
        foreach (var action in data?["actions"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var name = action["name"]?.ToString() ?? "?";
            Walk(action["steps"], step =>
            {
                if (step["sql"] is not JsonValue flag || !flag.TryGetValue<bool>(out var sql) || !sql || step["statement"] is not JsonValue sv || !sv.TryGetValue<string>(out var statement)) return;
                var use = new SqlUse { Op = origin, Where = $"in logic action '{name}' get '{step["as"]}'", Statement = statement, ParamsChecked = false };
                if (step["params"] is JsonObject declared)
                    foreach (var p in declared)
                        use.Params[p.Key] = new Param { Name = p.Key, Type = (p.Value as JsonObject)?["type"]?.ToString() };
                uses.Add(use);
            });
        }
    }

    private static void Walk(JsonNode? node, Action<JsonObject> visit)
    {
        if (node is JsonObject o) { visit(o); foreach (var p in o) Walk(p.Value, visit); }
        else if (node is JsonArray a) foreach (var item in a) Walk(item, visit);
    }

    // ---- base model ----------------------------------------------------------------------------

    /// <summary>Resolves the names <see cref="Analyze"/> left open against the loaded base; one message per failure.</summary>
    public static List<string> CheckBase(OutSystems.Model.IESpace es, Func<string, object?> resolve, JsonArray unresolved)
    {
        var failures = new List<string>();
        var cache = new Dictionary<string, OutSystems.Model.Data.IEntitySignature?>(StringComparer.OrdinalIgnoreCase);
        OutSystems.Model.Data.IEntitySignature? Find(string name)
        {
            if (!cache.TryGetValue(name, out var e)) cache[name] = e = TypeResolver.FindEntitySignature(es, name);
            return e;
        }
        string Prefix(JsonNode item) => $"op #{item["op"]} (SQL {item["where"]}, line {item["line"]})";
        object? Attribute(OutSystems.Model.Data.IEntitySignature e, string name) =>
            e.Attributes.FirstOrDefault(a => string.Equals(TypeResolver.Name(a), name, StringComparison.OrdinalIgnoreCase));
        foreach (var item in unresolved.OfType<JsonObject>())
        {
            var kind = item["kind"]?.ToString();
            if (kind is "entity" or "attribute" or "comparison")
            {
                var name = item["entity"]!.ToString();
                var entity = Find(name);
                if (entity == null)
                {
                    if (kind == "entity") failures.Add($"{Prefix(item)}: {{{name}}} is not an entity of this job, of the base module or of its references; check the name (case and spelling) or add the reference");
                    continue;
                }
                if (kind == "entity" && ModelHost.Prop(entity, "EntityKind")?.ToString() == "Client")
                    failures.Add($"{Prefix(item)}: {{{name}}} is a Local Storage (client) entity; SQL runs on the server database and cannot read it");
                var attributeName = item["attribute"]?.ToString();
                if (attributeName == null) continue;
                var attribute = Attribute(entity, attributeName);
                if (kind == "attribute" && attribute == null && !attributeName.Equals("TenantId", StringComparison.OrdinalIgnoreCase))
                    failures.Add($"{Prefix(item)}: [{attributeName}] is not an attribute of {{{name}}}; attributes: {string.Join(", ", entity.Attributes.Select(a => TypeResolver.Name(a)))}");
                if (kind == "comparison" && attribute != null && ModelHost.Prop(attribute, "DataType") is { } dataType)
                {
                    var typeName = TypeName(es, dataType);
                    if (typeName != null && Incompatible(Family(typeName, _ => null), item["paramFamily"]?.ToString()))
                        failures.Add($"{Prefix(item)}: " + TypeReason(name, attributeName, typeName, item["param"]!.ToString(), item["paramType"]!.ToString()));
                }
            }
            else if (kind is "odc-boolean-literal" or "odc-text-plus")
            {
                // PostgreSQL rules decided by the type of a base attribute (an unknown entity/attribute is its own item).
                var name = item["entity"]!.ToString(); var attributeName = item["attribute"]!.ToString();
                if (Find(name) is not { } entity || Attribute(entity, attributeName) is not { } attribute || ModelHost.Prop(attribute, "DataType") is not { } dataType) continue;
                var family = TypeName(es, dataType) is { } typeName ? Family(typeName, _ => null) : null;
                if (kind == "odc-boolean-literal" && family == "boolean")
                    failures.Add($"{Prefix(item)}: " + BooleanReason(name, attributeName, item["literal"]?.ToString() ?? "?"));
                else if (kind == "odc-text-plus" && family == "text")
                    failures.Add($"{Prefix(item)}: " + PlusReason($" ({{{name}}}.[{attributeName}] is Text)"));
            }
            else if (kind == "parameters")
            {
                object? node;
                try { node = resolve(item["target"]!.ToString()); } catch { continue; }   // the apply reports a target it cannot find
                if (node is not OutSystems.Model.Logic.Nodes.ISQLNode sql) continue;
                var declared = sql.InputParameters.Select(p => TypeResolver.Name(p) ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
                foreach (var removed in item["removed"]?.AsArray() ?? new JsonArray()) declared.Remove(removed!.ToString());
                foreach (var p in item["parameters"]!.AsArray().OfType<JsonObject>())
                    if (!declared.Contains(p["name"]!.ToString()))
                        failures.Add($"op #{item["op"]} (SQL {item["where"]}, line {p["line"]}): @{p["name"]} is used but the SQL node declares no parameter '{p["name"]}' (declared: {(declared.Count == 0 ? "none" : string.Join(", ", declared.OrderBy(x => x, StringComparer.Ordinal)))}); create the ISQLInputParameter or fix the name");
            }
        }
        return failures;
    }

    private static string? TypeName(OutSystems.Model.IESpace es, object dataType)
    {
        if (ReferenceEquals(dataType, es.TextType)) return "Text";
        if (ReferenceEquals(dataType, es.IntegerType)) return "Integer";
        if (ReferenceEquals(dataType, es.LongIntegerType)) return "Long Integer";
        if (ReferenceEquals(dataType, es.DecimalType)) return "Decimal";
        if (ReferenceEquals(dataType, es.CurrencyType)) return "Currency";
        if (ReferenceEquals(dataType, es.BooleanType)) return "Boolean";
        if (ReferenceEquals(dataType, es.DateType)) return "Date";
        if (ReferenceEquals(dataType, es.TimeType)) return "Time";
        if (ReferenceEquals(dataType, es.DateTimeType)) return "Date Time";
        if (ReferenceEquals(dataType, es.EmailType)) return "Email";
        if (ReferenceEquals(dataType, es.PhoneNumberType)) return "Phone Number";
        if (ReferenceEquals(dataType, es.BinaryDataType)) return "Binary Data";
        var name = TypeResolver.Name(dataType);
        return name != null && Family(name, null) != null ? name : null;
    }
}
