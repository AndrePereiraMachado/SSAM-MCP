// Owner-preserving native breakpoint ids (ODC Studio ExtendedBreakpointId(OwnerESpace.Key, node), O11 the same):
// .local/debugger/odc-library-breakpoint-contract/findings.json. Shared by both lanes; runs under tests-o11 and tests-odc.
internal static class BreakpointOwnerTests {
    const string Library = "AwMDAwMDAwMDAwMDAwMDAw", LibraryNode = "BAQEBAQEBAQEBAQEBAQEBA", Third = "BQUFBQUFBQUFBQUFBQUFBQ";
    static string Id(string owner, string node) => owner + ":" + node + "::";
    static void Refused(Action action, string code, string message) {
        try { action(); throw new Exception(message + " accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == code, message + ": " + e.Message); }
    }
    static Configuration Config() => new() { SessionId = Guid.NewGuid().ToString("N"), Module = "Fixture", RuntimeUrl = "https://example.invalid/App/",
        ModuleKey = Tests.ModuleKey, NodeKeys = [Tests.NodeKey, LibraryNode], AutoContinue = false };
    internal static void Run() {
        // Single owner: byte-identical to the previous session-keyed serialization, for both native ToString forms.
        var config = Config();
        foreach (var compound in new[] { true, false }) {
            Tests.Check(BreakpointOwners.Ids(config, scopesRequired: false, compound) == Id(Tests.ModuleKey, Tests.NodeKey) + "," + Id(Tests.ModuleKey, LibraryNode),
                "single-owner breakpoints changed");
        }
        // Explicit per-node owners (consumer + library pair) are serialized node by node.
        config.NodeModuleKeys = new() { [Tests.NodeKey] = Tests.ModuleKey, [LibraryNode] = Library };
        config.Validate();
        Tests.Check(BreakpointOwners.Ids(config, scopesRequired: false, true) == Id(Tests.ModuleKey, Tests.NodeKey) + "," + Id(Library, LibraryNode),
            "per-node owners not preserved");
        // A map that omits a breakpoint node never falls back to the session module.
        config.NodeModuleKeys = new() { [Tests.NodeKey] = Tests.ModuleKey };
        Refused(() => BreakpointOwners.Ids(config, false, true), "debug_breakpoint_owner_required", "missing owner");
        Refused(config.Validate, "debug_breakpoint_owner_required", "missing owner at validation");
        // Owners outside the session module plus one partner are refused before any native call.
        config.NodeKeys = [Tests.NodeKey, LibraryNode, Tests.ModuleKey];
        config.NodeModuleKeys = new() { [Tests.NodeKey] = Library, [LibraryNode] = Third, [Tests.ModuleKey] = Tests.ModuleKey };
        Refused(config.Validate, "debug_breakpoint_owner_required", "three owners");
        config.NodeKeys = [Tests.NodeKey, LibraryNode];
        config.NodeModuleKeys = new() { [Tests.NodeKey] = Tests.ModuleKey, [LibraryNode] = "not-a-key" };
        Refused(config.Validate, "debug_invalid_breakpoint_owners", "malformed owner");
        config.NodeModuleKeys = new() { [Tests.NodeKey] = Tests.ModuleKey, [LibraryNode] = Library, [Third] = Library };
        Refused(config.Validate, "debug_invalid_breakpoint_owners", "owner for a node that is not a breakpoint");
        // Inspection scopes name owners too; a scope and the map must agree, and one node has one owner.
        config.NodeModuleKeys = null;
        config.Inspection = new() { Scopes = [
            new() { ModuleKey = Tests.ModuleKey, FunctionKey = Tests.NodeKey, NodeKey = Tests.NodeKey, SourceSha256 = new string('a', 64) },
            new() { ModuleKey = Library, FunctionKey = LibraryNode, NodeKey = LibraryNode, SourceSha256 = new string('b', 64) }] };
        foreach (var required in new[] { true, false })
            Tests.Check(BreakpointOwners.Ids(config, required, false) == Id(Tests.ModuleKey, Tests.NodeKey) + "," + Id(Library, LibraryNode),
                "scope owners not preserved (scopesRequired=" + required + ")");
        config.NodeModuleKeys = new() { [Tests.NodeKey] = Tests.ModuleKey, [LibraryNode] = Tests.ModuleKey };
        Refused(() => BreakpointOwners.Ids(config, false, true), "debug_breakpoint_owner_required", "map contradicting a scope owner");
        config.NodeModuleKeys = null;
        config.Inspection.Scopes = [config.Inspection.Scopes[0], config.Inspection.Scopes[1],
            new() { ModuleKey = Library, FunctionKey = LibraryNode, NodeKey = Tests.NodeKey, SourceSha256 = new string('b', 64) }];
        foreach (var required in new[] { true, false })
            Refused(() => BreakpointOwners.Ids(config, required, true), "debug_breakpoint_owner_required", "ambiguous scope owner");
        // A node without scope keeps the session owner only where the lane does not require scope owners.
        config.Inspection.Scopes = [config.Inspection.Scopes[0]];
        Tests.Check(BreakpointOwners.Ids(config, false, true) == Id(Tests.ModuleKey, Tests.NodeKey) + "," + Id(Tests.ModuleKey, LibraryNode), "unscoped ODC node lost the session owner");
        Refused(() => BreakpointOwners.Ids(config, true, true), "debug_breakpoint_owner_required", "unscoped O11 node");
#if !ODC
        // O11 SoapTransport keeps its exact previous behaviour through the shared owner logic.
        var soap = new Configuration { ModuleKey = Tests.ModuleKey, NodeKeys = [Tests.NodeKey, LibraryNode] };
        Tests.Check(SoapTransport.BreakpointIds(soap) == BreakpointOwners.Ids(soap, true, false), "O11 legacy owner changed");
        soap.Inspection = new() { Scopes = [
            new() { ModuleKey = Tests.ModuleKey, FunctionKey = Tests.NodeKey, NodeKey = Tests.NodeKey, SourceSha256 = new string('a', 64) },
            new() { ModuleKey = Library, FunctionKey = LibraryNode, NodeKey = LibraryNode, SourceSha256 = new string('b', 64) }] };
        Tests.Check(SoapTransport.BreakpointIds(soap) == Id(Tests.ModuleKey, Tests.NodeKey) + "," + Id(Library, LibraryNode), "O11 scope owners changed");
        soap.NodeModuleKeys = new() { [Tests.NodeKey] = Tests.ModuleKey, [LibraryNode] = Library };
        Tests.Check(SoapTransport.BreakpointIds(soap) == Id(Tests.ModuleKey, Tests.NodeKey) + "," + Id(Library, LibraryNode), "O11 explicit owners lost");
#endif
        Console.WriteLine("PASS: owner-preserving native breakpoint ids");
    }
}
