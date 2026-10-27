/// Fixed domain for Condition.
create static entity MxCondition (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Excellent (Id=1, Label="Excellent", Order=1), Good (Id=2, Label="Good", Order=2), Fair (Id=3, Label="Fair", Order=3), Poor (Id=4, Label="Poor", Order=4), Critical (Id=5, Label="Critical", Order=5);
/// Fixed domain for Decision.
create static entity MxDecision (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Pending (Id=1, Label="Pending", Order=1), Approved (Id=2, Label="Approved", Order=2), Rejected (Id=3, Label="Rejected", Order=3), Withdrawn (Id=4, Label="Withdrawn", Order=4);
/// Fixed domain for Lifecycle.
create static entity MxLifecycle (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Draft (Id=1, Label="Draft", Order=1), Active (Id=2, Label="Active", Order=2), Closed (Id=3, Label="Closed", Order=3), Cancelled (Id=4, Label="Cancelled", Order=4);
/// Fixed domain for Hazard.
create static entity MxHazard (Id Integer identifier required, Label Text(100) required, Order Integer required)
values None (Id=1, Label="None", Order=1), Chemical (Id=2, Label="Chemical", Order=2), Biological (Id=3, Label="Biological", Order=3), Radiological (Id=4, Label="Radiological", Order=4), Mechanical (Id=5, Label="Mechanical", Order=5);
/// Fixed domain for Rights.
create static entity MxRights (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Public (Id=1, Label="Public", Order=1), Licensed (Id=2, Label="Licensed", Order=2), Restricted (Id=3, Label="Restricted", Order=3);
/// Records used by Institution.
create entity MxInstitution public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Institution.
CreatedOn Date Time required,
/// Stores UpdatedOn for Institution.
UpdatedOn Date Time,
/// Stores Version for Institution.
Version Long Integer required default 1,
/// Stores Code for Institution.
Code Text(50) required,
/// Stores Name for Institution.
Name Text(200) required,
/// Stores LegalName for Institution.
LegalName Text(200) required,
/// Stores TaxNumber for Institution.
TaxNumber Text(50) required
);
create unique index UQ_1 on MxInstitution (Code);
/// Records used by Branch.
create entity MxBranch public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Branch.
CreatedOn Date Time required,
/// Stores UpdatedOn for Branch.
UpdatedOn Date Time,
/// Stores Version for Branch.
Version Long Integer required default 1,
/// Stores InstitutionId for Branch.
InstitutionId MxInstitution Identifier required references MxInstitution on delete Protect,
/// Stores Name for Branch.
Name Text(200) required,
/// Stores City for Branch.
City Text(200) required,
/// Stores TimeZone for Branch.
TimeZone Text(80) required
);
/// Records used by Room.
create entity MxRoom public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Room.
CreatedOn Date Time required,
/// Stores UpdatedOn for Room.
UpdatedOn Date Time,
/// Stores Version for Room.
Version Long Integer required default 1,
/// Stores BranchId for Room.
BranchId MxBranch Identifier required references MxBranch on delete Protect,
/// Stores Code for Room.
Code Text(50) required,
/// Stores Floor for Room.
Floor Integer required,
/// Stores Area for Room.
Area Decimal(18,4) required,
/// Stores MaxOccupancy for Room.
MaxOccupancy Integer required
);
/// Records used by Cabinet.
create entity MxCabinet public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Cabinet.
CreatedOn Date Time required,
/// Stores UpdatedOn for Cabinet.
UpdatedOn Date Time,
/// Stores Version for Cabinet.
Version Long Integer required default 1,
/// Stores RoomId for Cabinet.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores Code for Cabinet.
Code Text(50) required,
/// Stores Locked for Cabinet.
Locked Boolean required,
/// Stores MaxWeight for Cabinet.
MaxWeight Decimal(18,4) required
);
/// Records used by Shelf.
create entity MxShelf public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Shelf.
CreatedOn Date Time required,
/// Stores UpdatedOn for Shelf.
UpdatedOn Date Time,
/// Stores Version for Shelf.
Version Long Integer required default 1,
/// Stores CabinetId for Shelf.
CabinetId MxCabinet Identifier required references MxCabinet on delete Protect,
/// Stores Position for Shelf.
Position Integer required,
/// Stores MaxHeight for Shelf.
MaxHeight Decimal(18,4) required,
/// Stores MaxWeight for Shelf.
MaxWeight Decimal(18,4) required
);
create unique index UQ_1 on MxShelf (CabinetId, Position);
/// Records used by StoragePosition.
create entity MxStoragePosition public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for StoragePosition.
CreatedOn Date Time required,
/// Stores UpdatedOn for StoragePosition.
UpdatedOn Date Time,
/// Stores Version for StoragePosition.
Version Long Integer required default 1,
/// Stores ShelfId for StoragePosition.
ShelfId MxShelf Identifier required references MxShelf on delete Protect,
/// Stores Code for StoragePosition.
Code Text(50) required,
/// Stores Width for StoragePosition.
Width Decimal(18,4) required,
/// Stores Depth for StoragePosition.
Depth Decimal(18,4) required
);
create unique index UQ_1 on MxStoragePosition (ShelfId, Code);
/// Records used by Person.
create entity MxPerson public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Person.
CreatedOn Date Time required,
/// Stores UpdatedOn for Person.
UpdatedOn Date Time,
/// Stores Version for Person.
Version Long Integer required default 1,
/// Stores Name for Person.
Name Text(200) required,
/// Stores Email for Person.
Email Email required,
/// Stores BirthDate for Person.
BirthDate Date,
/// Stores Phone for Person.
Phone Text(30)
);
/// Records used by Organization.
create entity MxOrganization public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Organization.
CreatedOn Date Time required,
/// Stores UpdatedOn for Organization.
UpdatedOn Date Time,
/// Stores Version for Organization.
Version Long Integer required default 1,
/// Stores LegalName for Organization.
LegalName Text(200) required,
/// Stores TaxNumber for Organization.
TaxNumber Text(50) required,
/// Stores Country for Organization.
Country Text(2) required,
/// Stores Website for Organization.
Website Text(200)
);
create unique index UQ_1 on MxOrganization (TaxNumber);
/// Records used by Address.
create entity MxAddress public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Address.
CreatedOn Date Time required,
/// Stores UpdatedOn for Address.
UpdatedOn Date Time,
/// Stores Version for Address.
Version Long Integer required default 1,
/// Stores OrganizationId for Address.
OrganizationId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores Street for Address.
Street Text(500) required,
/// Stores City for Address.
City Text(200) required,
/// Stores PostalCode for Address.
PostalCode Text(20) required
);
/// Records used by Contact.
create entity MxContact public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Contact.
CreatedOn Date Time required,
/// Stores UpdatedOn for Contact.
UpdatedOn Date Time,
/// Stores Version for Contact.
Version Long Integer required default 1,
/// Stores OrganizationId for Contact.
OrganizationId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores PersonId for Contact.
PersonId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores Role for Contact.
Role Text(200) required,
/// Stores IsPrimary for Contact.
IsPrimary Boolean
);
/// Records used by Collection.
create entity MxCollection public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Collection.
CreatedOn Date Time required,
/// Stores UpdatedOn for Collection.
UpdatedOn Date Time,
/// Stores Version for Collection.
Version Long Integer required default 1,
/// Stores InstitutionId for Collection.
InstitutionId MxInstitution Identifier required references MxInstitution on delete Protect,
/// Stores Code for Collection.
Code Text(50) required,
/// Stores Name for Collection.
Name Text(200) required,
/// Stores CuratorId for Collection.
CuratorId MxPerson Identifier required references MxPerson on delete Protect
);
create unique index UQ_1 on MxCollection (Code);
/// Records used by ObjectCategory.
create entity MxObjectCategory public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectCategory.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectCategory.
UpdatedOn Date Time,
/// Stores Version for ObjectCategory.
Version Long Integer required default 1,
/// Stores Code for ObjectCategory.
Code Text(50) required,
/// Stores Name for ObjectCategory.
Name Text(200) required,
/// Stores ParentId for ObjectCategory.
ParentId MxObjectCategory Identifier references MxObjectCategory on delete Protect,
/// Stores DefaultHazardId for ObjectCategory.
DefaultHazardId MxHazard Identifier required references MxHazard on delete Protect
);
create unique index UQ_1 on MxObjectCategory (Code);
/// Records used by Material.
create entity MxMaterial public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Material.
CreatedOn Date Time required,
/// Stores UpdatedOn for Material.
UpdatedOn Date Time,
/// Stores Version for Material.
Version Long Integer required default 1,
/// Stores Code for Material.
Code Text(50) required,
/// Stores Name for Material.
Name Text(200) required,
/// Stores SensitiveToLight for Material.
SensitiveToLight Boolean required,
/// Stores SensitiveToWater for Material.
SensitiveToWater Boolean required
);
create unique index UQ_1 on MxMaterial (Code);
/// Records used by Technique.
create entity MxTechnique public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Technique.
CreatedOn Date Time required,
/// Stores UpdatedOn for Technique.
UpdatedOn Date Time,
/// Stores Version for Technique.
Version Long Integer required default 1,
/// Stores Code for Technique.
Code Text(50) required,
/// Stores Name for Technique.
Name Text(200) required,
/// Stores Description for Technique.
Description Text(1000) required
);
create unique index UQ_1 on MxTechnique (Code);
/// Records used by Period.
create entity MxPeriod public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Period.
CreatedOn Date Time required,
/// Stores UpdatedOn for Period.
UpdatedOn Date Time,
/// Stores Version for Period.
Version Long Integer required default 1,
/// Stores Name for Period.
Name Text(200) required,
/// Stores StartYear for Period.
StartYear Integer required,
/// Stores EndYear for Period.
EndYear Integer required,
/// Stores Approximate for Period.
Approximate Boolean
);
/// Records used by CulturalOrigin.
create entity MxCulturalOrigin public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for CulturalOrigin.
CreatedOn Date Time required,
/// Stores UpdatedOn for CulturalOrigin.
UpdatedOn Date Time,
/// Stores Version for CulturalOrigin.
Version Long Integer required default 1,
/// Stores Name for CulturalOrigin.
Name Text(200) required,
/// Stores Region for CulturalOrigin.
Region Text(200) required,
/// Stores Country for CulturalOrigin.
Country Text(2),
/// Stores Notes for CulturalOrigin.
Notes Text(1000)
);
/// Records used by Accession.
create entity MxAccession public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Accession.
CreatedOn Date Time required,
/// Stores UpdatedOn for Accession.
UpdatedOn Date Time,
/// Stores Version for Accession.
Version Long Integer required default 1,
/// Stores CollectionId for Accession.
CollectionId MxCollection Identifier required references MxCollection on delete Protect,
/// Stores Number for Accession.
Number Text(50) required,
/// Stores AccessionDate for Accession.
AccessionDate Date required,
/// Stores SourceOrganizationId for Accession.
SourceOrganizationId MxOrganization Identifier references MxOrganization on delete Protect,
/// Stores DecisionId for Accession.
DecisionId MxDecision Identifier required references MxDecision on delete Protect
);
create unique index UQ_1 on MxAccession (Number);
/// Records used by MuseumObject.
create entity MxMuseumObject public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for MuseumObject.
CreatedOn Date Time required,
/// Stores UpdatedOn for MuseumObject.
UpdatedOn Date Time,
/// Stores Version for MuseumObject.
Version Long Integer required default 1,
/// Stores AccessionId for MuseumObject.
AccessionId MxAccession Identifier required references MxAccession on delete Protect,
/// Stores ObjectCategoryId for MuseumObject.
ObjectCategoryId MxObjectCategory Identifier required references MxObjectCategory on delete Protect,
/// Stores InventoryCode for MuseumObject.
InventoryCode Text(50) required,
/// Stores Title for MuseumObject.
Title Text(200) required,
/// Stores PeriodId for MuseumObject.
PeriodId MxPeriod Identifier references MxPeriod on delete Protect,
/// Stores OriginId for MuseumObject.
OriginId MxCulturalOrigin Identifier references MxCulturalOrigin on delete Protect,
/// Stores ConditionId for MuseumObject.
ConditionId MxCondition Identifier required references MxCondition on delete Protect
);
create unique index UQ_1 on MxMuseumObject (InventoryCode);
/// Records used by ObjectMaterial.
create entity MxObjectMaterial public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectMaterial.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectMaterial.
UpdatedOn Date Time,
/// Stores Version for ObjectMaterial.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectMaterial.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores MaterialId for ObjectMaterial.
MaterialId MxMaterial Identifier required references MxMaterial on delete Protect,
/// Stores Proportion for ObjectMaterial.
Proportion Decimal(18,4) required
);
create unique index UQ_1 on MxObjectMaterial (MuseumObjectId, MaterialId);
/// Records used by ObjectTechnique.
create entity MxObjectTechnique public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectTechnique.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectTechnique.
UpdatedOn Date Time,
/// Stores Version for ObjectTechnique.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectTechnique.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores TechniqueId for ObjectTechnique.
TechniqueId MxTechnique Identifier required references MxTechnique on delete Protect,
/// Stores Details for ObjectTechnique.
Details Text(200)
);
create unique index UQ_1 on MxObjectTechnique (MuseumObjectId, TechniqueId);
/// Records used by ObjectDimension.
create entity MxObjectDimension public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectDimension.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectDimension.
UpdatedOn Date Time,
/// Stores Version for ObjectDimension.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectDimension.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores Dimension for ObjectDimension.
Dimension Text(50) required,
/// Stores Value for ObjectDimension.
Value Decimal(18,4) required,
/// Stores Unit for ObjectDimension.
Unit Text(12) required
);
/// Records used by ObjectInscription.
create entity MxObjectInscription public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectInscription.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectInscription.
UpdatedOn Date Time,
/// Stores Version for ObjectInscription.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectInscription.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores Language for ObjectInscription.
Language Text(12) required,
/// Stores Transcription for ObjectInscription.
Transcription Text(2000) required,
/// Stores Location for ObjectInscription.
Location Text(200)
);
/// Records used by Provenance.
create entity MxProvenance public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Provenance.
CreatedOn Date Time required,
/// Stores UpdatedOn for Provenance.
UpdatedOn Date Time,
/// Stores Version for Provenance.
Version Long Integer required default 1,
/// Stores MuseumObjectId for Provenance.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores OwnerName for Provenance.
OwnerName Text(200) required,
/// Stores FromYear for Provenance.
FromYear Integer required,
/// Stores ToYear for Provenance.
ToYear Integer required,
/// Stores Evidence for Provenance.
Evidence Text(1000)
);
/// Records used by ObjectValuation.
create entity MxObjectValuation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectValuation.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectValuation.
UpdatedOn Date Time,
/// Stores Version for ObjectValuation.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectValuation.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores AssessedById for ObjectValuation.
AssessedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores AssessedOn for ObjectValuation.
AssessedOn Date required,
/// Stores Amount for ObjectValuation.
Amount Decimal(18,2) required,
/// Stores Currency for ObjectValuation.
Currency Text(3) required
);
/// Records used by ObjectLocation.
create entity MxObjectLocation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectLocation.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectLocation.
UpdatedOn Date Time,
/// Stores Version for ObjectLocation.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectLocation.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores StoragePositionId for ObjectLocation.
StoragePositionId MxStoragePosition Identifier required references MxStoragePosition on delete Protect,
/// Stores FromTime for ObjectLocation.
FromTime Date Time required,
/// Stores UntilTime for ObjectLocation.
UntilTime Date Time
);
/// Records used by ObjectRestriction.
create entity MxObjectRestriction public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectRestriction.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectRestriction.
UpdatedOn Date Time,
/// Stores Version for ObjectRestriction.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectRestriction.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores HazardId for ObjectRestriction.
HazardId MxHazard Identifier required references MxHazard on delete Protect,
/// Stores StartsOn for ObjectRestriction.
StartsOn Date required,
/// Stores EndsOn for ObjectRestriction.
EndsOn Date,
/// Stores Reason for ObjectRestriction.
Reason Text(1000) required
);
/// Records used by ObjectRelation.
create entity MxObjectRelation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectRelation.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectRelation.
UpdatedOn Date Time,
/// Stores Version for ObjectRelation.
Version Long Integer required default 1,
/// Stores FromObjectId for ObjectRelation.
FromObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores ToObjectId for ObjectRelation.
ToObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores RelationType for ObjectRelation.
RelationType Text(50) required,
/// Stores Notes for ObjectRelation.
Notes Text(200)
);
/// Records used by ObjectAlias.
create entity MxObjectAlias public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectAlias.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectAlias.
UpdatedOn Date Time,
/// Stores Version for ObjectAlias.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectAlias.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores Language for ObjectAlias.
Language Text(12) required,
/// Stores Label for ObjectAlias.
Label Text(200) required,
/// Stores Preferred for ObjectAlias.
Preferred Boolean
);
/// Records used by ObjectKeyword.
create entity MxObjectKeyword public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ObjectKeyword.
CreatedOn Date Time required,
/// Stores UpdatedOn for ObjectKeyword.
UpdatedOn Date Time,
/// Stores Version for ObjectKeyword.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ObjectKeyword.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores KeywordId for ObjectKeyword.
KeywordId MxKeyword Identifier required references MxKeyword on delete Protect
);
create unique index UQ_1 on MxObjectKeyword (MuseumObjectId, KeywordId);
/// Records used by Keyword.
create entity MxKeyword public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Keyword.
CreatedOn Date Time required,
/// Stores UpdatedOn for Keyword.
UpdatedOn Date Time,
/// Stores Version for Keyword.
Version Long Integer required default 1,
/// Stores Term for Keyword.
Term Text(100) required,
/// Stores ParentId for Keyword.
ParentId MxKeyword Identifier references MxKeyword on delete Protect,
/// Stores Description for Keyword.
Description Text(200)
);
create unique index UQ_1 on MxKeyword (Term);
/// Records used by ConditionReport.
create entity MxConditionReport public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ConditionReport.
CreatedOn Date Time required,
/// Stores UpdatedOn for ConditionReport.
UpdatedOn Date Time,
/// Stores Version for ConditionReport.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ConditionReport.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores ExaminerId for ConditionReport.
ExaminerId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores ExaminedAt for ConditionReport.
ExaminedAt Date Time required,
/// Stores ConditionId for ConditionReport.
ConditionId MxCondition Identifier required references MxCondition on delete Protect,
/// Stores Summary for ConditionReport.
Summary Text(2000) required
);
/// Records used by DamageObservation.
create entity MxDamageObservation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for DamageObservation.
CreatedOn Date Time required,
/// Stores UpdatedOn for DamageObservation.
UpdatedOn Date Time,
/// Stores Version for DamageObservation.
Version Long Integer required default 1,
/// Stores ConditionReportId for DamageObservation.
ConditionReportId MxConditionReport Identifier required references MxConditionReport on delete Protect,
/// Stores Location for DamageObservation.
Location Text(200) required,
/// Stores DamageType for DamageObservation.
DamageType Text(50) required,
/// Stores Severity for DamageObservation.
Severity Integer required,
/// Stores AreaPercent for DamageObservation.
AreaPercent Decimal(18,4)
);
/// Records used by TreatmentPlan.
create entity MxTreatmentPlan public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for TreatmentPlan.
CreatedOn Date Time required,
/// Stores UpdatedOn for TreatmentPlan.
UpdatedOn Date Time,
/// Stores Version for TreatmentPlan.
Version Long Integer required default 1,
/// Stores MuseumObjectId for TreatmentPlan.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores ConservatorId for TreatmentPlan.
ConservatorId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores Objective for TreatmentPlan.
Objective Text(1000) required,
/// Stores ApprovalId for TreatmentPlan.
ApprovalId MxDecision Identifier required references MxDecision on delete Protect,
/// Stores EstimatedCost for TreatmentPlan.
EstimatedCost Decimal(18,2) required
);
/// Records used by TreatmentStep.
create entity MxTreatmentStep public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for TreatmentStep.
CreatedOn Date Time required,
/// Stores UpdatedOn for TreatmentStep.
UpdatedOn Date Time,
/// Stores Version for TreatmentStep.
Version Long Integer required default 1,
/// Stores TreatmentPlanId for TreatmentStep.
TreatmentPlanId MxTreatmentPlan Identifier required references MxTreatmentPlan on delete Protect,
/// Stores Sequence for TreatmentStep.
Sequence Integer required,
/// Stores Instruction for TreatmentStep.
Instruction Text(2000) required,
/// Stores EstimatedMinutes for TreatmentStep.
EstimatedMinutes Integer required
);
create unique index UQ_1 on MxTreatmentStep (TreatmentPlanId, Sequence);
/// Records used by TreatmentExecution.
create entity MxTreatmentExecution public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for TreatmentExecution.
CreatedOn Date Time required,
/// Stores UpdatedOn for TreatmentExecution.
UpdatedOn Date Time,
/// Stores Version for TreatmentExecution.
Version Long Integer required default 1,
/// Stores TreatmentStepId for TreatmentExecution.
TreatmentStepId MxTreatmentStep Identifier required references MxTreatmentStep on delete Protect,
/// Stores PersonId for TreatmentExecution.
PersonId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores StartedAt for TreatmentExecution.
StartedAt Date Time required,
/// Stores FinishedAt for TreatmentExecution.
FinishedAt Date Time,
/// Stores Outcome for TreatmentExecution.
Outcome Text(1000)
);
/// Records used by Substance.
create entity MxSubstance public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Substance.
CreatedOn Date Time required,
/// Stores UpdatedOn for Substance.
UpdatedOn Date Time,
/// Stores Version for Substance.
Version Long Integer required default 1,
/// Stores Code for Substance.
Code Text(50) required,
/// Stores Name for Substance.
Name Text(200) required,
/// Stores HazardId for Substance.
HazardId MxHazard Identifier required references MxHazard on delete Protect,
/// Stores SafetySheetKey for Substance.
SafetySheetKey Text(200)
);
create unique index UQ_1 on MxSubstance (Code);
/// Records used by SubstanceBatch.
create entity MxSubstanceBatch public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for SubstanceBatch.
CreatedOn Date Time required,
/// Stores UpdatedOn for SubstanceBatch.
UpdatedOn Date Time,
/// Stores Version for SubstanceBatch.
Version Long Integer required default 1,
/// Stores SubstanceId for SubstanceBatch.
SubstanceId MxSubstance Identifier required references MxSubstance on delete Protect,
/// Stores BatchCode for SubstanceBatch.
BatchCode Text(50) required,
/// Stores ReceivedOn for SubstanceBatch.
ReceivedOn Date required,
/// Stores ExpiresOn for SubstanceBatch.
ExpiresOn Date required,
/// Stores Quantity for SubstanceBatch.
Quantity Decimal(18,4) required
);
/// Records used by SubstanceUse.
create entity MxSubstanceUse public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for SubstanceUse.
CreatedOn Date Time required,
/// Stores UpdatedOn for SubstanceUse.
UpdatedOn Date Time,
/// Stores Version for SubstanceUse.
Version Long Integer required default 1,
/// Stores TreatmentExecutionId for SubstanceUse.
TreatmentExecutionId MxTreatmentExecution Identifier required references MxTreatmentExecution on delete Protect,
/// Stores SubstanceBatchId for SubstanceUse.
SubstanceBatchId MxSubstanceBatch Identifier required references MxSubstanceBatch on delete Protect,
/// Stores Quantity for SubstanceUse.
Quantity Decimal(18,4) required,
/// Stores Unit for SubstanceUse.
Unit Text(12) required
);
/// Records used by ConservationSample.
create entity MxConservationSample public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ConservationSample.
CreatedOn Date Time required,
/// Stores UpdatedOn for ConservationSample.
UpdatedOn Date Time,
/// Stores Version for ConservationSample.
Version Long Integer required default 1,
/// Stores MuseumObjectId for ConservationSample.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores Code for ConservationSample.
Code Text(50) required,
/// Stores CollectedById for ConservationSample.
CollectedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores CollectedAt for ConservationSample.
CollectedAt Date Time required,
/// Stores Location for ConservationSample.
Location Text(200) required
);
create unique index UQ_1 on MxConservationSample (Code);
/// Records used by LabAnalysis.
create entity MxLabAnalysis public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for LabAnalysis.
CreatedOn Date Time required,
/// Stores UpdatedOn for LabAnalysis.
UpdatedOn Date Time,
/// Stores Version for LabAnalysis.
Version Long Integer required default 1,
/// Stores ConservationSampleId for LabAnalysis.
ConservationSampleId MxConservationSample Identifier required references MxConservationSample on delete Protect,
/// Stores TechniqueId for LabAnalysis.
TechniqueId MxTechnique Identifier required references MxTechnique on delete Protect,
/// Stores AnalystId for LabAnalysis.
AnalystId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores Result for LabAnalysis.
Result Text(2000) required,
/// Stores CompletedAt for LabAnalysis.
CompletedAt Date Time required
);
/// Records used by Sensor.
create entity MxSensor public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Sensor.
CreatedOn Date Time required,
/// Stores UpdatedOn for Sensor.
UpdatedOn Date Time,
/// Stores Version for Sensor.
Version Long Integer required default 1,
/// Stores RoomId for Sensor.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores SerialNumber for Sensor.
SerialNumber Text(50) required,
/// Stores Measurement for Sensor.
Measurement Text(50) required,
/// Stores Unit for Sensor.
Unit Text(12) required,
/// Stores CalibratedOn for Sensor.
CalibratedOn Date required
);
create unique index UQ_1 on MxSensor (SerialNumber);
/// Records used by SensorReading.
create entity MxSensorReading public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for SensorReading.
CreatedOn Date Time required,
/// Stores UpdatedOn for SensorReading.
UpdatedOn Date Time,
/// Stores Version for SensorReading.
Version Long Integer required default 1,
/// Stores SensorId for SensorReading.
SensorId MxSensor Identifier required references MxSensor on delete Protect,
/// Stores MeasuredAt for SensorReading.
MeasuredAt Date Time required,
/// Stores Value for SensorReading.
Value Decimal(18,4) required,
/// Stores IsValid for SensorReading.
IsValid Boolean required
);
/// Records used by ClimateTarget.
create entity MxClimateTarget public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ClimateTarget.
CreatedOn Date Time required,
/// Stores UpdatedOn for ClimateTarget.
UpdatedOn Date Time,
/// Stores Version for ClimateTarget.
Version Long Integer required default 1,
/// Stores RoomId for ClimateTarget.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores Measurement for ClimateTarget.
Measurement Text(50) required,
/// Stores LowerLimit for ClimateTarget.
LowerLimit Decimal(18,4) required,
/// Stores UpperLimit for ClimateTarget.
UpperLimit Decimal(18,4) required
);
create unique index UQ_1 on MxClimateTarget (RoomId, Measurement);
/// Records used by ClimateExcursion.
create entity MxClimateExcursion public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ClimateExcursion.
CreatedOn Date Time required,
/// Stores UpdatedOn for ClimateExcursion.
UpdatedOn Date Time,
/// Stores Version for ClimateExcursion.
Version Long Integer required default 1,
/// Stores SensorId for ClimateExcursion.
SensorId MxSensor Identifier required references MxSensor on delete Protect,
/// Stores StartedAt for ClimateExcursion.
StartedAt Date Time required,
/// Stores EndedAt for ClimateExcursion.
EndedAt Date Time,
/// Stores PeakValue for ClimateExcursion.
PeakValue Decimal(18,4) required,
/// Stores AcknowledgedById for ClimateExcursion.
AcknowledgedById MxPerson Identifier references MxPerson on delete Protect
);
/// Records used by PestInspection.
create entity MxPestInspection public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PestInspection.
CreatedOn Date Time required,
/// Stores UpdatedOn for PestInspection.
UpdatedOn Date Time,
/// Stores Version for PestInspection.
Version Long Integer required default 1,
/// Stores RoomId for PestInspection.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores InspectorId for PestInspection.
InspectorId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores InspectedOn for PestInspection.
InspectedOn Date required,
/// Stores EvidenceFound for PestInspection.
EvidenceFound Boolean required,
/// Stores Notes for PestInspection.
Notes Text(1000)
);
/// Records used by PestTrap.
create entity MxPestTrap public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PestTrap.
CreatedOn Date Time required,
/// Stores UpdatedOn for PestTrap.
UpdatedOn Date Time,
/// Stores Version for PestTrap.
Version Long Integer required default 1,
/// Stores RoomId for PestTrap.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores Code for PestTrap.
Code Text(50) required,
/// Stores InstalledOn for PestTrap.
InstalledOn Date required,
/// Stores LastCheckedOn for PestTrap.
LastCheckedOn Date
);
/// Records used by TrapObservation.
create entity MxTrapObservation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for TrapObservation.
CreatedOn Date Time required,
/// Stores UpdatedOn for TrapObservation.
UpdatedOn Date Time,
/// Stores Version for TrapObservation.
Version Long Integer required default 1,
/// Stores PestTrapId for TrapObservation.
PestTrapId MxPestTrap Identifier required references MxPestTrap on delete Protect,
/// Stores ObservedOn for TrapObservation.
ObservedOn Date required,
/// Stores Species for TrapObservation.
Species Text(200) required,
/// Stores Count for TrapObservation.
Count Integer required
);
/// Records used by CleaningSchedule.
create entity MxCleaningSchedule public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for CleaningSchedule.
CreatedOn Date Time required,
/// Stores UpdatedOn for CleaningSchedule.
UpdatedOn Date Time,
/// Stores Version for CleaningSchedule.
Version Long Integer required default 1,
/// Stores RoomId for CleaningSchedule.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores FrequencyDays for CleaningSchedule.
FrequencyDays Integer required,
/// Stores LastCompletedOn for CleaningSchedule.
LastCompletedOn Date,
/// Stores NextDueOn for CleaningSchedule.
NextDueOn Date required,
/// Stores Instructions for CleaningSchedule.
Instructions Text(1000)
);
/// Records used by CleaningExecution.
create entity MxCleaningExecution public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for CleaningExecution.
CreatedOn Date Time required,
/// Stores UpdatedOn for CleaningExecution.
UpdatedOn Date Time,
/// Stores Version for CleaningExecution.
Version Long Integer required default 1,
/// Stores CleaningScheduleId for CleaningExecution.
CleaningScheduleId MxCleaningSchedule Identifier required references MxCleaningSchedule on delete Protect,
/// Stores PersonId for CleaningExecution.
PersonId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores CompletedAt for CleaningExecution.
CompletedAt Date Time required,
/// Stores Notes for CleaningExecution.
Notes Text(200)
);
/// Records used by EmergencyProcedure.
create entity MxEmergencyProcedure public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for EmergencyProcedure.
CreatedOn Date Time required,
/// Stores UpdatedOn for EmergencyProcedure.
UpdatedOn Date Time,
/// Stores Version for EmergencyProcedure.
Version Long Integer required default 1,
/// Stores BranchId for EmergencyProcedure.
BranchId MxBranch Identifier required references MxBranch on delete Protect,
/// Stores HazardId for EmergencyProcedure.
HazardId MxHazard Identifier required references MxHazard on delete Protect,
/// Stores Title for EmergencyProcedure.
Title Text(200) required,
/// Stores Instructions for EmergencyProcedure.
Instructions Text(2000) required
);
/// Records used by LoanRequest.
create entity MxLoanRequest public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for LoanRequest.
CreatedOn Date Time required,
/// Stores UpdatedOn for LoanRequest.
UpdatedOn Date Time,
/// Stores Version for LoanRequest.
Version Long Integer required default 1,
/// Stores OrganizationId for LoanRequest.
OrganizationId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores RequestedById for LoanRequest.
RequestedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores StartsOn for LoanRequest.
StartsOn Date required,
/// Stores EndsOn for LoanRequest.
EndsOn Date required,
/// Stores Purpose for LoanRequest.
Purpose Text(1000) required,
/// Stores DecisionId for LoanRequest.
DecisionId MxDecision Identifier required references MxDecision on delete Protect
);
/// Records used by LoanObject.
create entity MxLoanObject public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for LoanObject.
CreatedOn Date Time required,
/// Stores UpdatedOn for LoanObject.
UpdatedOn Date Time,
/// Stores Version for LoanObject.
Version Long Integer required default 1,
/// Stores LoanRequestId for LoanObject.
LoanRequestId MxLoanRequest Identifier required references MxLoanRequest on delete Protect,
/// Stores MuseumObjectId for LoanObject.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores InsuredValue for LoanObject.
InsuredValue Decimal(18,2) required,
/// Stores SpecialConditions for LoanObject.
SpecialConditions Text(200)
);
create unique index UQ_1 on MxLoanObject (LoanRequestId, MuseumObjectId);
/// Records used by LoanAgreement.
create entity MxLoanAgreement public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for LoanAgreement.
CreatedOn Date Time required,
/// Stores UpdatedOn for LoanAgreement.
UpdatedOn Date Time,
/// Stores Version for LoanAgreement.
Version Long Integer required default 1,
/// Stores LoanRequestId for LoanAgreement.
LoanRequestId MxLoanRequest Identifier required references MxLoanRequest on delete Protect,
/// Stores Number for LoanAgreement.
Number Text(50) required,
/// Stores SignedOn for LoanAgreement.
SignedOn Date required,
/// Stores StatusId for LoanAgreement.
StatusId MxLifecycle Identifier required references MxLifecycle on delete Protect,
/// Stores ReturnDeadline for LoanAgreement.
ReturnDeadline Date required
);
create unique index UQ_1 on MxLoanAgreement (Number);
/// Records used by InsurancePolicy.
create entity MxInsurancePolicy public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for InsurancePolicy.
CreatedOn Date Time required,
/// Stores UpdatedOn for InsurancePolicy.
UpdatedOn Date Time,
/// Stores Version for InsurancePolicy.
Version Long Integer required default 1,
/// Stores OrganizationId for InsurancePolicy.
OrganizationId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores Number for InsurancePolicy.
Number Text(50) required,
/// Stores Coverage for InsurancePolicy.
Coverage Decimal(18,2) required,
/// Stores Deductible for InsurancePolicy.
Deductible Decimal(18,2) required,
/// Stores ValidUntil for InsurancePolicy.
ValidUntil Date required
);
create unique index UQ_1 on MxInsurancePolicy (Number);
/// Records used by LoanInsurance.
create entity MxLoanInsurance public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for LoanInsurance.
CreatedOn Date Time required,
/// Stores UpdatedOn for LoanInsurance.
UpdatedOn Date Time,
/// Stores Version for LoanInsurance.
Version Long Integer required default 1,
/// Stores LoanAgreementId for LoanInsurance.
LoanAgreementId MxLoanAgreement Identifier required references MxLoanAgreement on delete Protect,
/// Stores InsurancePolicyId for LoanInsurance.
InsurancePolicyId MxInsurancePolicy Identifier required references MxInsurancePolicy on delete Protect,
/// Stores EffectiveFrom for LoanInsurance.
EffectiveFrom Date required,
/// Stores EffectiveUntil for LoanInsurance.
EffectiveUntil Date required
);
/// Records used by Shipment.
create entity MxShipment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Shipment.
CreatedOn Date Time required,
/// Stores UpdatedOn for Shipment.
UpdatedOn Date Time,
/// Stores Version for Shipment.
Version Long Integer required default 1,
/// Stores LoanAgreementId for Shipment.
LoanAgreementId MxLoanAgreement Identifier required references MxLoanAgreement on delete Protect,
/// Stores CarrierId for Shipment.
CarrierId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores TrackingCode for Shipment.
TrackingCode Text(50) required,
/// Stores DepartsAt for Shipment.
DepartsAt Date Time required,
/// Stores ExpectedAt for Shipment.
ExpectedAt Date Time required
);
/// Records used by ShippingCrate.
create entity MxShippingCrate public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ShippingCrate.
CreatedOn Date Time required,
/// Stores UpdatedOn for ShippingCrate.
UpdatedOn Date Time,
/// Stores Version for ShippingCrate.
Version Long Integer required default 1,
/// Stores ShipmentId for ShippingCrate.
ShipmentId MxShipment Identifier required references MxShipment on delete Protect,
/// Stores Code for ShippingCrate.
Code Text(50) required,
/// Stores Width for ShippingCrate.
Width Decimal(18,4) required,
/// Stores Height for ShippingCrate.
Height Decimal(18,4) required,
/// Stores Depth for ShippingCrate.
Depth Decimal(18,4) required,
/// Stores GrossWeight for ShippingCrate.
GrossWeight Decimal(18,4) required
);
/// Records used by CrateContent.
create entity MxCrateContent public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for CrateContent.
CreatedOn Date Time required,
/// Stores UpdatedOn for CrateContent.
UpdatedOn Date Time,
/// Stores Version for CrateContent.
Version Long Integer required default 1,
/// Stores ShippingCrateId for CrateContent.
ShippingCrateId MxShippingCrate Identifier required references MxShippingCrate on delete Protect,
/// Stores MuseumObjectId for CrateContent.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores PackingMaterial for CrateContent.
PackingMaterial Text(200) required
);
create unique index UQ_1 on MxCrateContent (ShippingCrateId, MuseumObjectId);
/// Records used by ShipmentCheckpoint.
create entity MxShipmentCheckpoint public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ShipmentCheckpoint.
CreatedOn Date Time required,
/// Stores UpdatedOn for ShipmentCheckpoint.
UpdatedOn Date Time,
/// Stores Version for ShipmentCheckpoint.
Version Long Integer required default 1,
/// Stores ShipmentId for ShipmentCheckpoint.
ShipmentId MxShipment Identifier required references MxShipment on delete Protect,
/// Stores OccurredAt for ShipmentCheckpoint.
OccurredAt Date Time required,
/// Stores Location for ShipmentCheckpoint.
Location Text(200) required,
/// Stores Temperature for ShipmentCheckpoint.
Temperature Decimal(18,4),
/// Stores Humidity for ShipmentCheckpoint.
Humidity Decimal(18,4)
);
/// Records used by LoanReturn.
create entity MxLoanReturn public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for LoanReturn.
CreatedOn Date Time required,
/// Stores UpdatedOn for LoanReturn.
UpdatedOn Date Time,
/// Stores Version for LoanReturn.
Version Long Integer required default 1,
/// Stores LoanAgreementId for LoanReturn.
LoanAgreementId MxLoanAgreement Identifier required references MxLoanAgreement on delete Protect,
/// Stores ReceivedById for LoanReturn.
ReceivedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores ReceivedAt for LoanReturn.
ReceivedAt Date Time required,
/// Stores ConditionReportId for LoanReturn.
ConditionReportId MxConditionReport Identifier required references MxConditionReport on delete Protect,
/// Stores Discrepancy for LoanReturn.
Discrepancy Text(1000)
);
/// Records used by Exhibition.
create entity MxExhibition public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Exhibition.
CreatedOn Date Time required,
/// Stores UpdatedOn for Exhibition.
UpdatedOn Date Time,
/// Stores Version for Exhibition.
Version Long Integer required default 1,
/// Stores BranchId for Exhibition.
BranchId MxBranch Identifier required references MxBranch on delete Protect,
/// Stores Code for Exhibition.
Code Text(50) required,
/// Stores Title for Exhibition.
Title Text(200) required,
/// Stores StartsOn for Exhibition.
StartsOn Date required,
/// Stores EndsOn for Exhibition.
EndsOn Date required,
/// Stores CuratorId for Exhibition.
CuratorId MxPerson Identifier required references MxPerson on delete Protect
);
create unique index UQ_1 on MxExhibition (Code);
/// Records used by ExhibitionSection.
create entity MxExhibitionSection public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ExhibitionSection.
CreatedOn Date Time required,
/// Stores UpdatedOn for ExhibitionSection.
UpdatedOn Date Time,
/// Stores Version for ExhibitionSection.
Version Long Integer required default 1,
/// Stores ExhibitionId for ExhibitionSection.
ExhibitionId MxExhibition Identifier required references MxExhibition on delete Protect,
/// Stores Title for ExhibitionSection.
Title Text(200) required,
/// Stores Sequence for ExhibitionSection.
Sequence Integer required,
/// Stores RoomId for ExhibitionSection.
RoomId MxRoom Identifier required references MxRoom on delete Protect
);
/// Records used by ExhibitionObject.
create entity MxExhibitionObject public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ExhibitionObject.
CreatedOn Date Time required,
/// Stores UpdatedOn for ExhibitionObject.
UpdatedOn Date Time,
/// Stores Version for ExhibitionObject.
Version Long Integer required default 1,
/// Stores ExhibitionSectionId for ExhibitionObject.
ExhibitionSectionId MxExhibitionSection Identifier required references MxExhibitionSection on delete Protect,
/// Stores MuseumObjectId for ExhibitionObject.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores DisplayFrom for ExhibitionObject.
DisplayFrom Date required,
/// Stores DisplayUntil for ExhibitionObject.
DisplayUntil Date required,
/// Stores LightLimit for ExhibitionObject.
LightLimit Decimal(18,4) required
);
create unique index UQ_1 on MxExhibitionObject (ExhibitionSectionId, MuseumObjectId);
/// Records used by DisplayCase.
create entity MxDisplayCase public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for DisplayCase.
CreatedOn Date Time required,
/// Stores UpdatedOn for DisplayCase.
UpdatedOn Date Time,
/// Stores Version for DisplayCase.
Version Long Integer required default 1,
/// Stores RoomId for DisplayCase.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores Code for DisplayCase.
Code Text(50) required,
/// Stores AlarmEnabled for DisplayCase.
AlarmEnabled Boolean required,
/// Stores ClimateControlled for DisplayCase.
ClimateControlled Boolean required,
/// Stores MaxLoad for DisplayCase.
MaxLoad Decimal(18,4) required
);
/// Records used by DisplayPlacement.
create entity MxDisplayPlacement public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for DisplayPlacement.
CreatedOn Date Time required,
/// Stores UpdatedOn for DisplayPlacement.
UpdatedOn Date Time,
/// Stores Version for DisplayPlacement.
Version Long Integer required default 1,
/// Stores DisplayCaseId for DisplayPlacement.
DisplayCaseId MxDisplayCase Identifier required references MxDisplayCase on delete Protect,
/// Stores ExhibitionObjectId for DisplayPlacement.
ExhibitionObjectId MxExhibitionObject Identifier required references MxExhibitionObject on delete Protect,
/// Stores Position for DisplayPlacement.
Position Text(200) required,
/// Stores InstalledAt for DisplayPlacement.
InstalledAt Date Time required,
/// Stores RemovedAt for DisplayPlacement.
RemovedAt Date Time
);
/// Records used by InterpretiveLabel.
create entity MxInterpretiveLabel public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for InterpretiveLabel.
CreatedOn Date Time required,
/// Stores UpdatedOn for InterpretiveLabel.
UpdatedOn Date Time,
/// Stores Version for InterpretiveLabel.
Version Long Integer required default 1,
/// Stores ExhibitionObjectId for InterpretiveLabel.
ExhibitionObjectId MxExhibitionObject Identifier required references MxExhibitionObject on delete Protect,
/// Stores Language for InterpretiveLabel.
Language Text(12) required,
/// Stores Title for InterpretiveLabel.
Title Text(200) required,
/// Stores Body for InterpretiveLabel.
Body Text(2000) required,
/// Stores ApprovedById for InterpretiveLabel.
ApprovedById MxPerson Identifier references MxPerson on delete Protect
);
/// Records used by GuidedTour.
create entity MxGuidedTour public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for GuidedTour.
CreatedOn Date Time required,
/// Stores UpdatedOn for GuidedTour.
UpdatedOn Date Time,
/// Stores Version for GuidedTour.
Version Long Integer required default 1,
/// Stores ExhibitionId for GuidedTour.
ExhibitionId MxExhibition Identifier required references MxExhibition on delete Protect,
/// Stores GuideId for GuidedTour.
GuideId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores StartsAt for GuidedTour.
StartsAt Date Time required,
/// Stores DurationMinutes for GuidedTour.
DurationMinutes Integer required,
/// Stores Capacity for GuidedTour.
Capacity Integer required
);
/// Records used by TourBooking.
create entity MxTourBooking public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for TourBooking.
CreatedOn Date Time required,
/// Stores UpdatedOn for TourBooking.
UpdatedOn Date Time,
/// Stores Version for TourBooking.
Version Long Integer required default 1,
/// Stores GuidedTourId for TourBooking.
GuidedTourId MxGuidedTour Identifier required references MxGuidedTour on delete Protect,
/// Stores ContactId for TourBooking.
ContactId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores Participants for TourBooking.
Participants Integer required,
/// Stores AccessibilityNeeds for TourBooking.
AccessibilityNeeds Text(200),
/// Stores StatusId for TourBooking.
StatusId MxLifecycle Identifier required references MxLifecycle on delete Protect
);
/// Records used by Workshop.
create entity MxWorkshop public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Workshop.
CreatedOn Date Time required,
/// Stores UpdatedOn for Workshop.
UpdatedOn Date Time,
/// Stores Version for Workshop.
Version Long Integer required default 1,
/// Stores BranchId for Workshop.
BranchId MxBranch Identifier required references MxBranch on delete Protect,
/// Stores InstructorId for Workshop.
InstructorId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores Title for Workshop.
Title Text(200) required,
/// Stores StartsAt for Workshop.
StartsAt Date Time required,
/// Stores Capacity for Workshop.
Capacity Integer required,
/// Stores Fee for Workshop.
Fee Decimal(18,2) required
);
/// Records used by WorkshopEnrollment.
create entity MxWorkshopEnrollment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for WorkshopEnrollment.
CreatedOn Date Time required,
/// Stores UpdatedOn for WorkshopEnrollment.
UpdatedOn Date Time,
/// Stores Version for WorkshopEnrollment.
Version Long Integer required default 1,
/// Stores WorkshopId for WorkshopEnrollment.
WorkshopId MxWorkshop Identifier required references MxWorkshop on delete Protect,
/// Stores PersonId for WorkshopEnrollment.
PersonId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores PaidAmount for WorkshopEnrollment.
PaidAmount Decimal(18,2) required,
/// Stores Attended for WorkshopEnrollment.
Attended Boolean
);
create unique index UQ_1 on MxWorkshopEnrollment (WorkshopId, PersonId);
/// Records used by AcquisitionProposal.
create entity MxAcquisitionProposal public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for AcquisitionProposal.
CreatedOn Date Time required,
/// Stores UpdatedOn for AcquisitionProposal.
UpdatedOn Date Time,
/// Stores Version for AcquisitionProposal.
Version Long Integer required default 1,
/// Stores CollectionId for AcquisitionProposal.
CollectionId MxCollection Identifier required references MxCollection on delete Protect,
/// Stores ProposedById for AcquisitionProposal.
ProposedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores Title for AcquisitionProposal.
Title Text(200) required,
/// Stores Price for AcquisitionProposal.
Price Decimal(18,2) required,
/// Stores Justification for AcquisitionProposal.
Justification Text(2000) required,
/// Stores DecisionId for AcquisitionProposal.
DecisionId MxDecision Identifier required references MxDecision on delete Protect
);
/// Records used by ProposalObject.
create entity MxProposalObject public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ProposalObject.
CreatedOn Date Time required,
/// Stores UpdatedOn for ProposalObject.
UpdatedOn Date Time,
/// Stores Version for ProposalObject.
Version Long Integer required default 1,
/// Stores AcquisitionProposalId for ProposalObject.
AcquisitionProposalId MxAcquisitionProposal Identifier required references MxAcquisitionProposal on delete Protect,
/// Stores Description for ProposalObject.
Description Text(200) required,
/// Stores MaterialId for ProposalObject.
MaterialId MxMaterial Identifier required references MxMaterial on delete Protect,
/// Stores OriginId for ProposalObject.
OriginId MxCulturalOrigin Identifier references MxCulturalOrigin on delete Protect,
/// Stores Value for ProposalObject.
Value Decimal(18,2) required
);
/// Records used by DueDiligence.
create entity MxDueDiligence public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for DueDiligence.
CreatedOn Date Time required,
/// Stores UpdatedOn for DueDiligence.
UpdatedOn Date Time,
/// Stores Version for DueDiligence.
Version Long Integer required default 1,
/// Stores AcquisitionProposalId for DueDiligence.
AcquisitionProposalId MxAcquisitionProposal Identifier required references MxAcquisitionProposal on delete Protect,
/// Stores ReviewerId for DueDiligence.
ReviewerId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores CheckedOn for DueDiligence.
CheckedOn Date required,
/// Stores LegalConcern for DueDiligence.
LegalConcern Boolean required,
/// Stores Findings for DueDiligence.
Findings Text(2000) required
);
/// Records used by AcquisitionVote.
create entity MxAcquisitionVote public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for AcquisitionVote.
CreatedOn Date Time required,
/// Stores UpdatedOn for AcquisitionVote.
UpdatedOn Date Time,
/// Stores Version for AcquisitionVote.
Version Long Integer required default 1,
/// Stores AcquisitionProposalId for AcquisitionVote.
AcquisitionProposalId MxAcquisitionProposal Identifier required references MxAcquisitionProposal on delete Protect,
/// Stores PersonId for AcquisitionVote.
PersonId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores DecisionId for AcquisitionVote.
DecisionId MxDecision Identifier required references MxDecision on delete Protect,
/// Stores VotedAt for AcquisitionVote.
VotedAt Date Time required,
/// Stores Reason for AcquisitionVote.
Reason Text(200)
);
create unique index UQ_1 on MxAcquisitionVote (AcquisitionProposalId, PersonId);
/// Records used by Donation.
create entity MxDonation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Donation.
CreatedOn Date Time required,
/// Stores UpdatedOn for Donation.
UpdatedOn Date Time,
/// Stores Version for Donation.
Version Long Integer required default 1,
/// Stores OrganizationId for Donation.
OrganizationId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores AccessionId for Donation.
AccessionId MxAccession Identifier required references MxAccession on delete Protect,
/// Stores AgreementDate for Donation.
AgreementDate Date required,
/// Stores Conditions for Donation.
Conditions Text(2000) required
);
/// Records used by Grant.
create entity MxGrant public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Grant.
CreatedOn Date Time required,
/// Stores UpdatedOn for Grant.
UpdatedOn Date Time,
/// Stores Version for Grant.
Version Long Integer required default 1,
/// Stores OrganizationId for Grant.
OrganizationId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores Code for Grant.
Code Text(50) required,
/// Stores Purpose for Grant.
Purpose Text(200) required,
/// Stores Amount for Grant.
Amount Decimal(18,2) required,
/// Stores StartsOn for Grant.
StartsOn Date required,
/// Stores EndsOn for Grant.
EndsOn Date required
);
create unique index UQ_1 on MxGrant (Code);
/// Records used by GrantMilestone.
create entity MxGrantMilestone public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for GrantMilestone.
CreatedOn Date Time required,
/// Stores UpdatedOn for GrantMilestone.
UpdatedOn Date Time,
/// Stores Version for GrantMilestone.
Version Long Integer required default 1,
/// Stores GrantId for GrantMilestone.
GrantId MxGrant Identifier required references MxGrant on delete Protect,
/// Stores Title for GrantMilestone.
Title Text(200) required,
/// Stores DueOn for GrantMilestone.
DueOn Date required,
/// Stores Budget for GrantMilestone.
Budget Decimal(18,2) required,
/// Stores CompletedOn for GrantMilestone.
CompletedOn Date
);
/// Records used by GrantExpense.
create entity MxGrantExpense public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for GrantExpense.
CreatedOn Date Time required,
/// Stores UpdatedOn for GrantExpense.
UpdatedOn Date Time,
/// Stores Version for GrantExpense.
Version Long Integer required default 1,
/// Stores GrantMilestoneId for GrantExpense.
GrantMilestoneId MxGrantMilestone Identifier required references MxGrantMilestone on delete Protect,
/// Stores Description for GrantExpense.
Description Text(200) required,
/// Stores IncurredOn for GrantExpense.
IncurredOn Date required,
/// Stores Amount for GrantExpense.
Amount Decimal(18,2) required,
/// Stores InvoiceNumber for GrantExpense.
InvoiceNumber Text(50) required
);
/// Records used by Purchase.
create entity MxPurchase public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Purchase.
CreatedOn Date Time required,
/// Stores UpdatedOn for Purchase.
UpdatedOn Date Time,
/// Stores Version for Purchase.
Version Long Integer required default 1,
/// Stores OrganizationId for Purchase.
OrganizationId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores Reference for Purchase.
Reference Text(50) required,
/// Stores OrderedOn for Purchase.
OrderedOn Date required,
/// Stores Total for Purchase.
Total Decimal(18,2) required,
/// Stores StatusId for Purchase.
StatusId MxLifecycle Identifier required references MxLifecycle on delete Protect
);
create unique index UQ_1 on MxPurchase (Reference);
/// Records used by PurchaseItem.
create entity MxPurchaseItem public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PurchaseItem.
CreatedOn Date Time required,
/// Stores UpdatedOn for PurchaseItem.
UpdatedOn Date Time,
/// Stores Version for PurchaseItem.
Version Long Integer required default 1,
/// Stores PurchaseId for PurchaseItem.
PurchaseId MxPurchase Identifier required references MxPurchase on delete Protect,
/// Stores Description for PurchaseItem.
Description Text(200) required,
/// Stores Quantity for PurchaseItem.
Quantity Decimal(18,4) required,
/// Stores UnitPrice for PurchaseItem.
UnitPrice Decimal(18,2) required,
/// Stores MuseumObjectId for PurchaseItem.
MuseumObjectId MxMuseumObject Identifier references MxMuseumObject on delete Protect
);
/// Records used by ResearchProject.
create entity MxResearchProject public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ResearchProject.
CreatedOn Date Time required,
/// Stores UpdatedOn for ResearchProject.
UpdatedOn Date Time,
/// Stores Version for ResearchProject.
Version Long Integer required default 1,
/// Stores InstitutionId for ResearchProject.
InstitutionId MxInstitution Identifier required references MxInstitution on delete Protect,
/// Stores LeadId for ResearchProject.
LeadId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores Title for ResearchProject.
Title Text(200) required,
/// Stores StartsOn for ResearchProject.
StartsOn Date required,
/// Stores EndsOn for ResearchProject.
EndsOn Date required,
/// Stores EthicsApproval for ResearchProject.
EthicsApproval Text(50)
);
/// Records used by ResearchAccess.
create entity MxResearchAccess public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ResearchAccess.
CreatedOn Date Time required,
/// Stores UpdatedOn for ResearchAccess.
UpdatedOn Date Time,
/// Stores Version for ResearchAccess.
Version Long Integer required default 1,
/// Stores ResearchProjectId for ResearchAccess.
ResearchProjectId MxResearchProject Identifier required references MxResearchProject on delete Protect,
/// Stores MuseumObjectId for ResearchAccess.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores PersonId for ResearchAccess.
PersonId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores GrantedUntil for ResearchAccess.
GrantedUntil Date required,
/// Stores Restrictions for ResearchAccess.
Restrictions Text(200)
);
/// Records used by ResearchVisit.
create entity MxResearchVisit public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for ResearchVisit.
CreatedOn Date Time required,
/// Stores UpdatedOn for ResearchVisit.
UpdatedOn Date Time,
/// Stores Version for ResearchVisit.
Version Long Integer required default 1,
/// Stores ResearchAccessId for ResearchVisit.
ResearchAccessId MxResearchAccess Identifier required references MxResearchAccess on delete Protect,
/// Stores ScheduledAt for ResearchVisit.
ScheduledAt Date Time required,
/// Stores DurationMinutes for ResearchVisit.
DurationMinutes Integer required,
/// Stores SupervisedById for ResearchVisit.
SupervisedById MxPerson Identifier required references MxPerson on delete Protect
);
/// Records used by Publication.
create entity MxPublication public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Publication.
CreatedOn Date Time required,
/// Stores UpdatedOn for Publication.
UpdatedOn Date Time,
/// Stores Version for Publication.
Version Long Integer required default 1,
/// Stores ResearchProjectId for Publication.
ResearchProjectId MxResearchProject Identifier required references MxResearchProject on delete Protect,
/// Stores Title for Publication.
Title Text(200) required,
/// Stores Doi for Publication.
Doi Text(200),
/// Stores PublishedOn for Publication.
PublishedOn Date,
/// Stores RightsId for Publication.
RightsId MxRights Identifier required references MxRights on delete Protect
);
/// Records used by PublicationObject.
create entity MxPublicationObject public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PublicationObject.
CreatedOn Date Time required,
/// Stores UpdatedOn for PublicationObject.
UpdatedOn Date Time,
/// Stores Version for PublicationObject.
Version Long Integer required default 1,
/// Stores PublicationId for PublicationObject.
PublicationId MxPublication Identifier required references MxPublication on delete Protect,
/// Stores MuseumObjectId for PublicationObject.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores PageReference for PublicationObject.
PageReference Text(50)
);
create unique index UQ_1 on MxPublicationObject (PublicationId, MuseumObjectId);
/// Records used by DigitalAsset.
create entity MxDigitalAsset public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for DigitalAsset.
CreatedOn Date Time required,
/// Stores UpdatedOn for DigitalAsset.
UpdatedOn Date Time,
/// Stores Version for DigitalAsset.
Version Long Integer required default 1,
/// Stores MuseumObjectId for DigitalAsset.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores FileName for DigitalAsset.
FileName Text(200) required,
/// Stores StorageKey for DigitalAsset.
StorageKey Text(200) required,
/// Stores MimeType for DigitalAsset.
MimeType Text(100) required,
/// Stores ByteCount for DigitalAsset.
ByteCount Long Integer required,
/// Stores RightsId for DigitalAsset.
RightsId MxRights Identifier required references MxRights on delete Protect
);
/// Records used by AssetDerivative.
create entity MxAssetDerivative public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for AssetDerivative.
CreatedOn Date Time required,
/// Stores UpdatedOn for AssetDerivative.
UpdatedOn Date Time,
/// Stores Version for AssetDerivative.
Version Long Integer required default 1,
/// Stores DigitalAssetId for AssetDerivative.
DigitalAssetId MxDigitalAsset Identifier required references MxDigitalAsset on delete Protect,
/// Stores Format for AssetDerivative.
Format Text(50) required,
/// Stores Width for AssetDerivative.
Width Integer required,
/// Stores Height for AssetDerivative.
Height Integer required,
/// Stores StorageKey for AssetDerivative.
StorageKey Text(200) required
);
/// Records used by RightsPermission.
create entity MxRightsPermission public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for RightsPermission.
CreatedOn Date Time required,
/// Stores UpdatedOn for RightsPermission.
UpdatedOn Date Time,
/// Stores Version for RightsPermission.
Version Long Integer required default 1,
/// Stores DigitalAssetId for RightsPermission.
DigitalAssetId MxDigitalAsset Identifier required references MxDigitalAsset on delete Protect,
/// Stores OrganizationId for RightsPermission.
OrganizationId MxOrganization Identifier required references MxOrganization on delete Protect,
/// Stores Purpose for RightsPermission.
Purpose Text(200) required,
/// Stores ExpiresOn for RightsPermission.
ExpiresOn Date required,
/// Stores Fee for RightsPermission.
Fee Decimal(18,2) required
);
/// Records used by DigitizationTask.
create entity MxDigitizationTask public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for DigitizationTask.
CreatedOn Date Time required,
/// Stores UpdatedOn for DigitizationTask.
UpdatedOn Date Time,
/// Stores Version for DigitizationTask.
Version Long Integer required default 1,
/// Stores MuseumObjectId for DigitizationTask.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores AssignedToId for DigitizationTask.
AssignedToId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores DueOn for DigitizationTask.
DueOn Date required,
/// Stores ResolutionDpi for DigitizationTask.
ResolutionDpi Integer required,
/// Stores CompletedAt for DigitizationTask.
CompletedAt Date Time
);
/// Records used by AssetChecksum.
create entity MxAssetChecksum public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for AssetChecksum.
CreatedOn Date Time required,
/// Stores UpdatedOn for AssetChecksum.
UpdatedOn Date Time,
/// Stores Version for AssetChecksum.
Version Long Integer required default 1,
/// Stores DigitalAssetId for AssetChecksum.
DigitalAssetId MxDigitalAsset Identifier required references MxDigitalAsset on delete Protect,
/// Stores Algorithm for AssetChecksum.
Algorithm Text(50) required,
/// Stores Digest for AssetChecksum.
Digest Text(200) required,
/// Stores VerifiedAt for AssetChecksum.
VerifiedAt Date Time required
);
create unique index UQ_1 on MxAssetChecksum (DigitalAssetId, Algorithm);
/// Records used by SecurityIncident.
create entity MxSecurityIncident public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for SecurityIncident.
CreatedOn Date Time required,
/// Stores UpdatedOn for SecurityIncident.
UpdatedOn Date Time,
/// Stores Version for SecurityIncident.
Version Long Integer required default 1,
/// Stores RoomId for SecurityIncident.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores ReportedById for SecurityIncident.
ReportedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores OccurredAt for SecurityIncident.
OccurredAt Date Time required,
/// Stores Description for SecurityIncident.
Description Text(2000) required,
/// Stores ResolvedAt for SecurityIncident.
ResolvedAt Date Time
);
/// Records used by AccessBadge.
create entity MxAccessBadge public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for AccessBadge.
CreatedOn Date Time required,
/// Stores UpdatedOn for AccessBadge.
UpdatedOn Date Time,
/// Stores Version for AccessBadge.
Version Long Integer required default 1,
/// Stores PersonId for AccessBadge.
PersonId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores BadgeNumber for AccessBadge.
BadgeNumber Text(50) required,
/// Stores ValidUntil for AccessBadge.
ValidUntil Date required,
/// Stores Suspended for AccessBadge.
Suspended Boolean required
);
create unique index UQ_1 on MxAccessBadge (BadgeNumber);
/// Records used by RoomAccess.
create entity MxRoomAccess public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for RoomAccess.
CreatedOn Date Time required,
/// Stores UpdatedOn for RoomAccess.
UpdatedOn Date Time,
/// Stores Version for RoomAccess.
Version Long Integer required default 1,
/// Stores AccessBadgeId for RoomAccess.
AccessBadgeId MxAccessBadge Identifier required references MxAccessBadge on delete Protect,
/// Stores RoomId for RoomAccess.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores AllowedFrom for RoomAccess.
AllowedFrom Date required,
/// Stores AllowedUntil for RoomAccess.
AllowedUntil Date required
);
/// Records used by EntryLog.
create entity MxEntryLog public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for EntryLog.
CreatedOn Date Time required,
/// Stores UpdatedOn for EntryLog.
UpdatedOn Date Time,
/// Stores Version for EntryLog.
Version Long Integer required default 1,
/// Stores AccessBadgeId for EntryLog.
AccessBadgeId MxAccessBadge Identifier required references MxAccessBadge on delete Protect,
/// Stores RoomId for EntryLog.
RoomId MxRoom Identifier required references MxRoom on delete Protect,
/// Stores EnteredAt for EntryLog.
EnteredAt Date Time required,
/// Stores ExitedAt for EntryLog.
ExitedAt Date Time
);
/// Records used by MovementRequest.
create entity MxMovementRequest public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for MovementRequest.
CreatedOn Date Time required,
/// Stores UpdatedOn for MovementRequest.
UpdatedOn Date Time,
/// Stores Version for MovementRequest.
Version Long Integer required default 1,
/// Stores MuseumObjectId for MovementRequest.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores FromPositionId for MovementRequest.
FromPositionId MxStoragePosition Identifier required references MxStoragePosition on delete Protect,
/// Stores ToPositionId for MovementRequest.
ToPositionId MxStoragePosition Identifier required references MxStoragePosition on delete Protect,
/// Stores RequestedById for MovementRequest.
RequestedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores DecisionId for MovementRequest.
DecisionId MxDecision Identifier required references MxDecision on delete Protect
);
/// Records used by MovementExecution.
create entity MxMovementExecution public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for MovementExecution.
CreatedOn Date Time required,
/// Stores UpdatedOn for MovementExecution.
UpdatedOn Date Time,
/// Stores Version for MovementExecution.
Version Long Integer required default 1,
/// Stores MovementRequestId for MovementExecution.
MovementRequestId MxMovementRequest Identifier required references MxMovementRequest on delete Protect,
/// Stores MovedById for MovementExecution.
MovedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores MovedAt for MovementExecution.
MovedAt Date Time required,
/// Stores ConditionReportId for MovementExecution.
ConditionReportId MxConditionReport Identifier required references MxConditionReport on delete Protect
);
/// Records used by InventoryCampaign.
create entity MxInventoryCampaign public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for InventoryCampaign.
CreatedOn Date Time required,
/// Stores UpdatedOn for InventoryCampaign.
UpdatedOn Date Time,
/// Stores Version for InventoryCampaign.
Version Long Integer required default 1,
/// Stores BranchId for InventoryCampaign.
BranchId MxBranch Identifier required references MxBranch on delete Protect,
/// Stores Name for InventoryCampaign.
Name Text(200) required,
/// Stores StartsOn for InventoryCampaign.
StartsOn Date required,
/// Stores EndsOn for InventoryCampaign.
EndsOn Date required,
/// Stores ResponsibleId for InventoryCampaign.
ResponsibleId MxPerson Identifier required references MxPerson on delete Protect
);
/// Records used by InventoryCheck.
create entity MxInventoryCheck public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for InventoryCheck.
CreatedOn Date Time required,
/// Stores UpdatedOn for InventoryCheck.
UpdatedOn Date Time,
/// Stores Version for InventoryCheck.
Version Long Integer required default 1,
/// Stores InventoryCampaignId for InventoryCheck.
InventoryCampaignId MxInventoryCampaign Identifier required references MxInventoryCampaign on delete Protect,
/// Stores MuseumObjectId for InventoryCheck.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores Found for InventoryCheck.
Found Boolean required,
/// Stores CheckedAt for InventoryCheck.
CheckedAt Date Time required,
/// Stores ObservedPositionId for InventoryCheck.
ObservedPositionId MxStoragePosition Identifier references MxStoragePosition on delete Protect
);
create unique index UQ_1 on MxInventoryCheck (InventoryCampaignId, MuseumObjectId);
/// Records used by InventoryDiscrepancy.
create entity MxInventoryDiscrepancy public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for InventoryDiscrepancy.
CreatedOn Date Time required,
/// Stores UpdatedOn for InventoryDiscrepancy.
UpdatedOn Date Time,
/// Stores Version for InventoryDiscrepancy.
Version Long Integer required default 1,
/// Stores InventoryCheckId for InventoryDiscrepancy.
InventoryCheckId MxInventoryCheck Identifier required references MxInventoryCheck on delete Protect,
/// Stores Reason for InventoryDiscrepancy.
Reason Text(1000) required,
/// Stores AssignedToId for InventoryDiscrepancy.
AssignedToId MxPerson Identifier required references MxPerson on delete Protect,
/// Stores ResolvedAt for InventoryDiscrepancy.
ResolvedAt Date Time,
/// Stores Resolution for InventoryDiscrepancy.
Resolution Text(1000)
);
/// Records used by Deaccession.
create entity MxDeaccession public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for Deaccession.
CreatedOn Date Time required,
/// Stores UpdatedOn for Deaccession.
UpdatedOn Date Time,
/// Stores Version for Deaccession.
Version Long Integer required default 1,
/// Stores MuseumObjectId for Deaccession.
MuseumObjectId MxMuseumObject Identifier required references MxMuseumObject on delete Protect,
/// Stores RequestedById for Deaccession.
RequestedById MxPerson Identifier required references MxPerson on delete Protect,
/// Stores Reason for Deaccession.
Reason Text(2000) required,
/// Stores DecisionId for Deaccession.
DecisionId MxDecision Identifier required references MxDecision on delete Protect,
/// Stores EffectiveOn for Deaccession.
EffectiveOn Date
);
