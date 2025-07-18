import { ContentType } from '@medplum/core';
import { CodeSystem, Parameters } from '@medplum/fhirtypes';
import express from 'express';
import request from 'supertest';
import { initApp, shutdownApp } from '../../app';
import { loadTestConfig } from '../../config/loader';
import { DatabaseMode, getDatabasePool } from '../../database';
import { createTestProject, initTestAuth } from '../../test.setup';
import { Column, Condition, SelectQuery } from '../sql';
import { selectCoding } from './utils/terminology';

const app = express();

export const snomedJSON: CodeSystem = {
  resourceType: 'CodeSystem',
  url: 'http://snomed.info/sct',
  name: 'SNOMEDCT_US',
  title: 'SNOMED CT (US Edition)',
  status: 'active',
  experimental: false,
  hierarchyMeaning: 'is-a',
  versionNeeded: false,
  content: 'not-present',
  property: [
    {
      code: 'parent',
      uri: 'http://hl7.org/fhir/concept-properties#parent',
      description: 'A SNOMED CT concept id that has the target of a direct is-a relationship from the concept',
      type: 'code',
    },
  ],
};

describe('CodeSystem $import', () => {
  let accessToken: string;
  let snomed: CodeSystem;

  beforeAll(async () => {
    const config = await loadTestConfig();
    await initApp(app, config);
  });

  beforeEach(async () => {
    accessToken = await initTestAuth({ superAdmin: true });
    expect(accessToken).toBeDefined();

    const resS = await request(app)
      .get(`/fhir/R4/CodeSystem?url=${snomedJSON.url}`)
      .set('Authorization', 'Bearer ' + accessToken)
      .send();
    expect(resS.status).toStrictEqual(200);

    if (resS.body.entry.length > 0) {
      for (const entry of resS.body.entry) {
        const resD = await request(app)
          .delete(`/fhir/R4/CodeSystem/${entry.resource.id}`)
          .set('Authorization', 'Bearer ' + accessToken)
          .send();
        expect(resD.status).toStrictEqual(200);
      }
    }

    const res = await request(app)
      .post(`/fhir/R4/CodeSystem`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send(snomedJSON);
    expect(res.status).toStrictEqual(201);
    snomed = res.body as CodeSystem;
  });

  afterAll(async () => {
    await shutdownApp();
  });

  test('Imports concepts and properties separately', async () => {
    const res = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: snomed.url },
          { name: 'concept', valueCoding: { code: '37931006', display: 'Auscultation (procedure)' } },
          { name: 'concept', valueCoding: { code: '315306007', display: 'Examination by method (procedure)' } },
        ],
      });
    expect(res.status).toStrictEqual(200);

    const res2 = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: snomed.url },
          {
            name: 'property',
            part: [
              { name: 'code', valueCode: '37931006' },
              { name: 'property', valueCode: 'parent' },
              { name: 'value', valueString: '315306007' },
            ],
          },
        ],
      });
    expect(res2.status).toStrictEqual(200);

    const coding = await assertCodeExists(snomed.id, '37931006');
    expect(coding.isSynonym).toBe(false);
    await assertCodeExists(snomed.id, '315306007');
    await assertPropertyExists(snomed.id, '37931006', 'parent', '315306007');
  });

  test('Imports concepts and associated relationships', async () => {
    const res = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: snomed.url },
          { name: 'concept', valueCoding: { code: '184598004', display: 'Needle biopsy of brain (procedure)' } },
          { name: 'concept', valueCoding: { code: '702707005', display: 'Biopsy of head (procedure)' } },
          { name: 'concept', valueCoding: { code: '118690002', display: 'Procedure on head (procedure)' } },
          { name: 'concept', valueCoding: { code: '71388002', display: 'Procedure (procedure)' } },
          {
            name: 'property',
            part: [
              { name: 'code', valueCode: '184598004' },
              { name: 'property', valueCode: 'parent' },
              { name: 'value', valueString: '702707005' },
            ],
          },
          {
            name: 'property',
            part: [
              { name: 'code', valueCode: '702707005' },
              { name: 'property', valueCode: 'parent' },
              { name: 'value', valueString: '118690002' },
            ],
          },
          {
            name: 'property',
            part: [
              { name: 'code', valueCode: '118690002' },
              { name: 'property', valueCode: 'parent' },
              { name: 'value', valueString: '71388002' },
            ],
          },
        ],
      } as Parameters);
    expect(res.status).toBe(200);

    await assertCodeExists(snomed.id, '702707005');
    const target = await assertCodeExists(snomed.id, '118690002');
    const relationship = await assertPropertyExists(snomed.id, '702707005', 'parent', '118690002');
    expect(relationship.target).toStrictEqual(target.id);
  });

  test('Returns error on unknown code system', async () => {
    const res = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: 'http://example.com/unknown' },
          { name: 'concept', valueCoding: { code: '1', display: 'Aspirin' } },
        ],
      });
    expect(res.status).toStrictEqual(400);
    expect(res.body.issue[0].code).toStrictEqual('invalid');
  });

  test('Returns error on unknown code for property', async () => {
    const res2 = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: snomed.url },
          {
            name: 'property',
            part: [
              { name: 'code', valueCode: 'not a real code' },
              { name: 'property', valueCode: 'parent' },
              { name: 'value', valueString: '71388002' },
            ],
          },
        ],
      });
    expect(res2.status).toStrictEqual(400);
    expect(res2.body.issue[0].code).toStrictEqual('invalid');
  });

  test('Returns error on unknown property', async () => {
    const res2 = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: snomed.url },
          { name: 'concept', valueCoding: { code: '184598004', display: 'Needle biopsy of brain (procedure)' } },
          {
            name: 'property',
            part: [
              { name: 'code', valueCode: '184598004' },
              { name: 'property', valueCode: 'not a real property' },
              { name: 'value', valueString: '71388002' },
            ],
          },
        ],
      });
    expect(res2.status).toStrictEqual(400);
    expect(res2.body.issue[0].code).toStrictEqual('invalid');
  });

  test('Returns error on non-SuperAdmin user', async () => {
    const regularAccessToken = await initTestAuth({ superAdmin: false });
    const res2 = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + regularAccessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: snomed.url },
          { name: 'concept', valueCoding: { code: '184598004', display: 'Needle biopsy of brain (procedure)' } },
        ],
      });
    expect(res2.status).toStrictEqual(403);
    expect(res2.body.issue[0].code).toStrictEqual('forbidden');
  });

  test('Allows access by Project admin', async () => {
    const { accessToken } = await createTestProject({
      project: { superAdmin: false },
      membership: { admin: true },
      withAccessToken: true,
    });

    // Project Admin must have access to write to CodeSystem resource
    const res = await request(app)
      .post('/fhir/R4/CodeSystem')
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send(snomedJSON);
    expect(res.status).toStrictEqual(201);

    const res2 = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: snomed.url },
          { name: 'concept', valueCoding: { code: '184598004', display: 'Needle biopsy of brain (procedure)' } },
        ],
      });
    expect(res2.status).toStrictEqual(200);
    await assertCodeExists(res.body.id, '184598004');
  });

  test('Prevents writes by Project admin to linked Project systems', async () => {
    const { accessToken } = await createTestProject({
      project: { superAdmin: false },
      membership: { admin: true },
      withAccessToken: true,
    });

    const res2 = await request(app)
      .post(`/fhir/R4/CodeSystem/$import`)
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode' },
          { name: 'concept', valueCoding: { code: 'NIBL', display: 'nibling' } },
        ],
      });
    expect(res2.status).toStrictEqual(400);
  });
});

async function assertCodeExists(system: string | undefined, code: string): Promise<any> {
  const db = getDatabasePool(DatabaseMode.READER);
  const coding = await selectCoding(system as string, code)
    .column('isSynonym')
    .execute(db);
  expect(coding).toHaveLength(1);
  return coding[0];
}

async function assertPropertyExists(
  system: string | undefined,
  code: string,
  property: string,
  value: string
): Promise<any> {
  const db = getDatabasePool(DatabaseMode.READER);
  const query = new SelectQuery('Coding_Property');
  const codingTable = query.getNextJoinAlias();
  query.join(
    'INNER JOIN',
    'Coding',
    codingTable,
    new Condition(new Column('Coding_Property', 'coding'), '=', new Column(codingTable, 'id'))
  );
  const propertyTable = query.getNextJoinAlias();
  query.join(
    'INNER JOIN',
    'CodeSystem_Property',
    propertyTable,
    new Condition(new Column('Coding_Property', 'property'), '=', new Column(propertyTable, 'id'))
  );

  const results = await query
    .column('value')
    .column('target')
    .where(new Column(codingTable, 'system'), '=', system)
    .where(new Column(codingTable, 'code'), '=', code)
    .where(new Column(propertyTable, 'code'), '=', property)
    .execute(db);

  for (const row of results) {
    if (row.value === value) {
      return row;
    }
  }
  throw new Error(`Expected code ${code} to have property ${property}: ${value}`);
}
