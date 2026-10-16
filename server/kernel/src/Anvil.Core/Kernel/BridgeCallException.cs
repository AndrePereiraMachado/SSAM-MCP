using System.Text.Json.Nodes;
namespace Anvil.Core;

/// <summary>Optional bounded, cancellable transport for read-only recovery observations. Null is no evidence.</summary>
public interface IBridgeProbeReader
{
    Task<JsonObject?> ReadProbeAsync(string method, JsonObject? parameters = null, int timeoutMs = 250);
}

/// <summary>A bridge call that failed. Executed says whether the bridge reports having run the write (null = unknown),
/// which is what Delivery uses to mark a write as not-sent or unknown. Thrown by the platform bridge clients
/// (Adapters.SS11/BridgeClient.cs today), read by the kernel.</summary>
public sealed class BridgeCallException : InvalidOperationException
{
    public bool? Executed { get; }
    public JsonObject? Stall { get; }
    public BridgeCallException(string message, bool? executed) : this(message, executed, null) { }
    public BridgeCallException(string message, bool? executed, JsonObject? stall) : base(message)
    {
        Executed = executed;
        Stall = stall?.DeepClone().AsObject();
    }
}
