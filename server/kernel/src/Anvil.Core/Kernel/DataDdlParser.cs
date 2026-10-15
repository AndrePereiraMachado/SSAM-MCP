using System.Text;

namespace Anvil.Reading;

// One element of a data text as parsed: kind (the Model API's), name, @key, parent, the properties the text writes (by
// their Model API names; "none" reads as null) and its parts (record values, index columns, call arguments).
public sealed class DdlElement
{
    public string Kind = "", Name = "", Key = "";
    public int Line;
    public DdlElement? Parent;
    public readonly List<DdlElement> Children = [];
    public readonly SortedDictionary<string, string?> Props = new(StringComparer.Ordinal);
    public readonly List<(string Attribute, string Value)> Values = [];
    public readonly List<string> Columns = [];
    public readonly List<(string Parameter, string Value)> Arguments = [];
    // The entity a statement outside the entity's block names (index, event, sample record).
    public string? Of;
    // An attribute whose type is an identifier: the entity `references` names.
    public string? References;
    // `drop <what> <Name>; -- @key`: the element the edit removes (the way back, DL2; the printer never writes it).
    public bool Drop;
    // A static entity statement written with its `values` clause (the records are then the whole list).
    public bool HasValues;
}

// The defaults' context over a parsed element (DdlRules.Default): a property is the text's value, else its default.
public sealed class DdlParsedContext(DdlElement element) : DdlRules.IContext
{
    public string Kind => element.Kind;
    public string Name => element.Name;
    public string? ParentKind => element.Parent?.Kind;
    public string? Value(string property) => element.Props.TryGetValue(property, out var value) ? value : DdlRules.Default(this, property);
    public IReadOnlyList<string> Attributes => element.Children.Where(c => c.Kind == "EntityAttribute").Select(c => c.Name).ToList();
    // The value the text gives a property: written, else its default.
    public string? Effective(string property) => Value(property);
}

public sealed class DdlDocument
{
    public readonly List<DdlElement> Elements = [];
    // Statements whose named entity is not declared in this text; resolved against the module when compiling.
    // They are not top-level declarations and are deliberately outside All().
    public readonly List<DdlElement> Detached = [];
    public string? Schema, Module, Lane;
    // The source sha256 the header names (the capture the text was read from), or null.
    public string? SourceSha256;
    // The key of the module the header names (key=@...), or null: a read of another module is never the base of a merge.
    public string? ModuleKey;
    // The text the document was read from (its line endings as LF): the declarations a refusal hands back are cut from it.
    public string? Text;
    public IEnumerable<DdlElement> All() {
        var pending = new Stack<DdlElement>(Elements.AsEnumerable().Reverse());
        while (pending.TryPop(out var element)) { yield return element; for (var i = element.Children.Count - 1; i >= 0; i--) pending.Push(element.Children[i]); }
    }
}

// Every problem of a text at once, each with its line (the parse goes on at the next statement after a problem).
public sealed class DdlParseException(IReadOnlyList<(int Line, string Message)> errors, DdlDocument? partial = null)
    : FormatException(string.Join("; ", errors.Select(e => "line " + e.Line + ": " + e.Message)))
{
    public DdlParseException(string message, int line) : this([(line, message)]) { }
    public IReadOnlyList<(int Line, string Message)> Errors => errors;
    /// <summary>Statements successfully read before and after malformed statements.</summary>
    public DdlDocument? Partial => partial;
    public int Line => errors[0].Line;
}

// Reads ssam-ddl/1 (DataDdl) back into elements. The grammar is closed: a word it does not know, a clause twice, a value
// in the wrong place or a key comment without its element is an error with its line, never a guess.
public static class DdlParser
{
    public static DdlDocument Parse(string text) => new Reader(text.Replace("\r\n", "\n"), null).Document();

    // An edit sent back without the header (only the blocks that change): the lane decides the kind of a static record.
    public static DdlDocument Parse(string text, string? lane) => new Reader(text.Replace("\r\n", "\n"), lane).Document();

    private sealed class Reader(string s, string? lane)
    {
        private int at;
        private readonly List<string> doc = [];
        private bool docJson;
        private readonly DdlDocument document = new();
        private readonly List<DdlElement> pending = [];

        private int Line => 1 + s.AsSpan(0, Math.Min(at, s.Length)).Count('\n');
        private DdlParseException Error(string message) => new(message, Line);

        public DdlDocument Document()
        {
            // The header comment names the schema, module and lane.
            var header = s.StartsWith("-- ", StringComparison.Ordinal) ? s[3..(s.IndexOf('\n') is var nl and >= 0 ? nl : s.Length)] : "";
            foreach (var part in header.Split(' ', StringSplitOptions.RemoveEmptyEntries)) {
                if (part.StartsWith("ssam-ddl/", StringComparison.Ordinal)) document.Schema = part;
                else if (part.StartsWith("module=", StringComparison.Ordinal)) document.Module = part[7..];
                else if (part.StartsWith("lane=", StringComparison.Ordinal)) document.Lane = part[5..];
                else if (part.StartsWith("sourceSha256=", StringComparison.Ordinal)) document.SourceSha256 = part[13..];
                else if (part.StartsWith("key=@", StringComparison.Ordinal)) document.ModuleKey = part[5..];
            }
            document.Text = s;
            if (document.Schema == null && lane != null) document.Lane = lane;
            var errors = new List<(int Line, string Message)>();
            while (true) {
                try {
                    Space();
                    if (at >= s.Length) break;
                    Statement();
                } catch (DdlParseException error) {
                    errors.AddRange(error.Errors);
                    doc.Clear(); docJson = false;
                    NextStatement();
                }
            }
            if (doc.Count > 0) errors.Add((Line, "a description (///) with no element after it"));
            foreach (var element in pending) {
                var owner = document.Elements.LastOrDefault(e => !e.Drop && DdlRules.IsEntityKind(e.Kind) && e.Name == element.Of);
                if (owner == null) document.Detached.Add(element);
                else { element.Parent = owner; owner.Children.Add(element); }
            }
            if (errors.Count > 0) throw new DdlParseException(errors, document);
            return document;
        }

        // After a problem: the next line that starts a statement or the description of one.
        private static readonly string[] StatementStarts = ["create ", "type ", "site ", "setting ", "client ", "session ", "timer ", "on ", "sample ", "drop ", "///"];
        private void NextStatement()
        {
            var line = s.IndexOf('\n', at);
            while (line >= 0) {
                var next = line + 1;
                if (StatementStarts.Any(word => string.CompareOrdinal(s, next, word, 0, word.Length) == 0)) { at = next; return; }
                line = s.IndexOf('\n', next);
            }
            at = s.Length;
        }

        // ---- statements ----------------------------------------------------------------------------------------------

        private void Statement()
        {
            var line = Line;
            var word = Word();
            switch (word) {
                case "create": Create(line); return;
                case "type": Structure(line); return;
                case "site": ExpectWord("property"); Variable("SiteProperty", line); return;
                case "setting": Variable("SiteProperty", line); return;
                case "client": ExpectWord("variable"); Variable("ClientVariable", line); return;
                case "session": ExpectWord("variable"); Variable("SessionVariable", line); return;
                case "timer": Timer(line); return;
                case "on": Event(line); return;
                case "sample": Sample(line); return;
                case "drop": Drop(line); return;
                default: throw Error("unknown statement '" + word + "' (create, type, site property, setting, client variable, session variable, timer, on, sample, drop)");
            }
        }

        // drop entity|static entity|…|index|type|site property|setting|client variable|session variable|timer Name; -- @key
        // The element the edit removes: written only on the way back, by its key (the name is checked against it).
        private void Drop(int line)
        {
            if (doc.Count > 0) throw Error("a description (///) before drop");
            const string Whats = "entity, static entity, index, type, site property, setting, client variable, session variable or timer";
            var first = Word();
            string what, kind;
            switch (first) {
                case "index": what = first; kind = "EntityIndex"; break;
                case "type": what = first; kind = "Structure"; break;
                case "timer": what = first; kind = "Timer"; break;
                case "setting": what = first; kind = "SiteProperty"; break;
                case "site": ExpectWord("property"); what = "site property"; kind = "SiteProperty"; break;
                case "session": ExpectWord("variable"); what = "session variable"; kind = "SessionVariable"; break;
                case "client" when Starts(" variable") || Starts("\tvariable"): ExpectWord("variable"); what = "client variable"; kind = "ClientVariable"; break;
                default: {
                    // The words of an entity kind, then `entity` (drop entity X, drop static entity X, drop client entity X).
                    var words = new List<string>();
                    var word = first;
                    while (word != "entity") {
                        if (word.Length == 0 || words.Count > 3) throw Error("drop takes " + Whats);
                        words.Add(word);
                        word = Word();
                    }
                    what = string.Join(' ', words.Append("entity"));
                    kind = DdlRules.EntityKind(string.Join(' ', words));
                    break;
                }
            }
            var element = New(kind, line);
            element.Drop = true;
            element.Name = Name();
            HSpace();
            if (Peek(';')) at++;
            element.Key = Key() ?? throw Error("drop names its element by its key: drop " + what + " " + DdlRules.Name(element.Name) + "; -- @<key>");
            document.Elements.Add(element);
        }

        private void Create(int line)
        {
            var words = new List<string>();
            while (true) {
                HSpace();
                var word = Word();
                if (word == "index") {
                    if (words.Any(w => w != "unique")) throw Error("index takes only 'unique'");
                    Index(line, words.Contains("unique"));
                    return;
                }
                if (word == "entity") break;
                if (word.Length == 0) throw Error("create what? (entity, static entity, index)");
                words.Add(word);
            }
            var entity = New(DdlRules.EntityKind(string.Join(' ', words)), line);
            entity.Name = Name();
            while (true) {
                HSpace();
                if (Peek('(')) break;
                var word = Word();
                switch (word) {
                    case "public": Set(entity, "Public", "True"); break;
                    case "label": Set(entity, "LabelAttribute", NameOrNone()); break;
                    case "order": Set(entity, "OrderByAttribute", NameOrNone()); break;
                    case "active": Set(entity, "IsActiveAttribute", NameOrNone()); break;
                    case "update":
                        var behavior = Word();
                        Set(entity, "UpdateBehavior", behavior switch { "full" => "Full", "optimized" => "Optimized", _ => throw Error("update takes full or optimized") });
                        break;
                    case "folder": Set(entity, "Folder", Name()); break;
                    case "os": Os(entity); break;
                    default: throw Error("unknown entity clause '" + word + "'");
                }
            }
            at++;
            entity.Key = Key() ?? "";
            document.Elements.Add(entity);
            // Attributes: Name Type clauses [default expression], separated by commas.
            var more = true;
            while (true) {
                Space();
                if (Peek(')')) { if (doc.Count > 0) throw Error("a description (///) with no attribute after it"); at++; break; }
                if (!more) throw Error("attributes are separated by ','");
                var attribute = New("EntityAttribute", Line);
                attribute.Parent = entity; entity.Children.Add(attribute);
                attribute.Name = Name();
                Type(attribute);
                AttributeClauses(attribute, entity, DdlStop.Item);
                HSpace();
                more = Peek(',');
                if (more) at++;
                attribute.Key = Key() ?? "";
            }
            HSpace();
            if (Peek(';')) { at++; Trailing(entity); return; }
            Space();
            if (Word() != "values") throw Error("after the attributes: ';' or values");
            entity.HasValues = true;
            while (true) {
                Space();
                var record = New(document.Lane == "odc" ? "StaticEntityRecord" : "Record", Line);
                record.Parent = entity; entity.Children.Add(record);
                record.Name = Name();
                HSpace(); Expect('(');
                Values(record);
                OsClauses(record, ',', ';');
                HSpace();
                var last = Peek(';');
                if (!last && !Peek(',')) throw Error("a record ends with ',' or ';'");
                at++;
                record.Key = Key() ?? "";
                if (last) break;
            }
        }

        // Nothing may follow a statement on its line but its key.
        private void Trailing(DdlElement element)
        {
            if (Key() is { } key) element.Key = key;
        }

        private void AttributeClauses(DdlElement attribute, DdlElement? entity, DdlStop stop)
        {
            while (true) {
                HSpace();
                if (at >= s.Length || s[at] is ',' or ')' or ';' or '\n' || IsComment()) return;
                var word = Word();
                switch (word) {
                    case "identifier" when entity != null:
                        if (entity.Props.ContainsKey("Identifier")) throw Error("two identifier attributes");
                        entity.Props["Identifier"] = attribute.Name; break;
                    case "auto": Set(attribute, "IsAutoNumber", "Yes"); break;
                    case "required": Set(attribute, "IsMandatory", "True"); break;
                    case "references" when entity != null:
                        attribute.References = Name();
                        ExpectWord("on"); ExpectWord("delete");
                        var rule = Token();
                        Set(attribute, "DeleteRule", char.ToUpperInvariant(rule[0]) + rule[1..]);
                        break;
                    case "label": Set(attribute, "Label", TextOrNone()); break;
                    case "json": Set(attribute, "NameInJSON", TextValue()); break;
                    case "os": Os(attribute); break;
                    case "default":
                        var (value, end) = DdlScanner.ScanExpression(s, at, stop);
                        if (value.Length == 0) throw Error("default takes an expression");
                        at = end;
                        Set(attribute, "DefaultValue", value);
                        return;
                    default: throw Error("unknown attribute clause '" + word + "'");
                }
            }
        }

        // (Attribute = expression, …) after the '(' up to and with the ')'.
        private void Values(DdlElement record)
        {
            while (true) {
                Space();
                if (Peek(')')) { at++; return; }
                var attribute = Name();
                HSpace(); Expect('=');
                var (value, end) = DdlScanner.ScanExpression(s, at, DdlStop.Item);
                at = end;
                record.Values.Add((attribute, value));
                HSpace();
                if (Peek(',')) at++;
                else if (!Peek(')')) throw Error("a value ends with ',' or ')'");
            }
        }

        private void Index(int line, bool unique)
        {
            var index = New("EntityIndex", line);
            index.Name = Name();
            if (unique) index.Props["Unique"] = "True";
            ExpectWord("on");
            index.Of = Name();
            HSpace(); Expect('(');
            while (true) {
                Space();
                if (Peek(')')) { at++; break; }
                index.Columns.Add(Name());
                HSpace();
                if (Peek(',')) at++;
            }
            OsClauses(index, ';');
            HSpace(); Expect(';');
            index.Key = Key() ?? "";
            Attach(index);
        }

        private void Event(int line)
        {
            var on = Word();
            var kind = on switch { "create" => "OnCreateLifeCycleDatabaseEvent", "update" => "OnUpdateLifeCycleDatabaseEvent", "delete" => "OnDeleteLifeCycleDatabaseEvent",
                _ => throw Error("on takes create, update or delete") };
            var @event = New(kind, line);
            @event.Of = Name();
            HSpace(); Expect('-'); Expect('>');
            HSpace();
            var handler = NameOrNone();
            @event.Props["Destination"] = handler;
            HSpace(); Expect('(');
            Arguments(@event);
            OsClauses(@event, ';');
            HSpace(); Expect(';');
            @event.Key = Key() ?? "";
            Attach(@event);
        }

        private void Sample(int line)
        {
            var sample = New("Record", line);
            sample.Of = Name();
            HSpace(); Expect('(');
            Values(sample);
            HSpace(); Expect(';');
            sample.Key = Key() ?? "";
            Attach(sample);
        }

        // Resolve owners only after reading all statements: declarations may precede or follow their own statements.
        private void Attach(DdlElement element)
        {
            pending.Add(element);
        }

        private void Arguments(DdlElement element)
        {
            while (true) {
                Space();
                if (Peek(')')) { at++; return; }
                var parameter = Name();
                HSpace(); Expect('=');
                var (value, end) = DdlScanner.ScanExpression(s, at, DdlStop.Item);
                at = end;
                element.Arguments.Add((parameter, value));
                HSpace();
                if (Peek(',')) at++;
                else if (!Peek(')')) throw Error("an argument ends with ',' or ')'");
            }
        }

        private void Structure(int line)
        {
            var structure = New("Structure", line);
            structure.Name = Name();
            while (true) {
                HSpace();
                if (Peek('=')) break;
                var word = Word();
                switch (word) {
                    case "public": Set(structure, "Public", "True"); break;
                    case "folder": Set(structure, "Folder", Name()); break;
                    case "os": Os(structure); break;
                    default: throw Error("unknown type clause '" + word + "'");
                }
            }
            at++; HSpace(); Expect('{');
            structure.Key = Key() ?? "";
            document.Elements.Add(structure);
            while (true) {
                Space();
                if (Peek('}')) { if (doc.Count > 0) throw Error("a description (///) with no attribute after it"); at++; break; }
                var attribute = New("StructureAttribute", Line);
                attribute.Parent = structure; structure.Children.Add(attribute);
                attribute.Name = Name();
                HSpace(); Expect(':');
                Type(attribute);
                AttributeClauses(attribute, null, DdlStop.Field);
                HSpace(); Expect(';');
                attribute.Key = Key() ?? "";
            }
        }

        private void Variable(string kind, int line)
        {
            var variable = New(kind, line);
            variable.Name = Name();
            HSpace();
            if (Peek(':')) { at++; Type(variable); }
            while (true) {
                HSpace();
                if (at >= s.Length || s[at] == '\n' || IsComment()) break;
                if (Peek('=')) {
                    at++;
                    var (value, end) = DdlScanner.ScanExpression(s, at, DdlStop.Line);
                    if (value.Length == 0) throw Error("'=' takes the default value");
                    at = end;
                    Set(variable, "DefaultValue", value);
                    break;
                }
                var word = Word();
                switch (word) {
                    case "read-only": Set(variable, "IsReadOnly", "True"); break;
                    case "secret": Set(variable, "IsSecret", "True"); break;
                    case "folder": Set(variable, "Folder", Name()); break;
                    case "os": Os(variable); break;
                    default: throw Error("unknown declaration clause '" + word + "'");
                }
            }
            variable.Key = Key() ?? "";
            document.Elements.Add(variable);
        }

        private void Timer(int line)
        {
            var timer = New("Timer", line);
            timer.Name = Name();
            while (true) {
                HSpace();
                if (at >= s.Length || s[at] == '\n' || IsComment()) break;
                var word = Word();
                switch (word) {
                    case "action": Set(timer, "Action", NameOrNone()); break;
                    case "schedule": Set(timer, "Schedule", TextValue()); break;
                    case "cron": Set(timer, "CronSchedule", TextOrNone()); break;
                    case "priority": Set(timer, "Priority", NoneOr(Token())); break;
                    case "timeout": Set(timer, "TimeoutInMinutes", NoneOr(Token())); break;
                    case "folder": Set(timer, "Folder", Name()); break;
                    case "os": Os(timer); break;
                    case "with": HSpace(); Expect('('); Arguments(timer); break;
                    default: throw Error("unknown timer clause '" + word + "'");
                }
            }
            timer.Key = Key() ?? "";
            document.Elements.Add(timer);
        }

        // ---- clauses -------------------------------------------------------------------------------------------------

        // Type(Length,Decimals): bracketed, or capitalized words; "none" is no type.
        private void Type(DdlElement element)
        {
            HSpace();
            string? type;
            if (Peek('[')) type = Bracketed();
            else {
                var start = at;
                while (at < s.Length && char.IsUpper(s[at])) {
                    while (at < s.Length && (char.IsLetterOrDigit(s[at]) || s[at] == '_')) at++;
                    if (at + 1 < s.Length && s[at] == ' ' && char.IsUpper(s[at + 1])) at++; else break;
                }
                type = s[start..at];
                if (type.Length == 0) {
                    if (Word() != "none") throw Error("expected a type");
                    type = null;
                }
            }
            if (type != null) element.Props["DataType"] = type;
            if (!Peek('(')) return;
            at++;
            HSpace();
            if (!Peek(',')) element.Props["Length"] = SizeValue();
            HSpace();
            if (Peek(',')) { at++; HSpace(); element.Props["Decimals"] = SizeValue(); }
            HSpace(); Expect(')');
        }

        private string SizeValue() => Peek('"') || Peek('$') ? TextValue() : Token();

        // os:<Property>=<value>
        private void Os(DdlElement element)
        {
            Expect(':');
            var start = at;
            while (at < s.Length && (char.IsLetterOrDigit(s[at]) || s[at] == '_')) at++;
            var property = s[start..at];
            if (property.Length == 0) throw Error("os: takes a property name");
            Expect('=');
            string? value = Peek('"') || Peek('$') ? TextValue() : NoneOr(Token());
            Set(element, property, value);
        }

        private void OsClauses(DdlElement element, params char[] stops)
        {
            while (true) {
                HSpace();
                if (at >= s.Length || stops.Contains(s[at])) return;
                if (Word() != "os") throw Error("only os: clauses may follow here");
                Os(element);
            }
        }

        private void Set(DdlElement element, string property, string? value)
        {
            if (element.Props.ContainsKey(property)) throw Error(property + " is written twice");
            element.Props[property] = value;
        }

        // ---- tokens --------------------------------------------------------------------------------------------------

        private DdlElement New(string kind, int line)
        {
            var element = new DdlElement { Kind = kind, Line = line };
            if (doc.Count > 0) element.Props["Description"] = TakeDoc();
            return element;
        }

        private string TakeDoc()
        {
            var text = docJson ? doc[0] : string.Join("\n", doc);
            doc.Clear(); docJson = false;
            return text;
        }

        // Spaces, line breaks, descriptions (kept for the next element) and comments other than a key.
        private void Space()
        {
            while (at < s.Length) {
                var c = s[at];
                if (c is ' ' or '\t' or '\n' or '\r') { at++; continue; }
                if (c == '/' && Starts("///")) {
                    var end = s.IndexOf('\n', at); if (end < 0) end = s.Length;
                    var line = s[(at + 3)..end];
                    if (line.StartsWith('$')) {
                        if (doc.Count > 0) throw Error("a JSON description is the only line of its description");
                        var (text, _) = DdlScanner.ScanJson(line, 1);
                        doc.Add(text); docJson = true;
                    } else {
                        if (docJson) throw Error("a JSON description is the only line of its description");
                        doc.Add(line.StartsWith(' ') ? line[1..] : line);
                    }
                    at = end;
                    continue;
                }
                if (c == '-' && Starts("--")) {
                    if (Starts("-- @")) throw Error("a key comment with no element on its line");
                    var end = s.IndexOf('\n', at); at = end < 0 ? s.Length : end;
                    continue;
                }
                break;
            }
        }

        private void HSpace() { while (at < s.Length && s[at] is ' ' or '\t') at++; }

        private bool IsComment() => Starts("--") && (at + 2 >= s.Length || s[at + 2] is ' ' or '\t' or '\n');

        // `-- @<key>` on this line, or null.
        private string? Key()
        {
            HSpace();
            if (!Starts("-- @")) return null;
            var end = s.IndexOf('\n', at); if (end < 0) end = s.Length;
            var key = s[(at + 4)..end].TrimEnd();
            at = end;
            return key;
        }

        private bool Starts(string text) => string.CompareOrdinal(s, at, text, 0, text.Length) == 0;
        private bool Peek(char c) => at < s.Length && s[at] == c;
        private void Expect(char c) { if (!Peek(c)) throw Error("expected '" + c + "'"); at++; }

        // A lowercase word of the text (letters and '-').
        private string Word()
        {
            HSpace();
            var start = at;
            while (at < s.Length && (char.IsLower(s[at]) || s[at] == '-' && at > start)) at++;
            return s[start..at];
        }

        private void ExpectWord(string word) { if (Word() != word) throw Error("expected '" + word + "'"); }

        // A bare value: letters, digits, underscores, '-' and '.'.
        private string Token()
        {
            HSpace();
            var start = at;
            while (at < s.Length && (char.IsLetterOrDigit(s[at]) || s[at] is '_' or '-' or '.')) at++;
            if (at == start) throw Error("expected a value");
            return s[start..at];
        }

        private static string? NoneOr(string token) => token == "none" ? null : token;

        // A name: bare (letters, digits, underscores) or [bracketed] with ']]' for ']'.
        private string Name()
        {
            HSpace();
            if (Peek('[')) return Bracketed();
            var start = at;
            while (at < s.Length && (char.IsLetterOrDigit(s[at]) || s[at] == '_')) at++;
            if (at == start) throw Error("expected a name");
            return s[start..at];
        }

        private string? NameOrNone()
        {
            HSpace();
            if (Peek('[')) return Bracketed();
            var name = Name();
            return name == "none" ? null : name;
        }

        private string Bracketed()
        {
            Expect('[');
            var text = new StringBuilder();
            while (true) {
                if (at >= s.Length) throw Error("unterminated [name]");
                if (s[at] == ']') { if (at + 1 < s.Length && s[at + 1] == ']') { text.Append(']'); at += 2; continue; } at++; break; }
                text.Append(s[at++]);
            }
            return text.ToString();
        }

        // A text: "…" with "" for '"', or $"<JSON string>".
        private string TextValue()
        {
            HSpace();
            if (Peek('$')) { at++; var (json, end) = DdlScanner.ScanJson(s, at); at = end; return json; }
            Expect('"');
            var text = new StringBuilder();
            while (true) {
                if (at >= s.Length || s[at] == '\n') throw Error("unterminated text");
                if (s[at] == '"') { if (at + 1 < s.Length && s[at + 1] == '"') { text.Append('"'); at += 2; continue; } at++; break; }
                text.Append(s[at++]);
            }
            return text.ToString();
        }

        private string? TextOrNone()
        {
            HSpace();
            if (Peek('"') || Peek('$')) return TextValue();
            if (Word() != "none") throw Error("expected a text or none");
            return null;
        }
    }
}
