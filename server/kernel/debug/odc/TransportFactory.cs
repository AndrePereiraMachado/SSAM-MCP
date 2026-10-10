// ODC: REST commands and the SignalR events hub, as ODC Studio.
internal static class TransportFactory {
    internal static IDebugTransport Create(Configuration config) => new NativeTransport(config);
}
