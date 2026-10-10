using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Anvil.CSharp;

/// <summary>One source member identity for data layouts and invocation-local Places.
/// Runtime initialization is executable source; it is never a persisted default.</summary>
internal sealed record SourceMember(ISymbol Symbol)
{
    internal string Name => Symbol.Name;
    internal ITypeSymbol Type => Symbol switch { IPropertySymbol p => p.Type, IFieldSymbol f => f.Type, _ => throw new InvalidOperationException() };
    internal bool Mutable => Symbol is IFieldSymbol { IsReadOnly: false } or IPropertySymbol { SetMethod.IsInitOnly: false };
    internal ExpressionSyntax? Initializer => Symbol.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).Select(n => n switch {
        PropertyDeclarationSyntax p => p.Initializer?.Value, VariableDeclaratorSyntax f => f.Initializer?.Value, _ => null
    }).FirstOrDefault(n => n != null);
    internal static IEnumerable<SourceMember> Of(INamedTypeSymbol type) => type.GetMembers()
        .Where(s => s is IPropertySymbol { IsStatic: false, IsIndexer: false }
            or IFieldSymbol { IsStatic: false, IsConst: false, IsImplicitlyDeclared: false })
        .Where(s => s is not IPropertySymbol { IsImplicitlyDeclared: true } || s.DeclaredAccessibility == Accessibility.Public)
        .OrderBy(s => s.Locations.FirstOrDefault()?.SourceSpan.Start ?? int.MaxValue).Select(s => new SourceMember(s));
    internal static IEnumerable<(SourceMember Member, ExpressionSyntax Expression)> Initializers(INamedTypeSymbol type, Compilation compilation)
    {
        // Spans are local to their tree. Executable initializers follow the compiler's
        // tree order first; this does not change the order of storage/layout members.
        var treeOrder = compilation.SyntaxTrees.Select((tree, index) => (tree, index)).ToDictionary(p => p.tree, p => p.index);
        return Of(type).Select(member => (Member: member, Expression: member.Initializer))
            .Where(p => p.Expression != null)
            .OrderBy(p => treeOrder[p.Expression!.SyntaxTree]).ThenBy(p => p.Expression!.SpanStart)
            .Select(p => (p.Member, p.Expression!));
    }
    internal static IEnumerable<SourceMember> Data(INamedTypeSymbol type) => Of(type)
        .Where(m => m.Symbol.DeclaredAccessibility == Accessibility.Public && SourceProgram.Attribute(m.Symbol, "System.ComponentModel.DataAnnotations.Schema.NotMappedAttribute") == null);
}
