namespace Anvil.Core;

/// <summary>One public Verify message id of the installed IDE, as the platform adapter reads it (was in Adapters.SS11/VerifyCatalog.cs).</summary>
public sealed record VerifyDefinition(string Id, string Severity, string Title, string Detail);
