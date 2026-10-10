using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Anvil.Xif;

/// <summary>The body of one action as the spec gives it.</summary>
public sealed record XifActionBody(string Action, string Body);

/// <summary>The merged main source, the action methods that changed, and the 1-based line range of every body that came
/// from the spec (a compiler diagnostic inside it is reported on the action).</summary>
public sealed record XifMergeResult(string Source, IReadOnlyList<string> Changed, IReadOnlyDictionary<string, (int First, int Last)> BodyLines);

/// <summary>
/// The Roslyn merge of the action bodies into the main source of an extension (class Css&lt;Name&gt;, one method
/// Mss&lt;Action&gt; per action). The signature of every action method comes from the stubs the environment generated
/// (GenerateSourceCodeStubs); the body comes from the spec when the spec gives one, else from the current source; every
/// other member and every untouched method stays byte for byte. An action method the stubs no longer have is removed.
/// D8: a body may use the declared names (Left, Right, Result); each becomes ss&lt;Name&gt; (the Integration Studio
/// convention) only where the identifier does not resolve to another symbol (a local, a lambda parameter, a member of the
/// class, a member access, a named argument).
/// </summary>
public static class XifSourceMerge
{
    private static readonly CSharpParseOptions Parse = new(LanguageVersion.Latest);

    public static XifMergeResult Merge(string extensionName, string stubSource, string? currentSource, IEnumerable<XifActionBody> bodies)
    {
        var owner = "Css" + extensionName;
        var stubRoot = CSharpSyntaxTree.ParseText(stubSource, Parse).GetRoot();
        var stubClass = Class(stubRoot, owner)
            ?? throw XifRefusal.Single(XifCodes.MergeFailed, $"The generated stubs have no class {owner}.", "Generate the stubs again for this extension; nothing was sent.");
        var stubMethods = Methods(stubClass);
        var baseText = currentSource ?? stubSource;
        var baseRoot = CSharpSyntaxTree.ParseText(baseText, Parse).GetRoot();
        var baseClass = Class(baseRoot, owner)
            ?? throw XifRefusal.Single(XifCodes.MergeFailed, $"The current source of the extension has no class {owner}.", "Read the extension again (o11_extension read); nothing was sent.");
        var baseMethods = Methods(baseClass);
        var byAction = bodies.GroupBy(b => b.Action, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Last().Body, StringComparer.Ordinal);
        var unknown = byAction.Keys.Where(a => !stubMethods.ContainsKey("Mss" + a)).ToList();
        if (unknown.Count > 0)
            throw new XifRefusal(XifCodes.MergeFailed, "The stubs have no method for " + string.Join(", ", unknown) + ".",
                unknown.Select(a => new XifProblem(XifCodes.MergeFailed, "actions." + a, $"The generated stubs have no method Mss{a}.", "Check that the action is in the model sent to GenerateSourceCodeStubs.")).ToList());
        var members = MemberNames(baseClass).Concat(MemberNames(stubClass)).ToHashSet(StringComparer.Ordinal);
        var newline = baseText.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var edits = new List<(TextSpan Span, string Text)>();
        var changed = new List<string>();
        var memberIndent = baseClass.Members.Count > 0 ? Indent(baseText, baseClass.Members[0].SpanStart) : Indent(baseText, baseClass.SpanStart) + "    ";
        // New methods go on their own lines just before the line of the class's closing brace.
        var close = baseClass.CloseBraceToken.SpanStart;
        var lineStart = baseText.LastIndexOf('\n', Math.Max(0, close - 1)) + 1;
        var insertAt = baseText[lineStart..close].Trim().Length == 0 ? lineStart : close;
        string Insertion(string method) => insertAt == lineStart ? newline + memberIndent + method + newline : newline + memberIndent + method + newline + Indent(baseText, close);

        foreach (var (name, stub) in stubMethods)
        {
            var action = name[3..];
            baseMethods.TryGetValue(name, out var current);
            var signature = Signature(stub);
            // The stub's own style between the signature and its "{" (same line or the next).
            var separator = stub.Body is { } stubBody ? stubBody.OpenBraceToken.LeadingTrivia.ToFullString() + stubBody.OpenBraceToken.GetPreviousToken().TrailingTrivia.ToFullString() : " ";
            if (byAction.TryGetValue(action, out var body))
            {
                var parameters = stub.ParameterList.Parameters.Select(p => p.Identifier.ValueText).ToList();
                var rewritten = RewriteDeclaredNames(body, parameters, members);
                if (current != null)
                {
                    var indent = Indent(baseText, current.SpanStart);
                    var text = Render(signature, separator, rewritten, indent, newline);
                    if (text != baseText.Substring(current.Span.Start, current.Span.Length)) { edits.Add((current.Span, text)); changed.Add(action); }
                }
                else
                {
                    edits.Add((new TextSpan(insertAt, 0), Insertion(Render(signature, separator, rewritten, memberIndent, newline))));
                    changed.Add(action);
                }
            }
            else if (current != null)
            {
                // The body stays; the signature follows the stubs (a parameter added, removed or retyped); the spacing
                // before the body's "{" stays the author's.
                if (!SameSignature(stub, current) && current.Body != null)
                {
                    edits.Add((TextSpan.FromBounds(current.SpanStart, current.Body.OpenBraceToken.GetPreviousToken().Span.End), signature));
                    changed.Add(action);
                }
            }
            else
            {
                edits.Add((new TextSpan(insertAt, 0), Insertion(stub.ToString())));
                changed.Add(action);
            }
        }
        foreach (var (name, current) in baseMethods.Where(m => !stubMethods.ContainsKey(m.Key)))
        {
            edits.Add((current.FullSpan, ""));
            changed.Add(name[3..]);
        }
        // Insertions at the same point keep the order of the stubs.
        var merged = baseText;
        foreach (var (span, text) in edits.Select((e, i) => (e, i)).OrderByDescending(x => x.e.Span.Start).ThenByDescending(x => x.i).Select(x => x.e))
            merged = merged[..span.Start] + text + merged[span.End..];

        var lines = new Dictionary<string, (int, int)>(StringComparer.Ordinal);
        var mergedTree = CSharpSyntaxTree.ParseText(merged, Parse);
        if (Class(mergedTree.GetRoot(), owner) is { } mergedClass)
            foreach (var (name, method) in Methods(mergedClass))
                if (byAction.ContainsKey(name[3..]) && method.Body != null)
                {
                    var span = mergedTree.GetLineSpan(method.Body.Span);
                    lines[name[3..]] = (span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1);
                }
        return new XifMergeResult(merged, changed, lines);
    }

    /// <summary>D8: the declared names of the parameters (Left for ssLeft) become ss&lt;Name&gt; where they do not resolve to
    /// another symbol. parameters: the stub's parameter names (ssLeft, ssRight, ssResult).</summary>
    public static string RewriteDeclaredNames(string body, IReadOnlyCollection<string> parameters, IReadOnlySet<string> classMembers)
    {
        var map = parameters.Where(p => p.Length > 2 && p.StartsWith("ss", StringComparison.Ordinal)).ToDictionary(p => p[2..], p => p, StringComparer.Ordinal);
        var normalized = body.Replace("\r\n", "\n").TrimEnd();
        if (map.Count == 0) return normalized;
        var wrapped = "{\n" + normalized + "\n}";
        if (SyntaxFactory.ParseStatement(wrapped, options: Parse) is not BlockSyntax block || block.ToFullString() != wrapped) return normalized;
        var shadowed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in block.DescendantNodes())
        {
            switch (node)
            {
                case VariableDeclaratorSyntax v: shadowed.Add(v.Identifier.ValueText); break;
                case ForEachStatementSyntax f: shadowed.Add(f.Identifier.ValueText); break;
                case CatchDeclarationSyntax c when c.Identifier.ValueText.Length > 0: shadowed.Add(c.Identifier.ValueText); break;
                case ParameterSyntax p: shadowed.Add(p.Identifier.ValueText); break;
                case SingleVariableDesignationSyntax d: shadowed.Add(d.Identifier.ValueText); break;
                case LocalFunctionStatementSyntax l: shadowed.Add(l.Identifier.ValueText); break;
                case LabeledStatementSyntax l: shadowed.Add(l.Identifier.ValueText); break;
            }
        }
        var rewritten = (BlockSyntax)new DeclaredNames(map, shadowed, classMembers).Visit(block);
        var text = rewritten.ToFullString();
        return text.Substring(2, text.Length - 4);
    }

    private sealed class DeclaredNames(Dictionary<string, string> map, HashSet<string> shadowed, IReadOnlySet<string> members) : CSharpSyntaxRewriter
    {
        public override SyntaxNode? VisitIdentifierName(IdentifierNameSyntax node)
        {
            var name = node.Identifier.ValueText;
            if (!map.TryGetValue(name, out var target) || shadowed.Contains(name) || members.Contains(name)) return node;
            switch (node.Parent)
            {
                case MemberAccessExpressionSyntax access when access.Name == node: return node;
                case QualifiedNameSyntax qualified when qualified.Right == node: return node;
                case MemberBindingExpressionSyntax: return node;
                case NameColonSyntax: return node;
                case NameEqualsSyntax: return node;
            }
            return node.WithIdentifier(SyntaxFactory.Identifier(node.Identifier.LeadingTrivia, target, node.Identifier.TrailingTrivia));
        }
    }

    /// <summary>The statements of a block as the spec writes them: without the braces and the common indentation.</summary>
    public static string BodyText(BlockSyntax block)
    {
        var text = block.SyntaxTree.GetText();
        var inner = text.ToString(TextSpan.FromBounds(block.OpenBraceToken.Span.End, block.CloseBraceToken.SpanStart)).Replace("\r\n", "\n");
        var lines = inner.Split('\n').ToList();
        if (lines.Count > 0 && string.IsNullOrWhiteSpace(lines[0])) lines.RemoveAt(0);
        while (lines.Count > 0 && string.IsNullOrWhiteSpace(lines[^1])) lines.RemoveAt(lines.Count - 1);
        var indent = lines.Where(l => l.Trim().Length > 0).Select(l => l.Length - l.TrimStart().Length).DefaultIfEmpty(0).Min();
        return string.Join("\n", lines.Select(l => l.Trim().Length == 0 ? "" : l[Math.Min(indent, l.Length - l.TrimStart().Length)..].TrimEnd()));
    }

    private static string Render(string signature, string separator, string body, string indent, string newline)
    {
        var lines = body.Replace("\r\n", "\n").Split('\n');
        var step = indent.Contains('\t') ? "\t" : "    ";
        var inner = string.Concat(lines.Select(l => (l.Trim().Length == 0 ? "" : indent + step + l.TrimEnd()) + newline));
        // A separator with a line break puts "{" on its own line at the method's indentation.
        var open = separator.Contains('\n') ? newline + indent + "{" : (separator.Length == 0 ? " " : separator) + "{";
        return signature + open + newline + inner + indent + "}";
    }

    private static string Signature(MethodDeclarationSyntax method)
    {
        var text = method.SyntaxTree.GetText();
        var end = method.Body?.OpenBraceToken.SpanStart ?? method.Span.End;
        return text.ToString(TextSpan.FromBounds(method.SpanStart, end)).TrimEnd();
    }

    private static bool SameSignature(MethodDeclarationSyntax a, MethodDeclarationSyntax b) =>
        SyntaxFactory.AreEquivalent(a.ParameterList, b.ParameterList) && SyntaxFactory.AreEquivalent(a.ReturnType, b.ReturnType) &&
        a.Modifiers.Select(m => m.ValueText).SequenceEqual(b.Modifiers.Select(m => m.ValueText));

    private static string Indent(string text, int position)
    {
        var start = text.LastIndexOf('\n', Math.Max(0, position - 1)) + 1;
        var prefix = text[start..position];
        return prefix.Trim().Length == 0 ? prefix : new string(prefix.TakeWhile(char.IsWhiteSpace).ToArray());
    }

    private static ClassDeclarationSyntax? Class(SyntaxNode root, string name) =>
        root.DescendantNodes().OfType<ClassDeclarationSyntax>().FirstOrDefault(c => c.Identifier.ValueText == name);

    private static Dictionary<string, MethodDeclarationSyntax> Methods(ClassDeclarationSyntax owner)
    {
        var found = new Dictionary<string, MethodDeclarationSyntax>(StringComparer.Ordinal);
        foreach (var method in owner.Members.OfType<MethodDeclarationSyntax>().Where(m => m.Identifier.ValueText.StartsWith("Mss", StringComparison.Ordinal)))
            found.TryAdd(method.Identifier.ValueText, method);
        return found;
    }

    private static IEnumerable<string> MemberNames(ClassDeclarationSyntax owner) => owner.Members.SelectMany(m => m switch
    {
        MethodDeclarationSyntax method => [method.Identifier.ValueText],
        PropertyDeclarationSyntax property => [property.Identifier.ValueText],
        FieldDeclarationSyntax field => field.Declaration.Variables.Select(v => v.Identifier.ValueText),
        EventFieldDeclarationSyntax e => e.Declaration.Variables.Select(v => v.Identifier.ValueText),
        BaseTypeDeclarationSyntax type => [type.Identifier.ValueText],
        _ => Array.Empty<string>(),
    });
}
