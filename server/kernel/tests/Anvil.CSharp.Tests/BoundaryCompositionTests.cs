using System.Reflection;
using Xunit;

namespace Anvil.CSharp.Tests;

// Cross-feature source semantics. This is an informed regression fixture, not
// blind public-workflow evidence and not published O11 business execution.
public sealed class BoundaryCompositionTests
{
    private static string Source => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Cases", "boundary-composition", "BoundaryComposition.cs.txt"));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OmittedDefaultMutatesTheOriginalByteArrayThroughItsReadonlyView(bool sharedNativeStorage)
    {
        using var call = new ReferencePublicGraphTests.Call(Source, "Stamp", sharedNativeStorage);
        var state = call.New("Envelope"); var bytes = new byte[] { 255, 7 };
        var expectedState = call.New("Envelope"); var expectedBytes = new byte[] { 255, 7 };
        var expected = Clr(expectedState, "Stamp", expectedState, expectedBytes, Type.Missing);
        var actual = call.Invoke(state, bytes);
        Assert.Same(bytes, actual); Assert.Equal(expectedBytes, bytes);
        Assert.Same(bytes, call.Member(state, "Payload")); Assert.Same(bytes, call.Member(state, "View"));
        Assert.Same(expectedBytes, expected);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IndependentOmissionsKeepTheSelectedConcreteIdentity(bool array)
    {
        using var call = new ReferencePublicGraphTests.Call(Source, "Pick");
        object fallback = array ? new byte[] { 1, 2 } : new List<byte> { 1, 2 };
        var marker = call.New("Envelope");
        Assert.Null(call.Invoke());
        Assert.Same(fallback, Clr(marker, "Pick", Type.Missing, fallback));
        Assert.Same(fallback, call.Invoke(Type.Missing, fallback));
        Assert.Same(fallback, call.Invoke(null, fallback));
        Assert.Null(call.Invoke(null, null));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ReadonlyEnumerationAndArrayCastPreserveTheirConcreteRules(bool array)
    {
        using var sum = new ReferencePublicGraphTests.Call(Source, "Sum");
        object data = array ? new byte[] { 250, 5, 2 } : new List<byte> { 250, 5, 2 };
        var marker = sum.New("Envelope");
        Assert.Equal(Clr(marker, "Sum", data, Type.Missing), sum.Invoke(data));
        Assert.Equal(Clr(marker, "Sum", data, 1), sum.Invoke(data, 1));
        using var cast = new ReferencePublicGraphTests.Call(Source, "BackToArray");
        marker = cast.New("Envelope");
        if (array) Assert.Same(data, cast.Invoke(data));
        else
        {
            var expected = Assert.Throws<TargetInvocationException>(() => Clr(marker, "BackToArray", data)).InnerException!;
            var actual = Assert.Throws<InvalidCastException>(() => cast.Invoke(data));
            Assert.Equal(expected.GetType(), actual.GetType()); Assert.Equal(expected.Message, actual.Message);
        }
    }

    [Fact]
    public void TemporalDefaultsAndExplicitNullAreReconciledWithoutChangingSharedViews()
    {
        using var call = new ReferencePublicGraphTests.Call(Source, "Record");
        var state = call.New("Envelope"); var expected = call.New("Envelope");
        var bytes = new byte[] { 9 };
        state.GetType().GetProperty("Payload")!.SetValue(state, bytes);
        state.GetType().GetProperty("View")!.SetValue(state, bytes);
        var time = new DateTime(638929543234567891L, DateTimeKind.Utc);
        var offset = new DateTimeOffset(time).ToOffset(TimeSpan.FromHours(2));
        Clr(expected, "Record", expected, time, offset);
        Assert.Same(state, call.Invoke(state, time, offset));
        Assert.Equal(call.Member(expected, "Captured"), call.Member(state, "Captured"));
        Assert.Equal(((DateTime)call.Member(expected, "Captured")!).Kind, ((DateTime)call.Member(state, "Captured")!).Kind);
        Assert.Equal(call.Member(expected, "Offset"), call.Member(state, "Offset"));
        Assert.Equal(offset.Offset, ((DateTimeOffset)call.Member(state, "Offset")!).Offset);
        Clr(expected, "Record", expected, Type.Missing, Type.Missing);
        Assert.Same(state, call.Invoke(state));
        Assert.Equal(call.Member(expected, "Captured"), call.Member(state, "Captured"));
        Assert.Null(call.Member(state, "Offset"));
        Assert.Same(bytes, call.Member(state, "Payload")); Assert.Same(bytes, call.Member(state, "View"));
    }

    [Fact]
    public void OmittedHeaderLengthAllocatesNewZeroedArrays()
    {
        using var call = new ReferencePublicGraphTests.Call(Source, "NewHeader");
        var marker = call.New("Envelope");
        var expected = Assert.IsType<byte[]>(Clr(marker, "NewHeader", Type.Missing));
        var first = Assert.IsType<byte[]>(call.Invoke()); var second = Assert.IsType<byte[]>(call.Invoke());
        Assert.Equal(expected, first); Assert.Equal(expected, second); Assert.NotSame(first, second);
        Assert.Empty(Assert.IsType<byte[]>(call.Invoke(0)));
        Assert.Throws<OverflowException>(() => call.Invoke(-1));
    }

    private static object? Clr(object marker, string method, params object?[] values)
        => marker.GetType().Assembly.GetType("Rules")!.GetMethod(method)!.Invoke(null, values);
}
