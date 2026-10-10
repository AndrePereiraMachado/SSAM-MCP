using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

/// <summary>Exception identity is defined by BCL symbols, not source-spelled type names.</summary>
internal static class ExceptionTypes
{
    internal static INamedTypeSymbol Root(Compilation compilation)
        => compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly.GetTypeByMetadataName("System.Exception")
            ?? throw new InvalidOperationException("The BCL exception root is unavailable");
    internal static bool IsException(ITypeSymbol? type, Compilation compilation)
        => type != null && DerivesFrom(type, Root(compilation));
    internal static bool DerivesFrom(ITypeSymbol type, ITypeSymbol parent)
    {
        for (var current = type as INamedTypeSymbol; current != null; current = current.BaseType)
            if (SymbolEqualityComparer.Default.Equals(current.WithNullableAnnotation(NullableAnnotation.NotAnnotated), parent.WithNullableAnnotation(NullableAnnotation.NotAnnotated))) return true;
        return false;
    }
    internal static bool Contains(ITypeSymbol type, Compilation compilation, HashSet<ITypeSymbol>? visited = null)
    {
        if (IsException(type, compilation)) return true;
        visited ??= new(SymbolEqualityComparer.Default);
        if (!visited.Add(type.WithNullableAnnotation(NullableAnnotation.NotAnnotated))) return false;
        if (type is IArrayTypeSymbol array) return Contains(array.ElementType, compilation, visited);
        if (type is not INamedTypeSymbol named) return false;
        if (named.IsGenericType && named.OriginalDefinition.ToDisplayString() is "System.Collections.Generic.List<T>" or "System.Collections.Generic.IReadOnlyList<T>"
            || named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            return named.TypeArguments.Any(item => Contains(item, compilation, visited));
        return named.Locations.Any(location => location.IsInSource) && SourceMember.Of(named).Any(member => Contains(member.Type, compilation, visited));
    }
    internal static readonly IReadOnlyDictionary<string, (string Message, int HResult)> Builtins = new Dictionary<string, (string, int)>(StringComparer.Ordinal) {
        ["System.Exception"] = ("Exception of type 'System.Exception' was thrown.", unchecked((int)0x80131500)),
        ["System.SystemException"] = ("System error.", unchecked((int)0x80131501)),
        ["System.ApplicationException"] = ("Error in the application.", unchecked((int)0x80131600)),
        ["System.ArgumentException"] = ("Value does not fall within the expected range.", unchecked((int)0x80070057)),
        ["System.ArgumentNullException"] = ("Value cannot be null.", unchecked((int)0x80004003)),
        ["System.ArgumentOutOfRangeException"] = ("Specified argument was out of the range of valid values.", unchecked((int)0x80131502)),
        ["System.InvalidOperationException"] = ("Operation is not valid due to the current state of the object.", unchecked((int)0x80131509)),
        ["System.NullReferenceException"] = ("Object reference not set to an instance of an object.", unchecked((int)0x80004003)),
        ["System.IndexOutOfRangeException"] = ("Index was outside the bounds of the array.", unchecked((int)0x80131508)),
        ["System.OverflowException"] = ("Arithmetic operation resulted in an overflow.", unchecked((int)0x80131516)),
        ["System.DivideByZeroException"] = ("Attempted to divide by zero.", unchecked((int)0x80020012)),
        ["System.NotSupportedException"] = ("Specified method is not supported.", unchecked((int)0x80131515)),
        ["System.InvalidCastException"] = ("Specified cast is not valid.", unchecked((int)0x80004002)),
        ["System.FormatException"] = ("One of the identified items was in an invalid format.", unchecked((int)0x80131537))
    };
    // SourceProgram binds to the running BCL. Null-message constructor behavior changed
    // between CLR versions; ask only these whitelisted BCL types, never authored code.
    internal static readonly IReadOnlyDictionary<string, string> NullMessages = Builtins.Keys.ToDictionary(name => name, name => {
        var type = typeof(Exception).Assembly.GetType(name, throwOnError: true)!;
        var parameters = name is "System.ArgumentNullException" or "System.ArgumentOutOfRangeException"
            ? new[] { typeof(string), typeof(string) } : new[] { typeof(string) };
        return ((Exception)type.GetConstructor(parameters)!.Invoke(new object?[parameters.Length])).Message;
    }, StringComparer.Ordinal);
}
