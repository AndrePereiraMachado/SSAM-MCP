/// Records used by PortVessel.
create entity PortVessel public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortVessel.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortVessel.
UpdatedOn Date Time,
/// Stores Version for PortVessel.
Version Long Integer required default 1,
/// Stores Tenant for PortVessel.
Tenant Text(50),
/// Stores Code for PortVessel.
Code Text(50),
/// Stores Draft for PortVessel.
Draft Decimal(18,4),
/// Stores Length for PortVessel.
Length Decimal(18,4),
/// Stores Beam for PortVessel.
Beam Decimal(18,4),
/// Stores MaxTonnage for PortVessel.
MaxTonnage Decimal(18,4),
/// Stores UsedTonnage for PortVessel.
UsedTonnage Decimal(18,4),
/// Stores ReeferSlots for PortVessel.
ReeferSlots Integer,
/// Stores ReeferUsed for PortVessel.
ReeferUsed Integer,
/// Stores HazardLevel for PortVessel.
HazardLevel Integer,
/// Stores State for PortVessel.
State Text(50),
/// Stores FuelCap for PortVessel.
FuelCap Decimal(18,4),
/// Stores FuelRemaining for PortVessel.
FuelRemaining Decimal(18,4)
);
/// Records used by PortBerth.
create entity PortBerth public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortBerth.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortBerth.
UpdatedOn Date Time,
/// Stores Version for PortBerth.
Version Long Integer required default 1,
/// Stores Tenant for PortBerth.
Tenant Text(50),
/// Stores Code for PortBerth.
Code Text(50),
/// Stores Depth for PortBerth.
Depth Decimal(18,4),
/// Stores Length for PortBerth.
Length Decimal(18,4),
/// Stores MaxBeam for PortBerth.
MaxBeam Decimal(18,4),
/// Stores Occupied for PortBerth.
Occupied Boolean,
/// Stores ClosedWind for PortBerth.
ClosedWind Decimal(18,4),
/// Stores CurrentWind for PortBerth.
CurrentWind Decimal(18,4),
/// Stores ReservedLength for PortBerth.
ReservedLength Decimal(18,4),
/// Stores PowerSlots for PortBerth.
PowerSlots Integer,
/// Stores PowerUsed for PortBerth.
PowerUsed Integer
);
/// Records used by PortCall.
create entity PortCall public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortCall.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortCall.
UpdatedOn Date Time,
/// Stores Version for PortCall.
Version Long Integer required default 1,
/// Stores Tenant for PortCall.
Tenant Text(50),
/// Stores VesselId for PortCall.
VesselId PortVessel Identifier references PortVessel on delete Protect,
/// Stores BerthId for PortCall.
BerthId PortBerth Identifier references PortBerth on delete Protect,
/// Stores PlannedStart for PortCall.
PlannedStart Date Time,
/// Stores PlannedEnd for PortCall.
PlannedEnd Date Time,
/// Stores ActualStart for PortCall.
ActualStart Date Time,
/// Stores ActualEnd for PortCall.
ActualEnd Date Time,
/// Stores State for PortCall.
State Text(50),
/// Stores Priority for PortCall.
Priority Integer,
/// Stores DelayHours for PortCall.
DelayHours Decimal(18,4),
/// Stores TugsRequired for PortCall.
TugsRequired Integer,
/// Stores DocsComplete for PortCall.
DocsComplete Boolean,
/// Stores DepartureAuthorized for PortCall.
DepartureAuthorized Boolean
);
/// Records used by PortCargo.
create entity PortCargo public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortCargo.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortCargo.
UpdatedOn Date Time,
/// Stores Version for PortCargo.
Version Long Integer required default 1,
/// Stores Tenant for PortCargo.
Tenant Text(50),
/// Stores CallId for PortCargo.
CallId PortCall Identifier references PortCall on delete Protect,
/// Stores Code for PortCargo.
Code Text(50),
/// Stores Weight for PortCargo.
Weight Decimal(18,4),
/// Stores Volume for PortCargo.
Volume Decimal(18,4),
/// Stores Units for PortCargo.
Units Integer,
/// Stores HazardClass for PortCargo.
HazardClass Integer,
/// Stores Temperature for PortCargo.
Temperature Decimal(18,4),
/// Stores MinTemp for PortCargo.
MinTemp Decimal(18,4),
/// Stores MaxTemp for PortCargo.
MaxTemp Decimal(18,4),
/// Stores Reefer for PortCargo.
Reefer Boolean,
/// Stores CustomsReleased for PortCargo.
CustomsReleased Boolean,
/// Stores DamagedValue for PortCargo.
DamagedValue Decimal(18,2),
/// Stores LoadedWeight for PortCargo.
LoadedWeight Decimal(18,4),
/// Stores State for PortCargo.
State Text(50)
);
/// Records used by PortCrane.
create entity PortCrane public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortCrane.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortCrane.
UpdatedOn Date Time,
/// Stores Version for PortCrane.
Version Long Integer required default 1,
/// Stores Tenant for PortCrane.
Tenant Text(50),
/// Stores Code for PortCrane.
Code Text(50),
/// Stores Capacity for PortCrane.
Capacity Decimal(18,4),
/// Stores Hours for PortCrane.
Hours Decimal(18,4),
/// Stores MaintenanceAt for PortCrane.
MaintenanceAt Decimal(18,4),
/// Stores WindLimit for PortCrane.
WindLimit Decimal(18,4),
/// Stores Suspended for PortCrane.
Suspended Boolean,
/// Stores Loads for PortCrane.
Loads Integer,
/// Stores EnergyKwh for PortCrane.
EnergyKwh Decimal(18,4)
);
/// Records used by PortShift.
create entity PortShift public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortShift.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortShift.
UpdatedOn Date Time,
/// Stores Version for PortShift.
Version Long Integer required default 1,
/// Stores Tenant for PortShift.
Tenant Text(50),
/// Stores Code for PortShift.
Code Text(50),
/// Stores StartsAt for PortShift.
StartsAt Date Time,
/// Stores EndsAt for PortShift.
EndsAt Date Time,
/// Stores Workers for PortShift.
Workers Integer,
/// Stores Qualified for PortShift.
Qualified Integer,
/// Stores Assigned for PortShift.
Assigned Integer,
/// Stores Overtime for PortShift.
Overtime Decimal(18,4),
/// Stores MaxOvertime for PortShift.
MaxOvertime Decimal(18,4),
/// Stores RestHours for PortShift.
RestHours Decimal(18,4),
/// Stores State for PortShift.
State Text(50)
);
/// Records used by PortInspection.
create entity PortInspection public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortInspection.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortInspection.
UpdatedOn Date Time,
/// Stores Version for PortInspection.
Version Long Integer required default 1,
/// Stores Tenant for PortInspection.
Tenant Text(50),
/// Stores CallId for PortInspection.
CallId PortCall Identifier references PortCall on delete Protect,
/// Stores CargoId for PortInspection.
CargoId PortCargo Identifier references PortCargo on delete Protect,
/// Stores Score for PortInspection.
Score Integer,
/// Stores MajorDefects for PortInspection.
MajorDefects Integer,
/// Stores MinorDefects for PortInspection.
MinorDefects Integer,
/// Stores Evidence for PortInspection.
Evidence Text(50),
/// Stores InspectorId for PortInspection.
InspectorId User Identifier references User on delete Protect,
/// Stores ApproverId for PortInspection.
ApproverId User Identifier references User on delete Protect,
/// Stores State for PortInspection.
State Text(50),
/// Stores ReinspectionAt for PortInspection.
ReinspectionAt Date Time
);
/// Records used by PortInvoice.
create entity PortInvoice public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortInvoice.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortInvoice.
UpdatedOn Date Time,
/// Stores Version for PortInvoice.
Version Long Integer required default 1,
/// Stores Tenant for PortInvoice.
Tenant Text(50),
/// Stores CallId for PortInvoice.
CallId PortCall Identifier references PortCall on delete Protect,
/// Stores Subtotal for PortInvoice.
Subtotal Decimal(18,2),
/// Stores Tax for PortInvoice.
Tax Decimal(18,2),
/// Stores Paid for PortInvoice.
Paid Decimal(18,2),
/// Stores Credit for PortInvoice.
Credit Decimal(18,2),
/// Stores Disputed for PortInvoice.
Disputed Decimal(18,2),
/// Stores Currency for PortInvoice.
Currency Text(50),
/// Stores State for PortInvoice.
State Text(50),
/// Stores DueAt for PortInvoice.
DueAt Date Time,
/// Stores Rate for PortInvoice.
Rate Decimal(18,2),
/// Stores Hours for PortInvoice.
Hours Decimal(18,4)
);
/// Records used by PortEmission.
create entity PortEmission public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortEmission.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortEmission.
UpdatedOn Date Time,
/// Stores Version for PortEmission.
Version Long Integer required default 1,
/// Stores Tenant for PortEmission.
Tenant Text(50),
/// Stores CallId for PortEmission.
CallId PortCall Identifier references PortCall on delete Protect,
/// Stores FuelLitres for PortEmission.
FuelLitres Decimal(18,4),
/// Stores GridKwh for PortEmission.
GridKwh Decimal(18,4),
/// Stores Factor for PortEmission.
Factor Decimal(18,4),
/// Stores Co2 for PortEmission.
Co2 Decimal(18,4),
/// Stores Budget for PortEmission.
Budget Decimal(18,4),
/// Stores Offset for PortEmission.
Offset Decimal(18,4),
/// Stores Verified for PortEmission.
Verified Boolean,
/// Stores State for PortEmission.
State Text(50)
);
/// Records used by PortEvent.
create entity PortEvent public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for PortEvent.
CreatedOn Date Time required,
/// Stores UpdatedOn for PortEvent.
UpdatedOn Date Time,
/// Stores Version for PortEvent.
Version Long Integer required default 1,
/// Stores Tenant for PortEvent.
Tenant Text(50),
/// Stores CallId for PortEvent.
CallId PortCall Identifier references PortCall on delete Protect,
/// Stores Kind for PortEvent.
Kind Text(50),
/// Stores Body for PortEvent.
Body Text(200),
/// Stores Severity for PortEvent.
Severity Integer,
/// Stores Acknowledged for PortEvent.
Acknowledged Boolean,
/// Stores CreatedBy for PortEvent.
CreatedBy User Identifier references User on delete Protect
);
