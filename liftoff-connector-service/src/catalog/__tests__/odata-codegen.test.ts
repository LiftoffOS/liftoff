// Proves the OData ($metadata) codegen path on REAL SAP-published metadata.
// SAP SuccessFactors EC has no universal public spec — its exhaustive tool set is
// generated at connect time from the tenant's own $metadata. This test guarantees
// that generation is correct against a real EDMX fixture (the SAP-published User
// entity), so the connect-time path is verified, not theoretical.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromODataMetadata, fromWsdl, fromOpenApi } from '../spec-codegen';

const edmx = readFileSync(join(__dirname, '../../../specs/sap-successfactors-user.edmx'), 'utf8');

describe('fromODataMetadata (SAP SuccessFactors EDMX)', () => {
  const ops = fromODataMetadata(edmx);
  const byName = (n: string) => ops.find((o) => o.name === n);

  it('emits query/get/create/update for the User entity set', () => {
    for (const n of ['query_user', 'get_user', 'create_user', 'update_user']) {
      expect(byName(n)).toBeTruthy();
    }
  });

  it('uses the bare OData entity-set name as entityType (reuses the client upsert/MERGE path)', () => {
    expect(byName('query_user')?.entityType).toBe('User');
    expect(byName('create_user')?.entityType).toBe('User');
    expect(byName('update_user')?.entityType).toBe('User');
  });

  it('gates CRUD by the sap: annotations — User is deletable="false", so no delete tool', () => {
    expect(byName('delete_user')).toBeUndefined();
  });

  it('drives CRUD via categories: read for query/get, write for create/update', () => {
    expect(byName('query_user')?.categories).toEqual(['read']);
    expect(byName('get_user')?.categories).toEqual(['read']);
    expect(byName('create_user')?.categories).toEqual(['write']);
    expect(byName('update_user')?.categories).toEqual(['write']);
  });

  it('flags writes as dataChanges for the HITL classification migration', () => {
    expect(byName('create_user')?.classification).toContain('dataChanges');
    expect(byName('update_user')?.classification).toContain('dataChanges');
  });

  it('expands the EntityType into real create/update body fields (+ navigation)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const create = byName('create_user')?.inputSchema as Record<string, any>;
    expect(Object.keys(create.properties).length).toBeGreaterThan(100); // ~151 (140 props + 11 navs)
    expect(create.properties.userId?.type).toBe('string');
    expect(create.required).toEqual(['userId']); // key
    // a navigation property resolves to a nested object/array (directReports → User)
    const nav = create.properties.directReports;
    expect(nav?.type === 'array' || nav?.type === 'object').toBe(true);
    // update carries the key predicate (id) plus the same fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update = byName('update_user')?.inputSchema as Record<string, any>;
    expect(update.properties.id).toBeTruthy();
    expect(update.required).toEqual(['id']);
  });
});

describe('fromOpenApi body expansion ($ref + components.requestBodies)', () => {
  const spec = {
    openapi: '3.0.0',
    components: {
      schemas: {
        Widget: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, size: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } }, kind: { type: 'string', enum: ['a', 'b'] } } },
      },
      requestBodies: { WidgetBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } } } },
    },
    paths: {
      '/widgets': { post: { operationId: 'createWidget', requestBody: { $ref: '#/components/requestBodies/WidgetBody' } } },
      '/widgets/{id}': { get: { operationId: 'getWidget', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'view', in: 'query', schema: { type: 'string', enum: ['full', 'summary'] } }] } },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops = fromOpenApi(spec as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schemaOf = (n: string) => ops.find((o) => o.name === n)!.inputSchema as Record<string, any>;

  it('resolves a requestBody $ref (components.requestBodies) → real body fields with types/enum/required', () => {
    const body = schemaOf('createwidget').properties.body;
    expect(Object.keys(body.properties)).toEqual(['name', 'size', 'tags', 'kind']);
    expect(body.properties.size.type).toBe('integer');
    expect(body.properties.tags.type).toBe('array');
    expect(body.properties.kind.enum).toEqual(['a', 'b']);
    expect(body.requiredFields).toEqual(['name']);
  });

  it('captures query-param enums', () => {
    expect(schemaOf('getwidget').properties.view.enum).toEqual(['full', 'summary']);
  });
});

describe('fromWsdl (Workday WWS)', () => {
  const wsdl =
    '<wsdl:portType>' +
    '<wsdl:operation name="Get_Workers"/>' +
    '<wsdl:operation name="Find_Organization"/>' +
    '<wsdl:operation name="Change_Job"/>' +
    '<wsdl:operation name="Request_Compensation_Change"/>' +
    '<wsdl:operation name="Get_Workers"/>' + // dup — WSDLs repeat op names in binding
    '</wsdl:portType>';
  const ops = fromWsdl(wsdl, 'Human_Resources');
  const byName = (n: string) => ops.find((o) => o.name === n);

  it('emits one tool per UNIQUE operation with a SOAP entityType', () => {
    expect(ops.length).toBe(4); // dup Get_Workers collapsed
    expect(byName('human_resources_get_workers')?.entityType).toBe('SOAP Human_Resources Get_Workers');
  });

  it('read detection is fail-secure: Get_/Find_ read, Change_/Request_ write', () => {
    expect(byName('human_resources_get_workers')?.categories).toEqual(['read']);
    expect(byName('human_resources_find_organization')?.categories).toEqual(['read']);
    expect(byName('human_resources_change_job')?.categories).toEqual(['write']);
    // Request_* SUBMITS a business process — must be a write, not a read.
    expect(byName('human_resources_request_compensation_change')?.categories).toEqual(['write']);
  });

  it('flags financial writes (Request_Compensation_Change) for HITL', () => {
    expect(byName('human_resources_request_compensation_change')?.classification).toContain('financialActions');
  });
});

describe('fromWsdl XSD expansion (rich per-operation request schemas)', () => {
  const wsdl =
    '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:wd="urn:com.workday/bsvc">' +
    '<wsdl:types><xsd:schema targetNamespace="urn:com.workday/bsvc">' +
    '<xsd:element name="Get_Things_Request" type="wd:Get_Things_RequestType"/>' +
    '<xsd:complexType name="Get_Things_RequestType"><xsd:sequence>' +
    '<xsd:element name="Reference" type="wd:ThingRefType" minOccurs="0" maxOccurs="unbounded"/>' +
    '<xsd:element name="Count" type="xsd:int" minOccurs="1"/>' +
    '</xsd:sequence><xsd:attribute name="version" type="xsd:string"/></xsd:complexType>' +
    '<xsd:complexType name="ThingRefType"><xsd:sequence>' +
    '<xsd:element name="ID" type="wd:ThingIDType" maxOccurs="unbounded"/>' +
    '</xsd:sequence></xsd:complexType>' +
    '<xsd:complexType name="ThingIDType"><xsd:simpleContent><xsd:extension base="xsd:string">' +
    '<xsd:attribute name="type" type="wd:ThingIDEnum"/></xsd:extension></xsd:simpleContent></xsd:complexType>' +
    '<xsd:simpleType name="ThingIDEnum"><xsd:restriction base="xsd:string">' +
    '<xsd:enumeration value="WID"/><xsd:enumeration value="Thing_ID"/></xsd:restriction></xsd:simpleType>' +
    '</xsd:schema></wsdl:types>' +
    '<wsdl:portType><wsdl:operation name="Get_Things"/></wsdl:portType></wsdl:definitions>';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = fromWsdl(wsdl, 'Human_Resources')[0].inputSchema as Record<string, any>;

  it('expands the request type: sequence elements, attribute, and minOccurs=1 required', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(['@version', 'Count', 'Reference']);
    expect(schema.properties.Count.type).toBe('integer');
    expect(schema.required).toEqual(['Count']); // minOccurs=1
    expect(schema.properties['@version'].type).toBe('string');
  });

  it('maxOccurs=unbounded → array; nested refs expand transitively', () => {
    expect(schema.properties.Reference.type).toBe('array');
    expect(schema.properties.Reference.items.properties.ID.type).toBe('array');
  });

  it('simpleContent extension → #text, and the type attribute carries its enum', () => {
    const id = schema.properties.Reference.items.properties.ID.items;
    expect(id.properties['#text'].type).toBe('string');
    expect(id.properties['@type'].enum).toEqual(['WID', 'Thing_ID']);
  });
});
