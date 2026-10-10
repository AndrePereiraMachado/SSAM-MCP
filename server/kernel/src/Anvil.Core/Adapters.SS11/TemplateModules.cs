using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using OutSystems.ObjectKeys;
using ServiceStudio.Model;
using ServiceStudio.Presenter.Commands;

namespace Anvil.Core;

public sealed record TemplateModuleOutcome(
    string ModuleName, string ModuleKey, string TemplateKey, string TemplateFreshName, long TemplateBytes,
    string PrimaryColor, int Objects, ValidationSummary Validation, bool IsValid,
    IReadOnlyList<ModuleReference> References, long OmlBytes, string OmlPath, PublishOutcome? Publish, ModuleSummary? ServerModuleAfter,
    bool LayoutBlank = false, bool Content = false);

/// <summary>
/// Modulo a partir do template da aplicacao, o caminho do "New Module" normal do Studio
/// (Presenter prs#xumsmgkz): OML do template por REST (TemplateManager) -> ESpace.Clone com
/// nome/descricao novos -> ApplicationCommands.ChangeESpacePrimaryColor (tema com a cor da app)
/// -> Verify -> Save -> Publish. Sem a cor da app, o tema nasce com "PropertyValue must be set".
/// </summary>
public static class TemplateModules
{
    /// <summary>GET https://host/TemplateManager/rest/TemplateServices/Apps_GetTemplateESpace?ESpace_Key=... (Basic user:segredo).</summary>
    public static (byte[] Oml, string FreshName) DownloadTemplateModule(HeadlessSession s, string templateKey, TimeSpan? timeout = null)
    {
        if (s.Connected != null) return s.Connected.Call<(byte[], string)>("template-download", new { templateKey });
        var dbKey = Keys.ToDb(templateKey);
        var url = $"https://{s.Host}/TemplateManager/rest/TemplateServices/Apps_GetTemplateESpace?ESpace_Key={Uri.EscapeDataString(dbKey)}";
        using var http = new HttpClient { Timeout = timeout ?? TimeSpan.FromSeconds(120) };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes(s.Username + ":" + s.Secret)));
        using var resp = http.GetAsync(url).GetAwaiter().GetResult();
        var body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"template download failed: HTTP {(int)resp.StatusCode} {body[..Math.Min(body.Length, 300)]}");
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        string? Get(string name) => root.TryGetProperty(name, out var v) ? v.GetString() : root.TryGetProperty(name.ToLowerInvariant(), out var w) ? w.GetString() : null;
        var file = Get("File") ?? throw new InvalidOperationException("template response without File");
        return (Convert.FromBase64String(file), Get("Name") ?? "");
    }

    /// <summary>
    /// Cria (ou substitui, com `existingModuleKey`) um modulo a partir do template da app e publica.
    /// </summary>
    public static TemplateModuleOutcome CreateModuleFromTemplate(HeadlessSession s, ModelHost host, string appNameOrKey, string moduleName,
        string outDir, string? templateKey = null, string? existingModuleKey = null, string? description = null, bool publish = true, Action<string>? log = null,
        (byte[] Oml, string FreshName)? templateSource = null)
    {
        Directory.CreateDirectory(outDir);
        var app = s.FindApplication(appNameOrKey) ?? throw new KeyNotFoundException("application not found: " + appNameOrKey);
        var tpl = templateKey ?? app.TemplateKey ?? AppFactory.DefaultReactiveTemplateKey;
        var color = string.IsNullOrWhiteSpace(app.PrimaryColor) ? AppFactory.DefaultPrimaryColor : app.PrimaryColor!;
        var (tplOml, freshName) = templateSource ?? DownloadTemplateModule(s, tpl);
        log?.Invoke($"template {tpl} ({freshName}): {tplOml.Length} bytes; app color {color}");

        var newKey = existingModuleKey != null ? Keys.Parse(existingModuleKey) : null;
        using var stream = new MemoryStream(tplOml);
        var espace = ESpace.Clone(stream, null, null, null, forceModifiedFlag: false, e =>
        {
            e.SetName(moduleName);
            e.Description = description ?? $"{moduleName} created headless by SSAM from template {freshName}";
            e.Image = null;
        }, newKey);
        try
        {
            log?.Invoke($"cloned: {espace.Name} key={espace.Key} kind={espace.ESpaceType}");

            // tema com o nome do modulo e a cor primaria da app (o que o Studio faz no New Module)
            using (var aggregator = new MockAggregatorPresenter(espace, null, registerAsStaticInstance: false))
            {
                var presenter = new MockPresenter(aggregator);
                ApplicationCommands.ChangeESpacePrimaryColor(presenter.GetPresenterContext(), espace, color, isEspaceCreation: true);
            }
            var snap = ModelHost.Describe(espace, 0);
            var layout = ModuleLayout.Inspect(espace);
            log?.Invoke($"after color: {snap.Objects} objects, {snap.References.Count} references, {snap.Validation.Total} messages ({string.Join(", ", snap.Validation.ByType.Select(k => k.Key + "=" + k.Value))}), isValid={snap.IsValid}, layoutBlank={layout.LayoutBlank}, content={layout.Content}");
            foreach (var m in snap.Validation.Sample.Take(6)) log?.Invoke("  " + m);

            var bytes = host.Save(espace);
            var omlPath = Path.Combine(outDir, moduleName + ".oml");
            File.WriteAllBytes(omlPath, bytes);
            PublishOutcome? pub = null;
            if (publish && snap.IsValid)
            {
                var catalog = s.ListCatalogs().FirstOrDefault();
                pub = Publisher.Publish(s, bytes, app.Key, catalog?.Id, $"SSHeadless: {moduleName} from template", progress: log);
                log?.Invoke($"publish {moduleName}: started={pub.Started} completed={pub.Completed} hasErrors={pub.HasErrors} versionId={pub.VersionId} {pub.TotalMs} ms");
            }
            var after = publish ? s.ListModules(refresh: true).FirstOrDefault(m => string.Equals(m.Name, moduleName, StringComparison.OrdinalIgnoreCase)) : null;
            return new TemplateModuleOutcome(moduleName, espace.Key.ToString(), tpl, freshName, tplOml.Length, color,
                snap.Objects, snap.Validation, snap.IsValid, snap.References, bytes.Length, omlPath, pub, after, layout.LayoutBlank, layout.Content);
        }
        finally { ModelHost.Release(espace); }
    }
}
