import build from './app';
import * as MEMBERS_FIXTURES from './fixtures/members';
import { CannotModifyOtherMembers, MemberNotFound } from '../src/util/graasp-error';
import {
  mockMemberServiceGet,
  mockMemberServiceGetMatching,
  mockMemberServiceUpdate,
} from './mocks';
import { ReasonPhrases, StatusCodes } from 'http-status-codes';
import { HTTP_METHODS } from './fixtures/utils';

// mock auth, decorator and database plugins
jest.mock('../src/plugins/database');
jest.mock('../src/plugins/auth/auth');
jest.mock('../src/plugins/decorator');

describe('Member routes tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /members/current', () => {
    it('Returns successfully', async () => {
      mockMemberServiceGet([MEMBERS_FIXTURES.ACTOR]);
      const app = await build();

      const response = await app.inject({
        method: HTTP_METHODS.GET,
        url: '/members/current',
      });

      const m = response.json();
      expect(response.statusCode).toBe(StatusCodes.OK);
      expect(m.name).toEqual(MEMBERS_FIXTURES.ACTOR.name);
      expect(m.email).toEqual(MEMBERS_FIXTURES.ACTOR.email);
      expect(m.id).toEqual(MEMBERS_FIXTURES.ACTOR.id);
      expect(response.statusCode).toBe(StatusCodes.OK);
      app.close();
    });
  });

  describe('GET /members/:id', () => {
    it('Returns successfully', async () => {
      const member = MEMBERS_FIXTURES.BOB;
      mockMemberServiceGet([member]);
      const app = await build();
      const memberId = member.id;
      const response = await app.inject({
        method: HTTP_METHODS.GET,
        url: `/members/${memberId}`,
      });

      const m = response.json();
      expect(m.name).toEqual(member.name);
      expect(m.email).toEqual(member.email);
      expect(m.id).toEqual(member.id);
      expect(response.statusCode).toBe(StatusCodes.OK);
      app.close();
    });

    it('Returns Bad Request for invalid id', async () => {
      const app = await build();
      const memberId = 'invalid-id';
      const response = await app.inject({
        method: HTTP_METHODS.GET,
        url: `/members/${memberId}`,
      });

      expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
      app.close();
    });

    it('Returns MemberNotFound for invalid id', async () => {
      // the following id is not part of the fixtures
      const memberId = 'a3894999-c958-49c0-a5f0-f82dfebd941e';
      mockMemberServiceGet([]);
      const app = await build();
      const response = await app.inject({
        method: HTTP_METHODS.GET,
        url: `/members/${memberId}`,
      });

      expect(response.statusCode).toBe(StatusCodes.NOT_FOUND);
      expect(response.json()).toEqual(new MemberNotFound(memberId));
      app.close();
    });
  });

  describe('GET /members/search?email=<email>', () => {
    it('Returns successfully', async () => {
      const member = MEMBERS_FIXTURES.BOB;
      mockMemberServiceGetMatching([member]);
      const app = await build();
      const response = await app.inject({
        method: HTTP_METHODS.GET,
        url: `/members/search?email=${member.email}`,
      });

      const m = response.json()[0];
      expect(response.statusCode).toBe(StatusCodes.OK);
      expect(m.name).toEqual(member.name);
      expect(m.id).toEqual(member.id);
      expect(m.email).toEqual(member.email);
      app.close();
    });

    it('Returns Bad Request for invalid email', async () => {
      const app = await build();
      const email = 'not-a-valid-email';
      const response = await app.inject({
        method: HTTP_METHODS.GET,
        url: `/members/search?email=${email}`,
      });

      expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST);
      expect(response.statusMessage).toEqual(ReasonPhrases.BAD_REQUEST);
      app.close();
    });

    it('Returns empty array if no corresponding member is found', async () => {
      const email = 'empty@gmail.com';
      mockMemberServiceGetMatching([]);
      const app = await build();
      const response = await app.inject({
        method: HTTP_METHODS.GET,
        url: `/members/search?email=${email}`,
      });

      expect(response.statusCode).toBe(StatusCodes.OK);
      expect(response.json()).toEqual([]);
      app.close();
    });
  });

  describe('PATCH /members/:id', () => {
    it('Returns successfully', async () => {
      const member = MEMBERS_FIXTURES.ACTOR;
      const newName = 'new name';
      mockMemberServiceGet([member]);
      mockMemberServiceUpdate([member]);
      const app = await build();
      const response = await app.inject({
        method: HTTP_METHODS.PATCH,
        url: `/members/${member.id}`,
        payload: {
          name: newName,
          extra: {
            some: 'property',
          },
        },
      });

      expect(response.statusCode).toBe(StatusCodes.OK);
      expect(response.json().name).toEqual(newName);
      // todo: test whether extra is correctly modified (extra is not returned)
      app.close();
    });

    it('Current member cannot modify another member', async () => {
      const app = await build();
      const member = MEMBERS_FIXTURES.BOB;
      mockMemberServiceGet([member]);
      mockMemberServiceUpdate([member]);
      const response = await app.inject({
        method: HTTP_METHODS.PATCH,
        url: `/members/${member.id}`,
        payload: {
          name: 'new name',
        },
      });

      expect(response.statusCode).toBe(StatusCodes.FORBIDDEN);
      expect(response.json()).toEqual(new CannotModifyOtherMembers(member.id));
      app.close();
    });
  });
});
