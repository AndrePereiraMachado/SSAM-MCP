using Xunit;
using Anvil.Core;
namespace Anvil.Tests.Odc;
public sealed class OdcFallbackAuditTests {
    public OdcFallbackAuditTests() => StudioAssembliesOdc.Bind();
    [Fact]
    public void MissingDiagnosticMembersNeverStopFallbackOrPoisonTheNextRead() {
        var first=NativeMergeIntent.ReadForFallback(null!,null!,()=>throw new MissingMemberException("Match.Properties"));
        Assert.Empty(first.Changes);
        Assert.Contains("Match.Properties",first.Unavailable);
        var value=new NativeMergeIntent.Change("key","Action:A","Description","base","person",false,[]);
        var second=NativeMergeIntent.ReadForFallback(null!,null!,()=>[value]);
        Assert.Null(second.Unavailable);
        Assert.Equal("person",Assert.Single(second.Changes).Delivery);
    }
}
