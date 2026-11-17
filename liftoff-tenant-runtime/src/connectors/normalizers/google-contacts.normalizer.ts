// Google Contacts Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Google People API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';

// Google People API Person structure
interface GooglePerson {
  resourceName: string;
  etag?: string;
  metadata?: {
    sources?: Array<{
      type: string;
      id: string;
      etag?: string;
      profileMetadata?: {
        objectType?: string;
        userTypes?: string[];
      };
      updateTime?: string;
    }>;
    previousResourceNames?: string[];
    linkedPeopleResourceNames?: string[];
    deleted?: boolean;
    objectType?: string;
  };
  names?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    displayName?: string;
    familyName?: string;
    givenName?: string;
    middleName?: string;
    honorificPrefix?: string;
    honorificSuffix?: string;
    phoneticFullName?: string;
    phoneticFamilyName?: string;
    phoneticGivenName?: string;
    phoneticHonorificPrefix?: string;
    phoneticHonorificSuffix?: string;
    phoneticMiddleName?: string;
    unstructuredName?: string;
  }>;
  nicknames?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    value?: string;
    type?: string;
  }>;
  photos?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    url?: string;
    default?: boolean;
  }>;
  emailAddresses?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
      verified?: boolean;
    };
    value?: string;
    type?: string;
    formattedType?: string;
    displayName?: string;
  }>;
  phoneNumbers?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    value?: string;
    canonicalForm?: string;
    type?: string;
    formattedType?: string;
  }>;
  addresses?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    formattedValue?: string;
    type?: string;
    formattedType?: string;
    poBox?: string;
    streetAddress?: string;
    extendedAddress?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
    countryCode?: string;
  }>;
  organizations?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    type?: string;
    formattedType?: string;
    startDate?: { year?: number; month?: number; day?: number };
    endDate?: { year?: number; month?: number; day?: number };
    current?: boolean;
    name?: string;
    phoneticName?: string;
    department?: string;
    title?: string;
    jobDescription?: string;
    symbol?: string;
    domain?: string;
    location?: string;
    costCenter?: string;
    fullTimeEquivalentMillipercent?: number;
  }>;
  biographies?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    value?: string;
    contentType?: 'TEXT_PLAIN' | 'TEXT_HTML';
  }>;
  birthdays?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    date?: { year?: number; month?: number; day?: number };
    text?: string;
  }>;
  events?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    date?: { year?: number; month?: number; day?: number };
    type?: string;
    formattedType?: string;
  }>;
  urls?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    value?: string;
    type?: string;
    formattedType?: string;
  }>;
  relations?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    person?: string;
    type?: string;
    formattedType?: string;
  }>;
  memberships?: Array<{
    metadata?: {
      source?: { type: string; id: string };
    };
    contactGroupMembership?: {
      contactGroupId?: string;
      contactGroupResourceName?: string;
    };
    domainMembership?: {
      inViewerDomain?: boolean;
    };
  }>;
  userDefined?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    key?: string;
    value?: string;
  }>;
  imClients?: Array<{
    metadata?: {
      primary?: boolean;
      source?: { type: string; id: string };
    };
    username?: string;
    type?: string;
    formattedType?: string;
    protocol?: string;
    formattedProtocol?: string;
  }>;
}

// Google People API Contact Group structure
interface GoogleContactGroup {
  resourceName: string;
  etag?: string;
  metadata?: {
    updateTime?: string;
    deleted?: boolean;
  };
  groupType?: 'GROUP_TYPE_UNSPECIFIED' | 'USER_CONTACT_GROUP' | 'SYSTEM_CONTACT_GROUP';
  name?: string;
  formattedName?: string;
  memberResourceNames?: string[];
  memberCount?: number;
  clientData?: Array<{
    key?: string;
    value?: string;
  }>;
}

// Google People API List responses
interface GooglePeopleConnectionsResponse {
  connections?: GooglePerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalPeople?: number;
  totalItems?: number;
}

interface GoogleContactGroupsResponse {
  contactGroups?: GoogleContactGroup[];
  totalItems?: number;
  nextPageToken?: string;
  nextSyncToken?: string;
}

// Google People API Sync response
interface GooglePeopleSyncResponse {
  connections?: GooglePerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

type GoogleContactsPayload =
  | GooglePerson
  | GoogleContactGroup
  | GooglePeopleConnectionsResponse
  | GoogleContactGroupsResponse
  | GooglePeopleSyncResponse;

export class GoogleContactsNormalizer implements ConnectorNormalizer {
  connectorType = 'google_contacts';

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const contactsPayload = payload as GoogleContactsPayload;

    // Handle connections/people list response
    if (this.isConnectionsResponse(contactsPayload)) {
      for (const person of contactsPayload.connections || []) {
        if (!person.metadata?.deleted) {
          records.push(this.normalizePerson(person));
        }
      }
      return records;
    }

    // Handle contact groups list response
    if (this.isContactGroupsResponse(contactsPayload)) {
      for (const group of contactsPayload.contactGroups || []) {
        if (!group.metadata?.deleted) {
          records.push(this.normalizeContactGroup(group));
        }
      }
      return records;
    }

    // Handle single contact group
    if (this.isContactGroup(contactsPayload)) {
      if (!contactsPayload.metadata?.deleted) {
        records.push(this.normalizeContactGroup(contactsPayload));
      }
      return records;
    }

    // Handle single person/contact
    if (this.isPerson(contactsPayload)) {
      if (!contactsPayload.metadata?.deleted) {
        records.push(this.normalizePerson(contactsPayload));
      }
      return records;
    }

    return records;
  }

  private normalizePerson(person: GooglePerson): NormalizedRecord {
    const primaryName = person.names?.find((n) => n.metadata?.primary) || person.names?.[0];
    const primaryEmail =
      person.emailAddresses?.find((e) => e.metadata?.primary) || person.emailAddresses?.[0];
    const primaryPhone =
      person.phoneNumbers?.find((p) => p.metadata?.primary) || person.phoneNumbers?.[0];
    const primaryOrg =
      person.organizations?.find((o) => o.metadata?.primary) || person.organizations?.[0];
    const primaryPhoto =
      person.photos?.find((p) => p.metadata?.primary) || person.photos?.[0];

    return {
      entityType: 'Contact',
      externalId: person.resourceName,
      data: {
        // Name information
        displayName: primaryName?.displayName,
        givenName: primaryName?.givenName,
        familyName: primaryName?.familyName,
        middleName: primaryName?.middleName,
        honorificPrefix: primaryName?.honorificPrefix,
        honorificSuffix: primaryName?.honorificSuffix,
        nicknames: person.nicknames?.map((n) => n.value).filter(Boolean),

        // Contact information
        primaryEmail: primaryEmail?.value,
        emails: person.emailAddresses?.map((e) => ({
          value: e.value,
          type: e.type || e.formattedType,
          primary: e.metadata?.primary,
          verified: e.metadata?.verified,
        })),
        primaryPhone: primaryPhone?.value,
        phoneNumbers: person.phoneNumbers?.map((p) => ({
          value: p.value,
          canonicalForm: p.canonicalForm,
          type: p.type || p.formattedType,
          primary: p.metadata?.primary,
        })),

        // Addresses
        addresses: person.addresses?.map((a) => ({
          formatted: a.formattedValue,
          type: a.type || a.formattedType,
          streetAddress: a.streetAddress,
          city: a.city,
          region: a.region,
          postalCode: a.postalCode,
          country: a.country,
          countryCode: a.countryCode,
          primary: a.metadata?.primary,
        })),

        // Organization/Work
        organization: primaryOrg?.name,
        jobTitle: primaryOrg?.title,
        department: primaryOrg?.department,
        organizations: person.organizations?.map((o) => ({
          name: o.name,
          title: o.title,
          department: o.department,
          type: o.type || o.formattedType,
          current: o.current,
          location: o.location,
          primary: o.metadata?.primary,
        })),

        // Photo
        photoUrl: primaryPhoto?.url,
        hasPhoto: !primaryPhoto?.default && !!primaryPhoto?.url,

        // Biography
        biography: person.biographies?.find((b) => b.metadata?.primary)?.value,

        // Birthday
        birthday: this.formatDate(person.birthdays?.[0]?.date),
        birthdayText: person.birthdays?.[0]?.text,

        // Events (anniversaries, etc.)
        events: person.events?.map((e) => ({
          date: this.formatDate(e.date),
          type: e.type || e.formattedType,
        })),

        // URLs
        urls: person.urls?.map((u) => ({
          value: u.value,
          type: u.type || u.formattedType,
        })),

        // Relations
        relations: person.relations?.map((r) => ({
          person: r.person,
          type: r.type || r.formattedType,
        })),

        // IM Clients
        imClients: person.imClients?.map((im) => ({
          username: im.username,
          protocol: im.protocol || im.formattedProtocol,
          type: im.type || im.formattedType,
        })),

        // Group memberships
        groupMemberships: person.memberships
          ?.filter((m) => m.contactGroupMembership)
          .map((m) => ({
            groupId: m.contactGroupMembership?.contactGroupId,
            groupResourceName: m.contactGroupMembership?.contactGroupResourceName,
          })),

        // Custom fields
        customFields: person.userDefined?.map((ud) => ({
          key: ud.key,
          value: ud.value,
        })),

        // Metadata
        sources: person.metadata?.sources?.map((s) => ({
          type: s.type,
          id: s.id,
          updateTime: s.updateTime,
        })),
        linkedPeople: person.metadata?.linkedPeopleResourceNames,
        isDeleted: person.metadata?.deleted,
      },
      metadata: {
        source: 'google_contacts',
        syncedAt: new Date(),
        version: this.getLatestUpdateTime(person),
        etag: person.etag,
      },
    };
  }

  private normalizeContactGroup(group: GoogleContactGroup): NormalizedRecord {
    return {
      entityType: 'ContactGroup',
      externalId: group.resourceName,
      data: {
        name: group.name,
        formattedName: group.formattedName,
        groupType: group.groupType,
        memberCount: group.memberCount,
        memberResourceNames: group.memberResourceNames,
        isSystemGroup: group.groupType === 'SYSTEM_CONTACT_GROUP',
        isUserGroup: group.groupType === 'USER_CONTACT_GROUP',
        clientData: group.clientData?.reduce(
          (acc, cd) => {
            if (cd.key) acc[cd.key] = cd.value;
            return acc;
          },
          {} as Record<string, string | undefined>
        ),
        isDeleted: group.metadata?.deleted,
        updatedAt: group.metadata?.updateTime,
      },
      metadata: {
        source: 'google_contacts',
        syncedAt: new Date(),
        version: group.metadata?.updateTime,
        etag: group.etag,
      },
    };
  }

  private formatDate(
    date: { year?: number; month?: number; day?: number } | undefined
  ): string | undefined {
    if (!date) return undefined;
    if (date.year && date.month && date.day) {
      return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
    }
    if (date.month && date.day) {
      return `--${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
    }
    return undefined;
  }

  private getLatestUpdateTime(person: GooglePerson): string | undefined {
    const times = person.metadata?.sources
      ?.map((s) => s.updateTime)
      .filter(Boolean) as string[];
    if (!times?.length) return undefined;
    return times.sort().reverse()[0];
  }

  extractEntityType(record: unknown): string {
    const r = record as GoogleContactsPayload;
    if (this.isConnectionsResponse(r)) return 'ContactList';
    if (this.isContactGroupsResponse(r)) return 'ContactGroupList';
    if (this.isContactGroup(r)) return 'ContactGroup';
    if (this.isPerson(r)) return 'Contact';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as GoogleContactsPayload;
    if (this.isConnectionsResponse(r)) return r.nextSyncToken || r.nextPageToken || '';
    if (this.isContactGroupsResponse(r)) return r.nextSyncToken || r.nextPageToken || '';
    if (this.isContactGroup(r)) return r.resourceName;
    if (this.isPerson(r)) return r.resourceName;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as GoogleContactsPayload;
    if (this.isPerson(r)) return this.getLatestUpdateTime(r);
    if (this.isContactGroup(r)) return r.metadata?.updateTime;
    return undefined;
  }

  private isConnectionsResponse(
    payload: GoogleContactsPayload
  ): payload is GooglePeopleConnectionsResponse {
    return 'connections' in payload && Array.isArray((payload as any).connections);
  }

  private isContactGroupsResponse(
    payload: GoogleContactsPayload
  ): payload is GoogleContactGroupsResponse {
    return 'contactGroups' in payload && Array.isArray((payload as any).contactGroups);
  }

  private isContactGroup(payload: GoogleContactsPayload): payload is GoogleContactGroup {
    return (
      'resourceName' in payload &&
      (payload.resourceName as string).startsWith('contactGroups/')
    );
  }

  private isPerson(payload: GoogleContactsPayload): payload is GooglePerson {
    return (
      'resourceName' in payload &&
      (payload.resourceName as string).startsWith('people/')
    );
  }
}
