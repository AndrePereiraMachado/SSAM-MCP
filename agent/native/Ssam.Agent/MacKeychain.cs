using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace Ssam.Agent;

internal sealed record MacStoredItem(string Name, DateTimeOffset Written);
internal interface IMacPrivateStore
{
    JsonObject? Read(string name);
    void Write(string name, JsonObject value);
    void Delete(string name);
    IReadOnlyList<MacStoredItem> List(string prefix);
}

// Security.framework owns encryption and access control. No security CLI and no secret file.
internal sealed class MacKeychain : IMacPrivateStore
{
    private const string Security = "/System/Library/Frameworks/Security.framework/Security";
    private const string Core = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    private const uint Utf8 = 0x08000100;
    private static readonly Lazy<nint> SecurityHandle = new(() => NativeLibrary.Load(Security));
    private static readonly Lazy<nint> CoreHandle = new(() => NativeLibrary.Load(Core));
    private readonly string service;
    private readonly string installation;
    internal MacKeychain(string scope)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(scope, "\\A[a-f0-9]{32}\\z")) throw new ArgumentException("Invalid private scope.");
        installation = "SSAM/Agent/" + scope[..16] + "/";
        service = "com.ssam.agent.private." + scope[..16];
    }
    private static AgentFault Failure(int status) => new(status is -25308 or -25293 or -128 ? "MAC_KEYCHAIN_LOCKED" : "MAC_KEYCHAIN_FAILED", "The private keychain operation did not complete. Unlock or allow access to this SSAM Agent and try again.", false);
    private void Validate(string name) { if (!name.StartsWith(installation, StringComparison.Ordinal) || name.Length > 2048 || name.Any(char.IsControl)) throw new ArgumentException("Invalid private keychain target."); }
    private static nint Constant(string name) => Marshal.ReadIntPtr(NativeLibrary.GetExport(name.StartsWith('k') && name.StartsWith("kCF", StringComparison.Ordinal) ? CoreHandle.Value : SecurityHandle.Value, name));
    private static nint String(string value) => CFStringCreateWithCString(0, Encoding.UTF8.GetBytes(value + "\0"), Utf8);
    private static string Text(nint value)
    {
        if (value == 0 || CFGetTypeID(value) != CFStringGetTypeID()) throw Failure(-1);
        var size = checked((int)CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), Utf8) + 1);
        if (size > 16384) throw Failure(-1);
        var bytes = new byte[size]; if (!CFStringGetCString(value, bytes, size, Utf8)) throw Failure(-1);
        var zero = Array.IndexOf(bytes, (byte)0); return Encoding.UTF8.GetString(bytes, 0, zero < 0 ? bytes.Length : zero);
    }
    private sealed class Dictionary : IDisposable
    {
        internal readonly nint Value = CFDictionaryCreateMutable(0, 0, NativeLibrary.GetExport(CoreHandle.Value, "kCFTypeDictionaryKeyCallBacks"), NativeLibrary.GetExport(CoreHandle.Value, "kCFTypeDictionaryValueCallBacks"));
        internal void Set(string key, nint value) { if (Value == 0 || value == 0) throw Failure(-1); CFDictionarySetValue(Value, Constant(key), value); }
        internal void SetText(string key, string value) { var text = String(value); try { Set(key, text); } finally { if (text != 0) CFRelease(text); } }
        public void Dispose() { if (Value != 0) CFRelease(Value); }
    }
    private Dictionary Query(string? name)
    {
        if (!OperatingSystem.IsMacOS()) throw new AgentFault("MAC_KEYCHAIN_UNAVAILABLE", "The private keychain is available only on macOS.", false);
        if (name != null) Validate(name);
        var query = new Dictionary(); query.Set("kSecClass", Constant("kSecClassGenericPassword")); query.SetText("kSecAttrService", service);
        query.Set("kSecAttrSynchronizable", Constant("kCFBooleanFalse"));
        if (name != null) query.SetText("kSecAttrAccount", name);
        return query;
    }
    public JsonObject? Read(string name)
    {
        using var query = Query(name); query.Set("kSecReturnData", Constant("kCFBooleanTrue")); query.Set("kSecMatchLimit", Constant("kSecMatchLimitOne"));
        var status = SecItemCopyMatching(query.Value, out var result); if (status == -25300) return null; if (status != 0) throw Failure(status);
        try {
            if (result == 0 || CFGetTypeID(result) != CFDataGetTypeID()) throw Failure(-1);
            var length = CFDataGetLength(result); if (length < 1 || length > 32768) throw Failure(-1);
            var data = new byte[(int)length]; Marshal.Copy(CFDataGetBytePtr(result), data, 0, data.Length);
            try { return JsonNode.Parse(data) as JsonObject ?? throw Failure(-1); }
            catch (System.Text.Json.JsonException) { throw Failure(-1); }
            finally { Array.Clear(data); }
        } finally { if (result != 0) CFRelease(result); }
    }
    public void Write(string name, JsonObject value)
    {
        using var query = Query(name);
        var bytes = Encoding.UTF8.GetBytes(value.ToJsonString()); if (bytes.Length > 32768) throw Failure(-1);
        var data = CFDataCreate(0, bytes, bytes.Length); Array.Clear(bytes);
        try {
            using var changes = new Dictionary(); changes.Set("kSecValueData", data);
            var status = SecItemUpdate(query.Value, changes.Value);
            if (status == -25300) { query.Set("kSecValueData", data); status = SecItemAdd(query.Value, 0); }
            if (status != 0) throw Failure(status);
        } finally { if (data != 0) CFRelease(data); }
    }
    public void Delete(string name) { using var query = Query(name); var status = SecItemDelete(query.Value); if (status != 0 && status != -25300) throw Failure(status); }
    public IReadOnlyList<MacStoredItem> List(string prefix)
    {
        Validate(prefix); using var query = Query(null); query.Set("kSecReturnAttributes", Constant("kCFBooleanTrue")); query.Set("kSecMatchLimit", Constant("kSecMatchLimitAll"));
        var status = SecItemCopyMatching(query.Value, out var result); if (status == -25300) return []; if (status != 0) throw Failure(status);
        try {
            if (result == 0 || CFGetTypeID(result) != CFArrayGetTypeID()) throw Failure(-1);
            var count = CFArrayGetCount(result); if (count > 10000) throw Failure(-1);
            var items = new List<MacStoredItem>();
            for (nint i = 0; i < count; i++) {
                var row = CFArrayGetValueAtIndex(result, i); var name = Text(CFDictionaryGetValue(row, Constant("kSecAttrAccount")));
                if (!name.StartsWith(prefix, StringComparison.Ordinal)) continue;
                var modified = CFDictionaryGetValue(row, Constant("kSecAttrModificationDate"));
                if (modified == 0 || CFGetTypeID(modified) != CFDateGetTypeID()) throw Failure(-1);
                items.Add(new(name, DateTimeOffset.UnixEpoch.AddSeconds(978307200 + CFDateGetAbsoluteTime(modified))));
            }
            return items;
        } finally { if (result != 0) CFRelease(result); }
    }
    [DllImport(Security)] private static extern int SecItemCopyMatching(nint query, out nint result);
    [DllImport(Security)] private static extern int SecItemAdd(nint attributes, nint result);
    [DllImport(Security)] private static extern int SecItemUpdate(nint query, nint attributes);
    [DllImport(Security)] private static extern int SecItemDelete(nint query);
    [DllImport(Core)] private static extern nint CFStringCreateWithCString(nint allocator, byte[] text, uint encoding);
    [DllImport(Core)] private static extern nint CFStringGetLength(nint value);
    [DllImport(Core)] private static extern nint CFStringGetMaximumSizeForEncoding(nint length, uint encoding);
    [DllImport(Core)] [return: MarshalAs(UnmanagedType.I1)] private static extern bool CFStringGetCString(nint value, byte[] buffer, nint size, uint encoding);
    [DllImport(Core)] private static extern nint CFDictionaryCreateMutable(nint allocator, nint capacity, nint keys, nint values);
    [DllImport(Core)] private static extern void CFDictionarySetValue(nint dictionary, nint key, nint value);
    [DllImport(Core)] private static extern nint CFDictionaryGetValue(nint dictionary, nint key);
    [DllImport(Core)] private static extern nint CFDataCreate(nint allocator, byte[] bytes, nint length);
    [DllImport(Core)] private static extern nint CFDataGetLength(nint value);
    [DllImport(Core)] private static extern nint CFDataGetBytePtr(nint value);
    [DllImport(Core)] private static extern nint CFArrayGetCount(nint value);
    [DllImport(Core)] private static extern nint CFArrayGetValueAtIndex(nint value, nint index);
    [DllImport(Core)] private static extern double CFDateGetAbsoluteTime(nint value);
    [DllImport(Core)] private static extern nuint CFGetTypeID(nint value);
    [DllImport(Core)] private static extern nuint CFStringGetTypeID();
    [DllImport(Core)] private static extern nuint CFDataGetTypeID();
    [DllImport(Core)] private static extern nuint CFArrayGetTypeID();
    [DllImport(Core)] private static extern nuint CFDateGetTypeID();
    [DllImport(Core)] private static extern void CFRelease(nint value);
}
