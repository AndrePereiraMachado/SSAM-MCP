using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Ssam.Cryptography;
using Xunit;

public class CognitoSrpTests
{
    [Fact]
    public void ClientProofMatchesIndependentServerCalculation()
    {
        var prime = (string)typeof(CognitoSrp).GetField("Prime", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.GetRawConstantValue()!;
        var n = BigInteger.Parse("0" + prime, NumberStyles.HexNumber);
        static byte[] Pad(BigInteger x) { var bytes = x.ToByteArray(isUnsigned: true, isBigEndian: true); return bytes[0] >= 128 ? new byte[] { 0 }.Concat(bytes).ToArray() : bytes; }
        static BigInteger HashNumber(byte[] x) => new(SHA256.HashData(x), isUnsigned: true, isBigEndian: true);
        var k = HashNumber(Pad(n).Concat(Pad(2)).ToArray());
        var salt = new BigInteger(128); var b = new BigInteger(123456789);
        var x = HashNumber(Pad(salt).Concat(SHA256.HashData(Encoding.UTF8.GetBytes("Poolcanonical-user:pässword-测试"))).ToArray());
        var verifier = BigInteger.ModPow(2, x, n);
        var serverB = (k * verifier + BigInteger.ModPow(2, b, n)) % n;
        using var client = new CognitoSrp("123456789abcdef");
        var a = BigInteger.Parse("0" + client.PublicA, NumberStyles.HexNumber);
        var u = HashNumber(Pad(a).Concat(Pad(serverB)).ToArray());
        // Server uses verifier and b; it has no access to the client's ephemeral a.
        var shared = BigInteger.ModPow(a * BigInteger.ModPow(verifier, u, n) % n, b, n);
        var prk = HMACSHA256.HashData(Pad(u), Pad(shared));
        var key = HMACSHA256.HashData(prk, Encoding.UTF8.GetBytes("Caldera Derived Key\u0001"))[..16];
        const string time = "Tue Nov 3 18:00:00 UTC 2026";
        var block = Encoding.UTF8.GetBytes("synthetic-secret-block");
        var expected = Convert.ToBase64String(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes("Poolcanonical-user").Concat(block).Concat(Encoding.UTF8.GetBytes(time)).ToArray()));
        Assert.Equal(expected, client.Sign("Pool", "canonical-user", "pässword-测试", serverB.ToString("x").TrimStart('0'), "80", Convert.ToBase64String(block), time));
        Assert.Throws<InvalidOperationException>(() => client.Sign("Pool", "canonical-user", "pässword-测试", "5", "80", Convert.ToBase64String(block), time));
    }
    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("not-hex")]
    public void RejectsInvalidServerPublicValues(string value)
    {
        using var client = new CognitoSrp();
        Assert.Throws<ArgumentException>(() => client.Sign("Pool", "user", "password", value, "80", "YQ==", "time"));
    }
    [Fact]
    public void TimestampIsInvariantAndPublicValuesAreFresh()
    {
        using var first = new CognitoSrp(); using var second = new CognitoSrp();
        Assert.NotEqual(first.PublicA, second.PublicA);
        Assert.Equal("Tue Nov 3 18:00:00 UTC 2026", CognitoSrp.Timestamp(new DateTime(2026, 11, 3, 18, 0, 0, DateTimeKind.Utc)));
    }
}
