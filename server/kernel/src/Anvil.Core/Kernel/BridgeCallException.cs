namespace Anvil.Core;

/// <summary>A bridge call that failed. Executed says whether the bridge reports having run the write (null = unknown),
/// which is what Delivery uses to mark a write as not-sent or unknown. Thrown by the platform bridge clients
/// (Adapters.SS11/BridgeClient.cs today), read by the kernel.</summary>
public sealed class BridgeCallException(string message, bool? executed) : InvalidOperationException(message)
{
    public bool? Executed { get; } = executed;
}
