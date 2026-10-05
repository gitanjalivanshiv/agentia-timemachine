<!-- timemachine managed skill file: agentia timemachine skill install -->

# The v2 Template Document

`.timemachine/templates/<slug>/template.json` holds a template's v2 detail document exactly as Copado returns
it (keys sorted). An edit file must be the **complete** document: Copado replaces the whole thing on save.

## Anatomy

```jsonc
{
  "version": 2,                       // format marker; do not change
  "templateId": "a0U…", "templateName": "…", "templateApiName": "…",
  "mainObject": {"apiName": "Account", "label": "Account"},
  "status": "Inactive",
  "schemaCredential": "a11…",         // do not change
  "details": [                        // one entry per object in the template
    {
      "templateId": "a0U…", "table": "Account",
      "columns": [                    // EVERY field of the object; selection decides what is deployed
        {"name": "Fax", "type": "phone", "isSelected": true, "externalId": false,
         "lookUpType": "NONE", "anonymizerType": {"type": "None"}}
      ],
      "filters": ["Type = 'Customer'"],          // condition text, one per filter row
      "rawFilters": [                            // the filter builder rows behind `filters`
        {"order": 1, "fieldName": "Account Type-Type", "fieldLabel": "Account Type", "fieldType": "PICKLIST",
         "operator": "e", "input": "Customer", "finalValue": "Type = 'Customer'", "isValid": true}
      ],
      "limit": 50000,                 // Max. Record Limit (required)
      "batchSize": 200,
      "externalIdField": "Id",
      "externalIdGeneration": {…}, "virtualIdGeneration": {…},
      "parentTemplates": [], "childTemplates": [],
      "matchOwner": false, "matchRecordType": false, "continueOnError": "…"
    }
  ]
}
```

## Common Changes

| User asks                        | Change                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add field X                      | In `details[i].columns`, find `{"name": "X"}` and set `"isSelected": true`.                                                                                                             |
| Remove field X                   | Set `"isSelected": false` on that column. Do not delete the column.                                                                                                                     |
| Field not in `columns` at all    | Stop. The field is not in the template's schema; the user must refresh the template's schema in Copado (the "Refresh Schema" button on the template) or add the field to the org first. |
| Change a filter value            | Update the row in `rawFilters` (`input`, `finalValue`) **and** the matching string in `filters`, keeping the quoting style (`Type = 'Partner'`).                                        |
| Mark an external Id              | Set `"externalId": true` on the column and adjust `externalIdField` only if the user asks.                                                                                              |
| Change record limit / batch size | `details[i].limit` / `details[i].batchSize` (numbers).                                                                                                                                  |

## Rules

- Change only what the user asked for. Keep every other key and value as it is. Unknown keys must stay.
- `filters`, `rawFilters` and `limit` must not be empty or null: Copado rejects such documents (`SAVE_BLOCKED`).
- Do not invent filter `operator` codes. Only `"e"` (equals) has been observed in real documents. For any
  other operator, tell the user it is not supported through timemachine yet instead of guessing.
- The diff speaks in these terms: `+ field X added to Account`, `- field X removed from Account`,
  `~ filter on Account: A → B`, `~ Account: batchSize 200 → 100`. If the preview shows anything else,
  your file changed more than intended.
