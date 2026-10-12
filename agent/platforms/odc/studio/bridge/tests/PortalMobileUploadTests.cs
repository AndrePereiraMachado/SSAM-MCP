using System.Net;
using System.Text;
using Xunit;

public class PortalMobileUploadTests {
    private const string Host = "proof.outsystems.dev", User = "proof@example.test";
    private static readonly DateTimeOffset Now = new(2026, 10, 10, 10, 0, 0, TimeSpan.Zero);
    private const string ObjectUri = "https://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/c1a53070-e3b7-4f62-ba0d-cd99fac91159";
    // Actual observed bucket starts with 'te', not exclusively hexadecimal.
    private const string Signed = ObjectUri + "?X-Amz-Date=20261010T100000Z&X-Amz-Expires=600&X-Amz-Signature=private-test-capability";
    private sealed class Download(byte[] content) : HttpMessageHandler {
        internal int Sends;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
            Sends++; Assert.Equal(HttpMethod.Get, request.Method);Assert.Null(request.Headers.Authorization);Assert.False(request.Headers.Contains("Cookie"));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage=request, Content=new ByteArrayContent(content) });
        }
    }
    [Fact]
    public async Task SignedCapabilityNeverLeavesScopedResidentCacheAndCanBeConsumedOnce() {
        var bytes=Encoding.UTF8.GetBytes("public synthetic file");var handler=new Download(bytes);using var client=new HttpClient(handler);
        var id=Guid.NewGuid().ToString();var proof=await PortalMobileUpload.Capture(Host,User,id,Convert.ToBase64String(bytes),Signed,client,Now,CancellationToken.None);
        Assert.True((bool?)proof["contentVerified"]);Assert.False((bool?)proof["signedUriExposed"]);Assert.Equal(ObjectUri,(string?)proof["objectUri"]);
        Assert.DoesNotContain("private-test-capability",proof.ToJsonString());Assert.DoesNotContain("X-Amz",proof.ToJsonString());
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,"other.outsystems.dev",User,ObjectUri,Now,false));
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,"other@example.test",ObjectUri,Now,false));
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,ObjectUri+"other",Now,false));
        Assert.Equal(Signed,PortalMobileUpload.Resolve(id,Host,User,ObjectUri,Now,false));
        Assert.Equal(Signed,PortalMobileUpload.Resolve(id,Host,User,ObjectUri,Now,true));
        var missing=Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,ObjectUri,Now,true));Assert.DoesNotContain("private-test-capability",missing.Message);
        Assert.Equal(1,handler.Sends);
    }
    [Fact]
    public async Task ContentMismatchAndExpiredCapabilitiesCannotBeUsed() {
        var bytes=Encoding.UTF8.GetBytes("original");using var wrong=new HttpClient(new Download(Encoding.UTF8.GetBytes("different")));
        await Assert.ThrowsAsync<PortalCore.Refusal>(()=>PortalMobileUpload.Capture(Host,User,Guid.NewGuid().ToString(),Convert.ToBase64String(bytes),Signed,wrong,Now,CancellationToken.None));
        var handler=new Download(bytes);using var client=new HttpClient(handler);var id=Guid.NewGuid().ToString();
        await PortalMobileUpload.Capture(Host,User,id,Convert.ToBase64String(bytes),Signed,client,Now,CancellationToken.None);
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,ObjectUri,Now.AddMinutes(11),false));
        await Assert.ThrowsAsync<PortalCore.Refusal>(()=>PortalMobileUpload.Capture(Host,User,Guid.NewGuid().ToString(),Convert.ToBase64String(bytes),Signed,client,Now.AddMinutes(11),CancellationToken.None));
        Assert.Equal(1,handler.Sends);
    }
    [Theory]
    [InlineData("http://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/c1a53070-e3b7-4f62-ba0d-cd99fac91159")]
    [InlineData("https://attacker.example/tenants/uploads/c1a53070-e3b7-4f62-ba0d-cd99fac91159")]
    [InlineData("https://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/c1a53070-e3b7-4f62-ba0d-cd99fac91159?sig=%5BREDACTED%5D")]
    public void InvalidUploadEndpointsAreRejectedWithoutEcho(string value) {
        var error=Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.CheckUri(value));Assert.DoesNotContain(value,error.Message);
    }
}
