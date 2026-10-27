using Anvil.Core;
using Xunit;

namespace Anvil.Tests;
public sealed class MigrationAdapterTests
{
    [Fact] public void FormAndPopupRespectValidationBeforeCallingServerLogic()
    {
        var result = MigrationUiAdapters.Expand("""<screen name="Page"><migration-form id="Form" submit="Save()"><button data-form-submit="Form">Save</button></migration-form><migration-popup id="Edit" show="Opened" save="Save()" success="Success" valid="Form.Valid"/></screen>""");
        Assert.Contains("<form", result.Html);
        Assert.Contains("ValidateAndContinue", result.Html);
        Assert.Contains(result.Flows, f => f.Contains("if Form.Valid:\n    Save()"));
        Assert.Contains(result.Flows, f => f.Contains("if Form.Valid:\n    Saved = Save()"));
    }
    [Fact] public void AccordionCanCloseAndTabsStartAtTheirDeclaredFirstValue()
    {
        var accordion = MigrationUiAdapters.Expand("""<screen name="Page"><migration-accordion id="Details" active="Active"><item value="3" label="A">Body</item></migration-accordion></screen>""");
        Assert.Contains("default=\"3\"", accordion.Html);
        Assert.Contains("aria-expanded=", accordion.Html);
        Assert.Contains(accordion.Flows, f => f.Contains("If(Active = 3, -1, 3)"));
        var tabs = MigrationUiAdapters.Expand("""<screen name="Page"><migration-tabs id="Tabs" active="Active"><tab value="2" label="A">Body</tab></migration-tabs></screen>""");
        Assert.Contains("default=\"2\"", tabs.Html);
    }
    [Fact] public void DynamicTemporalValuesUseTheSameExplicitSemanticsAsCapturedLiterals()
    {
        var result = MigrationUiAdapters.Expand("""<screen name="Page"><migration-time id="Due" value="DateTimeToText(DueAt)" semantics="client-local" format="dd/MM/yyyy HH:mm"/></screen>""");
        Assert.Contains("Page_FormatTemporal", result.Html);
        Assert.Single(result.Actions);
        Assert.Contains("ssamFormatTemporal", result.Actions.ToJsonString());
    }
    [Fact] public void PopupHasSeparateOpenCancelAndSuccessfulSavePaths()
    {
        var result = MigrationUiAdapters.Expand("""
        <screen name="Page"><button data-popup-open="Editor">Open</button>
        <migration-popup id="Editor" show="ShowEditor" save="TrySave()" success="Success" refresh="LoadItems">
          <button data-popup-cancel="Editor">Cancel</button><button data-popup-save="Editor">Save</button>
        </migration-popup></screen>
        """);
        Assert.Contains("<popup", result.Html); Assert.DoesNotContain("<migration-popup", result.Html);
        Assert.Contains("onclick=\"MigrateEditorOpen\"", result.Html);
        Assert.Contains(result.Flows, f => f.Contains("if Saved.Success:\n    refresh LoadItems\n    assign ShowEditor = False"));
        Assert.Contains(result.Flows, f => f.Contains("MigrateEditorCancel") && !f.Contains("TrySave"));
    }
    [Fact] public void TabsRenderOnlyTheActivePanel()
    {
        var result = MigrationUiAdapters.Expand("""<screen name="Page"><migration-tabs id="Tabs" active="Active"><tab value="0" label="A"><p>First</p></tab><tab value="1" label="B"><p>Second</p></tab></migration-tabs></screen>""");
        Assert.Contains("if=\"Active = 0\"", result.Html);
        Assert.Contains("if=\"Active = 1\"", result.Html);
        Assert.Contains("role=\"tablist\"", result.Html);
        Assert.Contains(result.Flows, f => f.Contains("assign Active = 1"));
    }
    [Fact] public void PagerUsesNativeHandlersAndRequeriesTheSource()
    {
        var result = MigrationUiAdapters.Expand("""<screen name="Page"><migration-pager id="Pager" offset="Offset" total="Count" size="25" source="LoadItems"/></screen>""");
        Assert.Contains("display:flex", result.Html);
        Assert.Contains("StartIndex =", result.Html);
        Assert.Contains(result.Flows, f => f.Contains("in StartIndex: Integer") && f.Contains("refresh LoadItems"));
    }
    [Fact] public void UploadCreatesOneNativeControlWithBothFileBindings()
    {
        var result = MigrationUiAdapters.Expand("""<screen name="Page"><migration-upload id="Upload" content="Binary" filename="Filename" accept="Any"/></screen>""");
        Assert.Contains("<upload id=\"Upload\" content=\"Binary\" filename=\"Filename\" accept=\"Any\"/>", result.Html);
        Assert.DoesNotContain("<input", result.Html);
    }
    [Fact] public void DownloadUsesTheProvenClientTransportAndKeepsItsTypedInputs()
    {
        var result = MigrationUiAdapters.Expand("""<screen name="Page"><migration-download id="File" content="Content" filename="Filename" mime="application/pdf"/></screen>""");
        Assert.Contains("MigrateFileDownload", result.Html);
        Assert.Contains(result.Flows, f => f.Contains("FileContent=Content, FileName=Filename"));
        Assert.Contains("Binary Data", result.Actions.ToJsonString());
    }
    [Theory]
    [InlineData("<migration-tabs id='Tabs' active='Active'><tab value='0' label='A'/><tab value='0' label='B'/></migration-tabs>")]
    [InlineData("<migration-popup id='Popup' show='Open' save='Save()'/>")]
    [InlineData("<migration-upload id='Upload' content='Binary'/>")]
    public void IncompleteAdaptersCannotSilentlyProduceNonfunctionalWidgets(string body)
        => Assert.ThrowsAny<ArgumentException>(() => MigrationUiAdapters.Expand("<screen name='Page'>" + body + "</screen>"));
}
