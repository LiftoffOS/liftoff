// BambooHR Connector Normalizer
//
// BambooHR is reactive via native polling (api_key sidecar connector; no
// Composio, no native webhook wired). The polling scheduler hands
// BambooHRClient.list('Employee') results to normalize() as { results: [emp] }.
// The directory endpoint (GET /employees/directory) has no incremental `since`
// filter, so the scheduler dedups by version hash. Field set is the documented
// BambooHR employee directory shape, restricted to the identity + org fields a
// reactive subscription would predicate on (department, division, jobTitle,
// location, supervisor) plus contact identity (workEmail).

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface BambooHREmployee {
  id?: string | number;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  workEmail?: string;
  department?: string;
  division?: string;
  location?: string;
  supervisor?: string;
}

interface BambooHRPayload {
  results?: BambooHREmployee[];
}

const EmployeeDataSchema = z.object({
  id: z.string().describe('BambooHR employee id.'),
  displayName: z.string().optional().describe('Employee display name as configured in the directory.'),
  firstName: z.string().optional().describe('Employee first name.'),
  lastName: z.string().optional().describe('Employee last name.'),
  jobTitle: z.string().optional().describe('Current job title.'),
  workEmail: z.string().optional().describe('Work email address.'),
  department: z.string().optional().describe('Department the employee belongs to.'),
  division: z.string().optional().describe('Division the employee belongs to.'),
  location: z.string().optional().describe('Office / work location.'),
  supervisor: z.string().optional().describe('Display name of the employee\'s supervisor, for reporting-chain patterns.'),
});

export class BambooHRNormalizer implements ConnectorNormalizer {
  connectorType = 'bamboohr';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Employee: EmployeeDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const employees = (payload as BambooHRPayload)?.results ?? [];
    const records: NormalizedRecord[] = [];

    for (const emp of employees) {
      if (emp?.id === undefined || emp.id === null) continue;
      const id = String(emp.id);
      const declared: Record<string, unknown> = {
        id,
        displayName: emp.displayName,
        firstName: emp.firstName,
        lastName: emp.lastName,
        jobTitle: emp.jobTitle,
        workEmail: emp.workEmail,
        department: emp.department,
        division: emp.division,
        location: emp.location,
        supervisor: emp.supervisor,
      };
      records.push({
        entityType: 'Employee',
        externalId: id,
        data: declared,
        metadata: {
          source: 'bamboohr',
          syncedAt: new Date(),
          // Directory has no modified timestamp; hash the row so the scheduler
          // dedups unchanged employees and only re-publishes on a real change.
          version: hashCanonicalJson(emp),
        },
      });
    }

    return records;
  }

  extractEntityType(_record: unknown): string {
    return 'Employee';
  }

  extractExternalId(record: unknown): string {
    return String((record as BambooHREmployee).id ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    return hashCanonicalJson(record);
  }
}
