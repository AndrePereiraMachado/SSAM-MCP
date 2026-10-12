// Native empty state extracted statically from the public Timers.timer model; see research/CURRENT-TIMER-CONTRACT.md.
const defaults = {
  "screen": {
    "SkeletonInfo": {
      "ShowViewScreenSkeleton": false,
      "ShowHeaderActionsSkeleton": false,
      "ShowEditScreenSkeleton": false
    },
    "SelectedStage": {
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
    "StageHibernationStatus": {
      "EnvironmentName": "",
      "EnvironmentStatusId": "",
      "ShowAlert": false
    },
    "ScreenPermissionsConfigurations": {
      "Configurations": "NoAccess"
    },
    "ScreenTimerInformationStructure": {
      "TimerInfo": {
        "Timer": {
          "Key": "",
          "Name": "",
          "Description": "",
          "Configs": {
            "IsActive": {
              "Default": false,
              "Deployed": false,
              "Current": false,
              "ValueOrigin": "",
              "DeployedValueOrigin": ""
            },
            "Schedule": {
              "DefaultValue": "",
              "DeployedValue": "",
              "Value": "",
              "ValueOrigin": "",
              "DeployedValueOrigin": ""
            },
            "Timeout": {
              "DefaultValue": "0",
              "DeployedValue": "0",
              "Value": "0",
              "ValueOrigin": "",
              "DeployedValueOrigin": ""
            }
          }
        },
        "HasPendingConfigurations": false
      },
      "TimerScheduleFormatted": {
        "Occurance": "",
        "RunsAt_DEPRECATED": "",
        "RunsAt": "",
        "RunsAtList": {
          "List": [],
          "EmptyListItem": ""
        }
      },
      "TimerDefaultScheduleFormatted": {
        "Occurance": "",
        "RunsAt_DEPRECATED": "",
        "RunsAt": "",
        "RunsAtList": {
          "List": [],
          "EmptyListItem": ""
        }
      },
      "TimerRunningInfo": {
        "isRunning": false,
        "currentStartedOn": "1900-01-01T00:00:00",
        "lastRunStartedOn": "1900-01-01T00:00:00",
        "lastRunFinishedOn": "1900-01-01T00:00:00",
        "lastRunDuration": 0,
        "nextRunStartsOn": "1900-01-01T00:00:00",
        "isPendingRun": false
      },
      "TimerRunningInfo_CurrentDuration": 0,
      "TimerNotFound": false,
      "TimerInfoIsFetched": false,
      "ApplicationName": "",
      "AppInfoIsFetched": false,
      "EnableEnvironmentDropdown": false,
      "ShowNotFound": false,
      "ShowEditScreen": false,
      "ShowDeploymentOngoingPopUp": false,
      "ShowSaving": false
    },
    "TimerValue": {
      "Key": "",
      "IsActive": false,
      "Schedule": {
        "Value": {
          "Occurance": "",
          "Time": {
            "Hour": {
              "List": [],
              "EmptyListItem": ""
            },
            "Minute": {
              "List": [],
              "EmptyListItem": ""
            }
          },
          "Weekly": {
            "Mon": false,
            "Tue": false,
            "Wed": false,
            "Thu": false,
            "Fri": false,
            "Sat": false,
            "Sun": false
          },
          "Monthly": {
            "List": [],
            "EmptyListItem": ""
          }
        },
        "IsUsingDefault": false,
        "IsAdvanced": false
      },
      "Timeout": {
        "Value": "0",
        "IsUsingDefault": false
      }
    },
    "TimerSelectedScheduleDetails": {
      "Occurance": "",
      "RunsAt_DEPRECATED": "",
      "RunsAt": "",
      "RunsAtList": {
        "List": [],
        "EmptyListItem": ""
      }
    },
    "Timer_Schedule_Validations": {
      "IsOcurranceValid": true,
      "IsHoursValid": true,
      "IsMinutesValid": true,
      "IsWeekdaysValid": true,
      "IsDaysOfMonthValid": true
    },
    "AutoRefreshInfo": {
      "IsApplyingConfigs": false,
      "IsApplyConfigsBlocked": false,
      "IsAutoRefreshBlocked": false,
      "EnableAutoRefresh": false,
      "NewDeploymentKey": ""
    },
    "TimerSchedule_TagsListsValues": {
      "Days": {
        "List": [],
        "EmptyListItem": {
          "Value": "",
          "Label": "",
          "IsSelected": false
        }
      },
      "Hours": {
        "List": [],
        "EmptyListItem": {
          "Value": "",
          "Label": "",
          "IsSelected": false
        }
      },
      "Minutes": {
        "List": [],
        "EmptyListItem": {
          "Value": "",
          "Label": "",
          "IsSelected": false
        }
      }
    },
    "TimerCustomTimeoutTextValueInput": {
      "CustomTimeoutTextValueDeployed": "",
      "CustomTimeoutTextValueCurrent": "",
      "HasChanged": false
    },
    "ActivePortfolioKey": "",
    "appid": "",
    "_appidInDataFetchStatus": 1,
    "stageid": "",
    "_stageidInDataFetchStatus": 1,
    "id": "",
    "_idInDataFetchStatus": 1,
    "edit": false,
    "_editInDataFetchStatus": 1
  },
  "clientVariables": {
    "IsDebug": false,
    "MobilePackageHistoryListMobilePackageStatus": "",
    "ApplicationListViewPermission": "",
    "MobilePackageHistoryListMobilePlatform": "",
    "ApplicationListApplicationType": "",
    "ApplicationListO11AppsSort": "name",
    "ProducersColumn1Size": 0,
    "ProducersColumn2Size": 0,
    "ApplicationListO11ApplicationType": "",
    "ApplicationListSort": "name",
    "ApplicationListSearchValue": "",
    "MandatoryValidationMessage": "This is a mandatory field."
  }
};
export const createTimerScreenDefaults = () => structuredClone(defaults);
