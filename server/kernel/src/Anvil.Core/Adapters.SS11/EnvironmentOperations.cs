using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.MetaModel.Enumerations;

namespace Anvil.Core;

/// <summary>Remote-only primitives of the existing engine. No ModelHost, model
/// mutation, shell execution, credentials or arbitrary method invocation.</summary>
public static class EnvironmentOperations
{
    public static readonly string[] Names = [
        "applications", "modules", "application-icon", "catalogs", "referenceable",
        "extensions", "extension-download", "versions", "templates", "template-module",
        "template-download", "signature", "template-user-provider", "download",
        "application-save", "module-associate", "application-delete", "module-delete",
        "publish-start", "publish-check", EnvironmentData.ReadOperation, EnvironmentData.WriteOperation,
        // A13: the closed, read-only lookup of users and roles (UserDirectory); capability environment_session:users-read.
        UserDirectory.Operation
    ];

    public static JsonObject Execute(HeadlessSession session, string operation, JsonObject? arguments)
    {
        if (session.Connected != null) throw new InvalidOperationException("A Studio-owned session is required");
        T Get<T>(string name) => arguments?[name] is { } node
            ? node.Deserialize<T>(ConnectedEnvironment.Wire)!
            : default!;
        object? value = operation switch
        {
            "applications" => session.ListApplications(),
            "modules" => session.ListModules(),
            "application-icon" => session.GetApplicationIcon(Get<string>("nameOrKey")),
            "catalogs" => session.ListCatalogs(),
            "referenceable" => session.ListReferenceable(),
            "extensions" => session.ListExtensions(),
            "extension-download" => session.DownloadExtension(Get<string>("extensionKey"), Get<int>("versionId")),
            "versions" => session.ListVersionIds(Get<string>("moduleKey")),
            "templates" => session.ListApplicationTemplates(),
            "template-module" => session.GetTemplateModule(Get<string>("templateKey")),
            "template-download" => TemplateModules.DownloadTemplateModule(session, Get<string>("templateKey")),
            "signature" => session.GetReferenceSignature(Get<string>("producerKey"), Get<string>("kind")),
            "template-user-provider" => session.GetTemplateUserProvider(Get<string>("templateKey")),
            "download" => session.Download(Get<ModuleSummary>("module"), Get<string?>("outputDirectory"), Get<int?>("versionId")),
            "application-save" => Publisher.CreateOrUpdateApplication(session, Get<string>("name"),
                Get<SegmentationKind>("kind"), Get<string?>("description"), Get<string?>("existingKey"),
                Get<string?>("templateKey"), Get<string?>("primaryColor"), Get<byte[]?>("icon")),
            "module-associate" => Publisher.AddModuleToApplication(session, Get<string>("appKey"), Get<string>("moduleKey")),
            "application-delete" => Publisher.DeleteApplication(session, Get<string>("appKey"), Get<bool>("simulate")),
            "module-delete" => Publisher.DeleteModule(session, Get<string>("moduleKey")),
            "publish-start" => Publisher.StartPublish(session, Get<byte[]>("oml"), Get<string>("appKey"),
                Get<int?>("catalogId"), Get<string>("commitMessage")),
            "publish-check" => Publisher.CheckPublish(session, Get<PublishOutcome>("previous")),
            EnvironmentData.ReadOperation or EnvironmentData.WriteOperation => EnvironmentData.Execute(session, operation, arguments),
            UserDirectory.Operation => UserDirectory.Execute(session, arguments),
            _ => throw new ArgumentException("Unknown environment operation: " + operation)
        };
        return new JsonObject { ["value"] = JsonSerializer.SerializeToNode(value, value?.GetType() ?? typeof(object), ConnectedEnvironment.Wire) };
    }
}
