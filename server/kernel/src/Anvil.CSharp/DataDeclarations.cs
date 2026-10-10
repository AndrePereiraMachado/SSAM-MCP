using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Anvil.CSharp;

/// <summary>Reject executable data declarations until their behavior has a corresponding logic translation.</summary>
internal static class DataDeclarations
{
    internal static void Validate(SourceProgram program)
    {
        foreach (var tree in program.Compilation.SyntaxTrees)
        foreach (var node in tree.GetRoot().DescendantNodes())
        {
            switch (node)
            {
                case PropertyDeclarationSyntax property when property.ExpressionBody != null ||
                    property.AccessorList?.Accessors.Any(a => a.Body != null || a.ExpressionBody != null) == true:
                    throw SourceProgram.Error("AVCS102", "Computed properties/accessors require logic translation; their code cannot become a stored field", property);
                case ConstructorDeclarationSyntax constructor:
                    throw SourceProgram.Error("AVCS103", "Explicit constructors require logic translation; their behavior is not inferred from the data shape", constructor);
                case IndexerDeclarationSyntax indexer:
                    throw SourceProgram.Error("AVCS104", "Indexers require logic translation", indexer);
                case EventFieldDeclarationSyntax field:
                    throw SourceProgram.Error("AVCS104", "Events require logic translation", field);
                case FieldDeclarationSyntax field:
                    foreach (var variable in field.Declaration.Variables)
                    {
                        var symbol = program.Model(variable).GetDeclaredSymbol(variable) as IFieldSymbol;
                        if (symbol is { IsConst: true }) continue;
                        if (symbol is { IsStatic: true, IsReadOnly: true, DeclaredAccessibility: Accessibility.Public } &&
                            SourceProgram.Attribute(symbol.ContainingType, "Anvil.Authoring.StaticEntityAttribute") != null &&
                            SymbolEqualityComparer.Default.Equals(symbol.Type, symbol.ContainingType)) continue;
                        if (symbol is { IsStatic: false } &&
                            SourceProgram.Attribute(symbol.ContainingType, "Anvil.Authoring.EntityAttribute") == null &&
                            SourceProgram.Attribute(symbol.ContainingType, "System.ComponentModel.DataAnnotations.Schema.TableAttribute") == null &&
                            SourceProgram.Attribute(symbol.ContainingType, "Anvil.Authoring.StaticEntityAttribute") == null) continue;
                        throw SourceProgram.Error("AVCS104", "Static or persisted field state requires a storage translation; it is not silently discarded", variable);
                    }
                    break;
            }
        }
    }
}
