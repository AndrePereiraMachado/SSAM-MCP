using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>B15 on the ODC lane (review of W3-CSS, S8, R2-1): the create an image file of ssam_code files makes (its grant passed as --image-fill, outside the job) creates the
/// module image, and the same file again fills it (SetImageContent: one image, the new content), said in the answer as the high
/// warning IMAGE_CONTENT_REPLACED that studio_deliver relays; a create written by hand with the name of an existing image is
/// NAME_COLLISION, as before.</summary>
public class ModuleImageOdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "module-image-tests");
    private const string Fixture = "tests/fixtures/odc/blank-mobile.oml";
    private const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    private const string Gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

    private static JsonObject Image(string binary, string file, bool forged = false)
    {
        var op = new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IImage", ["name"] = "proof_logo", ["args"] = new JsonObject { ["binary"] = binary, ["originalPath"] = file } };
        if (forged) op["_from"] = "file";
        return op;
    }
    private static string Sha(string base64) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Convert.FromBase64String(base64)));

    [Fact]
    public void AnImageFileFillsTheImageOfItsNameAndTheAnswerSaysSo()
    {
        Assert.True(StudioAvailable(), "this test needs the ODC Studio's assemblies (headless)");
        var first = Run("image-first", Path.Combine(Root, Fixture), new JsonArray(Image(Png, "proof-logo.png")));
        Assert.True(first["accepted"]!.GetValue<bool>(), first["details"]?.ToJsonString() ?? first.ToJsonString());
        Assert.DoesNotContain(first["highWarnings"]?.AsArray() ?? new JsonArray(), w => w!["code"]?.ToString() == "IMAGE_CONTENT_REPLACED");
        JsonObject again;
        using (ImageFills.For(("proof_logo", Sha(Gif)))) again = Run("image-again", Path.Combine(Work, "image-first.oml"), new JsonArray(Image(Gif, "proof-logo.gif")));
        Assert.True(again["accepted"]!.GetValue<bool>(), again["details"]?.ToJsonString() ?? again.ToJsonString());
        Assert.True(again["results"]![0]!["result"]!["contentReplaced"]!.GetValue<bool>());
        var warning = Assert.Single(again["highWarnings"]!.AsArray(), w => w!["code"]?.ToString() == "IMAGE_CONTENT_REPLACED")!;
        Assert.Equal("proof_logo", warning["image"]!.ToString());
        Assert.Equal("high", warning["severity"]!.ToString());
        // One image of that name, never proof_logo2.
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(Path.Combine(Work, "image-again.oml")));
        try
        {
            var names = ((OutSystems.Model.IObjectSignature)espace).GetAllDescendantsOfType<OutSystems.Model.IObjectSignature>()
                .Where(o => o.GetType().GetInterfaces().Any(i => i.Name == "IImage")).Select(o => TypeResolver.Name(o)).ToList();
            Assert.Single(names, n => n != null && n.StartsWith("proof_logo", StringComparison.Ordinal));
        }
        finally { ModelHost.Release(espace); }
        // Written by hand (no grant), even with the _from "file" a generated job carried: the existing image is a name collision.
        foreach (var forged in new[] { false, true })
        {
            var error = Assert.ThrowsAny<Exception>(() => Run("image-hand", Path.Combine(Work, "image-first.oml"), new JsonArray(Image(Gif, "proof-logo.gif", forged))));
            Assert.Contains("NAME_COLLISION", Errors.Text(error), StringComparison.Ordinal);
        }
    }

    private static JsonObject Run(string name, string basePath, JsonArray ops)
    {
        Directory.CreateDirectory(Work);
        var job = Path.Combine(Work, name + ".json");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var output = Path.Combine(Work, name + ".oml");
        if (File.Exists(output)) File.Delete(output);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), basePath, job, output))!.AsObject();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ModuleImageOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
