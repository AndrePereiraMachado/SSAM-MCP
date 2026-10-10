# OutSystems.Model.Plugin.NRWidgets (ODC Studio 1.7.25.10778)

Public metadata by reflection; declared members only, inherited members are on the base types listed after the colon.

## OutSystems.Model.Plugin.NRWidgets.IconResources

### static class IconLibraryMappings

## ServiceStudio.Plugin.NRWidgets

### interface IAdvancedHtml : IAdvancedHtmlSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IAdvancedHtmlDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- string Tag { get; set; }
- WidgetGridType WidgetGridType { get; set; }
- void CreateContent()
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()

### interface IAdvancedHtmlDescriptor : IAdvancedHtmlSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IAdvancedHtmlSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IAdvancedHtmlSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- string Tag { get; }
- WidgetGridType WidgetGridType { get; }

### interface IAdvancedHtmlSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IProperty TagProperty { get; }
- IProperty WidgetGridTypeProperty { get; }

### interface IButton : IButtonSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IExpression ConfirmationMessage { get; }
- IContent Content { get; }
- IButtonDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- bool IsDefault { get; set; }
- JustifyContent JustifyContent { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnClick { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetConfirmationMessage(ExpressionDefinition value)
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IButtonDescriptor : IButtonSignatureDescriptor, IMobileWidgetDescriptor
- IExpressionProperty ConfirmationMessageProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty IsDefaultProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection<IButton, IBuiltinEvent> OnClickChildCollection { get; }

### interface IButtonGroup : IButtonGroupSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IButtonGroupDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- IExpression Mandatory { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnChange { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Variable { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetMandatory(ExpressionDefinition value)
- void SetMandatory(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)

### interface IButtonGroupDescriptor : IButtonGroupSignatureDescriptor, IMobileWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<IButtonGroup, IBuiltinEvent> OnChangeChildCollection { get; }
- IVariableProperty VariableProperty { get; }

### interface IButtonGroupItem : IButtonGroupItemSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IButtonGroupItemDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Value { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetValue(ExpressionDefinition value)
- void SetValue(object value)
- void SetVisible(ExpressionDefinition value)

### interface IButtonGroupItemDescriptor : IButtonGroupItemSignatureDescriptor, IMobileWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IButtonGroupItemSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IButtonGroupItemSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Value { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IButtonGroupItemSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty ValueProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }

### interface IButtonGroupSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IButtonGroupSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IButtonGroupSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IExpressionProperty MandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface IButtonSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IButtonSignatureDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IButtonSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IExpressionProperty EnabledProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface ICheckbox : ICheckboxSignature, IMobileWidget
- AlignSelf AlignSelf { get; set; }
- int? ColumnSpan { get; set; }
- ICheckboxDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- Flexible Flexible { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnChange { get; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Variable { get; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)

### interface ICheckboxDescriptor : ICheckboxSignatureDescriptor, IMobileWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<ICheckbox, IBuiltinEvent> OnChangeChildCollection { get; }

### interface ICheckboxSignature : IMobileWidgetSignature
- AlignSelf AlignSelf { get; }
- int? ColumnSpan { get; }
- ICheckboxSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Variable { get; }

### interface ICheckboxSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignSelfProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IVariableProperty VariableProperty { get; }

### class IconLibraryProvider : IIconLibraryProvider
- string DefaultIconLibrary { get; }
- IconLibraryProvider Instance { get; }
- string OldIconLibrary { get; }
- IEnumerable<string> GetAvailableIconLibraries()
- string GetBaseCssClass(string libraryName)
- Byte[] GetCssSourceByFontWeight(string libraryName, string fontWeight)
- IDictionary<string, string[]> GetFontSizeClassNameMapping(string libraryName)
- ValueTuple<Byte[], string> GetFontSourceByFontWeight(string libraryName, string fontWeight)
- IDictionary<string, string[]> GetFontWeightClassNameMapping(string libraryName)
- IDictionary<string, string[]> GetIconClassNameMapping(string libraryName)
- IDictionary<string, IconMapping> GetIconConversionMapping(string previousLibraryName, string newLibraryName)
- IIconProvider GetIconProvider(string libraryName)
- IEnumerable<string> GetWeights(string libraryName)

### interface IContainer : IContainerSignature, IMobileWidget
- Align Align { get; set; }
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- bool Animate { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IContainerDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Visible { get; }
- bool VisibleWasExpression { get; set; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetStyle(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IContainerDescriptor : IContainerSignatureDescriptor, IMobileWidgetDescriptor
- IProperty AnimateProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty VisibleWasExpressionProperty { get; }

### interface IContainerSignature : IMobileWidgetSignature
- Align Align { get; }
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IContainerSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IContainerSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface IDropdown : IDropdownSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IDropdownDescriptor Descriptor { get; }
- DropdownMode DropdownMode { get; set; }
- IExpression EmptyValue { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- IExpression Labels { get; }
- IExpression List { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnChange { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Values { get; }
- IExpression Variable { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetEmptyValue(ExpressionDefinition value)
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetLabels(ExpressionDefinition value)
- void SetList(ExpressionDefinition value)
- void SetMandatory(ExpressionDefinition value)
- void SetMandatory(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetValues(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)

### interface IDropdownDescriptor : IDropdownSignatureDescriptor, IMobileWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IExpressionProperty ListProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection<IDropdown, IBuiltinEvent> OnChangeChildCollection { get; }
- IExpressionProperty ValuesProperty { get; }
- IVariableProperty VariableProperty { get; }

### interface IDropdownSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IDropdownSignatureDescriptor Descriptor { get; }
- DropdownMode DropdownMode { get; }
- IExpression EmptyValue { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- IExpression Labels { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IDropdownSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IProperty DropdownModeProperty { get; }
- IExpressionProperty EmptyValueProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IExpressionProperty LabelsProperty { get; }
- IExpressionProperty MandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface IExpression : IExpressionSignature, IMobileWidget
- AlignSelf AlignSelf { get; set; }
- int? ColumnSpan { get; set; }
- IExpressionDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- string Example { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- Flexible Flexible { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Value { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetStyle(ExpressionDefinition value)
- void SetValue(ExpressionDefinition value)

### interface IExpressionDescriptor : IExpressionSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IExpressionSignature : IMobileWidgetSignature
- AlignSelf AlignSelf { get; }
- int? ColumnSpan { get; }
- IExpressionSignatureDescriptor Descriptor { get; }
- string Example { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Value { get; }
- string Width { get; }

### interface IExpressionSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignSelfProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IProperty ExampleProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty ValueProperty { get; }
- IProperty WidthProperty { get; }

### interface IForm : IFormSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IFormDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetStyle(ExpressionDefinition value)

### interface IFormDescriptor : IFormSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IFormSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IFormSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IFormSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface IHeaderCell : IHeaderCellSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IHeaderCellDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression SortAttribute { get; }
- IExpression Source { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetSortAttribute(ExpressionDefinition value)
- void SetSource(ExpressionDefinition value)
- void SetStyle(ExpressionDefinition value)

### interface IHeaderCellDescriptor : IHeaderCellSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IExpressionProperty SourceProperty { get; }

### interface IHeaderCellSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IHeaderCellSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression SortAttribute { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IHeaderCellSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty SortAttributeProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }

### interface IIcon : IIconSignature, IMobileWidget
- AlignSelf AlignSelf { get; set; }
- int? ColumnSpan { get; set; }
- IIconDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- Flexible Flexible { get; set; }
- string Icon { get; set; }
- IconSize IconSize { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Visible { get; }
- string Weight { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetStyle(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IIconDescriptor : IIconSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IIconSignature : IMobileWidgetSignature
- AlignSelf AlignSelf { get; }
- int? ColumnSpan { get; }
- IIconSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }
- string Icon { get; }
- IconSize IconSize { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Visible { get; }
- string Weight { get; }

### interface IIconSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignSelfProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty IconProperty { get; }
- IProperty IconSizeProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WeightProperty { get; }

### interface IImage : IImageSignature, IMobileWidget
- AlignSelf AlignSelf { get; set; }
- int? ColumnSpan { get; set; }
- IImageSignature DefaultImage { get; set; }
- IImageDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- Flexible Flexible { get; set; }
- IImageSignature Image { get; set; }
- IExpression ImageContent { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- Type Type { get; set; }
- IExpression Url { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetImageContent(ExpressionDefinition value)
- void SetStyle(ExpressionDefinition value)
- void SetUrl(ExpressionDefinition value)

### interface IImageDescriptor : IImageSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IImageSignature : IMobileWidgetSignature
- AlignSelf AlignSelf { get; }
- int? ColumnSpan { get; }
- IImageSignature DefaultImage { get; }
- IImageSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }
- IImageSignature Image { get; }
- IExpression ImageContent { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- Type Type { get; }
- IExpression Url { get; }
- string Width { get; }

### interface IImageSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignSelfProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IProperty DefaultImageProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexibleProperty { get; }
- IExpressionProperty ImageContentProperty { get; }
- IProperty ImageProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty TypeProperty { get; }
- IExpressionProperty UrlProperty { get; }
- IProperty WidthProperty { get; }

### interface IInput : IInputSignature, IMobileWidget
- AlignSelf AlignSelf { get; set; }
- int? ColumnSpan { get; set; }
- IInputDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- Flexible Flexible { get; set; }
- InputType InputType { get; set; }
- IExpression Mandatory { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- int? MaxLength { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnChange { get; }
- IExpression Prompt { get; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Variable { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetMandatory(ExpressionDefinition value)
- void SetMandatory(bool value)
- void SetPrompt(ExpressionDefinition value)
- void SetStyle(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)

### interface IInputDescriptor : IInputSignatureDescriptor, IMobileWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty MaxLengthProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection<IInput, IBuiltinEvent> OnChangeChildCollection { get; }

### interface IInputSignature : IMobileWidgetSignature
- AlignSelf AlignSelf { get; }
- int? ColumnSpan { get; }
- IInputSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }
- InputType InputType { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- IExpression Prompt { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Variable { get; }
- string Width { get; }

### interface IInputSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignSelfProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty InputTypeProperty { get; }
- IExpressionProperty MandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IExpressionProperty PromptProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IVariableProperty VariableProperty { get; }
- IProperty WidthProperty { get; }

### interface ILabel : ILabelSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- ILabelDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IMobileWidgetSignature TargetWidget { get; set; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetStyle(ExpressionDefinition value)

### interface ILabelDescriptor : ILabelSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty TargetWidgetProperty { get; }

### interface ILabelSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- ILabelSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface ILabelSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface ILink : ILinkSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IExpression ConfirmationMessage { get; }
- IContent Content { get; }
- ILinkDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnClick { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetConfirmationMessage(ExpressionDefinition value)
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface ILinkDescriptor : ILinkSignatureDescriptor, IMobileWidgetDescriptor
- IExpressionProperty ConfirmationMessageProperty { get; }
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<ILink, IBuiltinEvent> OnClickChildCollection { get; }

### interface ILinkSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- ILinkSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface ILinkSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface IList : IListSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- bool AnimateItems { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IListDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- bool ExpandedInWebEditor { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- IContent ListItem { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- Mode Mode { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnScrollEnding { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Source { get; }
- IExpression Style { get; }
- string Tag { get; set; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetSource(ExpressionDefinition value)
- void SetStyle(ExpressionDefinition value)

### interface IListDescriptor : IListSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<IList, IBuiltinEvent> OnScrollEndingChildCollection { get; }
- IExpressionProperty SourceProperty { get; }

### interface IListItem : IListItemSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IListItemDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- bool ExpandedInWebEditor { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- IContent LeftActions { get; }
- string Name { get; set; }
- IBuiltinEvent OnClick { get; }
- IContent RightActions { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- bool TriggerActionOnFullSwipeLeft { get; set; }
- bool TriggerActionOnFullSwipeRight { get; set; }
- WidgetGridType WidgetGridType { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetStyle(ExpressionDefinition value)

### interface IListItemAction : IListItemActionSignature, IMobileWidget
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IListItemActionDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnClick { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetStyle(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IListItemActionDescriptor : IListItemActionSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<IListItemAction, IBuiltinEvent> OnClickChildCollection { get; }

### interface IListItemActionSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IListItemActionSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IListItemActionSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }

### interface IListItemDescriptor : IListItemSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<IListItem, IBuiltinEvent> OnClickChildCollection { get; }
- IProperty TriggerActionOnFullSwipeLeftProperty { get; }
- IProperty TriggerActionOnFullSwipeRightProperty { get; }

### interface IListItemSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IListItemSignatureDescriptor Descriptor { get; }
- bool ExpandedInWebEditor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- IContentSignature LeftActions { get; }
- IContentSignature RightActions { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }

### interface IListItemSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IProperty ExpandedInWebEditorProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IChildCollection LeftActionsChildCollection { get; }
- IChildCollection RightActionsChildCollection { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }

### interface IListSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- bool AnimateItems { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IListSignatureDescriptor Descriptor { get; }
- bool ExpandedInWebEditor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- IContentSignature ListItem { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- Mode Mode { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- string Tag { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IListSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty AnimateItemsProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IProperty ExpandedInWebEditorProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IChildCollection ListItemChildCollection { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty ModeProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty TagProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface IPopover : IMobileWidget, IPopoverSignature
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- IContent BottomContent { get; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IPopoverDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- bool ExpandedInWebEditor { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- int? PopoverWidth { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IContent TopContent { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetStyle(ExpressionDefinition value)

### interface IPopoverDescriptor : IMobileWidgetDescriptor, IPopoverSignatureDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IPopoverSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- IContentSignature BottomContent { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IPopoverSignatureDescriptor Descriptor { get; }
- bool ExpandedInWebEditor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- int? PopoverWidth { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IContentSignature TopContent { get; }
- WidgetGridType WidgetGridType { get; }

### interface IPopoverSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IChildCollection BottomContentChildCollection { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IProperty ExpandedInWebEditorProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty PopoverWidthProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IChildCollection TopContentChildCollection { get; }
- IProperty WidgetGridTypeProperty { get; }

### interface IPopup : IMobileWidget, IPopupSignature
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IPopupDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- bool ExpandedInWebEditor { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression ShowPopup { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetShowPopup(ExpressionDefinition value)
- void SetShowPopup(bool value)
- void SetStyle(ExpressionDefinition value)

### interface IPopupDescriptor : IMobileWidgetDescriptor, IPopupSignatureDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IExpressionProperty ShowPopupProperty { get; }

### interface IPopupSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IPopupSignatureDescriptor Descriptor { get; }
- bool ExpandedInWebEditor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IPopupSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IProperty ExpandedInWebEditorProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }

### interface IRadioButton : IMobileWidget, IRadioButtonSignature
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IRadioButtonDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Value { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetValue(ExpressionDefinition value)
- void SetValue(object value)
- void SetVisible(ExpressionDefinition value)

### interface IRadioButtonDescriptor : IMobileWidgetDescriptor, IRadioButtonSignatureDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IRadioButtonSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IRadioButtonSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Value { get; }
- IExpression Visible { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IRadioButtonSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty ValueProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface IRadioGroup : IMobileWidget, IRadioGroupSignature
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IRadioGroupDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- IExpression Mandatory { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnChange { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Variable { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetMandatory(ExpressionDefinition value)
- void SetMandatory(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)

### interface IRadioGroupDescriptor : IMobileWidgetDescriptor, IRadioGroupSignatureDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<IRadioGroup, IBuiltinEvent> OnChangeChildCollection { get; }
- IVariableProperty VariableProperty { get; }

### interface IRadioGroupSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IRadioGroupSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IRadioGroupSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IExpressionProperty MandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### interface IRowCell : IMobileWidget, IRowCellSignature
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IRowCellDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetStyle(ExpressionDefinition value)

### interface IRowCellDescriptor : IMobileWidgetDescriptor, IRowCellSignatureDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }

### interface IRowCellSignature : IMobileWidgetSignature
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IRowCellSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IRowCellSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }

### interface ISwitch : IMobileWidget, ISwitchSignature
- AlignSelf AlignSelf { get; set; }
- int? ColumnSpan { get; set; }
- ISwitchDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- Flexible Flexible { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnChange { get; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- IExpression Variable { get; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetStyle(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)

### interface ISwitchDescriptor : IMobileWidgetDescriptor, ISwitchSignatureDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<ISwitch, IBuiltinEvent> OnChangeChildCollection { get; }

### interface ISwitchSignature : IMobileWidgetSignature
- AlignSelf AlignSelf { get; }
- int? ColumnSpan { get; }
- ISwitchSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- IExpression Variable { get; }

### interface ISwitchSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignSelfProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IVariableProperty VariableProperty { get; }

### interface ITableRecords : IMobileWidget, ITableRecordsSignature
- AlignSelf AlignSelf { get; set; }
- int? ColumnSpan { get; set; }
- ITableRecordsDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- bool ExpandedInWebEditor { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- Flexible Flexible { get; set; }
- IContent HeaderRow { get; }
- string Name { get; set; }
- IBuiltinEvent OnSort { get; }
- IContent Row { get; }
- int? RowSpan { get; set; }
- bool ShowHeader { get; set; }
- IExpression Source { get; }
- IExpression Style { get; }
- IExpression StyleHeader { get; }
- IExpression StyleRow { get; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetSource(ExpressionDefinition value)
- void SetStyle(ExpressionDefinition value)
- void SetStyleHeader(ExpressionDefinition value)
- void SetStyleRow(ExpressionDefinition value)

### interface ITableRecordsDescriptor : IMobileWidgetDescriptor, ITableRecordsSignatureDescriptor
- IChildCollection EventsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<ITableRecords, IBuiltinEvent> OnSortChildCollection { get; }
- IExpressionProperty SourceProperty { get; }

### interface ITableRecordsSignature : IMobileWidgetSignature
- AlignSelf AlignSelf { get; }
- int? ColumnSpan { get; }
- ITableRecordsSignatureDescriptor Descriptor { get; }
- bool ExpandedInWebEditor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }
- IContentSignature HeaderRow { get; }
- IContentSignature Row { get; }
- int? RowSpan { get; }
- bool ShowHeader { get; }
- IExpression Style { get; }
- IExpression StyleHeader { get; }
- IExpression StyleRow { get; }

### interface ITableRecordsSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignSelfProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IProperty ExpandedInWebEditorProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexibleProperty { get; }
- IChildCollection HeaderRowChildCollection { get; }
- IChildCollection RowChildCollection { get; }
- IProperty RowSpanProperty { get; }
- IProperty ShowHeaderProperty { get; }
- IExpressionProperty StyleHeaderProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IExpressionProperty StyleRowProperty { get; }

### interface ITextArea : IMobileWidget, ITextAreaSignature
- AlignSelf AlignSelf { get; set; }
- int? ColumnSpan { get; set; }
- ITextAreaDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- Flexible Flexible { get; set; }
- IExpression Mandatory { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- int? MaxLength { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnChange { get; }
- IExpression Prompt { get; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- int TextLines { get; set; }
- IExpression Variable { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetEnabled(bool value)
- void SetMandatory(ExpressionDefinition value)
- void SetMandatory(bool value)
- void SetPrompt(ExpressionDefinition value)
- void SetStyle(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)

### interface ITextAreaDescriptor : IMobileWidgetDescriptor, ITextAreaSignatureDescriptor
- IExpressionProperty EnabledProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty MaxLengthProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection<ITextArea, IBuiltinEvent> OnChangeChildCollection { get; }

### interface ITextAreaSignature : IMobileWidgetSignature
- AlignSelf AlignSelf { get; }
- int? ColumnSpan { get; }
- ITextAreaSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- IExpression Prompt { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- int TextLines { get; }
- IExpression Variable { get; }
- string Width { get; }

### interface ITextAreaSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignSelfProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexibleProperty { get; }
- IExpressionProperty MandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IExpressionProperty PromptProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty TextLinesProperty { get; }
- IVariableProperty VariableProperty { get; }
- IProperty WidthProperty { get; }

### interface IUpload : IMobileWidget, IUploadSignature
- Accept Accept { get; set; }
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- IContent Content { get; }
- IUploadDescriptor Descriptor { get; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IExpression FileContent { get; }
- IExpression FileName { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- JustifyContent JustifyContent { get; set; }
- IExpression Mandatory { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnChange { get; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; set; }
- IEnumerable<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type widgetType, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name, IKey key)
- void SetFileContent(ExpressionDefinition value)
- void SetFileName(ExpressionDefinition value)
- void SetMandatory(ExpressionDefinition value)
- void SetMandatory(bool value)
- void SetStyle(ExpressionDefinition value)

### interface IUploadDescriptor : IMobileWidgetDescriptor, IUploadSignatureDescriptor
- IChildCollection EventsChildCollection { get; }
- IVariableProperty FileContentProperty { get; }
- IVariableProperty FileNameProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection<IUpload, IBuiltinEvent> OnChangeChildCollection { get; }

### interface IUploadSignature : IMobileWidgetSignature
- Accept Accept { get; }
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- IContentSignature Content { get; }
- IUploadSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- JustifyContent JustifyContent { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression Style { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IUploadSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AcceptProperty { get; }
- IProperty AlignItemsProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IChildCollection ContentChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty JustifyContentProperty { get; }
- IExpressionProperty MandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IProperty WidthProperty { get; }

### class ModelFeatures : IDiscoverable

### class PluginDescriptor : WidgetsPluginDescriptor
- string JavascriptBundleName { get; }
- string JavascriptDesignTime { get; }
- string ModuleName { get; }
- string Namespace { get; }
- string StylesheetBundleName { get; }
- Version Version { get; }

### static class WidgetCustomStyleHelper
- bool AddStyle(IWidget widget, string style)
- bool SetTextAlign(IWidget widget, Alignment alignment)

## ServiceStudio.Plugin.NRWidgets.Enumerations

### enum Accept
- Image
- Video
- Any

### enum Align
- Default
- Left
- Center
- Right

### enum DropdownMode
- Text
- Custom

### enum IconSize
- FontSize
- Twotimes
- Threetimes
- Fourtimes

### enum InputType
- Text
- Password
- Number
- Time
- Date
- Datetime
- Phone
- Email
- Search

### enum Mode
- Default
- Custom

### enum Type
- Static
- External
- Binary

## ServiceStudio.Plugin.NRWidgets.IconProviders.FontAwesome

### class FontAwesome4IconProvider : IIconProvider
- string BaseCssClass { get; }
- string DefaultGroup { get; }
- string GroupIconName { get; }
- Byte[] GetCssSourceByFontWeight(string fontWeight)
- IDictionary<string, string[]> GetFontSizeClassNameMapping()
- ValueTuple<Byte[], string> GetFontSource(string fontWeight)
- IDictionary<string, string[]> GetFontWeightClassNameMapping()
- string[] GetGroups()
- IDictionary<string, string[]> GetIconClassNameMapping()
- ImageGroup[] GetIconGroups()
- ImageItem[] GetIconImages()
- string[] GetWeights()

## ServiceStudio.Plugin.NRWidgets.IconProviders.Phosphor

### class Phosphor2IconProvider : IIconProvider
- string BaseCssClass { get; }
- string DefaultGroup { get; }
- string GroupIconName { get; }
- Byte[] GetCssSourceByFontWeight(string fontWeight)
- IDictionary<string, string[]> GetFontSizeClassNameMapping()
- ValueTuple<Byte[], string> GetFontSource(string fontWeight)
- IDictionary<string, string[]> GetFontWeightClassNameMapping()
- string[] GetGroups()
- IDictionary<string, string[]> GetIconClassNameMapping()
- ImageGroup[] GetIconGroups()
- string[] GetWeights()

## ServiceStudio.Plugin.NRWidgets.IconResources

### class IconItem : IEquatable<IconItem>
- string[] Aliases { get; set; }
- string[] Categories { get; set; }
- string[] Classnames { get; set; }
- string[] Filter { get; set; }
- string Id { get; set; }
- string Name { get; set; }
- string Unicode { get; set; }
- IconItem <Clone>$()
- bool Equals(object obj)
- bool Equals(IconItem other)
- int GetHashCode()
- string ToString()
