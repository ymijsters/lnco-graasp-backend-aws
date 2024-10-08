import { FastifyPluginAsync } from 'fastify';

import { ActionTriggers } from '@graasp/sdk';

import { resolveDependency } from '../../../../di/utils';
import { notUndefined } from '../../../../utils/assertions';
import { buildRepositories } from '../../../../utils/repositories';
import { ActionService } from '../../../action/services/action';
import { isAuthenticated, optionalIsAuthenticated } from '../../../auth/plugins/passport';
import { matchOne } from '../../../authorization';
import { validatedMember } from '../../../member/strategies/validatedMember';
import { ItemService } from '../../service';
import common, { create, deleteOne, getLikesForItem, getLikesForMember } from './schemas';
import { ItemLikeService } from './service';

const plugin: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  const itemService = resolveDependency(ItemService);
  const itemLikeService = new ItemLikeService(itemService);
  const actionService = resolveDependency(ActionService);

  fastify.addSchema(common);
  //get liked entry for member
  // BUG: hide item you dont have membership (you liked then lose membership)
  fastify.get<{ Querystring: { memberId: string } }>(
    '/liked',
    { schema: getLikesForMember, preHandler: isAuthenticated },
    async ({ user }) => {
      const member = notUndefined(user?.member);
      return itemLikeService.getForMember(member, buildRepositories());
    },
  );

  // get likes
  // TODO: anonymize private members
  fastify.get<{ Params: { itemId: string } }>(
    '/:itemId/likes',
    { schema: getLikesForItem, preHandler: optionalIsAuthenticated },
    async ({ user, params: { itemId } }) => {
      return itemLikeService.getForItem(user?.member, buildRepositories(), itemId);
    },
  );

  // create item like entry
  fastify.post<{ Params: { itemId: string } }>(
    '/:itemId/like',
    { schema: create, preHandler: [isAuthenticated, matchOne(validatedMember)] },
    async (request) => {
      const {
        user,
        params: { itemId },
      } = request;
      const member = notUndefined(user?.member);
      return db.transaction(async (manager) => {
        const newItemLike = await itemLikeService.post(member, buildRepositories(manager), itemId);
        // action like item
        const item = await itemService.get(member, buildRepositories(manager), itemId);
        const action = {
          item,
          type: ActionTriggers.ItemLike,
          extra: {
            itemId: item.id,
          },
        };
        await actionService.postMany(member, buildRepositories(manager), request, [action]);
        return newItemLike;
      });
    },
  );

  // delete item like entry
  fastify.delete<{ Params: { itemId: string } }>(
    '/:itemId/like',
    { schema: deleteOne, preHandler: [isAuthenticated, matchOne(validatedMember)] },
    async (request) => {
      const {
        user,
        params: { itemId },
      } = request;
      const member = notUndefined(user?.member);
      return db.transaction(async (manager) => {
        const newItemLike = await itemLikeService.removeOne(
          member,
          buildRepositories(manager),
          itemId,
        );
        // action unlike item
        const item = await itemService.get(member, buildRepositories(manager), itemId);

        const action = {
          item,
          type: ActionTriggers.ItemUnlike,
          extra: {
            itemId: item.id,
          },
        };
        await actionService.postMany(member, buildRepositories(manager), request, [action]);
        return newItemLike;
      });
    },
  );
};

export default plugin;
