// O11: lane seam for the platform 11 transport (Service Studio 11 uses SOAP commands and polled XML events).
internal static class TransportFactory {
    internal static IDebugTransport Create(Configuration config) => new SoapTransport(config);
}
