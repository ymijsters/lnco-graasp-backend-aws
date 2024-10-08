import { FastifyPluginAsync } from 'fastify';

import { PermissionLevel, UUID } from '@graasp/sdk';

import { resolveDependency } from '../../../../../di/utils';
import { notUndefined } from '../../../../../utils/assertions';
import { buildRepositories } from '../../../../../utils/repositories';
import { isAuthenticated, optionalIsAuthenticated } from '../../../../auth/plugins/passport';
import { matchOne } from '../../../../authorization';
import { validatedMember } from '../../../../member/strategies/validatedMember';
import { ItemService } from '../../../service';
import { PublicationService } from '../publicationState/service';
import graaspSearchPlugin from './plugins/search';
import {
  getCollectionsForMember,
  getInformations,
  getManyInformations,
  getMostLikedItems,
  getRecentCollections,
  publishItem,
  unpublishItem,
} from './schemas';
import { ItemPublishedService } from './service';

const plugin: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;
  const itemPublishedService = resolveDependency(ItemPublishedService);
  const publicationService = resolveDependency(PublicationService);
  const itemService = resolveDependency(ItemService);

  fastify.register(graaspSearchPlugin);

  fastify.get<{ Params: { memberId: UUID } }>(
    '/collections/members/:memberId',
    {
      schema: getCollectionsForMember,
      preHandler: optionalIsAuthenticated,
    },
    async ({ user, params: { memberId } }) => {
      return itemPublishedService.getItemsForMember(user?.member, buildRepositories(), memberId);
    },
  );

  fastify.get<{ Params: { itemId: string } }>(
    '/collections/:itemId/informations',
    {
      preHandler: optionalIsAuthenticated,
      schema: getInformations,
    },
    async ({ params, user }) => {
      return itemPublishedService.get(user?.member, buildRepositories(), params.itemId);
    },
  );

  fastify.get<{ Querystring: { itemId: string[] } }>(
    '/collections/informations',
    {
      preHandler: optionalIsAuthenticated,
      schema: getManyInformations,
    },
    async ({ user, query: { itemId } }) => {
      return itemPublishedService.getMany(user?.member, buildRepositories(), itemId);
    },
  );

  fastify.get<{ Querystring: { limit?: number } }>(
    '/collections/liked',
    {
      preHandler: optionalIsAuthenticated,
      schema: getMostLikedItems,
    },
    async ({ user, query: { limit } }) => {
      return itemPublishedService.getLikedItems(user?.member, buildRepositories(), limit);
    },
  );

  fastify.post<{ Params: { itemId: string } }>(
    '/collections/:itemId/publish',
    {
      preHandler: [isAuthenticated, matchOne(validatedMember)],
      schema: publishItem,
    },
    async ({ params, user }) => {
      const member = notUndefined(user?.member);
      return db.transaction(async (manager) => {
        const repositories = buildRepositories(manager);
        const item = await itemService.get(
          member,
          repositories,
          params.itemId,
          PermissionLevel.Admin,
        );

        const status = await publicationService.computeStateForItem(member, repositories, item.id);

        return itemPublishedService.post(member, repositories, item, status);
      });
    },
  );

  fastify.delete<{ Params: { itemId: string } }>(
    '/collections/:itemId/unpublish',
    {
      preHandler: [isAuthenticated, matchOne(validatedMember)],
      schema: unpublishItem,
    },
    async ({ params, user }) => {
      const member = notUndefined(user?.member);
      return db.transaction(async (manager) => {
        return itemPublishedService.delete(member, buildRepositories(manager), params.itemId);
      });
    },
  );

  fastify.get<{ Querystring: { limit?: number } }>(
    '/collections/recent',
    {
      preHandler: optionalIsAuthenticated,
      schema: getRecentCollections,
    },
    async ({ user, query: { limit } }) => {
      return itemPublishedService.getRecentItems(user?.member, buildRepositories(), limit);
    },
  );
};
export default plugin;
