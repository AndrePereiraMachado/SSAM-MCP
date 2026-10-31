using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// F7 (25/10/2026): the shared sources the owner's SOAP delivery changed answer on the ODC build as on O11, where the lane
/// has the same rule: an integration op without `data` is wrapped (OP_DATA_WRAPPED) and a soap op is still
/// SOAP_LANE_UNSUPPORTED on ODC (the kernel's SoapOp, unchanged). Pure: no Studio.
/// </summary>
public class SoapWireSharedOdcTests
{
    [Fact]
    public void ASoapOpWithoutDataIsWrappedAndStaysASoapOp()
    {
        var ops = new JsonArray(JsonNode.Parse("""{"op":"soap","wsdl":"https://example.com/S.asmx?WSDL","client":"S","methods":["Do"]}"""),
            JsonNode.Parse("""{"op":"rest-expose","service":{"name":"Svc"},"methods":[]}"""));
        var done = JobNormalizer.Pure(ops, "/ops", "odc").Where(n => n["rule"]!.ToString() == JobNormalizer.DataWrapped).ToList();
        Assert.Equal(["/ops/0", "/ops/1"], done.Select(d => d["path"]!.ToString()));
        Assert.Equal(["op", "data"], ops[0]!.AsObject().Select(p => p.Key));
        Assert.Equal(["service", "methods"], ops[1]!["data"]!.AsObject().Select(p => p.Key));
        VerbSurface.Check(ops[0]!.AsObject());
        // The import request is O11's (IntegrationImport): it reads the op the same way.
        Assert.Equal("soap", ops[0]!["op"]!.ToString());
    }
}
