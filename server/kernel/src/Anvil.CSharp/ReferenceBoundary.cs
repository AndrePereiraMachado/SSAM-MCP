using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

internal enum BoundaryTypeKind { Value, Text, ObjectReference, ListReference, ArrayReference }

internal sealed record BoundaryRoot(ISymbol Symbol, ITypeSymbol Type, bool IsResult);
internal sealed record BoundaryType(ITypeSymbol Symbol, BoundaryTypeKind Kind)
{
    // A nullable annotation is a source warning contract, not a runtime null guard.
    internal bool CanBeNull => Symbol.IsReferenceType;
    internal bool HasIdentity => Kind is BoundaryTypeKind.ObjectReference or BoundaryTypeKind.ListReference or BoundaryTypeKind.ArrayReference;
}

/// <summary>
/// Describes the source signature independently of body effects and legacy native DTO transport.
/// This inventory selects the graph ABI only in the staged compiler entry. It is not
/// itself a codec or evidence that the default authoring/controller path is integrated.
/// </summary>
internal sealed class ReferenceBoundary
{
    internal IMethodSymbol Method { get; }
    internal bool IsPublicEntry { get; }
    internal IReadOnlyList<BoundaryRoot> Roots { get; }
    internal IReadOnlyList<BoundaryType> Types { get; }
    internal bool RequiresIdentityCodec => Types.Any(type => type.HasIdentity);
    internal bool RequiresTemporalCodec => Types.Any(type => TemporalModel.Kind(type.Symbol) != TemporalKind.None);
    internal bool RequiresSourceCodec => RequiresIdentityCodec || RequiresTemporalCodec;

    private ReferenceBoundary(IMethodSymbol method, IReadOnlyList<BoundaryRoot> roots, IReadOnlyList<BoundaryType> types)
    {
        Method = method;
        IsPublicEntry = method.IsStatic && (method.DeclaredAccessibility == Accessibility.Public ||
            SourceProgram.Attribute(method, "Anvil.Authoring.ServiceActionAttribute") != null);
        Roots = roots; Types = types;
    }

    internal static ReferenceBoundary Analyze(IMethodSymbol method)
    {
        var roots = method.Parameters.Where(parameter => !LogicModel.DataDependency(parameter.Type))
            .Select(parameter => new BoundaryRoot(parameter, parameter.Type, false)).ToList();
        if (!method.ReturnsVoid) roots.Add(new(method, method.ReturnType, true));
        var types = new List<BoundaryType>();
        var visited = new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default);
        if (!method.IsStatic && method.MethodKind == MethodKind.Ordinary) Visit(method.ContainingType);
        foreach (var root in roots) Visit(root.Type);
        return new(method, roots, types);

        void Visit(ITypeSymbol source)
        {
            var type = source.WithNullableAnnotation(NullableAnnotation.NotAnnotated);
            if (!visited.Add(type)) return;
            if (type.SpecialType == SpecialType.System_String)
            {
                types.Add(new(type, BoundaryTypeKind.Text));
                return;
            }
            if (type is IArrayTypeSymbol array)
            {
                types.Add(new(type, BoundaryTypeKind.ArrayReference));
                Visit(array.ElementType);
                return;
            }
            if (type is INamedTypeSymbol named)
            {
                if (named.IsGenericType && named.OriginalDefinition.ToDisplayString() is
                    "System.Collections.Generic.List<T>" or "System.Collections.Generic.IReadOnlyList<T>")
                {
                    types.Add(new(type, BoundaryTypeKind.ListReference));
                    Visit(named.TypeArguments[0]);
                    return;
                }
                types.Add(new(type, type.IsReferenceType ? BoundaryTypeKind.ObjectReference : BoundaryTypeKind.Value));
                if (named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
                    Visit(named.TypeArguments[0]);
                // Follow runtime state, including private and NotMapped members. A DTO's public
                // fields cannot establish that the complete C# object has been transported.
                else if (named.Locations.Any(location => location.IsInSource))
                    foreach (var member in SourceMember.Of(named)) Visit(member.Type);
                // Framework value types such as Id<T> are values. Their generic arguments are
                // not instance state; visiting Id<Entity>'s T would invent an entity reference.
                return;
            }
            types.Add(new(type, type.IsReferenceType ? BoundaryTypeKind.ObjectReference : BoundaryTypeKind.Value));
        }
    }
}
