using System;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Ssam.Cryptography
{
    // Cognito SRP-6a (3072-bit group, SHA-256, Cognito's 16-byte HKDF).
    // Shared source: Native AOT on macOS and the private PowerShell helper on Windows.
    public sealed class CognitoSrp : IDisposable
    {
        private const string Prime =
            "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
            "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
            "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
            "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
            "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
            "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
            "83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
            "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
            "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
            "DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
            "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64" +
            "ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
            "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B" +
            "F12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
            "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31" +
            "43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";
        private static readonly BigInteger N = Number(Prime);
        private static readonly BigInteger G = new BigInteger(2);
        private static readonly BigInteger K = Number(Hex(Hash(Bytes(Pad(N) + Pad(G)))));
        private BigInteger a;
        private readonly BigInteger A;
        private bool used;
        public CognitoSrp() : this(RandomHex()) { }
        internal CognitoSrp(string privateHex)
        {
            a = Number(privateHex);
            if (a <= 0 || a >= N) throw new ArgumentException("Invalid SRP ephemeral.");
            A = BigInteger.ModPow(G, a, N);
        }
        public string PublicA { get { return A.ToString("x", CultureInfo.InvariantCulture).TrimStart('0'); } }
        public static string Timestamp(DateTime utc) { return utc.ToUniversalTime().ToString("ddd MMM d HH:mm:ss 'UTC' yyyy", CultureInfo.InvariantCulture); }
        private static BigInteger Number(string hex)
        {
            if (hex == null || hex.Length == 0 || hex.Length > 768 || !Regex.IsMatch(hex, "\\A[0-9a-fA-F]+\\z")) throw new ArgumentException("Invalid SRP number.");
            return BigInteger.Parse("0" + hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }
        private static string Pad(BigInteger n)
        {
            var hex = n.ToString("x", CultureInfo.InvariantCulture).TrimStart('0');
            if (hex.Length == 0) hex = "0";
            if (hex.Length % 2 != 0) hex = "0" + hex;
            else if (hex[0] >= '8') hex = "00" + hex;
            return hex;
        }
        private static byte[] Bytes(string hex)
        {
            var b = new byte[hex.Length / 2];
            for (var i = 0; i < b.Length; i++) b[i] = byte.Parse(hex.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return b;
        }
        private static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }
        private static byte[] Hash(byte[] b) { try { using (var h = SHA256.Create()) return h.ComputeHash(b); } finally { Array.Clear(b, 0, b.Length); } }
        private static string RandomHex() { var b = new byte[128]; using (var r = RandomNumberGenerator.Create()) r.GetBytes(b); try { return Hex(b); } finally { Array.Clear(b, 0, b.Length); } }
        public string Sign(string poolName, string userId, string password, string serverB, string salt, string secretBlock, string timestamp)
        {
            if (used) throw new InvalidOperationException("SRP ephemeral already consumed.");
            used = true;
            if (String.IsNullOrEmpty(poolName) || String.IsNullOrEmpty(userId) || userId.Length > 1024 || password == null || password.Length > 8192 || secretBlock == null || secretBlock.Length > 8192 || String.IsNullOrEmpty(timestamp)) throw new ArgumentException("Invalid SRP challenge.");
            var b = Number(serverB);
            if (b <= 0 || b >= N) throw new ArgumentException("Invalid SRP public value.");
            var u = Number(Hex(Hash(Bytes(Pad(A) + Pad(b)))));
            if (u.IsZero) throw new ArgumentException("Invalid SRP scrambling value.");
            var x = Number(Hex(Hash(Bytes(Pad(Number(salt)) + Hex(Hash(Encoding.UTF8.GetBytes(poolName + userId + ":" + password)))))));
            var basis = (b - K * BigInteger.ModPow(G, x, N)) % N;
            if (basis.Sign < 0) basis += N;
            if (basis.IsZero) throw new ArgumentException("Invalid SRP shared value.");
            var s = BigInteger.ModPow(basis, a + u * x, N);
            var shared = Bytes(Pad(s)); var scrambling = Bytes(Pad(u));
            byte[] prk = new byte[0], key = new byte[0], block = new byte[0], message = new byte[0];
            try {
                using (var h = new HMACSHA256(scrambling)) prk = h.ComputeHash(shared);
                using (var h = new HMACSHA256(prk)) { var expanded = h.ComputeHash(Encoding.UTF8.GetBytes("Caldera Derived Key\u0001")); key = new byte[16]; Array.Copy(expanded, key, 16); Array.Clear(expanded, 0, expanded.Length); }
                block = Convert.FromBase64String(secretBlock);
                if (block.Length == 0) throw new ArgumentException("Invalid SRP secret block.");
                var prefix = Encoding.UTF8.GetBytes(poolName + userId); var suffix = Encoding.UTF8.GetBytes(timestamp);
                message = new byte[prefix.Length + block.Length + suffix.Length];
                Buffer.BlockCopy(prefix, 0, message, 0, prefix.Length); Buffer.BlockCopy(block, 0, message, prefix.Length, block.Length); Buffer.BlockCopy(suffix, 0, message, prefix.Length + block.Length, suffix.Length);
                using (var h = new HMACSHA256(key)) return Convert.ToBase64String(h.ComputeHash(message));
            } finally { foreach (var bytes in new[] { shared, scrambling, prk, key, block, message }) if (bytes != null) Array.Clear(bytes, 0, bytes.Length); Dispose(); }
        }
        public void Dispose() { a = BigInteger.Zero; used = true; }
    }
}
