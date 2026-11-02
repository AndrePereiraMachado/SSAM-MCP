using Ssam.Agent;
using Xunit;

// agent/r4-prefer-foreign (0.4.6-native, thin O11 bridge 1.2.0): the hello's agent.o11Methods declares merge_from_oml:prefer_foreign
// after the methods o11.bridge passes, so the server sends merge_from_oml {prefer:"foreign"} only to an agent that ships the bridge
// that resolves a conflict with the person's edits inside the Studio's merge. It is no method: o11.bridge never passes it.
public class PreferForeignHelloTests
{
    [Fact]
    public void TheHelloDeclaresPreferForeignAfterTheMethodsAndItIsNeverPassed()
    {
        Assert.Equal("merge_from_oml:prefer_foreign", StudioKinds.O11PreferForeign);
        Assert.Equal([.. StudioKinds.O11MethodList, "merge_from_oml:prefer_foreign"], StudioKinds.O11DeclaredList);
        Assert.DoesNotContain(StudioKinds.O11PreferForeign, StudioKinds.O11Methods);
        Assert.Equal(24, StudioKinds.O11MethodList.Length);
    }
}