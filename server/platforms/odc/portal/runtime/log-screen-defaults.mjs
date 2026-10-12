// Native public logs.logs defaults observed 2026-10-05; no downloaded code executes here.
// Defaults are empty state, not permission grants or tenant settings.
const defaults = {
  "screen": {
    "Screenskeletons": {
      "IsFirstLoading": true,
      "StageSkeleton": true,
      "DropdownsFilterLazyLoading": true,
      "ShowOpenTelemetryLinkSkeleton": true
    },
    "AllDataReady_Apps": {
      "DataSettings": false,
      "Filter_Apps": false,
      "Filter_Severity": false,
      "Filter_Stages": false,
      "Filter_Users": false,
      "Search": false
    },
    "DateRangeSetPresetList": {
      "List": [],
      "EmptyListItem": {
        "Id": "",
        "Label": "",
        "Minutes": 0
      }
    },
    "DateRangeSelectedPreset": {
      "Id": "",
      "Label": "",
      "Minutes": 0
    },
    "DateRangeInitialPreset": {
      "Id": "",
      "Label": "",
      "Minutes": 0
    },
    "ScreenPermissions_logs": {
      "UsersData": "NoAccess",
      "UsersEnablement": "NoAccess"
    },
    "Severities": "",
    "SearchTermUser": "",
    "UserListFirstLoad": true,
    "UserSelectedOption": {
      "Value": "",
      "Label": "",
      "ImageUrl": "",
      "Icon": "",
      "IconVariant": "",
      "GroupName": "",
      "Description": "",
      "RightIcon": "",
      "RightIconTooltipText": "",
      "Aliases": {
        "List": [],
        "EmptyListItem": ""
      },
      "AvatarColor": ""
    },
    "TabsInfo": {
      "ShowAgentsTab": false,
      "ShowAppsTab": false,
      "ShowWorkflowsTab": false,
      "SelectedTabIndex": 0
    },
    "isRefreshStages": false,
    "showRateLimitsBanner": false,
    "SeveritySelectedOptions": {
      "List": [],
      "EmptyListItem": {
        "Value": "",
        "Label": "",
        "ImageUrl": "",
        "Icon": "",
        "IconVariant": "",
        "GroupName": "",
        "Description": "",
        "RightIcon": "",
        "RightIconTooltipText": "",
        "Aliases": {
          "List": [],
          "EmptyListItem": ""
        },
        "AvatarColor": ""
      }
    },
    "SelectedEnviroment": {
      "Key": "",
      "Name": "",
      "Hostname": "",
      "Purpose": "",
      "Order": 0,
      "Region": "",
      "Hosting": "",
      "IsConfigured": false,
      "isDeployedToCluster": false,
      "DefaultDomain": "",
      "Status": "",
      "PortfolioKey": "",
      "RegionLabel": ""
    },
    "ApplicationsFilterSearchTerm": "",
    "ActivePortfolioKey": "",
    "IsRefreshing": true,
    "LogsDynamicColumns": {
      "HideUserColumn": false
    },
    "Page": {
      "Limit": "0",
      "Offset": "0",
      "NextPageOffset": "0",
      "TotalPages": "0",
      "TotalResults": "0"
    },
    "SeverityList": {
      "List": [],
      "EmptyListItem": ""
    },
    "instanceid": "",
    "_instanceidInDataFetchStatus": 1,
    "workflowid": "",
    "_workflowidInDataFetchStatus": 1,
    "tab": "",
    "_tabInDataFetchStatus": 1,
    "stageid": "",
    "_stageidInDataFetchStatus": 1,
    "agentid": "",
    "_agentidInDataFetchStatus": 1,
    "GetSettings": {
      "DataFetchStatus": 0,
      "DefaultPresetMinutes": 0,
      "AutoRefreshInterval": 200000,
      "MaxTimeRangeInterval": 14,
      "MaxNumberOfDays": 30,
      "MaxUsersDropdown": 20,
      "NumberOfRecordsPerPage": 100,
      "TextEllipsisTitleLength": 0,
      "IsAgentsV2Enabled": false
    }
  },
  "clientVariables": {
    "WFUsersFilter": "",
    "ATL_UserId": "",
    "WFDateTimeStart": "1900-01-01T00:00:00",
    "AgentsDateTimeEnd": "1900-01-01T00:00:00",
    "ATL_DateRangePresetInMinutes": 0,
    "AgentsLogsSeverity": "",
    "TracesStatus": "",
    "ATL_DateTimeEnd": "1900-01-01T00:00:00",
    "DateTimeStart": "1900-01-01T00:00:00",
    "WFDateRangePresetInMinutes": 0,
    "ApplicationId": "",
    "ATL_Export_DateTimeEnd": "1900-01-01T00:00:00",
    "ATL_PortfolioId": "",
    "ATL_Operation": "",
    "DateRangePresetInMinutes": 0,
    "DateTimeEnd": "1900-01-01T00:00:00",
    "SpanType": "",
    "AgentId": "",
    "ATL_SearchKeyword": "",
    "NoOptionsSelectedKeyword": "none",
    "WFDateTimeIsPreset": true,
    "TracesSearchKeyword": "",
    "AgentsLogListSearchKeyword": "",
    "ATL_ExportId": "",
    "DateTimeIsPreset": true,
    "ATL_Export_DateTimeIsPreset": true,
    "AllSpanTypesSelected": false,
    "LogsSeverity": "",
    "ATL_EntityType": "",
    "AgentsDateTimeStart": "1900-01-01T00:00:00",
    "LogListSearchKeyword": "",
    "UserId": "",
    "ATL_StageId": "",
    "StageId": "",
    "TracesMinDuration": "",
    "ATL_Status": "",
    "AgentsDateRangePresetInMinutes": 0,
    "ATL_Export_DateTimeStart": "1900-01-01T00:00:00",
    "ATL_DateTimeStart": "1900-01-01T00:00:00",
    "AgentsDateTimeIsPreset": true,
    "ATL_DateTimeIsPreset": true,
    "ATL_Export_DateRangePresetInMinutes": 43200,
    "WFLogListSearchKeyword": "",
    "WFDateTimeEnd": "1900-01-01T00:00:00"
  }
};
export const createLogScreenDefaults = () => structuredClone(defaults);
