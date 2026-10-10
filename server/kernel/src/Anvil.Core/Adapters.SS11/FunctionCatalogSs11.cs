using ServiceStudio.Scope;

namespace Anvil.Core;

/// <summary>SS11 side of FunctionCatalog.Visibility: the descriptor carries the five flags as booleans.</summary>
public static partial class FunctionCatalog
{
    private static partial (bool Logic, bool ClientSide, bool ServerAggregates, bool ClientAggregates, bool Emails) Visibility(BuiltinFunctions.BuiltinFunctionDescriptor descriptor)
        => (descriptor.IsVisibleInScripts, descriptor.IsVisibleInClientSide, descriptor.IsVisibleInServerQueries, descriptor.IsVisibleInClientQueries, descriptor.IsVisibleInNREmails);
}
