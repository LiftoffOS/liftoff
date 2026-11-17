// Apify Composio toolkit schemas. Toolkit slug: 'apify'.
// Curated subset of Composio's real apify tools (validated by validate:slugs).
// Regenerate via the remediate-composio-connector skill; do not hand-edit slugs.

import type { ComposioVendorSchema } from '../types';

export const APIFY_SCHEMAS: ComposioVendorSchema[] = [
  {
    "slug": "APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS",
    "name": "Run Actor Sync & Get Dataset Items",
    "description": "Tool to run an actor synchronously and retrieve its dataset items. use when immediate access to run results is needed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "input": {
          "type": "object",
          "title": "Input",
          "default": null,
          "nullable": true,
          "description": "JSON input object passed to the Actor run.",
          "additionalProperties": true
        },
        "limit": {
          "type": "integer",
          "title": "Limit",
          "default": 100,
          "minimum": 1,
          "examples": [
            10,
            500
          ],
          "description": "Maximum number of items to return for pagination."
        },
        "format": {
          "enum": [
            "json",
            "csv",
            "rss",
            "html"
          ],
          "type": "string",
          "title": "Format",
          "default": "json",
          "examples": [
            "json",
            "csv"
          ],
          "description": "Format of dataset items to retrieve."
        },
        "offset": {
          "type": "integer",
          "title": "Offset",
          "default": 0,
          "minimum": 0,
          "examples": [
            0,
            100
          ],
          "description": "Number of items to skip for pagination."
        },
        "actorId": {
          "type": "string",
          "title": "Actor Id",
          "examples": [
            "username/actor-name"
          ],
          "description": "Unique identifier or name of the Actor (e.g., 'username/actor-name')."
        }
      },
      "required": [
        "actorId"
      ]
    },
    "categories": [
      "write"
    ]
  },
  {
    "slug": "APIFY_RUN_ACTOR",
    "name": "Run Actor Asynchronously",
    "description": "Tool to run a specific actor asynchronously. use when you need to trigger an actor run without waiting for completion and retrieve its run details immediately.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "body": {
          "type": "object",
          "title": "Body",
          "description": "JSON input object passed to the Actor.",
          "additionalProperties": true
        },
        "build": {
          "type": "string",
          "title": "Build",
          "default": null,
          "examples": [
            "latest"
          ],
          "nullable": true,
          "description": "Specifies the Actor build to run (tag or build number). Defaults to default run config."
        },
        "memory": {
          "type": "number",
          "title": "Memory",
          "default": null,
          "examples": [
            1024
          ],
          "nullable": true,
          "description": "Memory limit for the run, in megabytes. Must be power of 2 and at least 128."
        },
        "actorId": {
          "type": "string",
          "title": "Actor Id",
          "examples": [
            "john~my-actor"
          ],
          "description": "Actor ID or '<username>~<actorName>', e.g. 'john~my-actor'."
        },
        "timeout": {
          "type": "number",
          "title": "Timeout",
          "default": null,
          "examples": [
            60
          ],
          "nullable": true,
          "description": "Optional timeout for the run, in seconds. Default uses actor's default timeout."
        },
        "maxItems": {
          "type": "number",
          "title": "Max Items",
          "default": null,
          "examples": [
            10
          ],
          "nullable": true,
          "description": "Maximum number of items that the Actor run should return."
        },
        "webhooks": {
          "type": "string",
          "title": "Webhooks",
          "default": null,
          "nullable": true,
          "description": "Base64-encoded JSON array of webhook definitions."
        },
        "waitForFinish": {
          "type": "number",
          "title": "Wait For Finish",
          "default": null,
          "examples": [
            30
          ],
          "nullable": true,
          "description": "Max seconds the server waits for the run to finish. Default 0, max 60."
        },
        "maxTotalChargeUsd": {
          "type": "number",
          "title": "Max Total Charge Usd",
          "default": null,
          "examples": [
            5
          ],
          "nullable": true,
          "description": "Specifies the maximum cost of the Actor run in USD."
        }
      },
      "required": [
        "actorId"
      ]
    },
    "categories": [
      "write"
    ]
  },
  {
    "slug": "APIFY_RUN_TASK",
    "name": "Run Task Asynchronously",
    "description": "Tool to run a specific actor task asynchronously. use when you need to trigger a task run without waiting for completion and immediately retrieve its run details.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "body": {
          "type": "object",
          "title": "Body",
          "description": "JSON input object passed to the Actor.",
          "additionalProperties": true
        },
        "build": {
          "type": "string",
          "title": "Build",
          "default": null,
          "examples": [
            "latest"
          ],
          "nullable": true,
          "description": "Specifies the Actor build to run (tag or build number). Defaults to default run config."
        },
        "memory": {
          "type": "number",
          "title": "Memory",
          "default": null,
          "examples": [
            1024
          ],
          "nullable": true,
          "description": "Memory limit for the run, in megabytes. Must be power of 2 and at least 128."
        },
        "timeout": {
          "type": "number",
          "title": "Timeout",
          "default": null,
          "examples": [
            60
          ],
          "nullable": true,
          "description": "Optional timeout for the run, in seconds. Default uses task's default timeout."
        },
        "maxItems": {
          "type": "number",
          "title": "Max Items",
          "default": null,
          "examples": [
            10
          ],
          "nullable": true,
          "description": "Maximum number of items that the Actor run should return."
        },
        "webhooks": {
          "type": "string",
          "title": "Webhooks",
          "default": null,
          "nullable": true,
          "description": "Base64-encoded JSON array of webhook definitions."
        },
        "actorTaskId": {
          "type": "string",
          "title": "Actor Task Id",
          "examples": [
            "john~my-task"
          ],
          "description": "Task ID or '<username>~<taskName>', e.g. 'john~my-task'."
        },
        "waitForFinish": {
          "type": "number",
          "title": "Wait For Finish",
          "default": null,
          "examples": [
            30
          ],
          "nullable": true,
          "description": "Max seconds the server waits for the run to finish. Default 0, max 60."
        },
        "maxTotalChargeUsd": {
          "type": "number",
          "title": "Max Total Charge Usd",
          "default": null,
          "examples": [
            5
          ],
          "nullable": true,
          "description": "Specifies the maximum cost of the Actor run in USD."
        }
      },
      "required": [
        "actorTaskId"
      ]
    },
    "categories": [
      "write"
    ]
  },
  {
    "slug": "APIFY_GET_DATASET_ITEMS",
    "name": "Get dataset items",
    "description": "Tool to retrieve items from a dataset. use when you need to fetch data from a specified dataset by pagination or filtering. only json format is fully supported.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "bom": {
          "type": "boolean",
          "title": "Bom",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, includes BOM header in CSV output."
        },
        "desc": {
          "type": "boolean",
          "title": "Desc",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, return items in reverse order. Default is ascending."
        },
        "omit": {
          "type": "string",
          "title": "Omit",
          "default": null,
          "examples": [
            "fieldX,fieldY"
          ],
          "nullable": true,
          "description": "Comma-separated list of fields to exclude from the returned items."
        },
        "clean": {
          "type": "boolean",
          "title": "Clean",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "When true, removes any Apify-specific metadata from items."
        },
        "limit": {
          "type": "integer",
          "title": "Limit",
          "default": 1000,
          "maximum": 1000,
          "minimum": 1,
          "examples": [
            100,
            500
          ],
          "nullable": true,
          "description": "Maximum number of items to return (pagination). Default and max is 1000."
        },
        "fields": {
          "type": "string",
          "title": "Fields",
          "default": null,
          "examples": [
            "fieldA,fieldB"
          ],
          "nullable": true,
          "description": "Comma-separated list of fields to include in the returned items."
        },
        "format": {
          "enum": [
            "json",
            "csv",
            "xlsx"
          ],
          "type": "string",
          "title": "Format",
          "default": "json",
          "examples": [
            "json",
            "csv"
          ],
          "description": "Output format of dataset items. Only 'json' is fully supported."
        },
        "offset": {
          "type": "integer",
          "title": "Offset",
          "default": 0,
          "minimum": 0,
          "examples": [
            0,
            100
          ],
          "nullable": true,
          "description": "Number of items to skip (pagination). Default is 0."
        },
        "unwind": {
          "type": "string",
          "title": "Unwind",
          "default": null,
          "examples": [
            "nestedField"
          ],
          "nullable": true,
          "description": "Name of the field to unwind into multiple items."
        },
        "flatten": {
          "type": "boolean",
          "title": "Flatten",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, flattens nested JSON into a single level for CSV."
        },
        "datasetId": {
          "type": "string",
          "title": "Dataset Id",
          "examples": [
            "myDatasetId"
          ],
          "description": "Identifier of the dataset to retrieve items from (e.g., 'username/datasetName' or dataset ID)."
        },
        "delimiter": {
          "type": "string",
          "title": "Delimiter",
          "default": null,
          "examples": [
            ","
          ],
          "nullable": true,
          "description": "Delimiter to use for CSV format."
        },
        "offsetKey": {
          "type": "string",
          "title": "Offset Key",
          "default": null,
          "examples": [
            "_id"
          ],
          "nullable": true,
          "description": "Key to use for pagination instead of numeric offset."
        },
        "skipEmpty": {
          "type": "boolean",
          "title": "Skip Empty",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, skips empty rows in CSV output."
        },
        "attachment": {
          "type": "boolean",
          "title": "Attachment",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, forces 'Content-Disposition: attachment' in the response."
        },
        "skipHidden": {
          "type": "boolean",
          "title": "Skip Hidden",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, skips hidden items (include only visible items)."
        },
        "asciiHeaders": {
          "type": "boolean",
          "title": "Ascii Headers",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, forces ASCII-only headers in CSV format."
        }
      },
      "required": [
        "datasetId"
      ]
    },
    "categories": [
      "read"
    ]
  },
  {
    "slug": "APIFY_GET_LIST_OF_RUNS",
    "name": "Get list of runs",
    "description": "Tool to get a list of runs for a specific actor. use when you need to paginate through runs and optionally filter by status before processing run data.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "desc": {
          "type": "boolean",
          "title": "Desc",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, sort by startedAt descending. Default is ascending."
        },
        "limit": {
          "type": "integer",
          "title": "Limit",
          "default": 1000,
          "maximum": 1000,
          "minimum": 1,
          "examples": [
            100
          ],
          "nullable": true,
          "description": "Maximum number of runs to return (pagination). Default and max is 1000."
        },
        "offset": {
          "type": "integer",
          "title": "Offset",
          "default": 0,
          "minimum": 0,
          "examples": [
            0
          ],
          "nullable": true,
          "description": "Number of runs to skip at the start (pagination). Default is 0."
        },
        "status": {
          "enum": [
            "READY",
            "RUNNING",
            "SUCCEEDED",
            "FAILED",
            "TIMING-OUT",
            "TIMED-OUT",
            "ABORTING",
            "ABORTED"
          ],
          "type": "string",
          "title": "Status",
          "default": null,
          "examples": [
            "SUCCEEDED"
          ],
          "nullable": true,
          "description": "Filter runs by this lifecycle status."
        },
        "actorId": {
          "type": "string",
          "title": "Actor Id",
          "examples": [
            "johnDoe/myActor"
          ],
          "description": "Actor ID or '<username>/<actorName>' whose runs to list."
        }
      },
      "required": [
        "actorId"
      ]
    },
    "categories": [
      "read"
    ]
  },
  {
    "slug": "APIFY_GET_ACTOR",
    "name": "Get Actor Details",
    "description": "Tool to get details of a specific actor. use when you need actor metadata by id or username/actorname.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "actorId": {
          "type": "string",
          "title": "Actor Id",
          "examples": [
            "5e0d:",
            "username/actor-name"
          ],
          "description": "Actor ID (24-character hex string) or username/actorName."
        }
      },
      "required": [
        "actorId"
      ]
    },
    "categories": [
      "read"
    ]
  },
  {
    "slug": "APIFY_GET_LOG",
    "name": "Get log",
    "description": "Tool to retrieve logs for a specific actor run or build. use after initiating an actor run or build when you need to inspect execution logs.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "buildOrRunId": {
          "type": "string",
          "title": "Build Or Run Id",
          "examples": [
            "H1qlbtI6MzKAfterR12RarK4Q"
          ],
          "description": "ID of the Actor run or build to retrieve the log for."
        }
      },
      "required": [
        "buildOrRunId"
      ]
    },
    "categories": [
      "read"
    ]
  },
  {
    "slug": "APIFY_GET_LIST_OF_TASKS",
    "name": "Get list of tasks",
    "description": "Tool to fetch a paginated list of tasks belonging to the authenticated user. use when you need to browse or sort tasks created by the user.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "desc": {
          "type": "boolean",
          "title": "Desc",
          "default": false,
          "examples": [
            true
          ],
          "nullable": true,
          "description": "If true, sort by createdAt descending. Default is ascending."
        },
        "limit": {
          "type": "integer",
          "title": "Limit",
          "default": 1000,
          "maximum": 1000,
          "minimum": 1,
          "examples": [
            100
          ],
          "nullable": true,
          "description": "Maximum number of records to return (pagination). Default and max is 1000."
        },
        "offset": {
          "type": "integer",
          "title": "Offset",
          "default": 0,
          "minimum": 0,
          "examples": [
            0
          ],
          "nullable": true,
          "description": "Number of records to skip at the start (pagination). Default is 0."
        }
      }
    },
    "categories": [
      "read"
    ]
  },
  {
    "slug": "APIFY_GET_KEY_VALUE_RECORD",
    "name": "Get Key-Value Record",
    "description": "Tool to retrieve a record from a key-value store. use when you need to fetch a specific value by key from an apify key-value store.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "format": {
          "enum": [
            "json",
            "xml",
            "html",
            "text"
          ],
          "type": "string",
          "title": "Format",
          "default": null,
          "examples": [
            "json"
          ],
          "nullable": true,
          "description": "Desired format of the retrieved record."
        },
        "storeId": {
          "type": "string",
          "title": "Store Id",
          "examples": [
            "my-store-id"
          ],
          "description": "ID of the key-value store."
        },
        "recordKey": {
          "type": "string",
          "title": "Record Key",
          "examples": [
            "config.json"
          ],
          "description": "Key of the record to retrieve."
        },
        "attachment": {
          "type": "boolean",
          "title": "Attachment",
          "default": null,
          "nullable": true,
          "description": "If true, force the response as an attachment (for browser downloads)."
        },
        "disableRedirect": {
          "type": "boolean",
          "title": "Disable Redirect",
          "default": null,
          "nullable": true,
          "description": "If true, do not redirect to the raw value; return metadata only."
        }
      },
      "required": [
        "storeId",
        "recordKey"
      ]
    },
    "categories": [
      "read"
    ]
  }
];
