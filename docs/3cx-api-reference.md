# 3CX API Complete Reference
## Discovered from redi-demo2.my3cx.us (v20.0.8.1109)
## Date: 2026-03-03

---

# Table of Contents
1. [Authentication](#authentication)
2. [API Surfaces Overview](#api-surfaces)
3. [XAPI REST (OData v4)](#xapi-rest)
4. [WebClient API (Protobuf/WebSocket)](#webclient-api)
5. [Queue Endpoints (Deep Dive)](#queue-endpoints)
6. [Call Control](#call-control)
7. [Wallboard / Real-Time Data](#wallboard-data)
8. [Reports & Statistics](#reports)
9. [System Management](#system-management)
10. [Action Reference (Write Operations)](#actions)
11. [Architecture for 3CX Tools Suite](#architecture)

---

# 1. Authentication <a name="authentication"></a>

## Login Flow
```
POST /webclient/api/Login/GetAccessToken
Content-Type: application/json

{
  "SecurityCode": "",
  "Username": "1000",
  "Password": "password"
}
```

### Response
```json
{
  "Status": "AuthSuccess",
  "Token": {
    "token_type": "Bearer",
    "expires_in": 60,
    "access_token": "eyJ...(JWT)",
    "refresh_token": "eyJ...(JWT)"
  },
  "TwoFactorAuth": null
}
```

### Token Details
- **Access token**: ES256 JWT, expires in **60 seconds** (must refresh frequently!)
- **Refresh token**: ES256 JWT, expires in **60 days**, also set as `RefreshTokenCookie`
- **Roles in JWT**: MyUser, Local, SingleCompany, Reports, PhoneSystemAdmin, Groups.Create, Users, Trunks, GlobalAdmin, Admin, Apps.ReadWrite, MachineAdmin, Paid, Enterprise
- **MaxRole**: `system_owners`

### Token Refresh
```
POST /connect/token
Cookie: RefreshTokenCookie=<refresh_jwt>
```

### Usage
All XAPI calls require:
```
Authorization: Bearer <access_token>
```

## Logout
```
POST /webclient/api/Logout
```

---

# 2. API Surfaces Overview <a name="api-surfaces"></a>

3CX exposes **3 distinct API surfaces**:

| API | Protocol | Auth | Use Case |
|-----|----------|------|----------|
| **XAPI** (`/xapi/v1/`) | REST OData v4 | Bearer JWT | Admin CRUD, reports, call control |
| **WebClient** (`/webclient/api/MyPhone`) | HTTP + Protobuf | Bearer JWT | User operations, session mgmt |
| **WebSocket** (`/ws/webclient?sessionId=`) | WS + Protobuf | Session ID | Real-time events, presence, calls |

### XAPI is the primary target for the tools suite.
- Full OData v4 with `$filter`, `$select`, `$expand`, `$orderby`, `$top`, `$skip`
- JSON responses
- Supports CRUD (GET/POST/PATCH/DELETE) + bound actions/functions

---

# 3. XAPI REST Endpoints <a name="xapi-rest"></a>

## Entity Sets (Collections) — `GET /xapi/v1/{EntitySet}`

### Core PBX Configuration
| Endpoint | Status | Description |
|----------|--------|-------------|
| `Users` | 200 | All extensions/users with full config (presence, queue status, auth, forwarding) |
| `Groups` | 200 | Departments/groups with routing, office hours |
| `Peers` | 200 | All registered entities (Extensions, Queues, IVRs, RingGroups, Parkings, Fax) |
| `Queues` | 200 | Queue configuration (polling strategy, timeouts, SLA, callbacks, routing) |
| `RingGroups` | 200 | Ring group config (strategy, ring time, routing) |
| `Receptionists` | 200 | IVR/Auto-attendant configurations |
| `Trunks` | 200 | SIP trunk config (providers, DID numbers, registration status) |
| `Contacts` | 200 | Phonebook contacts |
| `Parkings` | 200 | Call parking slots |

### Real-Time / Active Data
| Endpoint | Status | Description |
|----------|--------|-------------|
| `ActiveCalls` | 200 | **Currently active calls** — Caller, Callee, Status, EstablishedAt, LastChangeStatus |
| `Services` | 200 | Running 3CX services (PostgreSQL, SIP Server, IVR, Call Flow, etc.) with memory/CPU |
| `EventLogs` | 200 | System event logs |

### Historical Data
| Endpoint | Status | Description |
|----------|--------|-------------|
| `CallHistoryView` | 200 | Call history segments with full src/dst details, duration, answered status |
| `ChatHistoryView` | 200 | Chat history |
| `ChatMessagesHistoryView` | 200 | Individual chat messages |
| `Recordings` | 200 | Call recordings |
| `AuditLog` | 200 | Admin audit trail |
| `ActivityLog` | 200 | System activity |

### Configuration
| Endpoint | Status | Description |
|----------|--------|-------------|
| `InboundRules` | 200 | Inbound routing rules |
| `OutboundRules` | 200 | Outbound routing rules |
| `BlackListNumbers` | 200 | Blocked numbers |
| `Blocklist` | 200 | IP blocklist |
| `Holidays` | 200 | Holiday schedule |
| `PromptSets` | 200 | Audio prompt sets |
| `CustomPrompts` | 200 | Custom audio prompts |
| `Playlists` | 200 | Music on hold playlists |
| `CallFlowScripts` | 200 | Call flow designer scripts |
| `CallFlowApps` | 200 | Call flow applications |
| `Backups` | 200 | Backup history |
| `PhoneTemplates` | 200 | Phone provisioning templates |
| `DidNumbers` | 200 | DID number assignments |
| `Fax` | 200 | Fax messages |
| `ScheduledReports` | 200 | Scheduled report configurations |
| `DeviceInfos` | 200 | Provisioned device info |
| `SipDevices` | 200 | SIP device registrations |
| `SecurityTokens` | 200 | API tokens |

## Singletons — `GET /xapi/v1/{Singleton}`

| Endpoint | Description |
|----------|-------------|
| `SystemStatus` | **KEY** — Version, FQDN, IP, extensions total/registered, trunks, active calls, disk, license, backup status |
| `LicenseStatus` | License details, expiry, product code |
| `MyUser` | Current authenticated user |
| `MyGroup` | Current user's group |
| `Defs` | System definitions |
| `OfficeHours` | Global office hours schedule |
| `NetworkSettings` | Network configuration |
| `Firewall` | Firewall state |
| `VoicemailSettings` | VM config |
| `ConferenceSettings` | Conference settings |
| `MailSettings` | SMTP/email config |
| `NotificationSettings` | Notification settings |
| `AISettings` | AI/transcription settings |
| `CrmIntegration` | CRM integration config |
| `MusicOnHoldSettings` | MOH settings |
| `CodecsSettings` | Audio codec configuration |
| `GeneralSettingsForApps` | App general settings |
| `GeneralSettingsForPbx` | PBX general settings |
| `CallParkingSettings` | Call parking config |
| `DialCodeSettings` | Dial codes (*codes) |
| `E164Settings` | E.164 numbering config |
| `SecureSipSettings` | SRTP/TLS settings |
| `PhonesSettings` | Phone provisioning settings |
| `PhoneBookSettings` | Phonebook settings |
| `AntiHackingSettings` | Intrusion detection settings |
| `LoggingSettings` | Logging configuration |
| `ChatLogSettings` | Chat logging config |
| `CDRSettings` | Call detail record settings |
| `HotelServices` | Hotel module settings |
| `FaxServerSettings` | Fax server config |
| `RemoteArchivingSettings` | Remote archive config |
| `DataConnectorSettings` | External data connector |
| `CallCostSettings` | Call cost tracking |
| `CallTypesSettings` | Call type definitions |
| `EmergencyNotificationsSettings` | Emergency notifications |
| `ConsoleRestrictions` | Admin console restrictions |

## Navigation Properties (Drill-Down)

```
GET /xapi/v1/Queues(40)/Agents    → Queue agents with skill groups
GET /xapi/v1/Queues(40)/Managers  → Queue managers
GET /xapi/v1/RingGroups(48)/Members → Ring group members
GET /xapi/v1/Users(29)/Groups     → User's group memberships
```

---

# 4. WebClient API (Protobuf/WebSocket) <a name="webclient-api"></a>

## HTTP Endpoints
```
POST /webclient/api/MyPhone           → Main protobuf endpoint (requires session)
POST /webclient/api/MyPhone/session   → Session management
POST /webclient/api/MyPhone/log       → Client logging
POST /webclient/api/Login/GetAccessToken → Authentication
POST /webclient/api/Logout            → Logout
```

## WebSocket Connection
```
wss://{host}/ws/webclient?sessionId={sessionId}
```

## Protobuf Message Types (207 types discovered)

### Queue Operations
| MessageId | Type | Direction | Description |
|-----------|------|-----------|-------------|
| 501 | GetMyQueues | Request | Get queues for current agent |
| 245 | MyQueues | Response | List of queue numbers agent belongs to |
| 211 | QueuesInfo | Push | **Real-time queue statistics** (calls waiting, agents, etc.) |
| 145 | GetQueueCalls | Request | Get active calls in queue (paginated) |
| 223 | QueueCalls | Response | Queue call records |
| 146 | GetQueueCallsCount | Request | Count calls in queue |
| 147 | SetQueueCallData | Request | Update queue call metadata |
| 149 | SetQueueCallDataBulk | Request | Bulk update queue call data |
| 132 | SetQueueStatus | Request | Agent login/logout from queue |

### Call Control
| MessageId | Type | Direction | Description |
|-----------|------|-----------|-------------|
| 119 | MakeCall | Request | **Initiate a call** (destination, device, intercom) |
| 115 | DropCall | Request | Hang up a call |
| 116 | DivertCall | Request | Divert/forward a call |
| 117 | PickupCall | Request | Pick up a ringing call |
| 118 | TransferCall | Request | Transfer a call |
| 123 | BargeInCall | Request | Barge in (Listen/Whisper/BargeIn modes) |
| 152 | ConvertToAutoAnswer | Request | Auto-answer connection |
| 166 | JoinCalls | Request | Join/bridge calls |
| 136 | JoinCallParticipantsToConference | Request | Move to conference |
| 137 | RecordCall | Request | Start/stop recording |
| 167 | RecordingControl | Request | Recording control |
| 555 | CallReport | Request | Get call quality report |
| 556 | Monitor | Request | Monitor extension |

### Presence & Extensions
| MessageId | Type | Direction | Description |
|-----------|------|-----------|-------------|
| 102 | GetMyInfo | Request | Get current user info |
| 201 | MyInfo | Push | **Real-time user info/presence changes** |
| 103 | ChangeStatus | Request | Change presence status |
| 109 | GetExtensions | Request | Get all extensions |
| 206 | Extensions | Response | Extension list |
| 215 | ExtensionsChangedEvent | Push | **Real-time extension status changes** |
| 214 | ConnectionCapabilityMask | Push | Connection capabilities |

### System
| MessageId | Type | Direction | Description |
|-----------|------|-----------|-------------|
| 100 | LoginRequest | Request | WebSocket login |
| 200 | LoginResponse | Response | Login result with session data |
| 101 | LogoutRequest | Request | WebSocket logout |
| 122 | GetSystemParameters | Request | Get system config |
| 210 | SystemParameters | Response | System parameters |
| 131 | ServerTimeRequest | Request | Server time |
| 218 | ServerTimeResponse | Response | Server time response |

### Call History
| MessageId | Type | Direction | Description |
|-----------|------|-----------|-------------|
| 106 | GetCallHistory | Request | Query call history |
| 204 | CallHistory | Response | Call history records |
| 107 | GetCallHistoryCount | Request | Count call history |
| 205 | CallHistoryCount | Response | Count result |
| 148 | DeleteCallHistory | Request | Delete call history |

### Other
| MessageId | Type | Direction | Description |
|-----------|------|-----------|-------------|
| 211 | QueuesInfo | Push | Queue statistics pushed on change |
| 213 | IVRsInfo | Push | IVR info |
| 212 | ParkingsInfo | Push | Parking info |
| 208 | GroupsInfo | Push | Group info changes |
| 217 | ContactChangedEvent | Push | Contact changes |
| 108 | UpdateFwdProfiles | Request | Update forwarding profiles |
| 561 | GetFwdProfiles | Request | Get forwarding profiles |
| 512 | SetOfficeHoursMode | Request | Override office hours |

---

# 5. Queue Endpoints (Deep Dive) <a name="queue-endpoints"></a>

## Queue Configuration
```
GET  /xapi/v1/Queues                   → All queues
GET  /xapi/v1/Queues(40)               → Single queue by ID
GET  /xapi/v1/Queues(40)/Agents        → Queue agents
GET  /xapi/v1/Queues(40)/Managers      → Queue managers
POST /xapi/v1/Queues                   → Create queue
PATCH /xapi/v1/Queues(40)              → Update queue config
DELETE /xapi/v1/Queues(40)             → Delete queue
```

### Queue Object Properties
```json
{
  "Number": "8003",
  "Id": 40,
  "Name": "Queue 1",
  "IsRegistered": true,
  "PollingStrategy": "RingAll",     // RingAll, Hunt, LongestWaiting, etc.
  "RingTimeout": 30,                // Seconds to ring each agent
  "MasterTimeout": 60,              // Max total wait time (seconds)
  "SLATime": 0,                     // SLA target (seconds)
  "AnnounceQueuePosition": false,
  "AnnouncementInterval": 60,       // Seconds between announcements
  "WrapUpTime": 2,                  // Post-call wrap up (seconds)
  "MaxCallersInQueue": 0,           // 0 = unlimited
  "PriorityQueue": false,
  "EnableIntro": false,
  "IntroFile": "",
  "OnHoldFile": "onhold.wav",
  "GreetingFile": "",
  "Recording": "Disabled",
  "CallbackEnableTime": -1,         // -1 = disabled, else seconds
  "CallbackPrefix": "",
  "AgentAvailabilityMode": false,
  "ForwardNoAnswer": { "To": "None", "Number": "", ... },
  "OutOfOfficeRoute": { ... },
  "BreakRoute": { ... },
  "HolidaysRoute": { ... }
}
```

### Queue Agent Object
```json
{
  "Number": "1001",
  "SkillGroup": "1",
  "Name": "Johnson, Andrew",
  "Tags": [],
  "Id": 5
}
```

### Queue Actions
```
POST /xapi/v1/Queues(40)/Pbx.ResetQueueStatistics  → Reset stats
```

---

## Queue Agent Management (VERIFIED — All Tested Live)

### Add Agent to Queue
**Method**: PATCH the Queue with the full Agents array including the new agent.
```
PATCH /xapi/v1/Queues(40)
Content-Type: application/json
Authorization: Bearer <token>

{
  "Agents": [
    {"Number": "1001", "SkillGroup": "1"},
    {"Number": "1000", "SkillGroup": "1"}
  ]
}
```
**Response**: `204 No Content` (success)
**Important**: You must include ALL existing agents plus the new one. Any agent not in the array will be removed.

### Remove Agent from Queue
**Method**: PATCH the Queue with the Agents array EXCLUDING the agent to remove.
```
PATCH /xapi/v1/Queues(40)
Content-Type: application/json
Authorization: Bearer <token>

{
  "Agents": [
    {"Number": "1001", "SkillGroup": "1"}
  ]
}
```
**Response**: `204 No Content` (success)
**Important**: This is a "replace" operation — send the final desired state of agents.

### What Does NOT Work
- `POST /xapi/v1/Queues(40)/Agents` → **404** (OData nav property POST not supported)
- `PUT /xapi/v1/Queues(40)/Agents` → **405** (Method Not Allowed)
- `DELETE /xapi/v1/Queues(40)/Agents(5)` → Not tested, likely 404

### Check Agent Status in Queue (Global)
**Method**: Query User's `QueueStatus` property.
```
GET /xapi/v1/Users(29)?$select=Number,DisplayName,QueueStatus
```
**Response**:
```json
{
  "Number": "1000",
  "DisplayName": "Admin, REDiTECH",
  "QueueStatus": "LoggedIn"    // "LoggedIn" or "LoggedOut"
}
```

**Bulk check all users:**
```
GET /xapi/v1/Users?$select=Number,DisplayName,QueueStatus,IsRegistered
```

**QueueStatusType Enum:**
| Value | Name |
|-------|------|
| 0 | LoggedOut |
| 1 | LoggedIn |

**Note**: `QueueStatus` is a GLOBAL setting — it affects all queues the agent is a member of. There is no per-queue login/logout via XAPI REST. Per-queue login/logout would require the WebSocket/Protobuf `SetQueueStatus` (MessageId 132) which takes QueueId + AgentId.

### Sign Agent Out of All Queues
```
PATCH /xapi/v1/Users(29)
Content-Type: application/json
Authorization: Bearer <token>

{"QueueStatus": "LoggedOut"}
```
**Response**: `204 No Content` (success, immediate effect)

### Sign Agent Back Into All Queues
```
PATCH /xapi/v1/Users(29)
Content-Type: application/json
Authorization: Bearer <token>

{"QueueStatus": "LoggedIn"}
```
**Response**: `204 No Content` (success, immediate effect)

### Get Queue Managers
```
GET /xapi/v1/Queues(40)/Managers
```
**Response**:
```json
{
  "value": [
    {"Number": "1000", "Name": "Admin, REDiTECH", "Tags": [], "Id": 1}
  ]
}
```
**Manager entity is simpler than Agent** — no SkillGroup property.

### Manage Queue Managers (Add/Remove)
Same PATCH pattern as Agents:
```
PATCH /xapi/v1/Queues(40)
Content-Type: application/json

{
  "Managers": [
    {"Number": "1000"},
    {"Number": "1001"}
  ]
}
```

### Agent Login History (Report)
```
GET /xapi/v1/ReportAgentLoginHistory/Pbx.GetAgentLoginHistoryData(
  clientTimeZone='America%2FChicago',
  startDt=2026-02-01T00:00:00Z,
  endDt=2026-03-04T00:00:00Z,
  queueDnStr='8003',
  agentDnStr=''
)
```
**Response** (per-day records per agent per queue):
```json
{
  "value": [
    {
      "QueueNo": "8003",
      "AgentNo": "1001",
      "Agent": "1001 Andrew Johnson",
      "Day": "2026-03-03T00:00:00-06:00",
      "loggedInDt": "2026-03-03T00:00:00-06:00",
      "LoggedOutDt": "2026-03-03T18:00:00-06:00",
      "LoggedInInterval": "PT18H",
      "LoggedInDayInterval": "PT18H",
      "LoggedInTotalInterval": "P5DT13H43M24.960179S",
      "TalkingInterval": "PT0S",
      "TalkingDayInterval": "PT0S",
      "TalkingTotalInterval": "PT0S"
    }
  ]
}
```
**Note**: Intervals use ISO 8601 duration format (PT18H = 18 hours, P5DT13H = 5 days 13 hours).

### Recommended Approach for Queue Tools Suite

| Operation | Method | Endpoint |
|-----------|--------|----------|
| List queues | GET | `/xapi/v1/Queues?$expand=Agents` |
| Add agent to queue | PATCH | `/xapi/v1/Queues({id})` with full Agents array |
| Remove agent from queue | PATCH | `/xapi/v1/Queues({id})` with reduced Agents array |
| Check agent queue status | GET | `/xapi/v1/Users({id})?$select=QueueStatus` |
| Sign agent out (global) | PATCH | `/xapi/v1/Users({id})` with `{"QueueStatus":"LoggedOut"}` |
| Sign agent in (global) | PATCH | `/xapi/v1/Users({id})` with `{"QueueStatus":"LoggedIn"}` |
| Queue managers | GET | `/xapi/v1/Queues({id})/Managers` |
| Agent login history | GET | Report function (see above) |
| Queue active calls | GET | `/xapi/v1/ActiveCalls?$filter=Callee eq '8003'` |
| Reset queue stats | POST | `/xapi/v1/Queues({id})/Pbx.ResetQueueStatistics` |

### Important: ID vs Number
- **Queue ID** (e.g., 40) is used in URL paths: `Queues(40)`
- **Queue Number** (e.g., "8003") is the DN/extension, used in filters: `$filter=Number eq '8003'`
- **User ID** (e.g., 29) is used in URL paths: `Users(29)`
- **User Number** (e.g., "1000") is the extension, used in filters
- To find User ID from extension: `GET /xapi/v1/Users?$filter=Number eq '1000'&$select=Id,Number`
- To find Queue ID from DN: `GET /xapi/v1/Queues?$filter=Number eq '8003'&$select=Id,Number`

---

## Queue Statistics (Report Endpoints)
These require the `Report*` prefix and bound function calls with date parameters:

| Endpoint | Schema |
|----------|--------|
| `ReportQueuePerformanceOverview` | QueueDn, ExtensionDn, ReceivedCount, AnsweredCount, DroppedCount, TalkTime |
| `ReportQueuePerformanceTotals` | QueueDn, ReceivedCount, AnsweredCount, DroppedCount |
| `ReportTeamQueueGeneralStatistics` | QueueDnNumber, AgentsInQueueCount, ReceivedCount, AnsweredCount, TotalTalkTime, AvgTalkTime |
| `ReportDetailedQueueStatistics` | QueueDn, CallsCount, AnsweredCount, RingTime, AvgRingTime, TalkTime, AvgTalkTime, CallbacksCount |
| `ReportAbandonedQueueCalls` | QueueDn, CallTime, WaitTime, CallerId, PollingAttempts |
| `ReportQueueAnsweredCallsByWaitTime` | AnsweredTime intervals |
| `ReportAgentsInQueueStatistics` | Dn, Queue, LoggedInTime, LostCount, AnsweredCount, AnsweredPercent, AvgRingTime, AvgTalkTime |
| `ReportQueueCallbacks` | CallTime, Dn, CallbackNo, RingTime |
| `ReportQueueFailedCallbacks` | Failed callback details |
| `ReportStatisticSla` | SLA compliance data |
| `ReportBreachesSla` | SLA breach details |

### Fetching Report Data (Function Calls)
```
GET /xapi/v1/ReportQueuePerformanceOverview/Pbx.GetQueuePerformanceOverviewData(
  periodFrom=2025-01-01T00:00:00Z,
  periodTo=2026-03-04T23:59:59Z,
  queueDnStr='8003'
)
```

---

# 6. Call Control <a name="call-control"></a>

## Active Calls
```
GET /xapi/v1/ActiveCalls  → Currently active calls
```

### ActiveCall Object
```json
{
  "Id": 123,
  "Caller": "1001",
  "Callee": "8003",
  "Status": "Connected",       // Ringing, Connected, etc.
  "LastChangeStatus": "2026-03-04T03:15:00Z",
  "EstablishedAt": "2026-03-04T03:14:55Z",
  "ServerNow": "2026-03-04T03:15:30Z"
}
```

## MakeCall (XAPI)
```
POST /xapi/v1/Users/Pbx.MakeCall
Content-Type: application/json
Authorization: Bearer <token>

{
  "dn": "1001",              // Source extension
  "destination": "8003",     // Destination to call
  "contact": "",             // Optional contact reference
  "testCall": false          // Test mode
}
```
**Returns**: `CallControlResultResponse`

## DropCall (XAPI)
```
POST /xapi/v1/ActiveCalls({callId})/Pbx.DropCall
Authorization: Bearer <token>
```

## WebSocket Call Control (Protobuf)
| Action | MessageId | Fields |
|--------|-----------|--------|
| MakeCall | 119 | Destination, UseIntercomToSource, DeviceID, EnableCallControl |
| DropCall | 115 | LocalConnectionId, IsLocal, ActionIfRinging |
| DivertCall | 116 | LocalConnectionId, IsLocal, Destination, vmail |
| PickupCall | 117 | LocalConnectionId, IsLocal, DeviceID, EnableCallControl |
| TransferCall | 118 | LocalConnectionId, IsLocal, Destination, CallScreening |
| BargeInCall | 123 | LocalConnectionId, mode (0=BargeIn, 1=Listen, 2=Whisper), DeviceContact, EnableCallControl |

---

# 7. Wallboard / Real-Time Data <a name="wallboard-data"></a>

## Polling Approach (XAPI REST)
For a wallboard, poll these endpoints every 1-5 seconds:

```
GET /xapi/v1/ActiveCalls                              → Live calls
GET /xapi/v1/Users?$select=Number,DisplayName,IsRegistered,CurrentProfileName,QueueStatus
                                                       → Agent presence
GET /xapi/v1/SystemStatus                              → System health
GET /xapi/v1/Peers                                     → All entities status
```

### User Presence Fields
```json
{
  "Number": "1001",
  "DisplayName": "Johnson, Andrew",
  "IsRegistered": false,           // true = phone connected
  "CurrentProfileName": "Available", // Available, Away, DND, Lunch, etc.
  "QueueStatus": "LoggedIn"        // LoggedIn, LoggedOut
}
```

### Peer Types (for wallboard entity listing)
```
Extension, Queue, RingGroup, IVR, Conference, Fax, SpecialMenu, Parking
```

## WebSocket Approach (Real-Time Push)
Connect via WebSocket for instant updates:

1. Connect: `wss://{host}/ws/webclient?sessionId={id}`
2. Login: Send MessageId 100 (LoginRequest)
3. Receive pushes automatically:
   - **QueuesInfo** (211): Queue stats changes
   - **ExtensionsChangedEvent** (215): Extension status changes
   - **MyInfo** (201): Current user info changes
   - **GroupsInfo** (208): Group changes
   - **ParkingsInfo** (212): Parking slot changes

---

# 8. Reports & Statistics <a name="reports"></a>

## Report Entity Sets (all require date range parameters via function calls)

### Queue Reports
| Report Endpoint | Data Function | Description |
|----------------|---------------|-------------|
| `ReportQueuePerformanceOverview` | `GetQueuePerformanceOverviewData` | Per-agent queue performance |
| `ReportQueuePerformanceTotals` | `GetQueuePerformanceTotalsData` | Queue totals |
| `ReportTeamQueueGeneralStatistics` | `GetTeamQueueGeneralStatisticsData` | Team queue stats |
| `ReportDetailedQueueStatistics` | `GetDetailedQueueStatisticsData` | Detailed call-level queue data |
| `ReportAbandonedQueueCalls` | `GetAbandonedQueueCallsData` | Abandoned calls |
| `ReportQueueAnsweredCallsByWaitTime` | `GetQueueAnsweredCallsByWaitTimeData` | Wait time distribution |
| `ReportAgentsInQueueStatistics` | `GetAgentsInQueueStatisticsData` | Per-agent queue stats |
| `ReportQueueCallbacks` | `GetQueueCallbacksData` | Callback data |
| `ReportQueueFailedCallbacks` | `GetQueueFailedCallbacksData` | Failed callbacks |
| `ReportStatisticSla` | `GetStatisticSlaData` | SLA compliance |
| `ReportBreachesSla` | `GetBreachesSlaData` | SLA breaches |

### Chat Reports
| Report | Function | Description |
|--------|----------|-------------|
| `ReportQueueChatPerformance` | `GetQueueChatPerformanceData` | Chat queue performance |
| `ReportQueueAgentsChatStatistics` | `GetQueueAgentsChatStatisticsData` | Agent chat stats |
| `ReportAbandonedChatsStatistics` | `GetAbandonedChatsStatisticsData` | Abandoned chats |

### General Reports
| Report | Function | Description |
|--------|----------|-------------|
| `ReportCallLogData` | `GetCallLogData` | Detailed CDR data |
| `ReportExtensionStatistics` | `GetExtensionStatisticsData` | Extension usage stats |
| `ReportAgentLoginHistory` | `GetAgentLoginHistoryData` | Agent login/logout history |
| `ReportUserActivity` | `GetUserActivity` | User activity |
| `ReportCallDistribution` | `GetCallDistribution` | Call distribution |
| `ReportRingGroupStatistics` | `GetRingGroupStatisticsData` | Ring group stats |
| `ReportAuditLog` | `GetAuditLogData` | Audit log |
| `ReportInboundCalls` | `GetInboundCalls` | Inbound call report |
| `ReportOutboundCalls` | `GetOutboundCalls` | Outbound call report |
| `ReportInboundRules` | `GetInboundRulesData` | Inbound rule report |
| `ReportAverageQueueWaitingTime` | `GetAverageQueueWaitingTimeData` | Avg queue wait time |
| `ReportQueueAnUnCalls` | `GetQueueAnUnCallsData` | Queue answered/unanswered |

### Download Functions
Every report has a `Download*` function for CSV export:
```
GET /xapi/v1/ReportQueuePerformanceOverview/Pbx.DownloadQueuePerformanceOverview(...)
```

---

# 9. System Management <a name="system-management"></a>

## System Status
```json
{
  "FQDN": "redi-demo2.my3cx.us",
  "Version": "20.0.8.1109",
  "Activated": true,
  "MaxSimCalls": 4,
  "ExtensionsRegistered": 0,
  "ExtensionsTotal": 2,
  "TrunksRegistered": 2,
  "TrunksTotal": 2,
  "CallsActive": 0,
  "DiskUsage": 21,
  "FreeDiskSpace": 23911714816,
  "Support": true,
  "LicenseActive": true,
  "ExpirationDate": "2035-01-01T00:00:00Z",
  "BackupScheduled": true,
  "LastBackupDateTime": "2026-03-03T00:00:02Z",
  "IsAuditLogEnabled": true,
  "OS": "Linux",
  "AutoUpdateEnabled": true
}
```

## Services Monitoring
```
GET /xapi/v1/Services
```
Returns running services: PostgreSQL, SIP Server, IVR Server, Call Flow Server, System Server, Audio Provider, Config Server.

Each has: Status, MemoryUsed, TotalProcessorTime, ThreadCount, HandleCount.

### Service Actions
```
POST /xapi/v1/Services/Pbx.Start     → Start service
POST /xapi/v1/Services/Pbx.Stop      → Stop service
POST /xapi/v1/Services/Pbx.Restart   → Restart service
```

---

# 10. Action Reference (Write Operations) <a name="actions"></a>

## Call Actions
| Action | Bound To | Parameters |
|--------|----------|------------|
| `MakeCall` | `Collection(User)` | dn, contact, testCall, destination |
| `DropCall` | `ActiveCall` | (none - binds to specific call) |

## Queue Actions
| Action | Bound To | Parameters |
|--------|----------|------------|
| `ResetQueueStatistics` | `Queue` | (none) |

## User Actions
| Action | Bound To | Parameters |
|--------|----------|------------|
| `Regenerate` | `User` | opts (RegenerateOptions) |
| `RegeneratePasswords` | `Collection(User)` | |
| `RegenerateWebCredentials` | `Collection(User)` | |
| `SendWelcomeEmail` | `Collection(User)` | |
| `MultiUserUpdate` | `Collection(User)` | updates |
| `ExportSelectedExtensions` | `Collection(User)` | |

## Phone/Device Actions
| Action | Bound To | Parameters |
|--------|----------|------------|
| `RebootPhone` | `Collection(User)` | mac |
| `ReprovisionPhone` | `Collection(User)` | mac |
| `PushConfig` | `Collection(User)` | |
| `PushFirmware` | `Collection(User)` | |

## System Actions
| Action | Bound To | Parameters |
|--------|----------|------------|
| `Backup` | `Backups` | |
| `Restore` | `Backups` | |
| `PurgeAllLogs` | (unbound) | |
| `PurgeCalls` | (unbound) | |
| `PurgeChats` | (unbound) | |
| `InstallUpdates` | (unbound) | |
| `RestartOperatingSystem` | (unbound) | |

## Recording Actions
| Action | Bound To | Description |
|--------|----------|-------------|
| `ArchiveRecordings` | Recordings | Archive recordings |
| `TranscribeRecordings` | Recordings | AI transcribe recordings |
| `BulkRecordingsDelete` | Recordings | Bulk delete |

## CRM/Contact Actions
| Action | Bound To | Description |
|--------|----------|-------------|
| `ImportContacts` | Contacts | Import contacts |
| `CreateContactByNumber` | Contacts | Create by phone number |
| `DeleteContactsById` | Contacts | Delete contacts |

---

# 11. Architecture for 3CX Tools Suite <a name="architecture"></a>

## Recommended Architecture

```
┌──────────────────────────────────────────────┐
│           3CX Tools Docker Container          │
│                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Wallboard │  │  Queue   │  │  Agent   │   │
│  │  Module   │  │ Notifier │  │ Dashboard │   │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘   │
│        │              │              │         │
│  ┌─────┴──────────────┴──────────────┴─────┐  │
│  │          3CX Connector Service          │  │
│  │  (WebSocket + XAPI REST Hybrid Client)  │  │
│  └─────────────────┬───────────────────────┘  │
│                    │                           │
│  ┌─────────────────┴───────────────────────┐  │
│  │           Event Bus (Redis/Memory)       │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │         Web UI (Next.js / React)         │  │
│  └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
        │                    │
        │ WebSocket          │ XAPI REST
        │ (real-time)        │ (config/reports)
        ▼                    ▼
┌──────────────────────────────────────────────┐
│              3CX PBX Server                   │
│  /ws/webclient  │  /xapi/v1/  │  /webclient/ │
└──────────────────────────────────────────────┘
```

## Key Design Decisions

### Real-Time vs Polling
- **Wallboard**: Use WebSocket for instant call/presence updates + XAPI polling every 5s as fallback
- **Queue Notifier**: WebSocket `QueuesInfo` (211) push for queue state + `ActiveCalls` polling for wait times
- **Reports**: XAPI REST `Report*` endpoints with date range functions

### Queue Notifier Logic
```
1. Connect WebSocket → subscribe to QueuesInfo (211)
2. Poll GET /xapi/v1/ActiveCalls every 2-3 seconds
3. For each active call where Callee is a Queue number:
   - Calculate wait time: ServerNow - EstablishedAt
   - If wait time > threshold (e.g., 30s):
     - POST /xapi/v1/Users/Pbx.MakeCall with destination=paging_extension
     - OR trigger notification (Teams, SMS, email)
4. Track notified calls to prevent duplicate alerts
```

### No Agent Needed on PBX
The XAPI provides everything remotely over HTTPS. No need for a lightweight agent on the PBX unless you want:
- Sub-second latency (WebSocket is already ~100ms)
- Direct PostgreSQL access for custom queries
- SIP event monitoring at the protocol level

### Multi-PBX Support
The Docker container should support multiple 3CX instances:
```json
{
  "instances": [
    {
      "name": "Client A PBX",
      "url": "https://clienta.my3cx.us",
      "credentials": { "username": "admin", "password": "..." },
      "features": ["wallboard", "queue_notifier"]
    }
  ]
}
```

## Token Management
- Access tokens expire in **60 seconds** — must implement auto-refresh
- Refresh tokens last **60 days**
- Use the `RefreshTokenCookie` or `refresh_token` JWT to get new access tokens
- Implement token refresh 10 seconds before expiry

---

# Appendix: OData Query Examples

```bash
# Get all users, select only wallboard-relevant fields
GET /xapi/v1/Users?$select=Number,DisplayName,IsRegistered,CurrentProfileName,QueueStatus

# Get queues with their agents expanded
GET /xapi/v1/Queues?$expand=Agents

# Get active calls filtered by status
GET /xapi/v1/ActiveCalls?$filter=Status eq 'Ringing'

# Get call history for last 24 hours
GET /xapi/v1/CallHistoryView?$filter=SegmentStartTime ge 2026-03-03T00:00:00Z&$orderby=SegmentStartTime desc&$top=100

# Get event logs (errors only)
GET /xapi/v1/EventLogs?$filter=Type eq 'Error'&$top=50&$orderby=TimeGenerated desc
```

---

# Appendix: Enum Values

## PeerType
`Extension`, `Queue`, `RingGroup`, `IVR`, `Conference`, `Fax`, `SpecialMenu`, `Parking`

## PollingStrategyType (Queue)
`RingAll`, `Hunt`, `LongestWaiting`, `ExtensionPriority`, `RandomStart`, `RoundRobin`, `LeastTalkTime`

## Call States (WebSocket)
`None=0`, `Ringing=1`, `Dialing=2`, `Connected=3`, `WaitingForNewParty=4`, `TryingToTransfer=5`

## BargeInMode
`BargeIn=0`, `Listen=1`, `Whisper=2`

## QueueRecording
`Disabled`, `Always`, `External`, `Internal`

## ServiceStatus
`Running`, `Stopped`
