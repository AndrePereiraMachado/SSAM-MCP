// Testes que nao precisam de servidor nem do runtime do Studio.
using Anvil.Core;
using Xunit;

public class CredentialsTests
{
    [Theory]
    [InlineData("personal-x.outsystemscloud.com", "personal-x.outsystemscloud.com")]
    [InlineData("https://personal-x.outsystemscloud.com/", "personal-x.outsystemscloud.com")]
    [InlineData("https://personal-x.outsystemscloud.com/ServiceCenter/", "personal-x.outsystemscloud.com")]
    [InlineData("  host.local/ ", "host.local")]
    public void HostOnly_accepts_host_or_url(string input, string expected)
        => Assert.Equal(expected, HeadlessCredentials.HostOnly(input));

    [Fact]
    public void FromJsonFile_reads_repo_format_and_never_prints_password()
    {
        var path = Path.GetTempFileName();
        File.WriteAllText(path, """
            { "username": "u@x", "password": "p4ss", "targets": { "o11PlatformRoot": "https://env.example.com/" } }
            """);
        try
        {
            var c = HeadlessCredentials.FromJsonFile(path);
            Assert.Equal("env.example.com", c.Host);
            Assert.Equal("u@x", c.Username);
            Assert.Equal("p4ss", c.Password);
            Assert.DoesNotContain("p4ss", c.ToString());
            var o = HeadlessCredentials.FromJsonFile(path, "https://other.example.com/x");
            Assert.Equal("other.example.com", o.Host);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void FromJsonFile_requires_host_when_targets_missing()
    {
        var path = Path.GetTempFileName();
        File.WriteAllText(path, """{ "username": "u", "password": "p" }""");
        try
        {
            Assert.Throws<InvalidDataException>(() => HeadlessCredentials.FromJsonFile(path));
            Assert.Equal("h", HeadlessCredentials.FromJsonFile(path, "h").Host);
        }
        finally { File.Delete(path); }
    }
}

public class NamingTests
{
    [Theory]
    [InlineData("LogicIrUi", "LogicIrUi")]
    [InlineData("a/b:c", "a_b_c")]
    [InlineData("   ", "unnamed")]
    public void SafeFileName_strips_invalid_chars(string input, string expected)
        => Assert.Equal(expected, HeadlessSession.SafeFileName(input));
}

public class JsonProjectionTests
{
    private struct Dto { public string Name; public int VersionId; public bool Flag; public DateTime When; public string? Nothing; }
    private sealed class Throwing { public string Ok => "ok"; public string Boom => throw new InvalidOperationException("no"); }

    [Fact]
    public void Project_reads_public_fields_of_structs()
    {
        var node = Json.Project(new Dto { Name = "M", VersionId = 7, Flag = true, When = new DateTime(2026, 9, 3, 0, 0, 0, DateTimeKind.Utc) })!.AsObject();
        Assert.Equal("M", node["Name"]!.GetValue<string>());
        Assert.Equal(7, node["VersionId"]!.GetValue<int>());
        Assert.True(node["Flag"]!.GetValue<bool>());
        Assert.StartsWith("2026-09-03", node["When"]!.GetValue<string>());
        Assert.Null(node["Nothing"]);
    }

    [Fact]
    public void Project_tolerates_throwing_getters_and_arrays()
    {
        var node = Json.Project(new[] { new Throwing() })!.AsArray();
        var first = node[0]!.AsObject();
        Assert.Equal("ok", first["Ok"]!.GetValue<string>());
        Assert.StartsWith("<error", first["Boom"]!.GetValue<string>());
    }

    [Fact]
    public void Records_serialize_with_explicit_resolver()
    {
        var r = new DownloadResult("m", "k", "eSpace", 3, 10, null, DateTime.UnixEpoch, "u", true, 5, "ok");
        var s = Json.Serialize(r, pretty: false);
        Assert.Contains("\"Name\":\"m\"", s);
        Assert.Contains("\"VersionId\":3", s);
    }
}

/// <summary>Testes que so precisam das DLLs do Studio no disco (sem servidor, sem runtime).</summary>
public class StudioBoundTests
{
    private static bool TryBind()
    {
        try { StudioAssemblies.Bind(); return true; }
        catch (DirectoryNotFoundException) { return false; }
    }

    [Fact]
    public void ObjectKey_db_form_differs_when_key_has_plus()
    {
        if (!TryBind()) return; // maquina sem a copia SS3: nada a provar aqui
        CheckDbForm();          // num metodo separado: o JIT so resolve OutSystems.RuntimeCommon depois do Bind
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void CheckDbForm()
    {
        var key = OutSystems.ObjectKeys.ObjectKey.Parse("WWAQZTkE5UuwES8B+6Svpg");
        Assert.NotNull(key);
        var db = key!.ToString("DB");
        Assert.False(string.IsNullOrEmpty(db));
        Assert.DoesNotContain("+", db);         // e a forma que a URL REST aceita
        Assert.Equal("WWAQZTkE5UuwES8B+6Svpg", key.ToString());
    }
}

public class KeysTests
{
    private static bool TryBind()
    {
        try { StudioAssemblies.Bind(); return true; }
        catch (DirectoryNotFoundException) { return false; }
    }

    [Fact]
    public void Guid_and_studio_base64_are_the_same_key()
    {
        if (!TryBind()) return;
        CheckKeys();
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void CheckKeys()
    {
        // ReactiveWebApp: GUID do REST TemplateManager == chave base64 vista no inventario/OML (provado no ambiente)
        Assert.Equal("Wrm0V2ZyskqM7KobRok75w", Keys.ToStudio("57b4b95a-7266-4ab2-8cec-aa1b46893be7"));
        Assert.Equal("Wrm0V2ZyskqM7KobRok75w", Keys.ToStudio("Wrm0V2ZyskqM7KobRok75w"));
        Assert.Equal(Keys.ToDb("57b4b95a-7266-4ab2-8cec-aa1b46893be7"), Keys.ToDb("Wrm0V2ZyskqM7KobRok75w"));
        Assert.Equal("WWAQZTkE5UuwES8B+6Svpg", Keys.ToStudio(Keys.ToDb("WWAQZTkE5UuwES8B+6Svpg")));
        // Users e o user provider padrao (Constants.UsersESpaceKey = 65106059-0439-4BE5-B011-2F01FBA4AFA6)
        Assert.Equal(("Users", "WWAQZTkE5UuwES8B+6Svpg"), HeadlessSession.DefaultUserProvider);
        Assert.Throws<FormatException>(() => Keys.Parse("not a key at all!"));
    }
}

public class ReadOnlyCredentialsTests
{
    [Fact]
    public void ReadOnly_flag_and_service_center_host()
    {
        var path = Path.Combine(Path.GetTempPath(), "ssheadless-ro-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, """{ "username": "u", "password": "S3cr3tValue", "readOnly": true, "targets": { "o11ServiceCenter": "https://vm-example.outsystems.net/ServiceCenter/" } }""");
        try
        {
            var c = HeadlessCredentials.FromJsonFile(path);
            Assert.True(c.ReadOnly);
            Assert.Equal("vm-example.outsystems.net", c.Host);
            Assert.DoesNotContain("S3cr3tValue", c.ToString());   // ToString nunca expoe a senha
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void Default_is_writable()
    {
        var path = Path.Combine(Path.GetTempPath(), "ssheadless-rw-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, """{ "username": "u", "password": "p", "targets": { "o11PlatformRoot": "https://x.outsystemscloud.com/" } }""");
        try { Assert.False(HeadlessCredentials.FromJsonFile(path).ReadOnly); }
        finally { File.Delete(path); }
    }
}
