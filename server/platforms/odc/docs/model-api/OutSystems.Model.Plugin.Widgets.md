# OutSystems.Model.Plugin.Widgets (ODC Studio 1.7.25.10778)

Public metadata by reflection; declared members only, inherited members are on the base types listed after the colon.

## ServiceStudio.Plugin.Widgets

### interface IEditableTable : IEditableTableSignature, IWebWidget
- IExpression AddRecordMessage { get; }
- IExpression DeleteConfirmationMessage { get; }
- IEditableTableDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IContent HeaderRow { get; }
- IExpression IsEditable { get; }
- IExpression LineCount { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnRowDelete { get; }
- IBuiltinEvent OnRowSave { get; }
- IContent Row { get; }
- bool ShowHeader { get; set; }
- IExpression SourceRecordList { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetAddRecordMessage(ExpressionDefinition value)
- void SetDeleteConfirmationMessage(ExpressionDefinition value)
- void SetIsEditable(ExpressionDefinition value)
- void SetIsEditable(bool value)
- void SetLineCount(ExpressionDefinition value)
- void SetLineCount(int value)
- void SetSourceRecordList(ExpressionDefinition value)

### interface IEditableTableCell : IEditableTableCellSignature, IWebWidget
- IContent Content { get; }
- IEditableTableCellDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Name { get; set; }
- IEnumerable<IWebWidget> Widgets { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type widgetType, string name = null, IKey key = null)

### interface IEditableTableCellDescriptor : IEditableTableCellSignatureDescriptor, IWebWidgetDescriptor
- IProperty NameProperty { get; }

### interface IEditableTableCellSignature : IWebWidgetSignature
- IContentSignature Content { get; }
- IEditableTableCellSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IEditableTableCellSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty WidthProperty { get; }

### interface IEditableTableDescriptor : IEditableTableSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty AddRecordMessageProperty { get; }
- IExpressionProperty DeleteConfirmationMessageProperty { get; }
- IExpressionProperty LineCountProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection<IEditableTable, IBuiltinEvent> OnRowDeleteChildCollection { get; }
- IChildCollection<IEditableTable, IBuiltinEvent> OnRowSaveChildCollection { get; }
- IExpressionProperty SourceRecordListProperty { get; }

### interface IEditableTableSignature : IWebWidgetSignature
- IEditableTableSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IContentSignature HeaderRow { get; }
- IExpression IsEditable { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- IContentSignature Row { get; }
- bool ShowHeader { get; }
- string Width { get; }

### interface IEditableTableSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IChildCollection HeaderRowChildCollection { get; }
- IExpressionProperty IsEditableProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IChildCollection RowChildCollection { get; }
- IProperty ShowHeaderProperty { get; }
- IProperty WidthProperty { get; }

### interface IForm : IFormSignature, IWebWidget
- IContent Content { get; }
- IFormDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IExpression IsEditable { get; }
- LabelsPosition LabelsPosition { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IExpression SourceRecord { get; }
- IEnumerable<IWebWidget> Widgets { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- void SetIsEditable(ExpressionDefinition value)
- void SetIsEditable(bool value)
- void SetSourceRecord(ExpressionDefinition value)

### interface IFormDescriptor : IFormSignatureDescriptor, IWebWidgetDescriptor
- IProperty NameProperty { get; }
- IExpressionProperty SourceRecordProperty { get; }

### interface IFormSignature : IWebWidgetSignature
- IContentSignature Content { get; }
- IFormSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IExpression IsEditable { get; }
- LabelsPosition LabelsPosition { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IFormSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IExpressionProperty IsEditableProperty { get; }
- IProperty LabelsPositionProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty WidthProperty { get; }

### interface ILabel : ILabelSignature, IWebWidget
- ILabelDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IWebWidgetSignature TargetWidget { get; set; }
- string Text { get; set; }
- IExpression Value { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetValue(ExpressionDefinition value)

### interface ILabelDescriptor : ILabelSignatureDescriptor, IWebWidgetDescriptor
- IProperty NameProperty { get; }
- IProperty TargetWidgetProperty { get; }

### interface ILabelSignature : IWebWidgetSignature
- ILabelSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string Text { get; }
- IExpression Value { get; }
- string Width { get; }

### interface ILabelSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty TextProperty { get; }
- IExpressionProperty ValueProperty { get; }
- IProperty WidthProperty { get; }

### class PluginDescriptor : AbstractPluginDescriptor

## ServiceStudio.Plugin.Widgets.Enumerations

### enum LabelsPosition
- Top
- Left
- Right
