using ServiceStudio.Model;
using ServiceStudio.Scope;

namespace Anvil.Core;

/// <summary>ODC side of FunctionCatalog.Visibility. ODC's descriptor keeps ClientSide, ServerQueries and ClientQueries
/// as predicates over the owner module (Func&lt;ESpace, bool&gt;). The catalog is module-independent, so a predicate is
/// evaluated without a module: constant predicates answer directly; one that needs the module counts as visible
/// (the module-level Verify still decides the concrete case).</summary>
public static partial class FunctionCatalog
{
    private static partial (bool Logic, bool ClientSide, bool ServerAggregates, bool ClientAggregates, bool Emails) Visibility(BuiltinFunctions.BuiltinFunctionDescriptor descriptor)
        => (descriptor.IsVisibleInScripts, Evaluate(descriptor.IsVisibleInClientSide), Evaluate(descriptor.IsVisibleInServerQueriesExpression), Evaluate(descriptor.IsVisibleInClientQueriesExpression), descriptor.IsVisibleInNREmails);

    private static bool Evaluate(Func<ESpace, bool>? predicate)
    {
        if (predicate == null) return false;
        try { return predicate(null!); } catch (NullReferenceException) { return true; }
    }
}
