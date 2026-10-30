using System.Numerics;
using System.Security.Cryptography;

namespace Ssam.Agent;

internal static class BridgeTrust
{
    // Build-time constants only. The owner's watcher script supplies the real anchors.
    internal const string ManifestPublicKey = "";
    internal const string AuthenticodeThumbprint = "";
    internal static readonly string[] MicrosoftRoots = ["847DF6A78497943F27FC72EB93F9A637320A02B561D0A91B09E87A7807ED7C61"];
    internal const string MacVerifier = "tools/osslsigncode";

    // Strict RFC 8032 verification over public data. No signing or secret scalar operations.
    // Reject non-canonical encodings, small-order points and non-prime-order public keys.
    private static readonly BigInteger P = (BigInteger.One << 255) - 19;
    private static readonly BigInteger L = (BigInteger.One << 252) + BigInteger.Parse("27742317777372353535851937790883648493");
    private static BigInteger Mod(BigInteger n) => (n % P + P) % P;
    private static BigInteger Inv(BigInteger n) => BigInteger.ModPow(Mod(n), P - 2, P);
    private static readonly BigInteger D = Mod(-121665 * Inv(121666));
    private readonly record struct Point(BigInteger X, BigInteger Y);
    private static readonly Point Identity = new(0, 1);
    private static Point Add(Point a, Point b)
    {
        var product = Mod(D * a.X * b.X * a.Y * b.Y);
        return new(Mod((a.X * b.Y + a.Y * b.X) * Inv(1 + product)), Mod((a.Y * b.Y + a.X * b.X) * Inv(1 - product)));
    }
    private static Point Multiply(Point p, BigInteger n)
    {
        var result = Identity;
        while (n > 0) { if (!n.IsEven) result = Add(result, p); p = Add(p, p); n >>= 1; }
        return result;
    }
    private static Point Decode(ReadOnlySpan<byte> encoded)
    {
        var bytes = encoded.ToArray();
        var sign = bytes[31] >> 7; bytes[31] &= 127;
        var y = new BigInteger(bytes, true, false);
        if (y >= P) throw new CryptographicException();
        var square = Mod((y * y - 1) * Inv(D * y * y + 1));
        var x = BigInteger.ModPow(square, (P + 3) / 8, P);
        if (Mod(x * x) != square) x = Mod(x * BigInteger.ModPow(2, (P - 1) / 4, P));
        if (Mod(x * x) != square || x == 0 && sign != 0) throw new CryptographicException();
        if ((x.IsEven ? 0 : 1) != sign) x = P - x;
        return new(x, y);
    }
    internal static bool Verify(byte[] message, byte[] signature, string publicKey)
    {
        try
        {
            if (signature.Length != 64) return false;
            var der = Convert.FromBase64String(publicKey.Replace("-----BEGIN PUBLIC KEY-----", "").Replace("-----END PUBLIC KEY-----", ""));
            if (der.Length != 44 || !der.AsSpan(0, 12).SequenceEqual(Convert.FromHexString("302a300506032b6570032100"))) return false;
            var key = der.AsSpan(12, 32).ToArray();
            var a = Decode(key); var r = Decode(signature.AsSpan(0, 32));
            var s = new BigInteger(signature.AsSpan(32), true, false);
            if (s >= L || Multiply(a, 8) == Identity || Multiply(r, 8) == Identity || Multiply(a, L) != Identity) return false;
            var input = signature.AsSpan(0, 32).ToArray().Concat(key).Concat(message).ToArray();
            var h = new BigInteger(SHA512.HashData(input), true, false) % L;
            var b = new Point(BigInteger.Parse("15112221349535400772501151409588531511454012693041857206046113283949847762202"),
                BigInteger.Parse("46316835694926478169428394003475163141307993866256225615783033603165251855960"));
            return Multiply(b, s) == Add(r, Multiply(a, h));
        }
        catch (Exception e) when (e is FormatException or CryptographicException or ArgumentException) { return false; }
    }
}
