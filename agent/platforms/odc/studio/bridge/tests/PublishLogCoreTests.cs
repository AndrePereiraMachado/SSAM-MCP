using Xunit;
using Row = PublishLogCore.Row;

// publish-log without a Studio: the rows are shaped like the ODC Studio's server messages pane (IServerMessagesPanePresenter
// .Messages): step rows with the PresenterMessageId OneCP_* ids, server messages whose id is the hash code that
// PublishServiceExtensions.ToMessageDefinition gives them, MessageType names as MessageType.ToString() writes them.
public sealed class PublishLogCoreTests {
    // Stand-ins for the native step ids (the bridge reads the real ones from PresenterMessageId at run time).
    private static readonly Dictionary<string, string> Steps = new() { ["OneCP_Upload"] = "upload", ["OneCP_NRCompile"] = "compilation", ["OneCP_Publish"] = "deploy" };

    private static Row[] FailedCompilation() => new[] {
        new Row("OneCP_Upload", "Info", "Uploading GameStore to personal-test.outsystems.dev", null),
        new Row("OneCP_NRCompile", "Info", "Compiling GameStore", null),
        new Row("-1543098811", "Error", "Invalid SQL in 'GetTopSellers': column 'Pricee' does not exist", "Invalid SQL in 'GetTopSellers': column 'Pricee' does not exist"),
        new Row("228734117", "Warning", "Unused screen 'OldHome'", "Unused screen 'OldHome'"),
        new Row("99", "Error", "Generation failed", "Code generation stopped after 1 error."),
    };

    [Fact]
    public void Every_message_keeps_type_text_and_the_stage_of_the_step_row_above_it() {
        var log = PublishLogCore.Build(FailedCompilation(), Steps);
        Assert.Equal(new[] { "upload", "compilation" }, log.Stages);
        Assert.Equal("compilation", log.LastStage);
        Assert.Equal(3, log.Messages.Length);
        Assert.Equal((2, 1, 0), (log.Errors, log.Warnings, log.Infos));
        var sql = log.Messages[0];
        Assert.Equal(("error", "compilation"), (sql.Type, sql.Stage));
        Assert.Equal("Invalid SQL in 'GetTopSellers': column 'Pricee' does not exist", sql.Text);
        Assert.Null(sql.Detail); // identical to the text
        Assert.Null(sql.Code);   // a hash code, not a code
        Assert.Equal("Code generation stopped after 1 error.", log.Messages[2].Detail);
    }

    [Fact]
    public void The_element_is_the_first_quoted_name_the_model_knows_else_the_first_quoted_name() {
        var model = new Dictionary<string, (string, string)>(StringComparer.OrdinalIgnoreCase) { ["GetTopSellers"] = ("Rx5hKQ", "ServerAction") };
        var log = PublishLogCore.Build(FailedCompilation(), Steps, name => model.TryGetValue(name, out var hit) ? hit : null);
        Assert.Equal(new PublishLogCore.Element("GetTopSellers", "Rx5hKQ", "ServerAction", "model"), log.Messages[0].Element);
        Assert.Equal(new PublishLogCore.Element("OldHome", null, null, "text"), log.Messages[1].Element);
        Assert.Null(log.Messages[2].Element);
        // Without the model (status, --no-resolve) the name still comes from the text.
        Assert.Equal(new PublishLogCore.Element("GetTopSellers", null, null, "text"), PublishLogCore.Build(FailedCompilation(), Steps).Messages[0].Element);
    }

    [Fact]
    public void Entity_attribute_names_resolve_part_by_part_and_quotes_of_every_kind_count() {
        var model = new Dictionary<string, (string, string)> { ["Price"] = ("k1", "EntityAttribute") };
        var element = PublishLogCore.ElementOf("Attribute ‘Product.Price’ has an invalid default", n => model.TryGetValue(n, out var hit) ? hit : null);
        Assert.Equal(new PublishLogCore.Element("Price", "k1", "EntityAttribute", "model"), element);
        Assert.Equal(new[] { "Order", "Total" }, PublishLogCore.Candidates("“Order” and \"Total\" and 'two words' are checked"));
        Assert.Empty(PublishLogCore.Candidates("no names here"));
        Assert.Equal(new[] { "Checkout" }, PublishLogCore.Candidates("The module's 'Checkout' screen failed"));
    }

    [Fact]
    public void Types_follow_the_native_flags_and_studio_ids_survive_as_codes() {
        Assert.Equal("error", PublishLogCore.TypeOf("Error"));
        Assert.Equal("warning", PublishLogCore.TypeOf("Warning, DevWarn"));
        Assert.Equal("info", PublishLogCore.TypeOf("State"));
        var log = PublishLogCore.Build(new[] { new Row("OneCP_ConcurrentPublishing", "Error", "Someone else is publishing this app.", null), new Row("5", "Info", "", "") }, Steps);
        Assert.Single(log.Messages);
        Assert.Equal(("OneCP_ConcurrentPublishing", PublishLogCore.NoStage), (log.Messages[0].Code, log.Messages[0].Stage));
    }

    [Fact]
    public void The_summary_names_the_state_counts_and_first_error() {
        var log = PublishLogCore.Build(FailedCompilation(), Steps);
        Assert.Equal("CompletedWithFailure: 2 error(s), 1 warning(s); first error: Invalid SQL in 'GetTopSellers': column 'Pricee' does not exist", PublishLogCore.Summary("CompletedWithFailure", log));
        Assert.Equal("CompletedWithSuccessNotOpenedInBrowser: 0 error(s), 0 warning(s)", PublishLogCore.Summary("CompletedWithSuccessNotOpenedInBrowser", PublishLogCore.Build(Array.Empty<Row>(), Steps)));
    }
}
